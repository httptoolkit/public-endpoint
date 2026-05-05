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

        const SHUTDOWN_GRACE_MS = parseInt(process.env.SHUTDOWN_GRACE_MS ?? '5000', 10);

        process.on('SIGTERM', async () => {
            console.log(`Received SIGTERM, shutting down (grace ${SHUTDOWN_GRACE_MS}ms)...`);
            await Promise.all(servers.map(s => s.shutdown(SHUTDOWN_GRACE_MS)));
            process.exit(0);
        });
    });
}