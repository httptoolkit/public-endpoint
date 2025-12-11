import { once } from 'events';
import { createInterface } from 'readline';
import * as http from 'http';
import * as http2 from 'http2';
import { expect } from 'chai';

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

describe("Smoke test", () => {

    let servers: Array<{ destroy: () => Promise<void> }>;

    beforeEach(async () => {
        servers = await startServers({
            adminPort: ADMIN_PORT,
            publicPort: PUBLIC_PORT,
            publicRootDomain: 'e.localhost'
        });
    });

    afterEach(async () => {
        await Promise.all(servers.map(s => s.destroy()));
    });

    it("can create & tunnel an HTTP request", async () => {
        const h2Client = http2.connect(`http://localhost:${ADMIN_PORT}/`);
        const adminReq = h2Client.request({
            ':method': 'POST',
            ':path': '/start'
        });

        const [headers] = await once(adminReq, 'response') as [http2.OutgoingHttpHeaders];
        expect(headers[':status']).to.equal(200);

        const lineStream = createInterface({ input: adminReq, crlfDelay: Infinity });
        let nextLine: string | undefined;

        adminReq.write(JSON.stringify({
            command: 'auth',
            params: {} // TODO: We'll authenticate properly later
        }) + '\n');

        [nextLine] = await once(lineStream, 'line') as [string];
        const adminResponse = JSON.parse(nextLine);
        expect(adminResponse.success).to.equal(true);
        expect(adminResponse.endpointId).to.be.a('string');

        const endpointRequest = fetch(`http://${adminResponse.endpointId}.e.localhost:${PUBLIC_PORT}/test-path`);

        [nextLine] = await once(lineStream, 'line') as [string];
        const requestSetupCommand = JSON.parse(nextLine);
        expect(requestSetupCommand.command).to.equal('new-request');
        expect(requestSetupCommand.requestId).to.be.a('string');

        const requestSession = h2Client.request({
            ':method': 'POST',
            ':path': `/request/${requestSetupCommand.requestId}`
        });

        requestSession.on('response', (headers) => {
            expect(headers[':status']).to.equal(200);

            const httpServer = http.createServer((req, res) => {
                expect(req.url).to.equal('/test-path');
                res.writeHead(200);
                res.end('Hello through tunnel!');
            });
            httpServer.emit('connection', requestSession);
        });

        const endpointResponse = await endpointRequest;
        expect(endpointResponse.status).to.equal(200);
        const endpointText = await endpointResponse.text();
        expect(endpointText).to.equal('Hello through tunnel!');

        adminReq.write(JSON.stringify({
            command: 'end'
        }) + '\n');
        adminReq.close();
        h2Client.close();
    });

});