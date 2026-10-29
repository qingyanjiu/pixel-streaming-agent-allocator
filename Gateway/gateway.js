'use strict';

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const {
    fetchJson,
    getSecret,
    isPositiveInteger,
    loadJson,
    parseArguments,
    resolveFrom,
    timingSafeEqual
} = require('./common/runtime');

const DEFAULTS = {
    listenHost: '0.0.0.0',
    listenPort: 9300,
    upstreamHost: '127.0.0.1',
    validateTimeoutMs: 3_000,
    upstreamTimeoutMs: 30_000,
    allocatorRequestTimeoutMs: 5_000
};

const TICKET_PATTERN = /^\/play\/([A-Za-z0-9_-]{32,128})(?:\/(.*))?$/;
const HOP_BY_HOP_HEADERS = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade'
]);

function loadGatewayConfiguration(configPath) {
    const loaded = loadJson(configPath);
    const configDirectory = path.dirname(loaded.path);
    const config = { ...loaded.config };
    config.configDirectory = configDirectory;
    config.workerConfigFile = resolveFrom(configDirectory, config.workerConfigFile);
    config.allocatorTokenFile = resolveFrom(configDirectory, config.allocatorTokenFile);
    config.tlsKeyFile = resolveFrom(configDirectory, config.tlsKeyFile);
    config.tlsCertFile = resolveFrom(configDirectory, config.tlsCertFile);

    const workerConfig = loadJson(config.workerConfigFile).config;
    validateConfig(config, workerConfig);
    return {
        config,
        workerConfig,
        path: loaded.path,
        workerConfigPath: config.workerConfigFile
    };
}

function validateWorkerConfig(workerConfig) {
    if (!workerConfig.agentId || typeof workerConfig.agentId !== 'string') {
        throw new Error('Worker config requires a non-empty agentId.');
    }
    if (!Array.isArray(workerConfig.slots) || workerConfig.slots.length === 0) {
        throw new Error('Worker config requires at least one Slot.');
    }

    const slotIds = new Set();
    const playerPorts = new Set();
    for (const slot of workerConfig.slots) {
        if (!slot.id || typeof slot.id !== 'string') {
            throw new Error('Every Worker Slot requires a non-empty id.');
        }
        if (slotIds.has(slot.id)) {
            throw new Error(`Duplicate Slot id "${slot.id}" in Worker config.`);
        }
        slotIds.add(slot.id);
        if (!isPositiveInteger(slot.playerPort)) {
            throw new Error(`Slot "${slot.id}" requires a positive playerPort.`);
        }
        if (playerPorts.has(slot.playerPort)) {
            throw new Error(`Player port ${slot.playerPort} is used by more than one Slot.`);
        }
        playerPorts.add(slot.playerPort);
    }
}

function isLoopbackHost(hostname) {
    return ['127.0.0.1', 'localhost', '::1'].includes(String(hostname).toLowerCase());
}

function validateConfig(config, workerConfig) {
    if (!Number.isInteger(config.listenPort) || config.listenPort < 0) {
        throw new Error('listenPort must be a non-negative integer.');
    }
    if (!config.workerConfigFile) {
        throw new Error('workerConfigFile is required.');
    }
    if (!config.allocatorUrl || !/^https?:\/\//i.test(config.allocatorUrl)) {
        throw new Error('allocatorUrl must be an http(s) URL.');
    }
    if (!isLoopbackHost(config.upstreamHost || DEFAULTS.upstreamHost)) {
        throw new Error('upstreamHost must be a loopback address.');
    }
    if (!!config.tlsKeyFile !== !!config.tlsCertFile) {
        throw new Error('tlsKeyFile and tlsCertFile must be configured together.');
    }
    validateWorkerConfig(workerConfig);
}

function parsePlayPath(pathname) {
    const match = pathname.match(TICKET_PATTERN);
    if (!match) {
        return null;
    }
    return {
        ticket: match[1],
        relativePath: `/${match[2] || ''}`
    };
}

function sendJson(response, statusCode, payload, extraHeaders = {}) {
    const body = JSON.stringify(payload);
    response.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        ...extraHeaders
    });
    response.end(body);
}

function sendSocketResponse(socket, statusCode, reason, extraHeaders = {}) {
    if (!socket || socket.destroyed) {
        return;
    }
    const headers = {
        Connection: 'close',
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        ...extraHeaders
    };
    const lines = [`HTTP/1.1 ${statusCode} ${reason}`];
    for (const [name, value] of Object.entries(headers)) {
        lines.push(`${name}: ${value}`);
    }
    const body = `${reason}\n`;
    lines.push(`Content-Length: ${Buffer.byteLength(body)}`, '', body);
    socket.end(lines.join('\r\n'));
}

