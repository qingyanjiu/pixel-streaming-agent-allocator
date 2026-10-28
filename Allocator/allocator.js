'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const {
    fetchJson,
    getSecret,
    loadJson,
    parseArguments,
    resolveFrom,
    timingSafeEqual
} = require('./common/runtime');

const DEFAULTS = {
    listenHost: '0.0.0.0',
    listenPort: 9200,
    pollIntervalMs: 2_000,
    workerRequestTimeoutMs: 5_000,
    workerStartTimeoutMs: 210_000,
    workerStopTimeoutMs: 30_000,
    connectTimeoutMs: 600_000,
    idleReleaseMs: 600_000,
    defaultTtlSeconds: 3_600,
    minTtlSeconds: 60,
    maxTtlSeconds: 86_400,
    autoStart: true,
    stopOnRelease: true,
    sessionRetentionMs: 3_600_000,
    corsAllowedOrigins: []
};

function validateConfig(config) {
    if (!Array.isArray(config.workers) || config.workers.length === 0) {
        throw new Error('At least one worker must be configured.');
    }

    const ids = new Set();
    const baseUrls = new Set();
    for (const worker of config.workers) {
        if (!worker.id || typeof worker.id !== 'string') {
            throw new Error('Every worker requires a non-empty id.');
        }
        if (ids.has(worker.id)) {
            throw new Error(`Duplicate worker id "${worker.id}".`);
        }
        ids.add(worker.id);
        if (!worker.baseUrl || !/^https?:\/\//i.test(worker.baseUrl)) {
            throw new Error(`Worker "${worker.id}" requires an http(s) baseUrl.`);
        }
        const normalizedBaseUrl = worker.baseUrl.replace(/\/+$/, '').toLowerCase();
        if (baseUrls.has(normalizedBaseUrl)) {
            throw new Error(
                `Worker "${worker.id}" duplicates baseUrl "${worker.baseUrl}". Each Worker must use a unique address.`
            );
        }
        baseUrls.add(normalizedBaseUrl);
    }
}

function loadAllocatorConfiguration(configPath) {
    const loaded = loadJson(configPath);
    const config = { ...loaded.config };
    let workersFile = null;

    if (config.workersFile) {
        workersFile = resolveFrom(path.dirname(loaded.path), config.workersFile);
        const workerConfig = loadJson(workersFile).config;
        const workers = Array.isArray(workerConfig) ? workerConfig : workerConfig.workers;
        if (!Array.isArray(workers)) {
            throw new Error(
                `Worker file "${workersFile}" must be an array or contain a "workers" array.`
            );
        }
        config.workers = workers;
        config.resolvedWorkersFile = workersFile;
    }

    validateConfig(config);
    return {
        config,
        path: loaded.path,
        workersFile
    };
}

