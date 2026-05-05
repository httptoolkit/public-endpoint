import { expect } from 'chai';

import {
    setupServers,
    startTunnelClient,
    fetchEndpoint,
    delay,
} from './test-utils.ts';

describe("Smoke test", () => {

    setupServers();

    it("registers a tunnel, serves a varied request mix, then unregisters cleanly on disconnect", async () => {
        const tunnel = await startTunnelClient();

        await tunnel.mockServer.forGet('/teapot').thenReply(418, 'short and stout', {
            'X-Backend': 'on'
        });
        const echoEndpoint = await tunnel.mockServer
            .forAnyRequest()
            .matching((req) => req.path.startsWith('/echo'))
            .thenCallback(async (req) => {
                const body = await req.body.getText();
                return {
                    statusCode: 200,
                    headers: { 'Content-Type': 'text/plain' },
                    body: `${req.method}:${req.headers['x-trace'] ?? '-'}:${body}`
                };
            });

        // 1) GET — basic forwarding, custom status & response header.
        const teapot = await fetchEndpoint(tunnel.endpointId, '/teapot');
        expect(teapot.status).to.equal(418);
        expect(teapot.headers.get('x-backend')).to.equal('on');
        expect(await teapot.text()).to.equal('short and stout');

        // 2) POST with body and custom request header.
        const echo = await fetchEndpoint(tunnel.endpointId, '/echo', {
            method: 'POST',
            headers: { 'X-Trace': 'abc123' },
            body: 'payload-data'
        });
        expect(echo.status).to.equal(200);
        expect(echo.headers.get('content-type')).to.equal('text/plain');
        expect(await echo.text()).to.equal('POST:abc123:payload-data');

        // 3) Concurrent requests on the same tunnel.
        const concurrent = await Promise.all([
            fetchEndpoint(tunnel.endpointId, '/echo/a', { method: 'PUT', body: 'A' }).then(r => r.text()),
            fetchEndpoint(tunnel.endpointId, '/echo/b', { method: 'PUT', body: 'B' }).then(r => r.text()),
            fetchEndpoint(tunnel.endpointId, '/echo/c', { method: 'PUT', body: 'C' }).then(r => r.text()),
        ]);
        expect(concurrent.sort()).to.deep.equal(['PUT:-:A', 'PUT:-:B', 'PUT:-:C']);

        // The Mockttp echo endpoint saw all four /echo* requests.
        const seenEchoes = await echoEndpoint.getSeenRequests();
        expect(seenEchoes.map(r => r.path).sort()).to.deep.equal([
            '/echo', '/echo/a', '/echo/b', '/echo/c'
        ]);

        // 4) Admin client disconnects — endpoint should disappear.
        await tunnel.close();
        await delay(50);

        const afterDisconnect = await fetchEndpoint(tunnel.endpointId, '/teapot');
        expect(afterDisconnect.status).to.equal(404);
    });

});
