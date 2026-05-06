import * as readline from 'readline';
import * as crypto from 'crypto';
import * as http from 'http';
import * as http2 from 'http2';
import * as net from 'net';

import * as nanoid from 'nanoid';
import { DestroyableServer, makeDestroyable } from 'destroyable-server';

const SUBDOMAIN_ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const generateEndpointId = nanoid.customAlphabet(SUBDOMAIN_ID_ALPHABET, 8);

const REQUEST_ATTACH_TIMEOUT_MS = 30_000;
const ADMIN_KEEPALIVE_INTERVAL_MS = 30_000;
const ADMIN_KEEPALIVE_TIMEOUT_MS = 30_000;

export class AdminServer {

    private readonly port: number;
    private readonly server: DestroyableServer;

    private readonly connectionMap = new Map<string, AdminSession>();

    private destroyed = false;

    constructor(port: number) {
        this.port = port;

        this.server = makeDestroyable(http2.createServer());
        this.server.on('session', this.handleSession.bind(this));
    }

    public async start() {
        await new Promise<void>((resolve) => {
            this.server.listen({ port: this.port }, resolve);
        });

        setInterval(() => {
            console.log(`${this.connectionMap.size} admin connections open, with ${
                [...this.connectionMap.values()]
                .map(c => c.getActiveRequestCount())
                .reduce((a, b) => a + b, 0)
            } active requests.`)
        }, 30_000).unref();
    }

    public async destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        await this.server.destroy();
    }

    public async shutdown(graceMs: number) {
        if (this.destroyed) return;
        this.destroyed = true;

        // Stop the listener; callback resolves once the server fully closes.
        const listenerClosed = new Promise<void>((resolve) => this.server.close(() => resolve()));

        // Notify each client and GOAWAY their H2 session — this synchronously prevents
        // any new streams (including /start) from being created on existing sessions,
        // while letting in-flight streams complete within the grace window.
        for (const session of this.connectionMap.values()) {
            session.notifyShutdown();
        }

        const grace = new Promise<void>((resolve) => setTimeout(resolve, graceMs).unref());
        await Promise.race([listenerClosed, grace]);

        // Force-kill anything still active:
        for (const session of this.connectionMap.values()) {
            session.close(true);
        }

        // Wait till all sockets are fully gone
        await listenerClosed;
    }

    private handleSession(session: http2.ServerHttp2Session) {
        let adminSession: AdminSession | undefined;

        session.on('stream', async (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
            console.log('Received admin request:', headers[':method'], headers[':path']);

            if (headers[':method'] === 'POST') {
                if (headers[':path'] === '/start') {
                    if (adminSession) {
                        console.log('Received duplicate /start request on admin session');
                        stream.respond({ ':status': 400 });
                        stream.end();
                        adminSession.close();
                        return;
                    }
                    try {
                        adminSession = await this.handleStartRequest(stream, session);
                    } catch (e) {
                        console.error('Error handling /start request:', e);
                        stream.respond({ ':status': 500 });
                        stream.end();
                        session.close();
                    }
                    return;
                } else if (!adminSession) {
                    console.log(`${headers[':path']} request on an admin stream before /start`)
                    stream.respond({ ':status': 400 });
                    stream.end();
                    return;
                } else if (headers[':path']?.startsWith('/request/')) {
                    const requestId = headers[':path'].slice('/request/'.length);
                    const requestSession = adminSession.getRequestSession(requestId);
                    if (!requestSession) {
                        console.error(`/request channel opened for unknown request ID: ${requestId}`);
                        stream.respond({ ':status': 404 });
                        stream.end();
                        return;
                    }

                    requestSession.attachControlStream(stream);
                    return;
                }
            }

            console.log(`Unknown admin request: ${headers[':method']} ${headers[':path']}`);
            stream.respond({ ':status': 404 });
            stream.end();
        });

        session.on('error', (e) => {
            console.error(`Error in admin session (${adminSession?.id}):`, e);
        });

        session.on('close', () => {
            console.error(`Admin connection for session (${adminSession?.id}) closed`);
        });
    }

    private async handleStartRequest(stream: http2.ServerHttp2Stream, session: http2.ServerHttp2Session) {
        stream.respond({ ':status': 200 });

        const lineStream = readline.createInterface({ input: stream, crlfDelay: Infinity });
        const firstLine = await getNextLine(lineStream);
        const firstCommand = JSON.parse(firstLine);

        if (firstCommand.command !== 'auth') {
            stream.end(JSON.stringify({ error: 'Auth required' }));
            return;
        }

        const endpointId = generateEndpointId();
        const adminSession = new AdminSession(endpointId, stream, session, () => {
            console.log(`Admin session ${endpointId} closed`);
            this.connectionMap.delete(endpointId);
        });
        this.connectionMap.set(endpointId, adminSession);

        stream.write(JSON.stringify({
            success: true,
            endpointId
        }) + '\n');

        lineStream.on('line', (line) => {
            if (!line) return; // Ignore empty lines, can be used as keep-alives
            const message = JSON.parse(line);
            console.log(`Received admin message for endpoint ${endpointId}:`, message);
        });

        return adminSession;
    }

    public getSession(id: string): AdminSession | undefined {
        return this.connectionMap.get(id);
    }
}

