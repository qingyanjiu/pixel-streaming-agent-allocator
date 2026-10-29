'use strict';

const fs = require('node:fs');
const path = require('node:path');

function parseArguments(argv) {
    const result = {};
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        if (!argument.startsWith('--')) {
            continue;
        }

        const equalsIndex = argument.indexOf('=');
        if (equalsIndex !== -1) {
            result[argument.slice(2, equalsIndex)] = argument.slice(equalsIndex + 1);
            continue;
        }

        const key = argument.slice(2);
        const next = argv[index + 1];
        if (next && !next.startsWith('--')) {
            result[key] = next;
            index++;
        } else {
            result[key] = true;
        }
    }
    return result;
}

function loadJson(filePath) {
    const absolutePath = path.resolve(filePath);
    let raw;
    try {
        raw = fs.readFileSync(absolutePath, 'utf8');
    } catch (error) {
        throw new Error(`Cannot read configuration file "${absolutePath}": ${error.message}`);
    }

    try {
        return {
            config: JSON.parse(raw),
            path: absolutePath
        };
    } catch (error) {
        throw new Error(`Invalid JSON in "${absolutePath}": ${error.message}`);
    }
}

function resolveFrom(root, candidate) {
    if (!candidate) {
        return '';
    }
    return path.isAbsolute(candidate) ? path.normalize(candidate) : path.resolve(root, candidate);
}

function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isPositiveInteger(value) {
    return Number.isInteger(value) && value > 0;
}

function ensureDirectory(directoryPath) {
    fs.mkdirSync(directoryPath, { recursive: true });
}

function writeJsonAtomic(filePath, value) {
    ensureDirectory(path.dirname(filePath));
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(temporaryPath, filePath);
}

function getSecret(configValue, environmentName, secretFile) {
    if (environmentName && process.env[environmentName]) {
        return process.env[environmentName];
    }
    if (secretFile) {
        try {
            return fs.readFileSync(secretFile, 'utf8').trim();
        } catch (error) {
            throw new Error(`Cannot read secret file "${secretFile}": ${error.message}`);
        }
    }
    return typeof configValue === 'string' ? configValue : '';
}

function timingSafeEqual(left, right) {
    const leftBuffer = Buffer.from(String(left ?? ''));
    const rightBuffer = Buffer.from(String(right ?? ''));
    if (leftBuffer.length !== rightBuffer.length) {
        return false;
    }
    return require('node:crypto').timingSafeEqual(leftBuffer, rightBuffer);
}

async function fetchJson(url, timeoutMilliseconds, requestOptions = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMilliseconds);
    try {
        const response = await fetch(url, {
            ...requestOptions,
            headers: {
                Accept: 'application/json',
                ...(requestOptions.headers || {})
            },
            signal: controller.signal
        });
        if (!response.ok) {
            let detail = '';
            try {
                detail = (await response.text()).trim();
            } catch {
                // The status code is enough when the response body cannot be read.
            }
            throw new Error(
                `HTTP ${response.status} from ${url}${detail ? `: ${detail.slice(0, 500)}` : ''}`
            );
        }
        if (response.status === 204) {
            return null;
        }
        return await response.json();
    } catch (error) {
        if (error.name === 'AbortError') {
            throw new Error(`Request timed out after ${timeoutMilliseconds} ms: ${url}`);
        }
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

module.exports = {
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
};
