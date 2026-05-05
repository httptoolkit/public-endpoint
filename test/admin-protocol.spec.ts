import { once } from 'events';
import { createInterface } from 'readline';
import * as http2 from 'http2';
import { expect } from 'chai';

import {
    setupServers,
    startTunnelClient,
    fetchEndpoint,
    delay,
    ADMIN_PORT,
} from './test-utils.ts';

describe("admin protocol", () => {

    setupServers();

    it("issues unique endpointIds across separate sessions", async () => {
        const a = await startTunnelClient();
        const b = await startTunnelClient();
        expect(a.endpointId).to.match(/^[0-9a-z]{8}$/);
        expect(b.endpointId).to.not.equal(a.endpointId);
        await a.close();
        await b.close();
    });

    it("rejects /start when the first command isn't 'auth'", async () => {
        const h2 = http2.connect(`http://localhost:${ADMIN_PORT}`);
        const req = h2.request({ ':method': 'POST', ':path': '/start' });

        const [headers] = await once(req, 'response') as [http2.IncomingHttpHeaders & http2.IncomingHttpStatusHeader];
        expect(headers[':status']).to.equal(200);

        const lines = createInterface({ input: req, crlfDelay: Infinity });
        req.write(JSON.stringify({ command: 'something-else' }) + '\n');

        const [response] = await once(lines, 'line') as [string];
        expect(JSON.parse(response)).to.have.property('error', 'Auth required');

        req.close();
        h2.close();
    });

    it("tolerates empty keep-alive lines before the auth message", async () => {
        const h2 = http2.connect(`http://localhost:${ADMIN_PORT}`);
        const req = h2.request({ ':method': 'POST', ':path': '/start' });
        await once(req, 'response');

        const lines = createInterface({ input: req, crlfDelay: Infinity });

        req.write('\n\n');
        await delay(20);
        req.write(JSON.stringify({ command: 'auth', params: {} }) + '\n');

        const [authLine] = await once(lines, 'line') as [string];
        const parsed = JSON.parse(authLine);
        expect(parsed.success).to.equal(true);
        expect(parsed.endpointId).to.be.a('string');

        req.close();
        h2.close();
    });

    it("rejects a duplicate /start on the same H2 session", async () => {
        const tunnel = await startTunnelClient();

        const dup = tunnel.h2Client.request({ ':method': 'POST', ':path': '/start' });
        const [headers] = await once(dup, 'response') as [http2.IncomingHttpHeaders & http2.IncomingHttpStatusHeader];
        expect(headers[':status']).to.equal(400);

        await tunnel.close();
    });

    it("rejects /request/:id streams that arrive before /start", async () => {
        const h2 = http2.connect(`http://localhost:${ADMIN_PORT}`);
        const req = h2.request({ ':method': 'POST', ':path': '/request/whatever' });
        const [headers] = await once(req, 'response') as [http2.IncomingHttpHeaders & http2.IncomingHttpStatusHeader];
        expect(headers[':status']).to.equal(400);

        req.close();
        h2.close();
    });

    it("rejects /request/:id streams for unknown request IDs", async () => {
        const tunnel = await startTunnelClient();

        const bogus = tunnel.h2Client.request({
            ':method': 'POST',
            ':path': '/request/this-id-does-not-exist'
        });
        const [headers] = await once(bogus, 'response') as [http2.IncomingHttpHeaders & http2.IncomingHttpStatusHeader];
        expect(headers[':status']).to.equal(404);

        await tunnel.close();
    });

    it("rejects unknown methods with 404", async () => {
        const tunnel = await startTunnelClient();

        const get = tunnel.h2Client.request({ ':method': 'GET', ':path': '/start' });
        const [headers] = await once(get, 'response') as [http2.IncomingHttpHeaders & http2.IncomingHttpStatusHeader];
        expect(headers[':status']).to.equal(404);

        await tunnel.close();
    });

    it("removes the endpoint when the admin client disconnects", async () => {
        const tunnel = await startTunnelClient();
        await tunnel.mockServer.forGet('/').thenReply(200, 'ok');
        const id = tunnel.endpointId;

        const before = await fetchEndpoint(id);
        expect(before.status).to.equal(200);

        await tunnel.close();
        await delay(50);

        const after = await fetchEndpoint(id);
        expect(after.status).to.equal(404);
    });

});