class AdminSession {

    public readonly id: string;
    private readonly controlStream: http2.ServerHttp2Stream;
    private readonly h2Session: http2.ServerHttp2Session;

    private requestMap = new Map<string, RequestSession | UpgradeSession | H2RequestSession>();

    private closed = false;
    private readonly keepaliveInterval: NodeJS.Timeout;

    constructor(
        id: string,
        controlStream: http2.ServerHttp2Stream,
        session: http2.ServerHttp2Session,
        onClose: () => void
    ) {
        this.id = id;
        this.controlStream = controlStream;
        this.h2Session = session;
        this.onCloseCb = onClose;

        controlStream.on('close', () => this.close());
        session.on('close', () => this.close());

        this.keepaliveInterval = setInterval(() => this.sendKeepalivePing(), ADMIN_KEEPALIVE_INTERVAL_MS);
        this.keepaliveInterval.unref();
    }

    private readonly onCloseCb: () => void;

    private sendKeepalivePing() {
        if (this.closed || this.h2Session.destroyed) return;

        let pongReceived = false;
        const timeout = setTimeout(() => {
            if (pongReceived) return;
            console.warn(`Admin session ${this.id} keepalive ping timed out, closing`);
            this.close();
        }, ADMIN_KEEPALIVE_TIMEOUT_MS);
        timeout.unref();

        const accepted = this.h2Session.ping((err) => {
            pongReceived = true;
            clearTimeout(timeout);
            if (err && !this.closed && !this.h2Session.destroyed) {
                console.warn(`Admin session ${this.id} keepalive ping failed:`, err.message);
                this.close();
            }
        });

        if (!accepted) {
            // ping() returns false if the session is closed/closing — nothing to wait on
            clearTimeout(timeout);
        }
    }

    notifyShutdown() {
        try {
            this.controlStream.write(JSON.stringify({ command: 'shutdown' }) + '\n');
        } catch (e) {
            console.warn(`Failed to notify shutdown to admin session ${this.id}:`, e);
        }
        // GOAWAY: blocks any new streams on this H2 session, in-flight streams continue.
        try {
            this.h2Session.close();
        } catch (e) {}
    }

    close(force = false) {
        if (this.closed) return;
        this.closed = true;

        console.log(`Shutting down admin session ${this.id}${force ? ' (forced)' : ''}`);
        clearInterval(this.keepaliveInterval);

        if (force) {
            try { this.controlStream.destroy(); } catch (e) {}
            try { this.h2Session.destroy(); } catch (e) {}
        } else {
            try { this.controlStream.end(); } catch (e) {}
            try { this.h2Session.close(); } catch (e) {}

            // Try to cleanup nicely, then just kill everything
            setTimeout(() => {
                this.h2Session.destroy();
            }, 5_000).unref();
        }

        for (let requestSession of this.requestMap.values()) {
            requestSession.close();
        }

        this.onCloseCb();
    }

    startRequest(req: http.IncomingMessage, res: http.ServerResponse) {
        const requestId = crypto.randomBytes(16).toString('hex');
        const session = new RequestSession(requestId, req, res, this.cleanupRequest.bind(this));
        this.requestMap.set(requestId, session);

        this.controlStream.write(JSON.stringify({
            command: 'new-request',
            requestId
        }) + '\n');
    }

    startUpgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer) {
        const requestId = crypto.randomBytes(16).toString('hex');
        const session = new UpgradeSession(requestId, req, socket, head, this.cleanupRequest.bind(this));
        this.requestMap.set(requestId, session);

        this.controlStream.write(JSON.stringify({
            command: 'new-request',
            requestId
        }) + '\n');
    }

    startH2Stream(stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) {
        const requestId = crypto.randomBytes(16).toString('hex');
        const session = new H2RequestSession(requestId, stream, headers, this.cleanupRequest.bind(this));
        this.requestMap.set(requestId, session);

        this.controlStream.write(JSON.stringify({
            command: 'new-request',
            requestId
        }) + '\n');
    }

    getRequestSession(requestId: string): RequestSession | UpgradeSession | H2RequestSession | undefined {
        return this.requestMap.get(requestId);
    }

    getActiveRequestCount(): number {
        return this.requestMap.size;
    }

    cleanupRequest(requestId: string) {
        this.requestMap.delete(requestId);
    }

}

