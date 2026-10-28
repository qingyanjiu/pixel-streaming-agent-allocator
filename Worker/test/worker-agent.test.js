'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createWorkerAgent, resolveWorkerPaths } = require('../worker-agent');

const repositoryRoot = path.resolve(__dirname, '..', '..');

async function getFreePort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    return port;
}

async function requestJson(url, options = {}) {
    const response = await fetch(url, options);
    const text = await response.text();
    const payload = text ? JSON.parse(text) : null;
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${text}`);
    }
    return payload;
}

test('Worker Agent starts, reports readiness, observes players, and stops one slot', async (t) => {
    const [agentPort, streamerPort, playerPort, sfuPort] = await Promise.all([
        getFreePort(),
        getFreePort(),
        getFreePort(),
        getFreePort()
    ]);
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-worker-agent-'));
    const fakeWilbur = path.join(__dirname, 'fixtures', 'fake-wilbur.js');
    const fakeUe = path.join(__dirname, 'fixtures', 'fake-ue.js');
    const logLines = [];
    const logger = {
        log(message) {
            logLines.push(String(message));
        },
        warn(message) {
            logLines.push(String(message));
        },
        error(message) {
            logLines.push(String(message));
        }
    };
    const config = {
        agentId: 'test-worker',
        listenHost: '127.0.0.1',
        listenPort: agentPort,
        authToken: 'test-token',
        windowsDirectory: repositoryRoot,
        webServersDirectory: path.join(__dirname, 'fixtures'),
        nodeExecutable: process.execPath,
        signallingDirectory: 'signalling',
        gameExecutable: process.execPath,
        gameWorkingDirectory: '.',
        logsDirectory: temporaryDirectory,
        localHost: '127.0.0.1',
        startupTimeoutMs: 10_000,
        serverTimeoutMs: 5_000,
        stopTimeoutMs: 5_000,
        ueArgs: [fakeUe],
        slots: [
            {
                id: 'T1',
                streamerPort,
                playerPort,
                sfuPort,
                publicUrl: `http://127.0.0.1:${playerPort}/`,
                ueArgs: [`--playerPort=${playerPort}`]
            }
        ]
    };

    assert.ok(fs.existsSync(fakeWilbur));
    const agent = createWorkerAgent(config, {
        configPath: path.join(temporaryDirectory, 'worker-test.json'),
        logger
    });
    t.after(async () => {
        await agent.close(true);
        fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    });

    await agent.listen();
    const authHeaders = {
        Authorization: 'Bearer test-token'
    };

    const started = await requestJson(
        `http://127.0.0.1:${agentPort}/slots/T1/start`,
        { method: 'POST', headers: authHeaders }
    );
    assert.equal(started.status, 'ready');
    assert.equal(started.ready, true);
    assert.equal(started.running, true);
    assert.equal(started.streamerCount, 1);
    assert.equal(started.playerCount, 0);
    assert.ok(started.pids.wilbur);
    assert.ok(started.pids.ue);
    assert.ok(logLines.some((line) => line.includes('event=slot_start_request')));
    assert.ok(logLines.some((line) => line.includes('event=slot_starting')));
    assert.ok(logLines.some((line) => line.includes('event=slot_ready')));

    const playerResponse = await fetch(
        `http://127.0.0.1:${playerPort}/test/players?count=1`,
        { method: 'POST' }
    );
    assert.equal(playerResponse.ok, true);
    const busy = await requestJson(
        `http://127.0.0.1:${agentPort}/slots/T1`,
        { headers: authHeaders }
    );
    assert.equal(busy.playerCount, 1);
    assert.ok(logLines.some((line) => line.includes('event=player_connected')));

    const playerLeftResponse = await fetch(
        `http://127.0.0.1:${playerPort}/test/players?count=0`,
        { method: 'POST' }
    );
    assert.equal(playerLeftResponse.ok, true);
    const idle = await requestJson(
        `http://127.0.0.1:${agentPort}/slots/T1`,
        { headers: authHeaders }
    );
    assert.equal(idle.playerCount, 0);
    assert.ok(logLines.some((line) => line.includes('event=player_disconnected')));

    const stopped = await requestJson(
        `http://127.0.0.1:${agentPort}/slots/T1/stop`,
        { method: 'POST', headers: authHeaders }
    );
    assert.equal(stopped.status, 'stopped');
    assert.equal(stopped.running, false);
    assert.equal(stopped.playerCount, 0);
    assert.ok(logLines.some((line) => line.includes('event=slot_stopped')));

    const restarted = await requestJson(
        `http://127.0.0.1:${agentPort}/slots/T1/start`,
        { method: 'POST', headers: authHeaders }
    );
    assert.equal(restarted.status, 'ready');

    const shutdown = await requestJson(
        `http://127.0.0.1:${agentPort}/shutdown`,
        {
            method: 'POST',
            headers: authHeaders,
            body: '{}'
        }
    );
    assert.equal(shutdown.accepted, true);

    for (let attempt = 0; attempt < 40; attempt++) {
        if (!agent.server.listening && agent.slots.get('T1').status === 'stopped') {
            break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(agent.server.listening, false);
    assert.equal(agent.slots.get('T1').status, 'stopped');
    assert.equal(agent.slots.get('T1').wilburChild, null);
    assert.equal(agent.slots.get('T1').ueChild, null);
});

test('Worker path resolution keeps Windows and WebServers directories independent', () => {
    const configPath = path.join(repositoryRoot, 'Worker', 'test-worker.json');
    const paths = resolveWorkerPaths(
        {
            windowsDirectory: 'D:/GameBuilds/Windows',
            webServersDirectory: 'E:/PixelStreaming/WebServers',
            nodeExecutable: 'SignallingWebServer/platform_scripts/cmd/node/node.exe',
            signallingDirectory: 'SignallingWebServer',
            gameExecutable: 'UE_ANDA.exe',
            gameWorkingDirectory: '.',
            logsDirectory: 'logs',
            peerOptionsFile: 'turn.json'
        },
        {
            configPath,
            workerDirectory: 'C:/PixelStreamingWorker'
        }
    );

    assert.equal(paths.windowsDirectory, path.normalize('D:/GameBuilds/Windows'));
    assert.equal(paths.webServersDirectory, path.normalize('E:/PixelStreaming/WebServers'));
    assert.equal(
        paths.nodeExecutable,
        path.normalize('E:/PixelStreaming/WebServers/SignallingWebServer/platform_scripts/cmd/node/node.exe')
    );
    assert.equal(
        paths.signallingDirectory,
        path.normalize('E:/PixelStreaming/WebServers/SignallingWebServer')
    );
    assert.equal(paths.gameExecutable, path.normalize('D:/GameBuilds/Windows/UE_ANDA.exe'));
    assert.equal(paths.logsDirectory, path.normalize('C:/PixelStreamingWorker/logs'));
    assert.equal(
        paths.peerOptionsFile,
        path.resolve(path.dirname(configPath), 'turn.json')
    );
});
