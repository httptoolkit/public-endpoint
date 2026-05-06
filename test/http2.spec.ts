import { once } from 'events';
import * as http2 from 'http2';
import { expect } from 'chai';

import {
    setupServers,
    startTunnelClient,
    publicHostHeader,
    PUBLIC_PORT,
    ROOT_DOMAIN,
} from './test-utils.ts';

describe("HTTP/2 tunneled requests", () => {

    setupServers();

    it("forwards an HTTP/2 request as HTTP/2 to the backend", async () => {
        // Mockttp configured with http2 enabled accepts H2 traffic.
        const tunnel = await startTunnelClient();
        const endpoint = await tunnel.mockServer.forPost('/h2-path').thenReply(200, 'h2-ok');

        // Public client uses h2c against the public endpoint.
        const publicH2 = http2.connect(`http://${tunnel.endpointId}.${ROOT_DOMAIN}:${PUBLIC_PORT}`);
        const req = publicH2.request({
            ':method': 'POST',
            ':path': '/h2-path',
            ':scheme': 'http',
            ':authority': publicHostHeader(tunnel.endpointId)
        });
        req.end('h2-body');

        const [respHeaders] = await once(req, 'response') as [http2.IncomingHttpHeaders & http2.IncomingHttpStatusHeader];
        expect(respHeaders[':status']).to.equal(200);

        const body = await new Promise<string>((resolve) => {
            let s = '';
            req.setEncoding('utf8');
            req.on('data', (c) => { s += c; });
            req.on('end', () => resolve(s));
        });
        expect(body).to.equal('h2-ok');

        const [seen] = await endpoint.getSeenRequests();
        expect(seen!.method).to.equal('POST');
        expect(seen!.protocol).to.equal('http'); // HTTP/2 over cleartext
        expect((seen as any).httpVersion).to.equal('2.0');

        publicH2.close();
        await tunnel.close();
    });

    it("routes streams on a coalesced H2 connection to different tunnels by :authority", async () => {
        // Browsers reuse a single TLS/H2 connection across subdomains covered
        // by a wildcard cert (RFC 7540 §9.1.1). Each stream's :authority must
        // route independently — no connection-level binding to one tunnel.
        const tunnelA = await startTunnelClient();
        const tunnelB = await startTunnelClient();
        const endpointA = await tunnelA.mockServer.forGet('/a').thenReply(200, 'from-a');
        const endpointB = await tunnelB.mockServer.forGet('/b').thenReply(200, 'from-b');

        // Single h2c connection. The TCP target is irrelevant since all
        // subdomains resolve to the same listener; routing is by :authority.
        const publicH2 = http2.connect(`http://${tunnelA.endpointId}.${ROOT_DOMAIN}:${PUBLIC_PORT}`);

        const makeReq = (endpointId: string, path: string) => {
            const req = publicH2.request({
                ':method': 'GET',
                ':path': path,
                ':scheme': 'http',
                ':authority': publicHostHeader(endpointId)
            });
            req.end();
            return new Promise<{ status: number; body: string }>((resolve, reject) => {
                let body = '';
                let status = 0;
                req.on('response', (h) => { status = h[':status'] as number; });
                req.setEncoding('utf8');
                req.on('data', (c) => { body += c; });
                req.on('end', () => resolve({ status, body }));
                req.on('error', reject);
            });
        };

        // Fire concurrently on the same TCP connection.
        const [respA, respB] = await Promise.all([
            makeReq(tunnelA.endpointId, '/a'),
            makeReq(tunnelB.endpointId, '/b')
        ]);

        expect(respA.status).to.equal(200);
        expect(respA.body).to.equal('from-a');
        expect(respB.status).to.equal(200);
        expect(respB.body).to.equal('from-b');

        // Confirm each backend saw exactly its own request — no crosstalk.
        const seenA = await endpointA.getSeenRequests();
        const seenB = await endpointB.getSeenRequests();
        expect(seenA).to.have.length(1);
        expect(seenB).to.have.length(1);

        publicH2.close();
        await tunnelA.close();
        await tunnelB.close();
    });

});
