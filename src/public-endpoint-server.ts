import * as httpolyglot from '@httptoolkit/httpolyglot';
import * as http from 'http';

import { DestroyableServer, makeDestroyable } from 'destroyable-server';

import { AdminServer } from './admin-server.js';

export class PublicEndpointServer {

    private readonly port: number;
    private readonly rootDomain: string;

    private readonly adminServer: AdminServer;
    private readonly server: DestroyableServer;

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
    }

    public async start() {
        await new Promise<void>((resolve) => {
            this.server.listen({ port: this.port }, resolve);
        });
    }

    public async destroy() {
        return this.server.destroy();
    }

    private handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
        const hostHeader = req.headers[':authority'] as string | undefined ||
            req.headers['host'] ||
            '';
        const [hostname] = hostHeader.split(':');
        console.log(`Received public endpoint request for host: ${hostHeader}, url: ${req.url}`);

        if (!hostname.endsWith(this.rootDomain)) {
            console.log(`Rejected request for invalid public endpoint: ${hostname}`);
            res.writeHead(404);
            res.end();
            return;
        }

        // No tunnelling through public endpoints (that's a whole separate thing -hostHeader
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

        const subdomain = hostname.slice(0, hostname.length - this.rootDomain.length).replace(/\.$/, '');
        const adminSession = this.adminServer.getSession(subdomain);

        if (!adminSession) {
            console.log(`No admin session for unknown public endpoint: ${subdomain}`);
            res.writeHead(404);
            res.end();
            return;
        }

        console.log(`Connecting request for public endpoint ${subdomain} to admin session`);
        adminSession.startRequest(req, res);
    }

}