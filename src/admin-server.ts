import * as readline from 'readline';
import * as crypto from 'crypto';
import * as http from 'http';
import * as http2 from 'http2';

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
        return this.server.destroy();
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

    private requestMap = new Map<string, RequestSession>();

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

    close() {
        if (this.closed) return;
        this.closed = true;

        console.log(`Shutting down admin session ${this.id}`);
        clearInterval(this.keepaliveInterval);

        try { this.controlStream.end(); } catch (e) {}
        try { this.h2Session.close(); } catch (e) {}

        for (let requestSession of this.requestMap.values()) {
            requestSession.close();
        }

        // Try to cleanup nicely, then just kill everything
        setTimeout(() => {
            this.h2Session.destroy();
        }, 5_000).unref();

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

    getRequestSession(requestId: string): RequestSession | undefined {
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
        tunnelledReq.flushHeaders();
        this.req.pipe(tunnelledReq);

        tunnelledReq.on('response', (tunnelledRes) => {
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
            tunnelledRes.pipe(this.res);

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
            this.res.end();
        } catch (e) {}
        try {
            this.req.destroy();
        } catch (e) {}
    }

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