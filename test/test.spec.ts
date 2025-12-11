import * as http from 'http';
import * as http2 from 'http2';
import { expect } from 'chai';
import * as streamConsumers from 'stream/consumers';
import { DestroyableServer } from 'destroyable-server';

import { startServers } from '../src/server.ts';

function sendH2Request(port: number, path: string): Promise<{ headers: http2.IncomingHttpHeaders; stream: http2.ClientHttp2Stream }> {
    return new Promise((resolve, reject) => {
        const client = http2.connect(`http://localhost:${port}`);
        const req = client.request({ ':path': path });

        req.on('response', (headers) => {
            resolve({ headers, stream: req });
        });
        req.on('error', reject);
        req.end();
    });
}

const ADMIN_PORT = 5050;
const PUBLIC_PORT = 5001;

describe("Server setup", () => {

    let servers: DestroyableServer[];

    beforeEach(async () => {
        servers = await startServers({
            adminPort: ADMIN_PORT,
            publicPort: PUBLIC_PORT
        });
    });

    afterEach(async () => {
        await Promise.all(servers.map(s => s.destroy()));
    });

    it("sets up a public endpoint", async () => {
        const response = await fetch(`http://localhost:${PUBLIC_PORT}/`);
        const text = await response.text();

        expect(response.status).to.equal(200);
        expect(text).to.equal('Hello from Public URL Server!\n');
    });

    it("sets up a admin API endpoint", async () => {
        const h2Response = await sendH2Request(ADMIN_PORT, '/');

        expect(h2Response.headers[':status']).to.equal(200);

        expect(await streamConsumers.text(h2Response.stream)).to.equal('Hello world');
    });

});