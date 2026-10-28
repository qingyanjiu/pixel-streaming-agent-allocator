'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
    delay,
    ensureDirectory,
    fetchJson,
    getSecret,
    isPositiveInteger,
    loadJson,
    parseArguments,
    resolveFrom,
    timingSafeEqual,
    writeJsonAtomic
} = require('./common/runtime');

const DEFAULT_STARTUP_TIMEOUT_MS = 120_000;
const DEFAULT_SERVER_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_TIMEOUT_MS = 15_000;
const STATUS_POLL_INTERVAL_MS = 500;

function validateConfig(config) {
    if (!config.agentId || typeof config.agentId !== 'string') {
        throw new Error('agentId must be a non-empty string.');
    }
    if (!isPositiveInteger(config.listenPort)) {
        throw new Error('listenPort must be a positive integer.');
    }
    if (!Array.isArray(config.slots) || config.slots.length === 0) {
        throw new Error('At least one slot must be configured.');
    }

    const slotIds = new Set();
    const usedPorts = new Set();
    for (const slot of config.slots) {
        if (!slot.id || typeof slot.id !== 'string') {
            throw new Error('Every slot requires a non-empty id.');
        }
        if (slotIds.has(slot.id)) {
            throw new Error(`Duplicate slot id "${slot.id}".`);
        }
        slotIds.add(slot.id);

        for (const key of ['streamerPort', 'playerPort', 'sfuPort']) {
           if (!isPositiveInteger(slot[key])) {
                throw new Error(`Slot "${slot.id}" requires a positive ${key}.`);
            }
            if (usedPorts.has(slot[key])) {
                throw new Error(`Port ${slot[key]} is used by more than one slot or purpose.`);
            }
            usedPorts.add(slot[key]);
        }
        if (!slot.publicUrl || !/^https?:\/\//i.test(slot.publicUrl)) {
            throw new Error(`Slot "${slot.id}" requires an http(s) publicUrl.`);
        }
    }
    if (usedPorts.has(config.listenPort)) {
        throw new Error(`Agent listenPort ${config.listenPort} conflicts with a slot port.`);
    }
}

function expandArguments(argumentsList, slot, config) {
    const replacements = {
        slotId: slot.id,
        streamerPort: String(slot.streamerPort),
        playerPort: String(slot.playerPort),
        sfuPort: String(slot.sfuPort),
        projectName: config.projectName || ''
    };

    return (argumentsList || []).map((argument) =>
        String(argument).replace(/\$\{([A-Za-z0-9_]+)\}/g, (match, key) =>
            Object.prototype.hasOwnProperty.call(replacements, key) ? replacements[key] : match
        )
    );
}

function processIsRunning(child) {
    return !!child && child.exitCode === null && child.signalCode === null && !child.killed;
}

function childExitDescription(code, signal) {
    if (signal) {
        return `signal ${signal}`;
    }
    return `exit code ${code}`;
}

function resolveWorkerPaths(config, options = {}) {
    const configPath = options.configPath || path.join(process.cwd(), 'worker.json');
    const configDirectory = path.dirname(path.resolve(configPath));
    const workerDirectory =
        options.workerDirectory || path.resolve(__dirname);
    const legacyRoot = config.repoRoot
        ? resolveFrom(configDirectory, config.repoRoot)
        : configDirectory;
    const windowsDirectory = config.windowsDirectory
        ? resolveFrom(configDirectory, config.windowsDirectory)
        : legacyRoot;
    const webServersDirectory = config.webServersDirectory
        ? resolveFrom(configDirectory, config.webServersDirectory)
        : legacyRoot;
    const nodeValue = config.nodeExecutable || process.execPath;
    const nodeExecutable = path.isAbsolute(nodeValue)
        ? path.normalize(nodeValue)
        : resolveFrom(webServersDirectory, nodeValue);
    const signallingValue = config.signallingDirectory || 'SignallingWebServer';
    const signallingDirectory = path.isAbsolute(signallingValue)
        ? path.normalize(signallingValue)
        : resolveFrom(webServersDirectory, signallingValue);
    const gameValue = config.gameExecutable || 'UE_ANDA.exe';
    const gameExecutable = path.isAbsolute(gameValue)
        ? path.normalize(gameValue)
        : resolveFrom(windowsDirectory, gameValue);
    const gameWorkingDirectory = config.gameWorkingDirectory
        ? resolveFrom(windowsDirectory, config.gameWorkingDirectory)
        : windowsDirectory;
    const logsDirectory = config.logsDirectory
        ? resolveFrom(workerDirectory, config.logsDirectory)
        : path.join(workerDirectory, 'logs');
    const peerOptionsFile = config.peerOptionsFile
        ? resolveFrom(configDirectory, config.peerOptionsFile)
        : '';

    return {
        configDirectory,
        workerDirectory,
        windowsDirectory,
        webServersDirectory,
        nodeExecutable,
        signallingDirectory,
        gameExecutable,
        gameWorkingDirectory,
        logsDirectory,
        peerOptionsFile
    };
}

