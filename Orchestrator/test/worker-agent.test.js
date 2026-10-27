'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createWorkerAgent, resolveWorkerPaths } = require('../agent/worker-agent');

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
        logger: {
            log() {},
            warn() {},
            error() {}
        }
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

    const stopped = await requestJson(
        `http://127.0.0.1:${agentPort}/slots/T1/stop`,
        { method: 'POST', headers: authHeaders }
    );
    assert.equal(stopped.status, 'stopped');
    assert.equal(stopped.running, false);
    assert.equal(stopped.playerCount, 0);
});

test('Worker path resolution keeps Windows and WebServers directories independent', () => {
    const configPath = path.join(repositoryRoot, 'Orchestrator', 'agent', 'test-worker.json');
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
            orchestratorDirectory: 'C:/PixelStreamingOrchestrator'
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
    assert.equal(paths.logsDirectory, path.normalize('C:/PixelStreamingOrchestrator/logs'));
    assert.equal(
        paths.peerOptionsFile,
        path.resolve(path.dirname(configPath), 'turn.json')
    );
});
