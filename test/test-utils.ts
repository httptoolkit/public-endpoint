import { once } from 'events';
import { createInterface, Interface } from 'readline';
import * as net from 'net';
import * as http2 from 'http2';

import * as Mockttp from 'mockttp';
import { generateCACertificate } from 'mockttp';

import { startServers } from '../src/server.ts';
import { AdminServer } from '../src/admin-server.ts';
import { PublicEndpointServer } from '../src/public-endpoint-server.ts';

export const ADMIN_PORT = 5050;
export const PUBLIC_PORT = 5051;
export const ROOT_DOMAIN = 'e.localhost';

export interface ServerContext {
    adminServer: AdminServer;
    publicServer: PublicEndpointServer;
}

/**
 * Registers beforeEach/afterEach hooks that boot a fresh AdminServer +
 * PublicEndpointServer on the shared test ports and tear them down between tests.
 */
export function setupServers(): ServerContext {
    const ctx: Partial<ServerContext> = {};

    beforeEach(async () => {
        const servers = await startServers({
            adminPort: ADMIN_PORT,
            publicPort: PUBLIC_PORT,
            publicRootDomain: ROOT_DOMAIN
        });
        ctx.adminServer = servers[0] as AdminServer;
        ctx.publicServer = servers[1] as PublicEndpointServer;
    });

    afterEach(async () => {
        await Promise.allSettled([
            ctx.adminServer?.destroy(),
            ctx.publicServer?.destroy()
        ]);
    });

    return ctx as ServerContext;
}

let cachedCA: { key: string; cert: string } | undefined;
async function getTestCA() {
    if (!cachedCA) {
        const ca = await generateCACertificate({ subject: { commonName: 'public-endpoint-test-ca' } });
        cachedCA = { key: ca.key, cert: ca.cert };
    }
    return cachedCA;
}

export interface TunnelClient {
    endpointId: string;
    h2Client: http2.ClientHttp2Session;
    adminStream: http2.ClientHttp2Stream;
    lineStream: Interface;
    /** The local Mockttp instance every tunneled request is forwarded to. */
    mockServer: Mockttp.Mockttp;
    close: () => Promise<void>;
}

/**
 * Open an admin H2 session, complete the /start + auth handshake, and forward every
 * incoming /request/:id stream as raw TCP to a fresh local Mockttp instance. A good
 * approximation of the HTK server backend we'll use in reality.
 */
export async function startTunnelClient(): Promise<TunnelClient> {
    const ca = await getTestCA();
    const mockServer = Mockttp.getLocal({
        https: ca,
        http2: 'fallback'
    });
    await mockServer.start();

    const h2Client = http2.connect(`http://localhost:${ADMIN_PORT}`);
    const adminStream = h2Client.request({ ':method': 'POST', ':path': '/start' });
    adminStream.on('error', () => {});

    const [headers] = await once(adminStream, 'response') as [http2.IncomingHttpHeaders & http2.IncomingHttpStatusHeader];
    if (headers[':status'] !== 200) {
        throw new Error(`/start failed with status ${headers[':status']}`);
    }

    const lineStream = createInterface({ input: adminStream, crlfDelay: Infinity });
    lineStream.on('error', () => {});

    adminStream.write(JSON.stringify({ command: 'auth', params: {} }) + '\n');

    const [authLine] = await once(lineStream, 'line') as [string];
    const auth = JSON.parse(authLine);
    if (!auth.success) throw new Error(`auth failed: ${authLine}`);
    const endpointId = auth.endpointId as string;

    lineStream.on('line', (line) => {
        if (!line) return;
        let msg: any;
        try { msg = JSON.parse(line); } catch { return; }
        if (msg.command !== 'new-request') return;

        const requestStream = h2Client.request({
            ':method': 'POST',
            ':path': `/request/${msg.requestId}`
        });
        requestStream.on('error', () => {
            try { requestStream.destroy(); } catch {}
        });
        requestStream.on('response', (respHeaders) => {
            if (respHeaders[':status'] !== 200) {
                requestStream.destroy();
                return;
            }

            const conn = net.createConnection({ host: '127.0.0.1', port: mockServer.port });
            conn.on('error', () => {
                try { requestStream.destroy(); } catch {}
            });
            requestStream.pipe(conn);
            conn.pipe(requestStream);
        });
    });

    return {
        endpointId,
        h2Client,
        adminStream,
        lineStream,
        mockServer,
        close: async () => {
            try { adminStream.close(); } catch {}
            try { h2Client.close(); } catch {}
            try { await mockServer.stop(); } catch {}
        }
    };
}

export function fetchEndpoint(endpointId: string, path: string = '/', init?: RequestInit) {
    return fetch(`http://${endpointId}.${ROOT_DOMAIN}:${PUBLIC_PORT}${path}`, init);
}

export function delay(ms: number) {
    return new Promise<void>(resolve => setTimeout(resolve, ms));
}
