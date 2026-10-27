'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
    createAllocator,
    loadAllocatorConfiguration,
    validateConfig
} = require('../allocator/allocator');

async function listen(server) {
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    return server.address().port;
}

function createFakeAgent() {
    const slots = new Map([
        [
            'T1',
            {
                id: 'T1',
                status: 'ready',
                ready: true,
                running: true,
                streamerCount: 1,
                playerCount: 0,
                publicUrl: 'http://worker.test:801/'
            }
        ],
        [
            'T2',
            {
                id: 'T2',
                status: 'stopped',
                ready: false,
                running: false,
                streamerCount: 0,
                playerCount: 0,
                publicUrl: 'http://worker.test:802/'
            }
        ]
    ]);
    const server = http.createServer((request, response) => {
        if (request.headers.authorization !== 'Bearer worker-token') {
            response.writeHead(401);
            response.end();
            return;
        }

        const url = new URL(request.url, `http://${request.headers.host}`);
        if (request.method === 'GET' && url.pathname === '/slots') {
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ slots: Array.from(slots.values()) }));
            return;
        }

        const startMatch = url.pathname.match(/^\/slots\/([^/]+)\/start$/);
        if (request.method === 'POST' && startMatch) {
            const slot = slots.get(decodeURIComponent(startMatch[1]));
            slot.status = 'ready';
            slot.ready = true;
            slot.running = true;
            slot.streamerCount = 1;
            slot.playerCount = 0;
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify(slot));
            return;
        }

        const stopMatch = url.pathname.match(/^\/slots\/([^/]+)\/stop$/);
        if (request.method === 'POST' && stopMatch) {
            const slot = slots.get(decodeURIComponent(stopMatch[1]));
            slot.status = 'stopped';
            slot.ready = false;
            slot.running = false;
            slot.streamerCount = 0;
            slot.playerCount = 0;
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify(slot));
            return;
        }

        response.writeHead(404);
        response.end();
    });

    return {
        server,
        slots,
        setPlayerCount(slotId, count) {
            slots.get(slotId).playerCount = count;
        }
    };
}

async function requestJson(url, options = {}) {
    const response = await fetch(url, options);
    const text = await response.text();
    const payload = text ? JSON.parse(text) : null;
    return { response, payload };
}

test('Allocator loads Worker addresses from a separate workers.json file', (t) => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-workers-config-'));
    t.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));

    const allocatorDirectory = path.join(temporaryDirectory, 'allocator');
    const configDirectory = path.join(temporaryDirectory, 'config');
    fs.mkdirSync(allocatorDirectory, { recursive: true });
    fs.mkdirSync(configDirectory, { recursive: true });

    const workersPath = path.join(configDirectory, 'workers.json');
    fs.writeFileSync(
        workersPath,
        JSON.stringify({
            workers: [
                {
                    id: 'worker-01',
                    baseUrl: 'http://192.168.1.21:9101',
                    token: 'worker-token'
                }
            ]
        })
    );

    const allocatorPath = path.join(allocatorDirectory, 'allocator.json');
    fs.writeFileSync(
        allocatorPath,
        JSON.stringify({
            apiKey: 'client-token',
            workersFile: '../config/workers.json'
        })
    );

    const loaded = loadAllocatorConfiguration(allocatorPath);
    assert.equal(loaded.workersFile, workersPath);
    assert.equal(loaded.config.workers.length, 1);
    assert.equal(loaded.config.workers[0].id, 'worker-01');
    assert.equal(loaded.config.workers[0].baseUrl, 'http://192.168.1.21:9101');
});

test('Allocator rejects duplicate Worker management addresses', () => {
    assert.throws(
        () =>
            validateConfig({
                workers: [
                    {
                        id: 'worker-01',
                        baseUrl: 'http://192.168.1.21:9101'
                    },
                    {
                        id: 'worker-02',
                        baseUrl: 'http://192.168.1.21:9101/'
                    }
                ]
            }),
        /duplicates baseUrl/
    );
});

