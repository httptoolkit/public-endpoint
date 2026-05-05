import { expect } from 'chai';

import {
    setupServers,
    startTunnelClient,
    fetchEndpoint,
    delay,
} from './test-utils.ts';

describe("tunneled requests", () => {

    setupServers();

    it("forwards a basic GET request and response", async () => {
        const tunnel = await startTunnelClient();
        await tunnel.mockServer.forGet('/hello').thenReply(200, 'Hello through tunnel!');

        const response = await fetchEndpoint(tunnel.endpointId, '/hello');
        expect(response.status).to.equal(200);
        expect(await response.text()).to.equal('Hello through tunnel!');

        await tunnel.close();
    });

    it("forwards a request body and method", async () => {
        const tunnel = await startTunnelClient();
        const echo = await tunnel.mockServer.forPost('/echo').thenCallback(async (req) => ({
            statusCode: 200,
            body: `${req.method}:${await req.body.getText()}`
        }));

        const response = await fetchEndpoint(tunnel.endpointId, '/echo', {
            method: 'POST',
            body: 'request-body-content'
        });
        expect(await response.text()).to.equal('POST:request-body-content');

        const seen = await echo.getSeenRequests();
        expect(seen).to.have.length(1);
        expect(await seen[0]!.body.getText()).to.equal('request-body-content');

        await tunnel.close();
    });

    it("preserves request headers", async () => {
        const tunnel = await startTunnelClient();
        const endpoint = await tunnel.mockServer.forGet('/').thenReply(200, 'ok');

        await fetchEndpoint(tunnel.endpointId, '/', {
            headers: { 'X-Custom-Request': 'received-value' }
        });

        const [seen] = await endpoint.getSeenRequests();
        expect(seen?.headers['x-custom-request']).to.equal('received-value');

        await tunnel.close();
    });

    it("preserves response status and headers", async () => {
        const tunnel = await startTunnelClient();
        await tunnel.mockServer.forGet('/').thenReply(418, 'teapot', {
            'X-Custom-Response': 'echoed',
            'Content-Type': 'text/plain'
        });

        const response = await fetchEndpoint(tunnel.endpointId);
        expect(response.status).to.equal(418);
        expect(response.headers.get('x-custom-response')).to.equal('echoed');
        expect(response.headers.get('content-type')).to.equal('text/plain');
        expect(await response.text()).to.equal('teapot');

        await tunnel.close();
    });

    it("handles concurrent requests on a single tunnel", async () => {
        const tunnel = await startTunnelClient();
        let counter = 0;
        await tunnel.mockServer.forAnyRequest().thenCallback(async (req) => {
            const n = ++counter;
            await delay(40); // ensure overlap
            return { statusCode: 200, body: `${n}:${new URL(req.url).pathname}` };
        });

        const responses = await Promise.all([
            fetchEndpoint(tunnel.endpointId, '/a').then(r => r.text()),
            fetchEndpoint(tunnel.endpointId, '/b').then(r => r.text()),
            fetchEndpoint(tunnel.endpointId, '/c').then(r => r.text()),
        ]);

        const paths = responses.map(r => r.split(':')[1]).sort();
        const counts = responses.map(r => parseInt(r.split(':')[0]!, 10)).sort();
        expect(paths).to.deep.equal(['/a', '/b', '/c']);
        expect(counts).to.deep.equal([1, 2, 3]);

        await tunnel.close();
    });

    it("isolates traffic between tunnels", async () => {
        const tunnelA = await startTunnelClient();
        const tunnelB = await startTunnelClient();

        const aEndpoint = await tunnelA.mockServer.forGet('/foo').thenReply(200, 'A:/foo');
        const bEndpoint = await tunnelB.mockServer.forGet('/bar').thenReply(200, 'B:/bar');

        const [a, b] = await Promise.all([
            fetchEndpoint(tunnelA.endpointId, '/foo').then(r => r.text()),
            fetchEndpoint(tunnelB.endpointId, '/bar').then(r => r.text()),
        ]);

        expect(a).to.equal('A:/foo');
        expect(b).to.equal('B:/bar');
        expect(await aEndpoint.getSeenRequests()).to.have.length(1);
        expect(await bEndpoint.getSeenRequests()).to.have.length(1);

        await tunnelA.close();
        await tunnelB.close();
    });

    it("returns 502 when the backend tears down its end of the stream", async () => {
        const tunnel = await startTunnelClient();
        await tunnel.mockServer.forGet('/').thenCloseConnection();

        const response = await fetchEndpoint(tunnel.endpointId);
        expect(response.status).to.equal(502);

        await tunnel.close();
    });

    it("returns 502 when the admin client disconnects mid-request", async () => {
        const tunnel = await startTunnelClient();
        await tunnel.mockServer.forGet('/').thenTimeout();

        const inFlight = fetchEndpoint(tunnel.endpointId);
        await delay(50); // ensure the request is mid-tunnel

        await tunnel.close();

        const response = await inFlight;
        expect(response.status).to.be.at.least(500);
    });

});