class RequestSession {

    public readonly id: string;
    private readonly req: http.IncomingMessage
    private readonly res: http.ServerResponse;

    private requestClosed: boolean;
    private responseClosed: boolean;
    private readonly cleanupCb: (id: string) => void;

    private attached = false;
    private readonly attachTimeout: NodeJS.Timeout;

    constructor(
        id: string,
        req: http.IncomingMessage,
        res: http.ServerResponse,
        cleanupCb: (id: string) => void
    ) {
        this.id = id;
        this.req = req;
        this.res = res;

        this.requestClosed = req.closed;
        this.responseClosed = res.closed;
        this.cleanupCb = cleanupCb;

        req.on('close', () => {
            this.requestClosed = true;
            this.maybeCleanup();
        });
        res.on('close', () => {
            this.responseClosed = true;
            this.maybeCleanup();
        });

        this.attachTimeout = setTimeout(() => {
            if (this.attached) return;
            console.warn(`Request session ${this.id} timed out before control stream attached`);
            try {
                this.res.writeHead(504);
                this.res.end();
            } catch (e) {}
            try {
                this.req.destroy();
            } catch (e) {}
        }, REQUEST_ATTACH_TIMEOUT_MS);
        this.attachTimeout.unref();

        // In case they're somehow immediately closed, make sure we don't get stuck
        // waiting for events that never come (but debounce so startRequest setup
        // properly starts before cleanup).
        setImmediate(() => {
            this.maybeCleanup();
        });
    }

    maybeCleanup() {
        if (this.requestClosed && this.responseClosed) {
            clearTimeout(this.attachTimeout);
            this.cleanupCb(this.id);
        }
    }

    attachControlStream(stream: http2.ServerHttp2Stream) {
        this.attached = true;
        clearTimeout(this.attachTimeout);

        stream.respond({ ':status': 200 });

        const tunnelledReq = http.request({
            method: this.req.method,
            path: this.req.url,
            headers: this.req.rawHeaders,
            setDefaultHeaders: false,
            createConnection: () => stream
        });

        const handleTunnelError = (err: Error) => {
            console.error('Error in tunneled request:', err);
            try {
                this.res.writeHead(502);
                this.res.end();
                setImmediate(() => this.req.destroy());
            } catch (e) {}
        };

        tunnelledReq.on('error', handleTunnelError);

        // Forward 1xx informationals (e.g. 103 Early Hints)
        tunnelledReq.on('information', (info) => {
            if (this.res.headersSent || this.res.writableEnded) return;
            const lines = [`HTTP/1.1 ${info.statusCode} ${info.statusMessage}`];
            for (let i = 0; i < info.rawHeaders.length; i += 2) {
                lines.push(`${info.rawHeaders[i]}: ${info.rawHeaders[i + 1]}`);
            }
            try {
                (this.res as any)._writeRaw(lines.join('\r\n') + '\r\n\r\n', 'ascii');
            } catch (e) {}
        });

        tunnelledReq.flushHeaders();

        // Forward request body and trailers without auto-ending — we need to attach
        // any inbound trailers before ending the tunnelled request.
        this.req.pipe(tunnelledReq, { end: false });
        this.req.on('end', () => {
            const trailers = pairsFromRawTrailers(this.req.rawTrailers);
            if (trailers.length > 0) tunnelledReq.addTrailers(trailers);
            tunnelledReq.end();
        });

        tunnelledReq.on('response', (tunnelledRes) => {
            // The error handler may already have responded (e.g. tunnel torn down
            // mid-flight); skip the late response in that case.
            if (this.res.headersSent || this.res.writableEnded) return;

            // Disable default respose headers - we're going to use the exact
            // headers provided:
            [
                'connection',
                'content-length',
                'transfer-encoding',
                'date'
            ].forEach((defaultHeader) =>
                this.res.removeHeader(defaultHeader)
            );

            this.res.writeHead(tunnelledRes.statusCode!, tunnelledRes.rawHeaders);
            this.res.flushHeaders();

            // Forward response body without auto-ending so we can attach trailers
            // before this.res.end().
            tunnelledRes.pipe(this.res, { end: false });
            tunnelledRes.on('end', () => {
                const trailers = pairsFromRawTrailers(tunnelledRes.rawTrailers);
                if (trailers.length > 0) this.res.addTrailers(trailers);
                this.res.end();
            });

            tunnelledRes.on('error', (err) => {
                console.error('Error in tunneled response:', err);
                try {
                    this.res.writeHead(502);
                    this.res.end();
                    setImmediate(() => this.req.destroy());
                } catch (e) {}
            });
        });

    }