test('No-capacity responses can be retried with the same idempotency key', async (t) => {
    const fakeAgent = createFakeAgent();
    const agentPort = await listen(fakeAgent.server);
    const allocator = createAllocator(
        {
            listenHost: '127.0.0.1',
            listenPort: 0,
            apiKey: 'client-token',
            autoStart: false,
            stopOnRelease: true,
            pollIntervalMs: 60_000,
            connectTimeoutMs: 50,
            idleReleaseMs: 10,
            workers: [
                {
                    id: 'worker-test',
                    baseUrl: `http://127.0.0.1:${agentPort}`,
                    token: 'worker-token'
                }
            ]
        },
        {
            logger: {
                log() {},
                warn() {},
                error() {}
            }
        }
    );

    t.after(async () => {
        await allocator.close();
        await new Promise((resolve) => fakeAgent.server.close(resolve));
    });

    const address = await allocator.listen();
    const baseUrl = `http://127.0.0.1:${address.port}/api/sessions`;
    const headers = {
        'Content-Type': 'application/json',
        'X-API-Key': 'client-token',
        'Idempotency-Key': 'retry-after-capacity'
    };

    fakeAgent.slots.get('T1').playerCount = 1;
    fakeAgent.slots.get('T2').playerCount = 1;
    const noCapacity = await requestJson(baseUrl, {
        method: 'POST',
        headers,
        body: '{}'
    });
    assert.equal(noCapacity.response.status, 503);

    fakeAgent.setPlayerCount('T1', 0);
    fakeAgent.setPlayerCount('T2', 0);
    const retried = await requestJson(baseUrl, {
        method: 'POST',
        headers,
        body: '{}'
    });
    assert.equal(retried.response.status, 201);
    assert.equal(retried.payload.status, 'ready');
});

