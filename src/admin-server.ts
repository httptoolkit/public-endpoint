import * as readline from 'readline';
import * as crypto from 'crypto';
import * as http from 'http';
import * as http2 from 'http2';

import { DestroyableServer, makeDestroyable } from 'destroyable-server';

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
                    return;
                } else if (headers[':path'] === '/end') {
                    stream.respond({ ':status': 200 })
                    stream.end();
                    session.close();
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
    }

    private async handleStartRequest(stream: http2.ServerHttp2Stream, session: http2.ServerHttp2Session) {
        stream.respond({ ':status': 200 });

        const lineStream = readline.createInterface({ input: stream, crlfDelay: Infinity });
        const firstLine = await getNextLine(lineStream);
        const firstCommand = JSON.parse(firstLine);

        if (firstCommand.command !== 'auth') {
            stream.end(JSON.stringify({ error: 'Auth required' }));
        }

        const endpointId = crypto.randomBytes(8).toString('hex');
        const adminSession = new AdminSession(endpointId, stream, session);
        this.connectionMap.set(endpointId, adminSession);

        stream.write(JSON.stringify({
            success: true,
            endpointId
        }) + '\n');

        stream.on('close', () => {
            this.connectionMap.delete(endpointId);
            adminSession.close();
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
    private readonly session: http2.ServerHttp2Session;

    private requestMap = new Map<string, RequestSession>();

    constructor(
        id: string,
        controlStream: http2.ServerHttp2Stream,
        session: http2.ServerHttp2Session
    ) {
        this.id = id;
        this.controlStream = controlStream;
        this.session = session;
    }

    close() {
        this.controlStream.end();
        this.session.close();
    }

    startRequest(req: http.IncomingMessage, res: http.ServerResponse) {
        const requestId = crypto.randomBytes(32).toString('hex');
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

        // In case they're somehow immediately closed, make sure we don't get stuck
        // waiting for events that never come (but debounce so startRequest setup
        // properly starts before cleanup).
        setImmediate(() => {
            this.maybeCleanup();
        });
    }

    maybeCleanup() {
        if (this.requestClosed && this.responseClosed) {
            this.cleanupCb(this.id);
        }
    }

    attachControlStream(stream: http2.ServerHttp2Stream) {
        stream.respond({ ':status': 200 });

        const tunnelledReq = http.request({
            method: this.req.method,
            path: this.req.url,
            headers: this.req.rawHeaders,
            setDefaultHeaders: false,
            createConnection: () => stream
        });
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

        tunnelledReq.on('error', (err) => {
            console.error('Error in tunneled request:', err);
            try {
                this.res.writeHead(502);
                this.res.end();
                setImmediate(() => this.req.destroy());
            } catch (e) {}
        });
    }

}

function getNextLine(rl: readline.Interface): Promise<string> {
    return new Promise((resolve, reject) => {
        rl.once('line', (line) => {
            if (!line) return; // Ignore empty lines, can be used as keep-alives
            resolve(line);
        });
        rl.once('end', () => reject(new Error('Stream ended unexpected')));
        rl.once('error', reject);
    });
}