    close() {
        // Hard shutdown everything
        console.log(`Shutting down active request session ${this.id}`);
        clearTimeout(this.attachTimeout);

        try {
            if (!this.res.headersSent) this.res.writeHead(502);
            this.res.end();
        } catch (e) {}
        try {
            this.req.destroy();
        } catch (e) {}
    }

}

/**
 * Tunnels a HTTP/1.1 Upgrade request (e.g. WebSocket) over the admin tunnel.
 *
 * Re-emits the original request on the tunnel stream verbatim using rawHeaders
 * (preserving casing/order), then byte-splices the public socket and the tunnel
 * stream so all post-upgrade bytes (101 response, frames in both directions)
 * pass through untouched.
 */
class UpgradeSession {

    public readonly id: string;
    private readonly req: http.IncomingMessage;
    private readonly socket: net.Socket;
    private readonly head: Buffer;
    private readonly cleanupCb: (id: string) => void;

    private attached = false;
    private readonly attachTimeout: NodeJS.Timeout;

    constructor(
        id: string,
        req: http.IncomingMessage,
        socket: net.Socket,
        head: Buffer,
        cleanupCb: (id: string) => void
    ) {
        this.id = id;
        this.req = req;
        this.socket = socket;
        this.head = head;
        this.cleanupCb = cleanupCb;

        socket.on('close', () => {
            clearTimeout(this.attachTimeout);
            this.cleanupCb(this.id);
        });

        this.attachTimeout = setTimeout(() => {
            if (this.attached) return;
            console.warn(`Upgrade session ${this.id} timed out before control stream attached`);
            try { this.socket.destroy(); } catch (e) {}
        }, REQUEST_ATTACH_TIMEOUT_MS);
        this.attachTimeout.unref();
    }

    attachControlStream(stream: http2.ServerHttp2Stream) {
        this.attached = true;
        clearTimeout(this.attachTimeout);

        stream.respond({ ':status': 200 });

        // Reconstruct the original HTTP/1.1 request line + headers verbatim.
        const requestLine = `${this.req.method} ${this.req.url} HTTP/${this.req.httpVersion}\r\n`;
        const headerLines: string[] = [];
        for (let i = 0; i < this.req.rawHeaders.length; i += 2) {
            headerLines.push(`${this.req.rawHeaders[i]}: ${this.req.rawHeaders[i + 1]}`);
        }
        stream.write(requestLine + headerLines.join('\r\n') + '\r\n\r\n');
        if (this.head.length > 0) stream.write(this.head);

        // Splice raw bytes both ways. The 101 response and all post-upgrade
        // frames flow through unparsed.
        this.socket.pipe(stream);
        stream.pipe(this.socket);

        const teardown = () => {
            try { this.socket.destroy(); } catch (e) {}
            try { stream.destroy(); } catch (e) {}
        };
        this.socket.on('error', teardown);
        stream.on('error', teardown);
        stream.on('close', () => {
            try { this.socket.destroy(); } catch (e) {}
        });
    }

    close() {
        console.log(`Shutting down upgrade session ${this.id}`);
        clearTimeout(this.attachTimeout);
        try { this.socket.destroy(); } catch (e) {}
    }
}

/**
 * Tunnels a single inbound HTTP/2 request as HTTP/2 to the backend. We open a
 * fresh `http2.connect` whose underlying connection is the tunnel stream, then
 * issue one HTTP/2 request through it preserving pseudo-headers, regular headers
 * and trailers in both directions.
 */
class H2RequestSession {

    public readonly id: string;
    private readonly inboundStream: http2.ServerHttp2Stream;
    private readonly inboundHeaders: http2.IncomingHttpHeaders;
    private readonly cleanupCb: (id: string) => void;

    private attached = false;
    private readonly attachTimeout: NodeJS.Timeout;
    private respondedToInbound = false;

    constructor(
        id: string,
        inboundStream: http2.ServerHttp2Stream,
        inboundHeaders: http2.IncomingHttpHeaders,
        cleanupCb: (id: string) => void
    ) {
        this.id = id;
        this.inboundStream = inboundStream;
        this.inboundHeaders = inboundHeaders;
        this.cleanupCb = cleanupCb;

        inboundStream.on('close', () => {
            clearTimeout(this.attachTimeout);
            this.cleanupCb(this.id);
        });

        this.attachTimeout = setTimeout(() => {
            if (this.attached) return;
            console.warn(`H2 request session ${this.id} timed out before control stream attached`);
            try {
                if (!this.respondedToInbound) {
                    this.inboundStream.respond({ ':status': 504 });
                }
                this.inboundStream.end();
            } catch (e) {}
        }, REQUEST_ATTACH_TIMEOUT_MS);
        this.attachTimeout.unref();
    }

