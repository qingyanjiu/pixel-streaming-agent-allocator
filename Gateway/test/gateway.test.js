'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
    createGateway,
    loadGatewayConfiguration,
    parsePlayPath,
    validateConfig,
    validateWorkerConfig
} = require('../gateway');

async function listen(server) {
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    return server.address().port;
}

async function closeServer(server) {
    if (typeof server.closeAllWebSockets === 'function') {
        server.closeAllWebSockets();
    }
    if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
    }
    await new Promise((resolve) => server.close(resolve));
}

function createSilentLogger() {
    return {
        log() {},
        warn() {},
        error() {}
    };
}

function createFakeAllocator() {
    const tickets = new Map();
    const server = http.createServer(async (request, response) => {
        if (
            request.method !== 'POST' ||
            request.url !== '/api/gateway/validate' ||
            request.headers['x-gateway-token'] !== 'gateway-token'
        ) {
            response.writeHead(401, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ error: 'unauthorized' }));
            return;
        }

        const chunks = [];
        for await (const chunk of request) {
            chunks.push(chunk);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const assignment = tickets.get(body.ticket);
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(
            JSON.stringify(
                assignment
                    ? {
                          valid: true,
                          sessionId: assignment.sessionId,
                          workerId: assignment.workerId,
                          slotId: assignment.slotId,
                          status: 'ready'
                      }
                    : {
                          valid: false,
                          reason: 'invalid_or_inactive_session'
                      }
            )
        );
    });
    return { server, tickets };
}

function createFakeWilbur() {
    const websocketSockets = new Set();
    const server = http.createServer((request, response) => {
        if (request.url.startsWith('/')) {
            const body =
                request.url === '/player.js'
                    ? 'window.fakePixelStreaming = true;'
                    : '<html><body>fake player</body></html>';
            response.writeHead(200, {
                'Content-Type':
                    request.url === '/player.js'
                        ? 'text/javascript; charset=utf-8'
                        : 'text/html; charset=utf-8',
                'Content-Length': Buffer.byteLength(body)
            });
            response.end(body);
            return;
        }
        response.writeHead(404);
        response.end();
    });
    server.on('upgrade', (request, socket) => {
        websocketSockets.add(socket);
        socket.once('close', () => websocketSockets.delete(socket));
        const accept = crypto
            .createHash('sha1')
            .update(
                `${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`
            )
            .digest('base64');
        socket.write(
            [
                'HTTP/1.1 101 Switching Protocols',
                'Upgrade: websocket',
                'Connection: Upgrade',
                `Sec-WebSocket-Accept: ${accept}`,
                '',
                ''
            ].join('\r\n')
        );
    });
    server.closeAllWebSockets = () => {
        for (const socket of websocketSockets) {
            socket.destroy();
        }
        websocketSockets.clear();
    };
    return server;
}

function requestWebSocket(port, requestPath) {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: '127.0.0.1', port });
        let response = '';
        const timeout = setTimeout(() => {
            socket.destroy();
            reject(new Error('Timed out waiting for WebSocket upgrade.'));
        }, 3_000);
        socket.once('error', (error) => {
            clearTimeout(timeout);
            reject(error);
        });
        socket.on('data', (chunk) => {
            response += chunk.toString('utf8');
            if (response.includes('\r\n\r\n')) {
                clearTimeout(timeout);
                socket.destroy();
                resolve(response);
            }
        });
        socket.once('connect', () => {
            const key = crypto.randomBytes(16).toString('base64');
            socket.write(
                [
                    `GET ${requestPath} HTTP/1.1`,
                    'Host: 127.0.0.1',
                    'Upgrade: websocket',
                    'Connection: Upgrade',
                    `Sec-WebSocket-Key: ${key}`,
                    'Sec-WebSocket-Version: 13',
                    '',
                    ''
                ].join('\r\n')
            );
        });
    });
}

test('Gateway parses only the protected play route shape', () => {
    const ticket = 'a'.repeat(43);
    assert.deepEqual(parsePlayPath(`/play/${ticket}/player.js`), {
        ticket,
        relativePath: '/player.js'
    });
    assert.deepEqual(parsePlayPath(`/play/${ticket}/ws`), {
        ticket,
        relativePath: '/ws'
    });
    assert.equal(parsePlayPath('/player.js'), null);
    assert.equal(parsePlayPath('/play/short/player.js'), null);
});