function createGateway(config, workerConfig, options = {}) {
    validateConfig(config, workerConfig);
    const settings = { ...DEFAULTS, ...config };
    const logger = options.logger || console;
    const allocatorUrl = settings.allocatorUrl.replace(/\/+$/, '');
    const allocatorToken = getSecret(
        settings.allocatorToken,
        settings.allocatorTokenEnv,
        settings.allocatorTokenFile
    );
    if (!allocatorToken) {
        throw new Error('An Allocator Gateway token is required.');
    }

    const slots = new Map(
        workerConfig.slots.map((slot) => [
            slot.id,
            {
                id: slot.id,
                playerPort: slot.playerPort
            }
        ])
    );
    const sockets = new Set();
    let closed = false;

    function logEvent(event, fields = {}) {
        const details = Object.entries(fields)
            .filter(([, value]) => value !== undefined && value !== null && value !== '')
            .map(([key, value]) => `${key}=${String(value).replace(/\s+/g, '_')}`)
            .join(' ');
        logger.log(
            `[gateway] ${new Date().toISOString()} event=${event}${details ? ` ${details}` : ''}`
        );
    }

    function getClientAddress(request) {
        return request.socket.remoteAddress || 'unknown';
    }

    function safeRequestPath(rawUrl) {
        try {
            const url = new URL(rawUrl, 'http://gateway.local');
            const route = parsePlayPath(url.pathname);
            return route ? `/play/<ticket>${route.relativePath}` : url.pathname;
        } catch {
            return '<invalid-url>';
        }
    }

    async function validateTicket(ticket, clientAddress, route) {
        try {
            const result = await fetchJson(
                `${allocatorUrl}/api/gateway/validate`,
                settings.allocatorRequestTimeoutMs,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Gateway-Token': allocatorToken
                    },
                    body: JSON.stringify({ ticket })
                }
            );
            if (!result || result.valid !== true) {
                logEvent('ticket_rejected', {
                    client: clientAddress,
                    route,
                    reason: result?.reason || 'invalid_ticket'
                });
                return null;
            }
            if (result.workerId !== workerConfig.agentId) {
                logEvent('ticket_rejected', {
                    client: clientAddress,
                    route,
                    session: result.sessionId,
                    reason: 'worker_mismatch',
                    expectedWorker: workerConfig.agentId,
                    actualWorker: result.workerId
                });
                return null;
            }
            const slot = slots.get(result.slotId);
            if (!slot) {
                logEvent('ticket_rejected', {
                    client: clientAddress,
                    route,
                    session: result.sessionId,
                    reason: 'slot_not_local',
                    slot: result.slotId
                });
                return null;
            }
            return {
                ...result,
                slot
            };
        } catch (error) {
            logEvent('allocator_validation_failed', {
                client: clientAddress,
                route,
                error: error.message
            });
            const validationError = new Error('Allocator validation is unavailable.');
            validationError.statusCode = 503;
            throw validationError;
        }
    }

    function forwardedHeaders(request, upstreamPort, includeUpgrade = false) {
        const headers = {};
        for (const [name, value] of Object.entries(request.headers)) {
            if (!includeUpgrade && HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
                continue;
            }
            if (['host', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto'].includes(name)) {
                continue;
            }
            headers[name] = value;
        }
        headers.host = `${settings.upstreamHost}:${upstreamPort}`;
        headers['x-forwarded-for'] = getClientAddress(request);
        headers['x-forwarded-host'] = request.headers.host || '';
        headers['x-forwarded-proto'] = request.socket.encrypted ? 'https' : 'http';
        if (includeUpgrade) {
            headers.connection = 'Upgrade';
            headers.upgrade = 'websocket';
        }
        return headers;
    }

    function proxyHttp(request, response, ticket, relativePath, validation) {
        const upstreamPort = validation.slot.playerPort;
        const requestPath = `${relativePath}${request.url.includes('?') ? request.url.slice(request.url.indexOf('?')) : ''}`;
        let settled = false;

        const upstreamRequest = http.request(
            {
                host: settings.upstreamHost,
                port: upstreamPort,
                method: request.method,
                path: requestPath,
                headers: forwardedHeaders(request, upstreamPort)
            },
            (upstreamResponse) => {
                settled = true;
                const responseHeaders = { ...upstreamResponse.headers };
                if (
                    responseHeaders.location &&
                    responseHeaders.location.startsWith('/')
                ) {
                    responseHeaders.location = `/play/${ticket}${responseHeaders.location}`;
                }
                response.writeHead(upstreamResponse.statusCode || 502, responseHeaders);
                upstreamResponse.pipe(response);
            }
        );

        upstreamRequest.setTimeout(settings.upstreamTimeoutMs, () => {
            upstreamRequest.destroy(new Error('Local Wilbur request timed out.'));
        });
        upstreamRequest.once('error', (error) => {
            if (settled || response.headersSent) {
                response.destroy(error);
                return;
            }
            logEvent('upstream_http_failed', {
                client: getClientAddress(request),
                session: validation.sessionId,
                slot: validation.slot.id,
                error: error.message
            });
            sendJson(response, 502, {
                error: 'pixel_stream_upstream_unavailable'
            });
        });
        request.once('aborted', () => upstreamRequest.destroy());
        request.pipe(upstreamRequest);
    }

    async function handleHttp(request, response) {
        const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
        const clientAddress = getClientAddress(request);

        if (request.method === 'GET' && url.pathname === '/health') {
            sendJson(response, 200, {
                ok: true,
                agentId: workerConfig.agentId,
                slots: Array.from(slots.keys()),
                time: new Date().toISOString()
            });
            return;
        }

        if (request.method === 'POST' && url.pathname === '/shutdown') {
            if (!timingSafeEqual(request.headers['x-gateway-token'] || '', allocatorToken)) {
                sendJson(response, 401, { error: 'unauthorized' });
                return;
            }
            sendJson(response, 202, { accepted: true });
            setImmediate(() => void close());
            return;
        }

        const playRoute = parsePlayPath(url.pathname);
        if (!playRoute) {
            sendJson(response, 404, { error: 'not_found' });
            return;
        }
        if (!['GET', 'HEAD'].includes(request.method)) {
            sendJson(response, 405, { error: 'method_not_allowed' }, { Allow: 'GET, HEAD' });
            return;
        }
        if (url.pathname === `/play/${playRoute.ticket}`) {
            response.writeHead(308, {
                Location: `/play/${playRoute.ticket}/${url.search}`,
                'Cache-Control': 'no-store',
                'Content-Length': '0'
            });
            response.end();
            return;
        }
        if (playRoute.relativePath === '/ws') {
            sendJson(response, 426, { error: 'websocket_upgrade_required' });
            return;
        }

        const validation = await validateTicket(
            playRoute.ticket,
            clientAddress,
            playRoute.relativePath
        );
        if (!validation) {
            sendJson(response, 403, { error: 'invalid_or_expired_play_ticket' });
            return;
        }

        logEvent('http_request', {
            client: clientAddress,
            session: validation.sessionId,
            worker: validation.workerId,
            slot: validation.slotId,
            path: playRoute.relativePath
        });
        proxyHttp(request, response, playRoute.ticket, playRoute.relativePath, validation);
    }

    async function handleUpgrade(request, socket, head) {
        socket.on('error', () => undefined);
        let url;
        try {
            url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
        } catch {
            sendSocketResponse(socket, 400, 'Bad Request');
            return;
        }

        const playRoute = parsePlayPath(url.pathname);
        if (!playRoute || playRoute.relativePath !== '/ws') {
            sendSocketResponse(socket, 404, 'Not Found');
            return;
        }

        let validation;
        try {
            validation = await validateTicket(
                playRoute.ticket,
                getClientAddress(request),
                playRoute.relativePath
            );
        } catch (error) {
            sendSocketResponse(socket, error.statusCode || 503, 'Service Unavailable');
            return;
        }
        if (!validation) {
            sendSocketResponse(socket, 403, 'Forbidden');
            return;
        }
        if (socket.destroyed) {
            return;
        }

        const upstreamPort = validation.slot.playerPort;
        const upstreamRequest = http.request({
            host: settings.upstreamHost,
            port: upstreamPort,
            method: 'GET',
            path: '/',
            headers: forwardedHeaders(request, upstreamPort, true)
        });
        let upgraded = false;
        const upgradeTimeout = setTimeout(() => {
            upstreamRequest.destroy(new Error('Local Wilbur WebSocket request timed out.'));
        }, settings.upstreamTimeoutMs);
        upgradeTimeout.unref();
        upstreamRequest.once('upgrade', (upstreamResponse, upstreamSocket, upstreamHead) => {
            clearTimeout(upgradeTimeout);
            upgraded = true;
            sockets.add(socket);
            sockets.add(upstreamSocket);
            logEvent('websocket_connected', {
                client: getClientAddress(request),
                session: validation.sessionId,
                worker: validation.workerId,
                slot: validation.slotId,
                upstreamPort
            });

            const lines = [
                `HTTP/1.1 ${upstreamResponse.statusCode || 101} ${upstreamResponse.statusMessage || 'Switching Protocols'}`
            ];
            for (let index = 0; index < upstreamResponse.rawHeaders.length; index += 2) {
                lines.push(
                    `${upstreamResponse.rawHeaders[index]}: ${upstreamResponse.rawHeaders[index + 1]}`
                );
            }
            lines.push('', '');
            socket.write(lines.join('\r\n'));
            if (upstreamHead.length > 0) {
                socket.write(upstreamHead);
            }
            if (head.length > 0) {
                upstreamSocket.write(head);
            }

            socket.pipe(upstreamSocket);
            upstreamSocket.pipe(socket);
            const cleanup = () => {
                sockets.delete(socket);
                sockets.delete(upstreamSocket);
                if (!socket.destroyed) {
                    socket.destroy();
                }
                if (!upstreamSocket.destroyed) {
                    upstreamSocket.destroy();
                }
            };
            socket.once('close', cleanup);
            upstreamSocket.once('close', cleanup);
            socket.once('error', cleanup);
            upstreamSocket.once('error', cleanup);
        });
        upstreamRequest.once('response', (upstreamResponse) => {
            clearTimeout(upgradeTimeout);
            if (upgraded) {
                return;
            }
            upstreamResponse.resume();
            sendSocketResponse(socket, 502, 'Upstream Rejected WebSocket Upgrade');
        });
        upstreamRequest.once('error', (error) => {
            clearTimeout(upgradeTimeout);
            if (upgraded || socket.destroyed) {
                return;
            }
            logEvent('upstream_websocket_failed', {
                client: getClientAddress(request),
                session: validation.sessionId,
                slot: validation.slotId,
                error: error.message
            });
            sendSocketResponse(socket, 502, 'Bad Gateway');
        });
        upstreamRequest.end();
    }

    let server;
    if (settings.tlsKeyFile && settings.tlsCertFile) {
        server = https.createServer(
            {
                key: fs.readFileSync(settings.tlsKeyFile),
                cert: fs.readFileSync(settings.tlsCertFile)
            },
            (request, response) => {
                void handleHttp(request, response).catch((error) => {
                    logger.error(
                        `[gateway] HTTP ${request.method} ${safeRequestPath(request.url)}: ${error.stack || error.message}`
                    );
                    if (!response.headersSent) {
                        sendJson(response, error.statusCode || 500, {
                            error: error.message || 'internal_error'
                        });
                    } else {
                        response.destroy(error);
                    }
                });
            }
        );
    } else {
        server = http.createServer((request, response) => {
            void handleHttp(request, response).catch((error) => {
                logger.error(
                    `[gateway] HTTP ${request.method} ${safeRequestPath(request.url)}: ${error.stack || error.message}`
                );
                if (!response.headersSent) {
                    sendJson(response, error.statusCode || 500, {
                        error: error.message || 'internal_error'
                    });
                } else {
                    response.destroy(error);
                }
            });
        });
    }
    server.on('upgrade', (request, socket, head) => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
        void handleUpgrade(request, socket, head).catch((error) => {
            logger.error(
                `[gateway] WebSocket ${safeRequestPath(request.url)}: ${error.stack || error.message}`
            );
            sendSocketResponse(socket, 500, 'Internal Server Error');
        });
    });

    async function close() {
        if (closed) {
            return;
        }
        closed = true;
        for (const socket of sockets) {
            socket.destroy();
        }
        sockets.clear();
        await new Promise((resolve) => {
            if (!server.listening) {
                resolve();
                return;
            }
            server.close(resolve);
            if (typeof server.closeAllConnections === 'function') {
                server.closeAllConnections();
            }
        });
    }

    return {
        config: settings,
        workerConfig,
        server,
        slots,
        close,
        listen() {
            return new Promise((resolve, reject) => {
                server.once('error', reject);
                server.listen(settings.listenPort, settings.listenHost, () => {
                    server.off('error', reject);
                    const address = server.address();
                    const protocol = settings.tlsKeyFile ? 'https' : 'http';
                    logger.log(
                        `[gateway] ${workerConfig.agentId} listening on ${protocol}://${address.address}:${address.port}`
                    );
                    resolve(address);
                });
            });
        }
    };
}

async function main() {
    const argumentsMap = parseArguments(process.argv.slice(2));
    const configFile = argumentsMap.config || path.join(__dirname, 'gateway.json');
    const loaded = loadGatewayConfiguration(configFile);
    const gateway = createGateway(loaded.config, loaded.workerConfig, { logger: console });
    console.log(`[gateway] Worker config: ${loaded.workerConfigPath}`);

    let shuttingDown = false;
    const shutdown = async () => {
        if (shuttingDown) {
            return;
        }
        shuttingDown = true;
        await gateway.close();
    };
    process.once('SIGINT', () => void shutdown());
    process.once('SIGTERM', () => void shutdown());
    await gateway.listen();
}

if (require.main === module) {
    main().catch((error) => {
        console.error(`Gateway failed: ${error.stack || error.message}`);
        process.exitCode = 1;
    });
}

module.exports = {
    createGateway,
    loadGatewayConfiguration,
    parsePlayPath,
    validateConfig,
    validateWorkerConfig
};
