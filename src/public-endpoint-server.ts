import * as httpolyglot from '@httptoolkit/httpolyglot';
import * as http from 'http';
import * as http2 from 'http2';
import * as net from 'net';

import { DestroyableServer, makeDestroyable } from 'destroyable-server';

import { AdminServer } from './admin-server.js';

export class PublicEndpointServer {

    private readonly port: number;
    private readonly rootDomain: string;

    private readonly adminServer: AdminServer;
    private readonly server: DestroyableServer;

    private destroyed = false;

    constructor(
        adminServer: AdminServer,
        port: number,
        rootDomain: string
    ) {
        this.adminServer = adminServer;
        this.port = port;
        this.rootDomain = rootDomain;

        this.server = makeDestroyable(httpolyglot.createServer({
            socks: undefined,
            unknownProtocol: undefined,
            tls: undefined
        }, this.handleRequest.bind(this)));

        // We subscribe to 'request' (HTTP/1), 'upgrade' (HTTP/1 Upgrade) and 'stream'
        // (HTTP/2). Registering 'stream' suppresses 'request' for HTTP/2 streams, so
        // each request lands in exactly one handler.
        this.server.on('upgrade', this.handleUpgrade.bind(this));
        this.server.on('stream', this.handleH2Stream.bind(this));
    }

    public async start() {
        await new Promise<void>((resolve) => {
            this.server.listen({ port: this.port }, resolve);
        });
    }

    public async destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        await this.server.destroy();
    }

    public async shutdown(graceMs: number) {
        if (this.destroyed) return;
        this.destroyed = true;
        const closed = new Promise<void>((resolve) => this.server.close(() => resolve()));
        const grace = new Promise<void>((resolve) => setTimeout(resolve, graceMs).unref());
        await Promise.race([closed, grace]);
    }

    private resolveAdminSession(hostHeader: string) {
        const [hostname] = hostHeader.split(':');
        if (!hostname || !hostname.endsWith(this.rootDomain)) return undefined;
        const subdomain = hostname.slice(0, hostname.length - this.rootDomain.length).replace(/\.$/, '');
        return this.adminServer.getSession(subdomain);
    }

    private handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
        const hostHeader = req.headers[':authority'] as string | undefined ||
            req.headers['host'] ||
            '';
        const [hostname] = hostHeader.split(':');
        console.log(`Received public endpoint request for host: ${hostHeader}, url: ${req.url}`);

        if (!hostname || !hostname.endsWith(this.rootDomain)) {
            console.log(`Rejected request for invalid public endpoint: ${hostname}`);
            res.writeHead(404);
            res.end();
            return;
        }

        // No tunnelling through public endpoints (that's a whole separate thing -
        // watch this space!)
        if (req.method === 'CONNECT') {
            console.log(`Rejected CONNECT request on public endpoint: ${hostHeader}`);
            res.writeHead(405);
            res.end();
            return;
        }

        // Same again, for absolute URLs:
        if (!req.url!.startsWith('/')) {
            console.log(`Rejected request with non-relative URL: ${req.url}`);
            res.writeHead(400);
            res.end();
            return;
        }

        const adminSession = this.resolveAdminSession(hostHeader);
        if (!adminSession) {
            console.log(`No admin session for unknown public endpoint host: ${hostHeader}`);
            res.writeHead(404);
            res.end();
            return;
        }

        console.log(`Connecting request for public endpoint ${hostname} to admin session`);
        adminSession.startRequest(req, res);
    }

    private handleH2Stream(stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) {
        const authority = (headers[':authority'] as string | undefined) ?? '';
        const path = (headers[':path'] as string | undefined) ?? '';
        const method = headers[':method'] as string | undefined;
        console.log(`Received public endpoint H2 stream for authority: ${authority}, path: ${path}`);

        if (method === 'CONNECT') {
            stream.respond({ ':status': 405 });
            stream.end();
            return;
        }
        if (!path.startsWith('/')) {
            stream.respond({ ':status': 400 });
            stream.end();
            return;
        }

        const adminSession = this.resolveAdminSession(authority);
        if (!adminSession) {
            console.log(`No admin session for unknown public endpoint H2 host: ${authority}`);
            stream.respond({ ':status': 404 });
            stream.end();
            return;
        }

        adminSession.startH2Stream(stream, headers);
    }

    private handleUpgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer) {
        const hostHeader = req.headers['host'] || '';
        console.log(`Received public endpoint upgrade for host: ${hostHeader}, url: ${req.url}`);

        if (!req.url || !req.url.startsWith('/')) {
            socket.destroy();
            return;
        }

        const adminSession = this.resolveAdminSession(hostHeader);
        if (!adminSession) {
            console.log(`No admin session for unknown public endpoint upgrade: ${hostHeader}`);
            socket.destroy();
            return;
        }

        adminSession.startUpgrade(req, socket, head);
    }

}