test('Gateway loads Worker and Gateway settings from independent paths', (t) => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-gateway-config-'));
    t.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));
    const gatewayDirectory = path.join(temporaryDirectory, 'Gateway');
    const workerDirectory = path.join(temporaryDirectory, 'Worker');
    const secretsDirectory = path.join(temporaryDirectory, 'secrets');
    fs.mkdirSync(gatewayDirectory, { recursive: true });
    fs.mkdirSync(workerDirectory, { recursive: true });
    fs.mkdirSync(secretsDirectory, { recursive: true });

    fs.writeFileSync(
        path.join(workerDirectory, 'worker01.json'),
        JSON.stringify({
            agentId: 'worker01',
            slots: [{ id: 'slot01', playerPort: 801 }]
        })
    );
    fs.writeFileSync(path.join(secretsDirectory, 'gateway-token.txt'), 'gateway-token');
    const gatewayConfigPath = path.join(gatewayDirectory, 'gateway.json');
    fs.writeFileSync(
        gatewayConfigPath,
        JSON.stringify({
            listenHost: '127.0.0.1',
            listenPort: 9300,
            workerConfigFile: '../Worker/worker01.json',
            allocatorUrl: 'http://127.0.0.1:9200',
            allocatorTokenFile: '../secrets/gateway-token.txt'
        })
    );

    const loaded = loadGatewayConfiguration(gatewayConfigPath);
    assert.equal(loaded.config.workerConfigFile, path.join(workerDirectory, 'worker01.json'));
    assert.equal(
        loaded.config.allocatorTokenFile,
        path.join(secretsDirectory, 'gateway-token.txt')
    );
    assert.equal(loaded.workerConfig.agentId, 'worker01');

    const worker02Path = path.join(workerDirectory, 'worker02.json');
    fs.writeFileSync(
        worker02Path,
        JSON.stringify({
            agentId: 'worker02',
            slots: [{ id: 'slot01', playerPort: 803 }]
        })
    );
    const overridden = loadGatewayConfiguration(gatewayConfigPath, {
        workerConfigFile: worker02Path
    });
    assert.equal(overridden.workerConfigPath, worker02Path);
    assert.equal(overridden.workerConfig.agentId, 'worker02');

    const gateway = createGateway(loaded.config, loaded.workerConfig, {
        logger: createSilentLogger()
    });
    assert.equal(gateway.slots.get('slot01').playerPort, 801);
    void gateway.close();
});

test('Gateway rejects duplicate Slot player ports and non-loopback upstreams', () => {
    const workerConfig = {
        agentId: 'worker01',
        slots: [
            { id: 'slot01', playerPort: 801 },
            { id: 'slot02', playerPort: 801 }
        ]
    };
    assert.throws(() => validateWorkerConfig(workerConfig), /used by more than one Slot/);
    assert.throws(
        () =>
            validateConfig(
                {
                    listenPort: 9300,
                    workerConfigFile: 'worker01.json',
                    allocatorUrl: 'http://127.0.0.1:9200',
                    upstreamHost: '192.168.1.188'
                },
                {
                    agentId: 'worker01',
                    slots: [{ id: 'slot01', playerPort: 801 }]
                }
            ),
        /loopback address/
    );
});

test('Gateway proxies HTTP and WebSocket only for a current local Session ticket', async (t) => {
    const fakeAllocator = createFakeAllocator();
    const allocatorPort = await listen(fakeAllocator.server);
    const fakeWilbur = createFakeWilbur();
    const wilburPort = await listen(fakeWilbur);
    const ticket = 't'.repeat(43);
    fakeAllocator.tickets.set(ticket, {
        sessionId: 'session-1',
        workerId: 'worker01',
        slotId: 'slot01'
    });

    const gateway = createGateway(
        {
            listenHost: '127.0.0.1',
            listenPort: 0,
            workerConfigFile: 'unused-in-direct-test.json',
            allocatorUrl: `http://127.0.0.1:${allocatorPort}`,
            allocatorToken: 'gateway-token',
            upstreamHost: '127.0.0.1',
            allocatorRequestTimeoutMs: 2_000,
            upstreamTimeoutMs: 2_000
        },
        {
            agentId: 'worker01',
            slots: [
                {
                    id: 'slot01',
                    playerPort: wilburPort
                }
            ]
        },
        { logger: createSilentLogger() }
    );

    t.after(async () => {
        await gateway.close();
        await closeServer(fakeAllocator.server);
        await closeServer(fakeWilbur);
    });

    const gatewayPort = (await gateway.listen()).port;
    const baseUrl = `http://127.0.0.1:${gatewayPort}`;

    const root = await fetch(`${baseUrl}/`);
    assert.equal(root.status, 404);
    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual((await health.json()).slots, ['slot01']);

    const page = await fetch(`${baseUrl}/play/${ticket}/?ss=test`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /fake player/);

    const script = await fetch(`${baseUrl}/play/${ticket}/player.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type'), /javascript/);

    const invalid = await fetch(`${baseUrl}/play/${'x'.repeat(43)}/`);
    assert.equal(invalid.status, 403);

    fakeAllocator.tickets.get(ticket).workerId = 'worker02';
    const wrongWorker = await fetch(`${baseUrl}/play/${ticket}/`);
    assert.equal(wrongWorker.status, 403);
    fakeAllocator.tickets.get(ticket).workerId = 'worker01';

    const websocketResponse = await requestWebSocket(
        gatewayPort,
        `/play/${ticket}/ws`
    );
    assert.match(websocketResponse, /^HTTP\/1\.1 101 Switching Protocols/);
    const compatibleWebsocketResponse = await requestWebSocket(
        gatewayPort,
        `/play/${ticket}/?ss=${encodeURIComponent(`ws://127.0.0.1:${gatewayPort}/play/${ticket}/ws`)}`
    );
    assert.match(compatibleWebsocketResponse, /^HTTP\/1\.1 101 Switching Protocols/);

    fakeAllocator.tickets.delete(ticket);
    const releasedHttp = await fetch(`${baseUrl}/play/${ticket}/`);
    assert.equal(releasedHttp.status, 403);
    const releasedWebSocket = await requestWebSocket(
        gatewayPort,
        `/play/${ticket}/ws`
    );
    assert.match(releasedWebSocket, /^HTTP\/1\.1 403 Forbidden/);
    const releasedCompatibleWebSocket = await requestWebSocket(
        gatewayPort,
        `/play/${ticket}/?ss=test`
    );
    assert.match(releasedCompatibleWebSocket, /^HTTP\/1\.1 403 Forbidden/);
});
