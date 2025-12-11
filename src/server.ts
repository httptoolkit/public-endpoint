import { AdminServer } from './admin-server.js';
import { PublicEndpointServer } from './public-endpoint-server.js';

export async function startServers(options: {
    adminPort: number;
    publicPort: number;
    publicRootDomain: string;
}) {
    const adminServer = new AdminServer(options.adminPort);
    const publicServer = new PublicEndpointServer(
        adminServer,
        options.publicPort,
        options.publicRootDomain
    );

    await Promise.all([
        adminServer.start(),
        publicServer.start()
    ])

    return [adminServer, publicServer];
}

// This is not a perfect test (various odd cases) but good enough
const wasRunDirectly = import.meta.filename === process?.argv[1];
if (wasRunDirectly) {
    startServers({
        adminPort: parseInt(process.env.ADMIN_PORT ?? '4000', 10),
        publicPort: parseInt(process.env.PUBLIC_PORT ?? '4040', 10),
        publicRootDomain: process.env.PUBLIC_ROOT_DOMAIN ?? 'e.httptoolk.it'
    }).then((servers) => {
        console.log('Server started');

        process.on('SIGTERM', async () => {
            console.log('Received SIGTERM, shutting down...');
            // Close all connections when asked nicely to shut down:
            await Promise.all(servers.map(s => s.destroy()));
            process.exit(0);
        });
    });
}