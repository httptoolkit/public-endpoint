import * as http2 from 'http2';
import * as httpolyglot from '@httptoolkit/httpolyglot';
import { makeDestroyable, DestroyableServer } from 'destroyable-server';

async function startAdminServer(options: {
    adminPort: number;
}) {
    const adminServer = makeDestroyable(http2.createServer());
    adminServer.on('session', (session) => {
        session.on('stream', (stream, headers) => {
            console.log('Received admin request:', headers[':method'], headers[':path']);
            stream.respond({ ':status': 200 });
            stream.end("Hello world");
        });
    });

    await new Promise<void>((resolve) => {
        adminServer.listen({ port: options.adminPort }, resolve);
    });

    return adminServer;
}

async function startPublicUrlServer(options: {
    publicPorts: number[];
}) {
    const server = makeDestroyable(httpolyglot.createServer({
        socks: undefined,
        unknownProtocol: undefined,
        tls: undefined
    }, (req, res) => {
        console.log(`Received public url request: ${req.method} ${req.url}`);
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Hello from Public URL Server!\n');
    }));

    await Promise.all([
        options.publicPorts.map((port) => {
            return new Promise<void>((resolve) => {
                server.listen(port, () => {
                    console.log(`Public URL Server listening on port ${port}`);
                    resolve();
                });
            });
        })
    ]);

    return server;
}

export async function startServers(options: {
    adminPort: number;
    publicPorts: number[];
}) {
    const servers = await Promise.all([
        startAdminServer({ adminPort: options.adminPort }),
        startPublicUrlServer({ publicPorts: options.publicPorts })
    ]);

    return servers as DestroyableServer[];
}

// This is not a perfect test (various odd cases) but good enough
const wasRunDirectly = import.meta.filename === process?.argv[1];
if (wasRunDirectly) {
    startServers({
        adminPort: parseInt(process.env.ADMIN_PORT ?? '4000', 10),
        publicPorts: (process.env.PUBLIC_PORTS ?? '8080').split(',').map(p => parseInt(p, 10))
    }).then(() => {
        console.log('Server started');
    });
}