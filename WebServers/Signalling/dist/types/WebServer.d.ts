import express from 'express';
import http from 'http';
import https from 'https';
/**
 * Options for configuring CORS on the Express app. When `enabled` is true the
 * `cors` middleware is registered so that browser-based clients hosted on a
 * different origin (e.g. a custom frontend) can call the REST API or other
 * routes mounted on the app. Use `allowedOrigins` to restrict which origins
 * are accepted; an empty / unset list means "allow all origins" (`*`).
 */
export interface ICorsConfig {
    enabled?: boolean;
    allowedOrigins?: string[];
    allowedMethods?: string[];
    allowedHeaders?: string[];
    credentials?: boolean;
}
/**
 * An interface that describes the possible options to pass to
 * WebServer.
 */
export interface IWebServerConfig {
    httpPort: number;
    root: string;
    homepageFile: string;
    perMinuteRateLimit?: number;
    httpsPort?: number;
    ssl_key?: Buffer;
    ssl_cert?: Buffer;
    https_redirect?: boolean;
    serveStatic?: boolean;
    cors?: ICorsConfig;
}
/**
 * An object to manage the initialization of a web server. Used to serve the
 * pixel streaming frontend.
 */
export declare class WebServer {
    httpServer: http.Server | undefined;
    httpsServer: https.Server | undefined;
    constructor(app: express.Express, config: IWebServerConfig);
}
