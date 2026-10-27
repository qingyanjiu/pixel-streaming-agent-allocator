'use strict';

const http = require('node:http');

function argumentValue(name) {
    const index = process.argv.indexOf(name);
    return index === -1 ? null : process.argv[index + 1];
}

const port = Number(argumentValue('--player_port'));
if (!Number.isInteger(port) || port <= 0) {
    console.error('fake-wilbur requires --player_port.');
    process.exit(1);
}

let streaming = false;
let playerCount = 0;

const server = http.createServer((request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (request.method === 'GET' && url.pathname === '/api/status') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({
            uptime: 1,
            streamer_count: streaming ? 1 : 0,
            player_count: playerCount,
            version: 'test'
        }));
        return;
    }
    if (request.method === 'GET' && url.pathname === '/api/streamers') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(
            streaming
                ? [{ streamerId: 'DefaultStreamer', type: 'streamer', streaming: true, subscribers: [] }]
                : []
        ));
        return;
    }
    if (request.method === 'POST' && url.pathname === '/test/streamer') {
        streaming = url.searchParams.get('enabled') === '1';
        response.writeHead(200);
        response.end('ok');
        return;
    }
    if (request.method === 'POST' && url.pathname === '/test/players') {
        playerCount = Number(url.searchParams.get('count')) || 0;
        response.writeHead(200);
        response.end('ok');
        return;
    }
    response.writeHead(404);
    response.end('not found');
});

server.listen(port, '127.0.0.1', () => {
    console.log(`fake-wilbur listening on ${port}`);
});

const stop = () => server.close(() => process.exit(0));
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