function createAllocator(config, options = {}) {
    validateConfig(config);
    const settings = { ...DEFAULTS, ...config };
    const logger = options.logger || console;
    const apiKey = getSecret(settings.apiKey, settings.apiKeyEnv);
    const workers = settings.workers.map((worker) => ({
        ...worker,
        token: getSecret(worker.token, worker.tokenEnv),
        baseUrl: worker.baseUrl.replace(/\/+$/, ''),
        online: false,
        lastSeenAt: null,
        lastError: null,
        slots: []
    }));
    const workersById = new Map(workers.map((worker) => [worker.id, worker]));
    const sessions = new Map();
    const idempotencyKeys = new Map();
    const slotLeases = new Map();
    let allocationTail = Promise.resolve();
    let closed = false;
    let pollTimer = null;

    function logEvent(event, fields = {}) {
        const details = Object.entries(fields)
            .filter(([, value]) => value !== undefined && value !== null && value !== '')
            .map(([key, value]) => `${key}=${String(value).replace(/\s+/g, '_')}`)
            .join(' ');
        logger.log(`[allocator] ${new Date().toISOString()} event=${event}${details ? ` ${details}` : ''}`);
    }

    function getClientAddress(request) {
        const forwarded = request.headers['x-forwarded-for'];
        if (typeof forwarded === 'string' && forwarded.trim()) {
            return forwarded.split(',')[0].trim();
        }
        return request.socket.remoteAddress || 'unknown';
    }

    function setSessionStatus(session, status, detail = {}) {
        if (session.status === status) {
            return;
        }
        const previous = session.status;
        session.status = status;
        session.updatedAt = Date.now();
        logEvent('session_status', {
            session: session.id,
            from: previous,
            to: status,
            client: session.clientAddress,
            worker: session.workerId,
            slot: session.slotId,
            reason: session.reason || detail.reason
        });
    }

    function workerHeaders(worker) {
        const headers = {};
        if (worker.token) {
            headers.Authorization = `Bearer ${worker.token}`;
        }
        return headers;
    }

    async function workerRequest(worker, requestPath, requestOptions = {}, timeoutMilliseconds) {
        return fetchJson(
            `${worker.baseUrl}${requestPath}`,
            timeoutMilliseconds || settings.workerRequestTimeoutMs,
            {
                ...requestOptions,
                headers: {
                    ...workerHeaders(worker),
                    ...(requestOptions.headers || {})
                }
            }
        );
    }

    function slotKey(workerId, slotId) {
        return `${workerId}:${slotId}`;
    }

    async function refreshWorker(worker) {
        const wasOnline = worker.online;
        try {
            const response = await workerRequest(worker, '/slots');
            worker.online = true;
            worker.lastSeenAt = new Date().toISOString();
            worker.lastError = null;
            worker.slots = Array.isArray(response.slots) ? response.slots : [];
            if (!wasOnline) {
                logEvent('worker_online', {
                    worker: worker.id,
                    address: worker.baseUrl,
                    slots: worker.slots.length
                });
            }
        } catch (error) {
            worker.online = false;
            worker.lastError = error.message;
            worker.slots = [];
            if (wasOnline) {
                logEvent('worker_offline', {
                    worker: worker.id,
                    address: worker.baseUrl,
                    error: error.message
                });
            }
        }
    }

    async function refreshWorkers() {
        await Promise.all(workers.map((worker) => refreshWorker(worker)));
    }

    function allSlots() {
        const result = [];
        for (const worker of workers) {
            for (const slot of worker.slots) {
                result.push({
                    ...slot,
                    workerId: worker.id,
                    key: slotKey(worker.id, slot.id)
                });
            }
        }
        return result;
    }

    function getSlot(workerId, slotId) {
        const worker = workersById.get(workerId);
        if (!worker) {
            return null;
        }
        const slot = worker.slots.find((candidate) => candidate.id === slotId);
        return slot
            ? {
                  ...slot,
                  workerId,
                  key: slotKey(workerId, slotId)
              }
            : null;
    }

    function slotIsLeased(slot) {
        return slotLeases.has(slotKey(slot.workerId, slot.id));
    }

    function slotCanServeNewClient(slot) {
        return (
            slot.ready === true &&
            slot.running === true &&
            Number(slot.playerCount) === 0 &&
            !slotIsLeased(slot)
        );
    }

    function slotCanStart(slot) {
        return (
            !slotIsLeased(slot) &&
            !slot.running &&
            (slot.status === 'stopped' || slot.status === 'failed')
        );
    }

    function withAllocationLock(operation) {
        const result = allocationTail.then(operation, operation);
        allocationTail = result.catch(() => undefined);
        return result;
    }

    function sessionMessage(session) {
        switch (session.status) {
            case 'allocating':
                return '正在分配 Pixel Streaming 服务，请稍候...';
            case 'starting':
                return '正在启动 Pixel Streaming 服务，请稍候...';
            case 'ready':
                return '服务已就绪，正在等待播放器连接。';
            case 'active':
                return '已连接到 Pixel Streaming 服务。';
            case 'disconnected': {
                const remainingSeconds = Math.max(
                    0,
                    Math.ceil(((session.reconnectDeadline || Date.now()) - Date.now()) / 1_000)
                );
                return `连接已断开，可在 ${remainingSeconds} 秒内重连。`;
            }
            case 'released':
                return 'Pixel Streaming 会话已结束。';
            case 'failed':
                return 'Pixel Streaming 服务启动失败，请重试。';
            case 'no_capacity':
                return '当前没有可用的 Pixel Streaming 实例，请稍后重试。';
            default:
                return '';
        }
    }

    function serializeSession(session, includeToken = false) {
        const response = {
            sessionId: session.id,
            status: session.status,
            message: sessionMessage(session),
            url: ['ready', 'active', 'disconnected'].includes(session.status)
                ? session.url
                : null,
            pollUrl: `/api/sessions/${session.id}`,
            workerId: session.workerId,
            slotId: session.slotId,
            createdAt: new Date(session.createdAt).toISOString(),
            readyAt: session.readyAt ? new Date(session.readyAt).toISOString() : null,
            disconnectedAt: session.disconnectedAt
                ? new Date(session.disconnectedAt).toISOString()
                : null,
            reconnectDeadline: session.reconnectDeadline
                ? new Date(session.reconnectDeadline).toISOString()
                : null,
            expiresAt: new Date(session.expiresAt).toISOString(),
            reason: session.reason || null,
            error: session.error || null
        };
        if (includeToken) {
            response.sessionToken = session.sessionToken;
        }
        return response;
    }

    function newSession(ttlSeconds, requestContext = {}) {
        const now = Date.now();
        const ttl = Number(ttlSeconds) || settings.defaultTtlSeconds;
        return {
            id: crypto.randomUUID(),
            sessionToken: crypto.randomBytes(32).toString('base64url'),
            status: 'allocating',
            workerId: null,
            slotId: null,
            url: null,
            clientAddress: requestContext.clientAddress || null,
            requestOrigin: requestContext.origin || null,
            createdAt: now,
            updatedAt: now,
            reservedAt: now,
            readyAt: null,
            expiresAt: now + ttl * 1_000,
            lastPlayerSeenAt: null,
            disconnectedAt: null,
            reconnectDeadline: null,
            releaseRequestedAt: null,
            reason: null,
            error: null,
            releasing: false
        };
    }

    function claimSlot(session, slot) {
        session.workerId = slot.workerId;
        session.slotId = slot.id;
        session.url = slot.publicUrl;
        session.updatedAt = Date.now();
        slotLeases.set(slotKey(slot.workerId, slot.id), session.id);
    }

    function releaseLease(session) {
        if (!session.workerId || !session.slotId) {
            return;
        }
        const key = slotKey(session.workerId, session.slotId);
        if (slotLeases.get(key) === session.id) {
            slotLeases.delete(key);
        }
    }

    async function startSessionSlot(session) {
        const worker = workersById.get(session.workerId);
        if (!worker) {
            session.error = 'Selected worker no longer exists.';
            setSessionStatus(session, 'failed', { reason: 'worker_missing' });
            releaseLease(session);
            return;
        }

        try {
            await workerRequest(
                worker,
                `/slots/${encodeURIComponent(session.slotId)}/start`,
                { method: 'POST' },
                settings.workerStartTimeoutMs
            );
            if (session.status === 'released') {
                return;
            }
            await refreshWorker(worker);
            const slot = getSlot(session.workerId, session.slotId);
            if (!slot || !slot.ready || !slot.running) {
                throw new Error('Worker reported that the slot did not become ready.');
            }
            session.readyAt = Date.now();
            setSessionStatus(session, 'ready', { reason: 'worker_ready' });
        } catch (error) {
            if (session.status !== 'released') {
                session.error = error.message;
                setSessionStatus(session, 'failed', { reason: 'worker_start_failed' });
            }
            releaseLease(session);
            try {
                await workerRequest(
                    worker,
                    `/slots/${encodeURIComponent(session.slotId)}/stop`,
                    { method: 'POST' },
                    settings.workerStopTimeoutMs
                );
            } catch {
                // A failed start already causes the agent to clean up local processes.
            }
        }
    }

    async function stopSessionSlot(session) {
        if (!settings.stopOnRelease || !session.workerId || !session.slotId) {
            releaseLease(session);
            return;
        }
        const worker = workersById.get(session.workerId);
        if (!worker) {
            releaseLease(session);
            return;
        }

        try {
            await workerRequest(
                worker,
                `/slots/${encodeURIComponent(session.slotId)}/stop`,
                { method: 'POST' },
                settings.workerStopTimeoutMs
            );
        } catch (error) {
            logger.warn(
                `[allocator] Failed to stop ${session.workerId}/${session.slotId}: ${error.message}`
            );
        } finally {
            releaseLease(session);
            await refreshWorker(worker);
        }
    }

    async function releaseSession(session, reason, stopSlot) {
        if (['released', 'failed'].includes(session.status) || session.releasing) {
            return;
        }
        session.releasing = true;
        session.reason = reason;
        session.releaseRequestedAt = Date.now();
        setSessionStatus(session, 'released', { reason });
        try {
            if (stopSlot) {
                await stopSessionSlot(session);
            } else {
                releaseLease(session);
            }
        } finally {
            session.releasing = false;
        }
    }

    async function createSession(ttlSeconds, idempotencyKey, requestContext = {}) {
        if (idempotencyKey && idempotencyKeys.has(idempotencyKey)) {
            const existing = sessions.get(idempotencyKeys.get(idempotencyKey));
            logEvent('session_request_reused', {
                session: existing?.id,
                client: requestContext.clientAddress
            });
            return existing;
        }

        const session = newSession(ttlSeconds, requestContext);
        sessions.set(session.id, session);
        logEvent('session_created', {
            session: session.id,
            client: session.clientAddress,
            origin: session.requestOrigin,
            ttlSeconds
        });
        if (idempotencyKey) {
            idempotencyKeys.set(idempotencyKey, session.id);
        }

        await refreshWorkers();
        const slots = allSlots();
        const available = slots.find(slotCanServeNewClient);
        if (available) {
            claimSlot(session, available);
            session.readyAt = Date.now();
            setSessionStatus(session, 'ready', { reason: 'hot_slot' });
            logEvent('slot_assigned', {
                session: session.id,
                client: session.clientAddress,
                worker: session.workerId,
                slot: session.slotId,
                mode: 'hot'
            });
            return session;
        }

        if (settings.autoStart) {
            const startable = slots.find(slotCanStart);
            if (startable) {
                claimSlot(session, startable);
                setSessionStatus(session, 'starting', { reason: 'cold_slot' });
                logEvent('slot_assigned', {
                    session: session.id,
                    client: session.clientAddress,
                    worker: session.workerId,
                    slot: session.slotId,
                    mode: 'cold'
                });
                setImmediate(() => void startSessionSlot(session));
                return session;
            }
        }

        session.reason = 'No free or startable Pixel Streaming slots are currently available.';
        setSessionStatus(session, 'no_capacity', { reason: 'capacity_exhausted' });
        logEvent('capacity_exhausted', {
            session: session.id,
            client: session.clientAddress
        });
        releaseLease(session);
        if (idempotencyKey) {
            idempotencyKeys.delete(idempotencyKey);
        }
        sessions.delete(session.id);
        return session;
    }

    async function reconcileSessions() {
        await refreshWorkers();
        const now = Date.now();

        for (const session of sessions.values()) {
            if (['released', 'failed', 'no_capacity'].includes(session.status)) {
                continue;
            }

            const slot = getSlot(session.workerId, session.slotId);
            if (!slot) {
                if (session.status === 'starting' && session.updatedAt + settings.workerStartTimeoutMs < now) {
                    session.error = 'Timed out waiting for the worker to report the slot.';
                    setSessionStatus(session, 'failed', { reason: 'worker_report_timeout' });
                    releaseLease(session);
                }
                continue;
            }

            if (session.status === 'starting') {
                if (slot.ready && slot.running) {
                    session.readyAt = now;
                    session.url = slot.publicUrl;
                    setSessionStatus(session, 'ready', { reason: 'slot_ready' });
                } else if (slot.status === 'failed') {
                    session.error = slot.lastError || 'Selected slot failed to start.';
                    setSessionStatus(session, 'failed', { reason: 'slot_failed' });
                    releaseLease(session);
                }
                continue;
            }

            if (session.status === 'ready') {
                if (Number(slot.playerCount) > 0) {
                    session.lastPlayerSeenAt = now;
                    session.disconnectedAt = null;
                    session.reconnectDeadline = null;
                    setSessionStatus(session, 'active', { reason: 'player_connected' });
                } else if (now - session.reservedAt > settings.connectTimeoutMs) {
                    await releaseSession(session, 'client_connect_timeout', true);
                }
                continue;
            }

            if (session.status === 'active') {
                if (Number(slot.playerCount) > 0) {
                    session.lastPlayerSeenAt = now;
                } else {
                    session.disconnectedAt = now;
                    session.reconnectDeadline = now + settings.idleReleaseMs;
                    setSessionStatus(session, 'disconnected', { reason: 'player_disconnected' });
                    logEvent('reconnect_window_started', {
                        session: session.id,
                        client: session.clientAddress,
                        deadline: new Date(session.reconnectDeadline).toISOString()
                    });
                }
                if (now >= session.expiresAt) {
                    await releaseSession(session, 'session_expired', true);
                }
                continue;
            }

            if (session.status === 'disconnected') {
                if (Number(slot.playerCount) > 0) {
                    session.lastPlayerSeenAt = now;
                    session.disconnectedAt = null;
                    session.reconnectDeadline = null;
                    setSessionStatus(session, 'active', { reason: 'player_reconnected' });
                    logEvent('session_reconnected', {
                        session: session.id,
                        client: session.clientAddress,
                        worker: session.workerId,
                        slot: session.slotId
                    });
                } else if (now >= session.expiresAt) {
                    await releaseSession(session, 'session_expired', true);
                } else if (now >= (session.reconnectDeadline || 0)) {
                    await releaseSession(session, 'reconnect_timeout', true);
                }
            }
        }

        for (const [sessionId, session] of sessions.entries()) {
            if (
                ['released', 'failed', 'no_capacity'].includes(session.status) &&
                now - session.updatedAt > settings.sessionRetentionMs
            ) {
                sessions.delete(sessionId);
            }
        }
    }

    async function poll() {
        try {
            await reconcileSessions();
        } catch (error) {
            logger.error(`[allocator] Poll failed: ${error.stack || error.message}`);
        }
    }

    function sendJson(response, statusCode, payload, extraHeaders = {}) {
        const body = JSON.stringify(payload);
        response.writeHead(statusCode, {
            ...response.getHeaders(),
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': Buffer.byteLength(body),
            'Cache-Control': 'no-store',
            ...extraHeaders
        });
        response.end(body);
    }

    async function readJsonBody(request) {
        const chunks = [];
        let length = 0;
        for await (const chunk of request) {
            length += chunk.length;
            if (length > 64 * 1024) {
                const error = new Error('Request body is too large.');
                error.statusCode = 413;
                throw error;
            }
            chunks.push(chunk);
        }
        if (length === 0) {
            return {};
        }
        try {
            return JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
            const error = new Error('Request body must be valid JSON.');
            error.statusCode = 400;
            throw error;
        }
    }

    function isAuthorized(request) {
        if (!apiKey) {
            return true;
        }
        const apiKeyHeader = request.headers['x-api-key'] || '';
        const authorization = request.headers.authorization || '';
        return (
            timingSafeEqual(apiKeyHeader, apiKey) ||
            timingSafeEqual(authorization, `Bearer ${apiKey}`)
        );
    }

    function applyCors(request, response) {
        const origin = request.headers.origin;
        if (!origin) {
            return true;
        }

        const allowedOrigins = settings.corsAllowedOrigins || [];
        const wildcard = allowedOrigins.includes('*');
        if (!wildcard && !allowedOrigins.includes(origin)) {
            return false;
        }

        response.setHeader('Access-Control-Allow-Origin', wildcard ? '*' : origin);
        response.setHeader('Vary', 'Origin');
        response.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
        response.setHeader(
            'Access-Control-Allow-Headers',
            'Content-Type, Authorization, X-API-Key, X-Session-Token, Idempotency-Key'
        );
        response.setHeader('Access-Control-Max-Age', '600');
        return true;
    }

    const server = http.createServer(async (request, response) => {
        try {
            const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
            const clientAddress = getClientAddress(request);

            if (!applyCors(request, response)) {
                sendJson(response, 403, { error: 'origin_not_allowed' });
                return;
            }

            if (request.method === 'OPTIONS') {
                response.writeHead(204, {
                    ...response.getHeaders(),
                    'Content-Length': '0'
                });
                response.end();
                return;
            }

            if (request.method === 'GET' && url.pathname === '/health') {
                sendJson(response, 200, {
                    ok: true,
                    onlineWorkers: workers.filter((worker) => worker.online).length,
                    workerCount: workers.length,
                    sessions: sessions.size,
                    time: new Date().toISOString()
                });
                return;
            }

            if (!isAuthorized(request)) {
                logger.warn(
                    `[allocator] ${new Date().toISOString()} event=auth_rejected client=${clientAddress} method=${request.method} path=${url.pathname}`
                );
                sendJson(response, 401, { error: 'unauthorized' });
                return;
            }

            if (request.method === 'GET' && url.pathname === '/api/slots') {
                await refreshWorkers();
                sendJson(response, 200, {
                    workers: workers.map((worker) => ({
                        id: worker.id,
                        online: worker.online,
                        lastSeenAt: worker.lastSeenAt,
                        lastError: worker.lastError
                    })),
                    slots: allSlots().map((slot) => ({
                        ...slot,
                        leasedTo: slotLeases.get(slot.key) || null
                    }))
                });
                return;
            }

            if (request.method === 'POST' && url.pathname === '/api/sessions') {
                const body = await readJsonBody(request);
                logEvent('client_session_request', {
                    client: clientAddress,
                    origin: request.headers.origin
                });
                const requestedTtl = Number(body.ttlSeconds) || settings.defaultTtlSeconds;
                const ttlSeconds = Math.max(
                    settings.minTtlSeconds,
                    Math.min(settings.maxTtlSeconds, requestedTtl)
                );
                const idempotencyKey = request.headers['idempotency-key'] || null;
                const session = await withAllocationLock(() =>
                    createSession(ttlSeconds, idempotencyKey, {
                        clientAddress,
                        origin: request.headers.origin || null
                    })
                );

                if (session.status === 'no_capacity') {
                    logEvent('client_session_rejected', {
                        client: clientAddress,
                        status: 'no_capacity'
                    });
                    sendJson(
                        response,
                        503,
                        {
                            error: session.reason,
                            message: sessionMessage(session),
                            retryAfterMs: 5_000
                        },
                        { 'Retry-After': '5' }
                    );
                    return;
                }

                const statusCode = session.status === 'ready' ? 201 : 202;
                sendJson(response, statusCode, serializeSession(session, true));
                return;
            }

            const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
            if (request.method === 'GET' && sessionMatch) {
                const session = sessions.get(decodeURIComponent(sessionMatch[1]));
                if (!session) {
                    sendJson(response, 404, { error: 'session_not_found' });
                    return;
                }
                const sessionToken = request.headers['x-session-token'] || '';
                if (!timingSafeEqual(sessionToken, session.sessionToken)) {
                    logEvent('session_auth_rejected', {
                        session: session.id,
                        client: clientAddress
                    });
                    sendJson(response, 401, { error: 'session_unauthorized' });
                    return;
                }
                sendJson(response, 200, serializeSession(session));
                return;
            }

            if (request.method === 'DELETE' && sessionMatch) {
                const session = sessions.get(decodeURIComponent(sessionMatch[1]));
                if (!session) {
                    sendJson(response, 404, { error: 'session_not_found' });
                    return;
                }
                const sessionToken = request.headers['x-session-token'] || '';
                if (!timingSafeEqual(sessionToken, session.sessionToken)) {
                    logEvent('session_auth_rejected', {
                        session: session.id,
                        client: clientAddress
                    });
                    sendJson(response, 401, { error: 'session_unauthorized' });
                    return;
                }
                logEvent('client_release_request', {
                    session: session.id,
                    client: clientAddress,
                    worker: session.workerId,
                    slot: session.slotId
                });
                if (!['released', 'failed', 'no_capacity'].includes(session.status)) {
                    await withAllocationLock(() => releaseSession(session, 'client_requested', true));
                }
                sendJson(response, 200, serializeSession(session));
                return;
            }

            sendJson(response, 404, { error: 'not_found' });
        } catch (error) {
            logger.error(`[allocator] HTTP ${request.method} ${request.url}: ${error.stack || error.message}`);
            sendJson(response, error.statusCode || 500, {
                error: error.message || 'internal_error'
            });
        }
    });

    async function close() {
        if (closed) {
            return;
        }
        closed = true;
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
        await new Promise((resolve) => {
            if (!server.listening) {
                resolve();
                return;
            }
            server.close(resolve);
        });
    }

    return {
        config: settings,
        server,
        sessions,
        workers,
        refreshWorkers,
        createSession,
        reconcileSessions,
        close,
        async listen() {
            await refreshWorkers();
            const address = await new Promise((resolve, reject) => {
                server.once('error', reject);
                server.listen(settings.listenPort, settings.listenHost, () => {
                    server.off('error', reject);
                    const listeningAddress = server.address();
                    logger.log(
                        `[allocator] Listening on ${listeningAddress.address}:${listeningAddress.port} with ${workers.length} worker(s)`
                    );
                    resolve(listeningAddress);
                });
            });
            pollTimer = setInterval(() => void poll(), settings.pollIntervalMs);
            pollTimer.unref();
            return address;
        }
    };
}

async function main() {
    const argumentsMap = parseArguments(process.argv.slice(2));
    const configFile = argumentsMap.config || path.join(__dirname, 'allocator.json');
    const loaded = loadAllocatorConfiguration(configFile);
    const allocator = createAllocator(loaded.config, { logger: console });
    if (loaded.workersFile) {
        console.log(`[allocator] Loaded workers from ${loaded.workersFile}`);
    }

    let shuttingDown = false;
    const shutdown = async () => {
        if (shuttingDown) {
            return;
        }
        shuttingDown = true;
        await allocator.close();
    };
    process.once('SIGINT', () => void shutdown());
    process.once('SIGTERM', () => void shutdown());
    await allocator.listen();
}

if (require.main === module) {
    main().catch((error) => {
        console.error(`Allocator failed: ${error.stack || error.message}`);
        process.exitCode = 1;
    });
}

module.exports = {
    createAllocator,
    loadAllocatorConfiguration,
    validateConfig
};