    attachControlStream(tunnelStream: http2.ServerHttp2Stream) {
        this.attached = true;
        clearTimeout(this.attachTimeout);

        tunnelStream.respond({ ':status': 200 });

        // Open an h2c client whose underlying connection IS the tunnel stream.
        const authority = (this.inboundHeaders[':authority'] as string | undefined) ?? 'localhost';
        const scheme = (this.inboundHeaders[':scheme'] as string | undefined) ?? 'http';
        const backend = http2.connect(`${scheme}://${authority}`, {
            createConnection: () => tunnelStream as any
        });

        const fail502 = () => {
            try {
                if (!this.respondedToInbound) {
                    this.inboundStream.respond({ ':status': 502 });
                    this.respondedToInbound = true;
                }
                this.inboundStream.end();
            } catch (e) {}
            try { tunnelStream.destroy(); } catch (e) {}
            try { backend.destroy(); } catch (e) {}
        };

        backend.on('error', (err) => {
            console.error(`H2 backend session ${this.id} error:`, err);
            fail502();
        });
        tunnelStream.on('error', (err) => {
            console.error(`H2 tunnel stream ${this.id} error:`, err);
            fail502();
        });

        // Forward all the inbound headers verbatim — pseudo-headers and regular
        // alike — to the backend. http2's request() accepts this shape directly.
        const backendReq = backend.request(this.inboundHeaders);
        backendReq.on('error', (err) => {
            console.error(`H2 backend request ${this.id} error:`, err);
            fail502();
        });

        // Pipe the inbound body to the backend, then attach trailers (if any)
        // before ending.
        this.inboundStream.pipe(backendReq, { end: false });
        const inboundTrailers: http2.IncomingHttpHeaders = {};
        this.inboundStream.on('trailers', (t) => Object.assign(inboundTrailers, t));
        this.inboundStream.on('end', () => {
            if (Object.keys(inboundTrailers).length > 0) {
                try { backendReq.sendTrailers(inboundTrailers); } catch (e) {}
            } else {
                backendReq.end();
            }
        });

        // Forward 1xx informational header frames
        backendReq.on('headers', (infoHeaders) => {
            if (this.respondedToInbound) return;
            try { this.inboundStream.additionalHeaders(infoHeaders); } catch (e) {}
        });

        // Pipe the backend response back to the inbound stream.
        backendReq.on('response', (respHeaders) => {
            if (this.respondedToInbound) return;
            this.respondedToInbound = true;
            this.inboundStream.respond(respHeaders);
            backendReq.pipe(this.inboundStream, { end: false });
            backendReq.on('trailers', (t) => {
                try { this.inboundStream.sendTrailers(t); } catch (e) {}
            });
            backendReq.on('end', () => {
                try { this.inboundStream.end(); } catch (e) {}
            });
        });
    }

    close() {
        console.log(`Shutting down H2 request session ${this.id}`);
        clearTimeout(this.attachTimeout);
        try {
            if (!this.respondedToInbound) {
                this.inboundStream.respond({ ':status': 502 });
            }
            this.inboundStream.end();
        } catch (e) {}
    }
}

function pairsFromRawTrailers(rawTrailers: string[] | undefined): [string, string][] {
    if (!rawTrailers) return [];
    const pairs: [string, string][] = [];
    for (let i = 0; i < rawTrailers.length; i += 2) {
        pairs.push([rawTrailers[i]!, rawTrailers[i + 1]!]);
    }
    return pairs;
}

function getNextLine(rl: readline.Interface): Promise<string> {
    return new Promise((resolve, reject) => {
        const onLine = (line: string) => {
            if (!line) return; // Ignore empty lines, can be used as keep-alives
            cleanup();
            resolve(line);
        };
        const onEnd = () => {
            cleanup();
            reject(new Error('Stream ended unexpectedly'));
        };
        const onError = (err: Error) => {
            cleanup();
            reject(err);
        };
        const cleanup = () => {
            rl.removeListener('line', onLine);
            rl.removeListener('close', onEnd);
            rl.removeListener('error', onError);
        };
        rl.on('line', onLine);
        rl.on('close', onEnd);
        rl.on('error', onError);
    });
}