async function terminateProcessTree(child, timeoutMilliseconds) {
    if (!processIsRunning(child)) {
        return;
    }

    const pid = child.pid;
    if (!pid) {
        return;
    }

    await new Promise((resolve) => {
        let settled = false;
        let timeout = null;
        const finish = () => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeout);
            resolve();
        };
        timeout = setTimeout(finish, timeoutMilliseconds);
        child.once('exit', finish);

        if (process.platform === 'win32') {
            const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
                windowsHide: true,
                stdio: 'ignore'
            });
            const fallbackKill = () => {
                try {
                    child.kill();
                } catch {
                    finish();
                }
            };
            killer.once('error', fallbackKill);
            killer.once('exit', (code) => {
                if (code !== 0) {
                    fallbackKill();
                }
            });
        } else {
            try {
                process.kill(-pid, 'SIGTERM');
            } catch {
                try {
                    child.kill('SIGTERM');
                } catch {
                    finish();
                }
            }
        }
    });
}

function createWorkerAgent(config, options = {}) {
    validateConfig(config);

    const resolvedPaths = resolveWorkerPaths(config, options);
    const {
        nodeExecutable,
        signallingDirectory,
        gameExecutable,
        gameWorkingDirectory,
        logsDirectory,
        peerOptionsFile
    } = resolvedPaths;
    const runtimeStateFile = path.join(logsDirectory, `${config.agentId}.processes.json`);
    const authToken = getSecret(config.authToken, config.authTokenEnv);
    const startupTimeoutMs = config.startupTimeoutMs || DEFAULT_STARTUP_TIMEOUT_MS;
    const serverTimeoutMs = config.serverTimeoutMs || DEFAULT_SERVER_TIMEOUT_MS;
    const stopTimeoutMs = config.stopTimeoutMs || DEFAULT_STOP_TIMEOUT_MS;
    const localHost = config.localHost || '127.0.0.1';
    const logger = options.logger || console;

    function logSlotEvent(slot, event, fields = {}) {
        const details = Object.entries(fields)
            .filter(([, value]) => value !== undefined && value !== null && value !== '')
            .map(([key, value]) => `${key}=${String(value).replace(/\s+/g, '_')}`)
            .join(' ');
        logger.log(
            `[worker] ${new Date().toISOString()} event=${event} worker=${config.agentId} slot=${slot.config.id}${details ? ` ${details}` : ''}`
        );
    }

    function getClientAddress(request) {
        const forwarded = request.headers['x-forwarded-for'];
        if (typeof forwarded === 'string' && forwarded.trim()) {
            return forwarded.split(',')[0].trim();
        }
        return request.socket.remoteAddress || 'unknown';
    }

    if (!fs.existsSync(gameExecutable)) {
        logger.warn(`Game executable does not exist yet: ${gameExecutable}`);
    }
    if (!fs.existsSync(path.join(signallingDirectory, 'dist', 'index.js'))) {
        throw new Error(`Wilbur entry point not found under "${signallingDirectory}".`);
    }
    if (!authToken) {
        logger.warn('Worker authentication is disabled because no token is configured.');
    }

    ensureDirectory(logsDirectory);

    const slots = new Map();
    for (const configuredSlot of config.slots) {
        const slotLogDirectory = path.join(logsDirectory, config.agentId, configuredSlot.id);
        ensureDirectory(slotLogDirectory);
        slots.set(configuredSlot.id, {
            config: {
                ...configuredSlot,
                maxPlayers: configuredSlot.maxPlayers || config.maxPlayers || 1
            },
            status: 'stopped',
            ready: false,
            streamerCount: 0,
            playerCount: 0,
            wilburChild: null,
            ueChild: null,
            operation: null,
            intentionalStop: false,
            lastError: null,
            startedAt: null,
            lastStatusAt: null,
            logDirectory: slotLogDirectory
        });
    }

    function getSlot(slotId) {
        const slot = slots.get(slotId);
        if (!slot) {
            const error = new Error(`Unknown slot "${slotId}".`);
            error.statusCode = 404;
            throw error;
        }
        return slot;
    }

    function saveProcessState() {
        const state = {};
        for (const [slotId, slot] of slots.entries()) {
            state[slotId] = {
                status: slot.status,
                wilburPid: slot.wilburChild?.pid || null,
                uePid: slot.ueChild?.pid || null,
                startedAt: slot.startedAt,
                updatedAt: new Date().toISOString()
            };
        }
        writeJsonAtomic(runtimeStateFile, state);
    }

    function startLoggedProcess(command, argumentsList, workingDirectory, logName, kind, slot) {
        const logPath = path.join(logName);
        ensureDirectory(path.dirname(logPath));
        const output = fs.createWriteStream(logPath, { flags: 'a' });
        output.write(`\n[${new Date().toISOString()}] ${command} ${argumentsList.join(' ')}\n`);

        const child = spawn(command, argumentsList, {
            cwd: workingDirectory,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let stdoutBuffer = '';
        child.stdout.on('data', (chunk) => {
            output.write(chunk);
            if (kind !== 'wilbur') {
                return;
            }
            stdoutBuffer += chunk.toString();
            const lines = stdoutBuffer.split(/\r?\n/);
            stdoutBuffer = lines.pop() || '';
            for (const line of lines) {
                const cleanLine = line.replace(/\u001b\[[0-9;]*m/g, '').trim();
                if (
                    /New player connection|Player .* disconnected|New streamer connection|Streamer connected|Listening for streamer connections/.test(
                        cleanLine
                    )
                ) {
                    logger.log(
                        `[worker] ${new Date().toISOString()} event=wilbur_event worker=${config.agentId} slot=${slot.config.id} message="${cleanLine}"`
                    );
                }
            }
        });
        child.stderr.on('data', (chunk) => output.write(chunk));
        child.once('exit', () => output.end());
        return child;
    }

    async function waitForSpawn(child, label) {
        await new Promise((resolve, reject) => {
            const onSpawn = () => {
                cleanup();
                resolve();
            };
            const onError = (error) => {
                cleanup();
                reject(new Error(`${label} failed to start: ${error.message}`));
            };
            const cleanup = () => {
                child.off('spawn', onSpawn);
                child.off('error', onError);
            };
            child.once('spawn', onSpawn);
            child.once('error', onError);
        });
    }

    function attachExitHandler(slot, kind, child) {
        child.once('exit', (code, signal) => {
            if (kind === 'wilbur' && slot.wilburChild === child) {
                slot.wilburChild = null;
            }
            if (kind === 'ue' && slot.ueChild === child) {
                slot.ueChild = null;
            }

            if (!slot.intentionalStop) {
                slot.status = 'failed';
                slot.ready = false;
                slot.lastError = `${kind} exited unexpectedly (${childExitDescription(code, signal)}).`;
                logger.error(`[${config.agentId}/${slot.config.id}] ${slot.lastError}`);
            }
            saveProcessState();
        });
    }

    async function refreshSlot(slot) {
        if (!processIsRunning(slot.wilburChild)) {
            slot.ready = false;
            slot.streamerCount = 0;
            slot.playerCount = 0;
            if (!slot.intentionalStop && slot.status !== 'starting' && slot.status !== 'stopped') {
                slot.status = 'failed';
            }
            return;
        }

        try {
            const baseUrl = `http://${localHost}:${slot.config.playerPort}`;
            const [status, streamers] = await Promise.all([
                fetchJson(`${baseUrl}/api/status`, 3_000),
                fetchJson(`${baseUrl}/api/streamers`, 3_000)
            ]);
            const previousPlayerCount = slot.playerCount;
            const previousReady = slot.ready;
            slot.streamerCount = Number(status.streamer_count) || 0;
            slot.playerCount = Number(status.player_count) || 0;
            slot.ready = Array.isArray(streamers) && streamers.some((streamer) => streamer.streaming === true);
            slot.lastStatusAt = new Date().toISOString();
            if (!previousReady && slot.ready) {
                logSlotEvent(slot, 'streamer_ready', {
                    streamers: slot.streamerCount
                });
            }
            if (previousPlayerCount !== slot.playerCount) {
                logSlotEvent(
                    slot,
                    slot.playerCount > 0 ? 'player_connected' : 'player_disconnected',
                    {
                        previousPlayers: previousPlayerCount,
                        players: slot.playerCount
                    }
                );
            }
            if (slot.ready && processIsRunning(slot.ueChild)) {
                slot.status = 'ready';
            } else if (slot.status !== 'starting' && slot.status !== 'stopping') {
                slot.status = 'failed';
            }
        } catch (error) {
            slot.ready = false;
            if (slot.status !== 'starting' && slot.status !== 'stopping') {
                slot.lastError = error.message;
            }
        }
    }

    async function waitForWilburServer(slot) {
        const deadline = Date.now() + serverTimeoutMs;
        const baseUrl = `http://${localHost}:${slot.config.playerPort}`;
        while (Date.now() < deadline) {
            if (!processIsRunning(slot.wilburChild)) {
                throw new Error('Wilbur exited before becoming reachable.');
            }
            try {
                await fetchJson(`${baseUrl}/api/status`, 2_000);
                return;
            } catch {
                await delay(STATUS_POLL_INTERVAL_MS);
            }
        }
        throw new Error(`Wilbur did not become reachable within ${serverTimeoutMs} ms.`);
    }

    async function waitForStreamer(slot) {
        const deadline = Date.now() + startupTimeoutMs;
        while (Date.now() < deadline) {
            if (!processIsRunning(slot.ueChild)) {
                throw new Error('Unreal Engine exited before registering its streamer.');
            }
            await refreshSlot(slot);
            if (slot.ready) {
                return;
            }
            await delay(STATUS_POLL_INTERVAL_MS);
        }
        throw new Error(
            `Unreal Engine did not connect a streaming Pixel Streamer within ${startupTimeoutMs} ms. ` +
                `Check ${slot.logDirectory}.`
        );
    }

    async function stopProcesses(slot, finalStatus = 'stopped') {
        logSlotEvent(slot, 'slot_stopping', {
            finalStatus
        });
        slot.intentionalStop = true;
        slot.status = 'stopping';
        slot.ready = false;
        slot.lastError = slot.lastError || null;

        const ueChild = slot.ueChild;
        const wilburChild = slot.wilburChild;
        await terminateProcessTree(ueChild, stopTimeoutMs);
        await terminateProcessTree(wilburChild, stopTimeoutMs);

        if (slot.ueChild === ueChild) {
            slot.ueChild = null;
        }
        if (slot.wilburChild === wilburChild) {
            slot.wilburChild = null;
        }
        slot.status = finalStatus;
        slot.streamerCount = 0;
        slot.playerCount = 0;
        slot.startedAt = null;
        slot.intentionalStop = false;
        saveProcessState();
        logSlotEvent(slot, finalStatus === 'failed' ? 'slot_cleanup_failed' : 'slot_stopped', {
            finalStatus
        });
    }

    function buildWilburArguments(slot) {
        const argumentsList = [
            path.join(signallingDirectory, 'dist', 'index.js'),
            '--serve',
            '--rest_api',
            '--streamer_port',
            String(slot.config.streamerPort),
            '--player_port',
            String(slot.config.playerPort),
            '--sfu_port',
            String(slot.config.sfuPort),
            '--max_players',
            String(slot.config.maxPlayers),
            '--http_root',
            'www',
            '--log_folder',
            path.join(slot.logDirectory, 'wilbur-logs')
        ];

        if (peerOptionsFile) {
            argumentsList.push(
                '--peer_options_file',
                peerOptionsFile
            );
        }
        return argumentsList
            .concat(expandArguments(config.wilburExtraArgs || [], slot, config))
            .concat(expandArguments(slot.config.wilburArgs || [], slot, config));
    }

    function buildUeArguments(slot) {
        const argumentsList = expandArguments(config.ueArgs || [], slot, config);
        argumentsList.push(
            `-PixelStreamingURL=ws://${localHost}:${slot.config.streamerPort}`
        );
        return argumentsList.concat(expandArguments(slot.config.ueArgs || [], slot, config));
    }

    async function startSlotInternal(slot) {
        if (slot.ready && processIsRunning(slot.wilburChild) && processIsRunning(slot.ueChild)) {
            await refreshSlot(slot);
            return;
        }
        if (processIsRunning(slot.wilburChild) || processIsRunning(slot.ueChild)) {
            await stopProcesses(slot);
        }

        slot.lastError = null;
        slot.status = 'starting';
        slot.ready = false;
        slot.startedAt = new Date().toISOString();
        saveProcessState();
        logSlotEvent(slot, 'slot_starting', {
            streamerPort: slot.config.streamerPort,
            playerPort: slot.config.playerPort
        });

        try {
            const wilburArguments = buildWilburArguments(slot);
            logSlotEvent(slot, 'wilbur_starting');
            slot.wilburChild = startLoggedProcess(
                nodeExecutable,
                wilburArguments,
                signallingDirectory,
                path.join(slot.logDirectory, 'wilbur.log'),
                'wilbur',
                slot
            );
            attachExitHandler(slot, 'wilbur', slot.wilburChild);
            await waitForSpawn(slot.wilburChild, 'Wilbur');
            await waitForWilburServer(slot);
            logSlotEvent(slot, 'wilbur_ready', {
                pid: slot.wilburChild.pid
            });

            logSlotEvent(slot, 'ue_starting', {
                executable: gameExecutable
            });
            slot.ueChild = startLoggedProcess(
                gameExecutable,
                buildUeArguments(slot),
                gameWorkingDirectory,
                path.join(slot.logDirectory, 'ue.log'),
                'ue',
                slot
            );
            attachExitHandler(slot, 'ue', slot.ueChild);
            await waitForSpawn(slot.ueChild, 'Unreal Engine');
            logSlotEvent(slot, 'ue_process_started', {
                pid: slot.ueChild.pid
            });
            await waitForStreamer(slot);
            slot.status = 'ready';
            saveProcessState();
            logSlotEvent(slot, 'slot_ready');
        } catch (error) {
            slot.lastError = error.message;
            logger.error(`[${config.agentId}/${slot.config.id}] ${error.message}`);
            logSlotEvent(slot, 'slot_start_failed', {
                error: error.message
            });
            await stopProcesses(slot, 'failed');
            throw error;
        }
    }

    async function startSlot(slotId) {
        const slot = getSlot(slotId);
        if (slot.operation) {
            return slot.operation;
        }

        slot.operation = startSlotInternal(slot).finally(() => {
            slot.operation = null;
        });
        return slot.operation;
    }

    async function stopSlot(slotId) {
        const slot = getSlot(slotId);
        if (slot.operation) {
            try {
                await slot.operation;
            } catch {
                // A failed start has already cleaned up its child processes.
            }
        }
        if (!processIsRunning(slot.ueChild) && !processIsRunning(slot.wilburChild)) {
            slot.status = 'stopped';
            slot.ready = false;
            slot.streamerCount = 0;
            slot.playerCount = 0;
            saveProcessState();
            return;
        }
        await stopProcesses(slot);
    }

    function serializeSlot(slot) {
        return {
            id: slot.config.id,
            agentId: config.agentId,
            status: slot.status,
            ready: slot.ready,
            running: processIsRunning(slot.wilburChild) && processIsRunning(slot.ueChild),
            streamerCount: slot.streamerCount,
            playerCount: slot.playerCount,
            capacity: slot.config.maxPlayers,
            publicUrl: slot.config.publicUrl,
            ports: {
                streamer: slot.config.streamerPort,
                player: slot.config.playerPort,
                sfu: slot.config.sfuPort
            },
            pids: {
                wilbur: slot.wilburChild?.pid || null,
                ue: slot.ueChild?.pid || null
            },
            lastError: slot.lastError,
            startedAt: slot.startedAt,
            lastStatusAt: slot.lastStatusAt
        };
    }

    function sendJson(response, statusCode, payload) {
        const body = JSON.stringify(payload);
        response.writeHead(statusCode, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': Buffer.byteLength(body),
            'Cache-Control': 'no-store'
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
        if (!authToken) {
            return true;
        }
        const header = request.headers.authorization || '';
        return timingSafeEqual(header, `Bearer ${authToken}`);
    }

    const server = http.createServer(async (request, response) => {
        try {
            const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

            if (request.method === 'GET' && url.pathname === '/health') {
                sendJson(response, 200, {
                    ok: true,
                    agentId: config.agentId,
                    slotCount: slots.size,
                    time: new Date().toISOString()
                });
                return;
            }

            if (!isAuthorized(request)) {
                logger.warn(
                    `[worker] ${new Date().toISOString()} event=auth_rejected worker=${config.agentId} client=${getClientAddress(request)} method=${request.method} path=${url.pathname}`
                );
                sendJson(response, 401, { error: 'unauthorized' });
                return;
            }

            if (request.method === 'GET' && url.pathname === '/slots') {
                await Promise.all(Array.from(slots.values(), (slot) => refreshSlot(slot)));
                sendJson(response, 200, {
                    agentId: config.agentId,
                    slots: Array.from(slots.values(), serializeSlot)
                });
                return;
            }

            const startMatch = url.pathname.match(/^\/slots\/([^/]+)\/start$/);
            if (request.method === 'POST' && startMatch) {
                const slotId = decodeURIComponent(startMatch[1]);
                logger.log(
                    `[worker] ${new Date().toISOString()} event=slot_start_request worker=${config.agentId} slot=${slotId} client=${getClientAddress(request)}`
                );
                await startSlot(slotId);
                const slot = getSlot(slotId);
                await refreshSlot(slot);
                sendJson(response, 200, serializeSlot(slot));
                return;
            }

            const stopMatch = url.pathname.match(/^\/slots\/([^/]+)\/stop$/);
            if ((request.method === 'POST' || request.method === 'DELETE') && stopMatch) {
                const slotId = decodeURIComponent(stopMatch[1]);
                logger.log(
                    `[worker] ${new Date().toISOString()} event=slot_stop_request worker=${config.agentId} slot=${slotId} client=${getClientAddress(request)}`
                );
                await stopSlot(slotId);
                sendJson(response, 200, serializeSlot(getSlot(slotId)));
                return;
            }

            const slotMatch = url.pathname.match(/^\/slots\/([^/]+)$/);
            if (request.method === 'GET' && slotMatch) {
                const slot = getSlot(decodeURIComponent(slotMatch[1]));
                await refreshSlot(slot);
                sendJson(response, 200, serializeSlot(slot));
                return;
            }

            if (request.method === 'POST' && url.pathname === '/shutdown') {
                await readJsonBody(request);
                logger.log(
                    `[worker] ${new Date().toISOString()} event=shutdown_request worker=${config.agentId} client=${getClientAddress(request)}`
                );
                sendJson(response, 202, { accepted: true });
                setImmediate(() => void close(true));
                return;
            }

            sendJson(response, 404, { error: 'not_found' });
        } catch (error) {
            logger.error(`[${config.agentId}] HTTP ${request.method} ${request.url}: ${error.stack || error.message}`);
            sendJson(response, error.statusCode || 500, {
                error: error.message || 'internal_error'
            });
        }
    });

    let closing = false;
    async function close(stopAll = false) {
        if (closing) {
            return;
        }
        closing = true;
        if (stopAll) {
            await Promise.all(
                Array.from(slots.keys(), async (slotId) => {
                    try {
                        await stopSlot(slotId);
                    } catch (error) {
                        logger.error(`[${config.agentId}/${slotId}] Failed to stop during shutdown: ${error.message}`);
                    }
                })
            );
        }
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
        agentId: config.agentId,
        config,
        paths: resolvedPaths,
        server,
        slots,
        startSlot,
        stopSlot,
        refreshSlot,
        close,
        listen() {
            return new Promise((resolve, reject) => {
                server.once('error', reject);
                server.listen(config.listenPort, config.listenHost || '0.0.0.0', () => {
                    server.off('error', reject);
                    const address = server.address();
                    logger.log(
                        `[${config.agentId}] Worker Agent listening on ${address.address}:${address.port}`
                    );
                    resolve(address);
                });
            });
        }
    };
}

async function main() {
    const argumentsMap = parseArguments(process.argv.slice(2));
    const configFile = argumentsMap.config;
    if (!configFile) {
        throw new Error(
            'Missing --config. Use start-worker.bat <worker-config.json> or pass --config <worker-config.json>.'
        );
    }
    const loaded = loadJson(configFile);
    const agent = createWorkerAgent(loaded.config, {
        configPath: loaded.path,
        logger: console
    });

    let shuttingDown = false;
    const shutdown = async () => {
        if (shuttingDown) {
            return;
        }
        shuttingDown = true;
        console.log(`[${agent.agentId}] Shutting down and stopping managed slots...`);
        try {
            await agent.close(true);
            process.exitCode = 0;
        } catch (error) {
            console.error(error);
            process.exitCode = 1;
        }
    };

    process.once('SIGINT', () => void shutdown());
    process.once('SIGTERM', () => void shutdown());

    await agent.listen();
}

if (require.main === module) {
    main().catch((error) => {
        console.error(`Worker Agent failed: ${error.stack || error.message}`);
        process.exitCode = 1;
    });
}

module.exports = {
    createWorkerAgent,
    resolveWorkerPaths,
    validateConfig
};