test('Allocator reserves warm capacity, starts a cold slot, and releases disconnected sessions', async (t) => {
    const fakeAgent = createFakeAgent();
    const agentPort = await listen(fakeAgent.server);
    const allocator = createAllocator(
        {
            listenHost: '127.0.0.1',
            listenPort: 0,
            apiKey: 'client-token',
            autoStart: true,
            stopOnRelease: true,
            pollIntervalMs: 60_000,
            connectTimeoutMs: 60_000,
            idleReleaseMs: 10,
            sessionRetentionMs: 60_000,
            corsAllowedOrigins: ['http://client.example'],
            workers: [
                {
                    id: 'worker-test',
                    baseUrl: `http://127.0.0.1:${agentPort}`,
                    token: 'worker-token'
                }
            ]
        },
        {
            logger: {
                log() {},
                warn() {},
                error() {}
            }
        }
    );

    t.after(async () => {
        await allocator.close();
        await new Promise((resolve) => fakeAgent.server.close(resolve));
    });

    const address = await allocator.listen();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const headers = {
        'Content-Type': 'application/json',
        'X-API-Key': 'client-token'
    };

    const preflight = await fetch(`${baseUrl}/api/sessions`, {
        method: 'OPTIONS',
        headers: {
            Origin: 'http://client.example',
            'Access-Control-Request-Method': 'POST',
            'Access-Control-Request-Headers':
                'x-api-key, x-session-token, content-type, idempotency-key'
        }
    });
    assert.equal(preflight.status, 204);
    assert.equal(
        preflight.headers.get('access-control-allow-origin'),
        'http://client.example'
    );

    const rejectedOrigin = await requestJson(`${baseUrl}/api/slots`, {
        headers: {
            ...headers,
            Origin: 'http://untrusted.example'
        }
    });
    assert.equal(rejectedOrigin.response.status, 403);

    const first = await requestJson(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: {
            ...headers,
            'Idempotency-Key': 'first-request'
        },
        body: JSON.stringify({ ttlSeconds: 300 })
    });
    assert.equal(first.response.status, 201);
    assert.equal(first.payload.status, 'ready');
    assert.equal(first.payload.slotId, 'T1');
    assert.equal(typeof first.payload.sessionToken, 'string');
    assert.ok(first.payload.sessionToken.length >= 32);

    const duplicate = await requestJson(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: {
            ...headers,
            'Idempotency-Key': 'first-request'
        },
        body: JSON.stringify({ ttlSeconds: 300 })
    });
    assert.equal(duplicate.payload.sessionId, first.payload.sessionId);
    assert.equal(duplicate.payload.sessionToken, first.payload.sessionToken);

    const second = await requestJson(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ttlSeconds: 300 })
    });
    assert.equal(second.response.status, 202);
    assert.equal(second.payload.status, 'starting');
    assert.equal(second.payload.slotId, 'T2');
    assert.match(second.payload.message, /正在启动/);

    const firstHeaders = {
        ...headers,
        'X-Session-Token': first.payload.sessionToken
    };
    const secondHeaders = {
        ...headers,
        'X-Session-Token': second.payload.sessionToken
    };

    let secondStatus;
    for (let attempt = 0; attempt < 30; attempt++) {
        const current = await requestJson(
            `${baseUrl}/api/sessions/${second.payload.sessionId}`,
            { headers: secondHeaders }
        );
        secondStatus = current.payload;
        if (secondStatus.status === 'ready') {
            break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(secondStatus.status, 'ready');

    fakeAgent.setPlayerCount('T2', 1);
    await allocator.reconcileSessions();

    fakeAgent.setPlayerCount('T1', 1);
    await allocator.reconcileSessions();
    const active = await requestJson(`${baseUrl}/api/sessions/${first.payload.sessionId}`, {
        headers: firstHeaders
    });
    assert.equal(active.payload.status, 'active');

    fakeAgent.setPlayerCount('T1', 0);
    const stored = allocator.sessions.get(first.payload.sessionId);
    await allocator.reconcileSessions();

    const disconnected = await requestJson(`${baseUrl}/api/sessions/${first.payload.sessionId}`, {
        headers: firstHeaders
    });
    assert.equal(disconnected.payload.status, 'disconnected');
    assert.equal(disconnected.payload.url, first.payload.url);
    assert.match(disconnected.payload.message, /重连/);
    assert.ok(disconnected.payload.reconnectDeadline);

    const newUserDuringGrace = await requestJson(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: {
            ...headers,
            'Idempotency-Key': 'new-user-during-grace'
        },
        body: JSON.stringify({ ttlSeconds: 300 })
    });
    assert.equal(newUserDuringGrace.response.status, 503);

    const wrongSessionToken = await requestJson(
        `${baseUrl}/api/sessions/${first.payload.sessionId}`,
        {
            headers: {
                ...headers,
                'X-Session-Token': 'wrong-session-token'
            }
        }
    );
    assert.equal(wrongSessionToken.response.status, 401);

    fakeAgent.setPlayerCount('T1', 1);
    await allocator.reconcileSessions();
    const reconnected = await requestJson(
        `${baseUrl}/api/sessions/${first.payload.sessionId}`,
        { headers: firstHeaders }
    );
    assert.equal(reconnected.payload.status, 'active');

    fakeAgent.setPlayerCount('T1', 0);
    await allocator.reconcileSessions();
    stored.disconnectedAt = Date.now() - 1_000;
    stored.reconnectDeadline = Date.now() - 1;
    await allocator.reconcileSessions();

    const released = await requestJson(`${baseUrl}/api/sessions/${first.payload.sessionId}`, {
        headers: firstHeaders
    });
    assert.equal(released.payload.status, 'released');
    assert.equal(released.payload.reason, 'reconnect_timeout');
    assert.equal(fakeAgent.slots.get('T1').status, 'stopped');

    const unauthorized = await requestJson(`${baseUrl}/api/slots`);
    assert.equal(unauthorized.response.status, 401);
});
