"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.SignallingServer = void 0;
const wslib = __importStar(require("ws"));
const StreamerConnection_1 = require("./StreamerConnection");
const PlayerConnection_1 = require("./PlayerConnection");
const SFUConnection_1 = require("./SFUConnection");
const Logger_1 = require("./Logger");
const StreamerRegistry_1 = require("./StreamerRegistry");
const PlayerRegistry_1 = require("./PlayerRegistry");
const lib_pixelstreamingcommon_ue5_8_1 = require("@epicgames-ps/lib-pixelstreamingcommon-ue5.8");
const Utils_1 = require("./Utils");
/**
 * The main signalling server object.
 * Contains a streamer and player registry and handles setting up of websockets
 * to listen for incoming connections.
 */
class SignallingServer {
    /**
     * Initializes the server object and sets up listening sockets for streamers
     * players and optionally SFU connections.
     * @param config - A collection of options for this server.
     */
    constructor(config) {
        Logger_1.Logger.debug('Started SignallingServer with config: %s', (0, Utils_1.stringify)(config));
        this.config = config;
        this.streamerRegistry = new StreamerRegistry_1.StreamerRegistry(config.authorizeStreamerId);
        this.playerRegistry = new PlayerRegistry_1.PlayerRegistry();
        this.protocolConfig = {
            protocolVersion: lib_pixelstreamingcommon_ue5_8_1.SignallingProtocol.SIGNALLING_VERSION,
            peerConnectionOptions: this.config.peerOptions || {}
        };
        this.startTime = new Date();
        if (!config.playerPort && !config.httpServer && !config.httpsServer) {
            Logger_1.Logger.error('No player port, http server or https server supplied to SignallingServer.');
            return;
        }
        // Streamer connections
        const streamerServer = new wslib.WebSocketServer(Object.assign({ port: config.streamerPort, backlog: 1 }, config.streamerWsOptions));
        streamerServer.on('connection', this.onStreamerConnected.bind(this));
        Logger_1.Logger.info(`Listening for streamer connections on port ${config.streamerPort}`);
        // Player connections
        const server = config.httpsServer || config.httpServer;
        const playerServer = new wslib.WebSocketServer(Object.assign({ server: server, port: server ? undefined : config.playerPort }, config.playerWsOptions));
        playerServer.on('connection', this.onPlayerConnected.bind(this));
        if (!config.httpServer && !config.httpsServer) {
            Logger_1.Logger.info(`Listening for player connections on port ${config.playerPort}`);
        }
        // Optional SFU connections
        if (config.sfuPort) {
            const sfuServer = new wslib.WebSocketServer(Object.assign({ port: config.sfuPort, backlog: 1 }, config.sfuWsOptions));
            sfuServer.on('connection', this.onSFUConnected.bind(this));
            Logger_1.Logger.info(`Listening for SFU connections on port ${config.sfuPort}`);
        }
    }
    sendConfigMessage(connection) {
        // peer connection options is a general field with all optional fields;
        // it doesnt play nice with mergePartial so we just add it verbatim
        const message = lib_pixelstreamingcommon_ue5_8_1.MessageHelpers.createMessage(lib_pixelstreamingcommon_ue5_8_1.Messages.config, this.protocolConfig);
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        message.peerConnectionOptions = this.protocolConfig['peerConnectionOptions'];
        connection.sendMessage(message);
    }
    onStreamerConnected(ws, request) {
        Logger_1.Logger.info(`New streamer connection: %s`, request.socket.remoteAddress);
        const newStreamer = new StreamerConnection_1.StreamerConnection(this, ws, request.socket.remoteAddress, request);
        newStreamer.maxSubscribers = this.config.maxSubscribers || 0;
        // add it to the registry and when the transport closes, remove it.
        this.streamerRegistry.add(newStreamer);
        newStreamer.transport.on('close', () => {
            this.streamerRegistry.remove(newStreamer);
            Logger_1.Logger.info(`Streamer %s (%s) disconnected.`, newStreamer.streamerId, request.socket.remoteAddress);
        });
        this.sendConfigMessage(newStreamer);
    }
    onPlayerConnected(ws, request) {
        Logger_1.Logger.info(`New player connection: %s (%s)`, request.socket.remoteAddress, request.url);
        const newPlayer = new PlayerConnection_1.PlayerConnection(this, ws, request.socket.remoteAddress, request);
        // add it to the registry and when the transport closes, remove it
        this.playerRegistry.add(newPlayer);
        newPlayer.transport.on('close', () => {
            this.playerRegistry.remove(newPlayer);
            Logger_1.Logger.info(`Player %s (%s) disconnected.`, newPlayer.playerId, request.socket.remoteAddress);
        });
        // Optionally monitor the player connection for liveness. A player whose socket dies without
        // a clean close frame (sleeping laptop, dropped Wi-Fi, killed tab) is otherwise only removed
        // once the OS TCP keepalive eventually reaps it, leaving it subscribed in the meantime. When
        // maxSubscribers is set this can hold a slot that no live player is using. We use
        // ws.terminate() rather than a graceful close because a dead peer never completes the close
        // handshake. The monitor stops itself on transport 'close', so no manual teardown is needed.
        const keepaliveTimeout = this.config.playerKeepaliveTimeout || 0;
        if (keepaliveTimeout > 0) {
            const keepalive = new lib_pixelstreamingcommon_ue5_8_1.KeepaliveMonitor(newPlayer.protocol, keepaliveTimeout);
            keepalive.onTimeout = () => {
                Logger_1.Logger.info(`Player %s (%s) failed keepalive - terminating dead connection.`, newPlayer.playerId, request.socket.remoteAddress);
                ws.terminate();
            };
        }
        this.sendConfigMessage(newPlayer);
    }
    onSFUConnected(ws, request) {
        Logger_1.Logger.info(`New SFU connection: %s`, request.socket.remoteAddress);
        const newSFU = new SFUConnection_1.SFUConnection(this, ws, request.socket.remoteAddress, request);
        // SFU acts as both a streamer and player
        this.streamerRegistry.add(newSFU);
        this.playerRegistry.add(newSFU);
        newSFU.transport.on('close', () => {
            this.streamerRegistry.remove(newSFU);
            this.playerRegistry.remove(newSFU);
            Logger_1.Logger.info(`SFU %s (%s) disconnected.`, newSFU.streamerId, request.socket.remoteAddress);
        });
        this.sendConfigMessage(newSFU);
    }
}
exports.SignallingServer = SignallingServer;
//# sourceMappingURL=SignallingServer.js.map