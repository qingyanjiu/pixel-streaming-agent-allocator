'use strict';

function argumentValue(prefix) {
    const argument = process.argv.find((candidate) => candidate.startsWith(prefix));
    return argument ? argument.slice(prefix.length) : null;
}

const playerPort = Number(argumentValue('--playerPort='));
if (!Number.isInteger(playerPort) || playerPort <= 0) {
    console.error('fake-ue requires --playerPort.');
    process.exit(1);
}

const endpoint = `http://127.0.0.1:${playerPort}/test/streamer?enabled=1`;
const keepAlive = setInterval(async () => {
    try {
        await fetch(endpoint, { method: 'POST' });
    } catch {
        // The test agent will stop this process if the fake signalling server exits.
    }
}, 100);

void fetch(endpoint, { method: 'POST' }).catch(() => undefined);

const stop = () => {
    clearInterval(keepAlive);
    process.exit(0);
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
