import { expect } from 'chai';

import {
    setupServers,
    startTunnelClient,
    fetchEndpoint,
    rawPublicRequest,
    publicHostHeader,
    delay,
} from './test-utils.ts';

describe("HTTP/1 tunneled requests", () => {

    setupServers();

    describe("basic request/response", () => {

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

    });

    describe("header fidelity", () => {

        it("preserves request header case, order and duplicates", async () => {
            const tunnel = await startTunnelClient();
            const endpoint = await tunnel.mockServer.forGet('/').thenReply(200);

            await rawPublicRequest(
                `GET / HTTP/1.1\r\n` +
                `Host: ${publicHostHeader(tunnel.endpointId)}\r\n` +
                `X-Mixed-Case: one\r\n` +
                `x-lower: two\r\n` +
                `X-MIXED-CASE: three\r\n` +
                `Connection: close\r\n\r\n`
            );

            const [seen] = await endpoint.getSeenRequests();
            const raw = seen!.rawHeaders;
            // Casing preserved on every header
            const names = raw.map(([n]) => n);
            expect(names).to.include('X-Mixed-Case');
            expect(names).to.include('x-lower');
            expect(names).to.include('X-MIXED-CASE');
            // Duplicate header preserved twice with original values, in order
            const mixedValues = raw.filter(([n]) => n.toLowerCase() === 'x-mixed-case').map(([, v]) => v);
            expect(mixedValues).to.deep.equal(['one', 'three']);

            await tunnel.close();
        });

        it("preserves a custom request header end-to-end", async () => {
            const tunnel = await startTunnelClient();
            const endpoint = await tunnel.mockServer.forGet('/').thenReply(200, 'ok');

            await fetchEndpoint(tunnel.endpointId, '/', {
                headers: { 'X-Custom-Request': 'received-value' }
            });

            const [seen] = await endpoint.getSeenRequests();
            expect(seen?.headers['x-custom-request']).to.equal('received-value');

            await tunnel.close();
        });

        it("preserves duplicate response headers (e.g. Set-Cookie)", async () => {
            const tunnel = await startTunnelClient();
            await tunnel.mockServer.forGet('/').thenReply(200, 'ok', {
                'Set-Cookie': ['a=1', 'b=2'],
                'X-Multi': ['one', 'two']
            });

            const response = await fetchEndpoint(tunnel.endpointId);
            expect(response.headers.getSetCookie()).to.deep.equal(['a=1', 'b=2']);
            const multi = response.headers.get('x-multi');
            expect(multi).to.match(/one.*two/);

            await tunnel.close();
        });

    });

    describe("strict parser smuggling defences", () => {

        // We forward rawHeaders verbatim with setDefaultHeaders:false. That's
        // only safe if Node's strict parser is rejecting smuggling-shaped
        // requests on the inbound side. If someone ever flips on
        // --insecure-http-parser / insecureHTTPParser:true, these regress.

        it("rejects requests with conflicting Content-Length values", async () => {
            const tunnel = await startTunnelClient();
            const endpoint = await tunnel.mockServer.forPost('/').thenReply(200);

            const reply = await rawPublicRequest(
                `POST / HTTP/1.1\r\n` +
                `Host: ${publicHostHeader(tunnel.endpointId)}\r\n` +
                `Content-Length: 5\r\n` +
                `Content-Length: 6\r\n` +
                `Connection: close\r\n\r\n` +
                `hello`
            );

            expect(reply.toString()).to.not.match(/HTTP\/1\.1 2\d\d/);
            const seen = await endpoint.getSeenRequests();
            expect(seen).to.have.length(0);

            await tunnel.close();
        });

        it("rejects requests with bare LF in header values", async () => {
            const tunnel = await startTunnelClient();
            const endpoint = await tunnel.mockServer.forGet('/').thenReply(200);

            const reply = await rawPublicRequest(
                `GET / HTTP/1.1\r\n` +
                `Host: ${publicHostHeader(tunnel.endpointId)}\r\n` +
                `X-Smuggle: foo\nSmuggled-Header: yes\r\n` +
                `Connection: close\r\n\r\n`
            );

            expect(reply.toString()).to.not.match(/HTTP\/1\.1 2\d\d/);
            const seen = await endpoint.getSeenRequests();
            for (const req of seen) {
                const names = req.rawHeaders.map(([n]) => n.toLowerCase());
                expect(names).to.not.include('smuggled-header');
            }

            await tunnel.close();
        });

        it("rejects requests with malformed chunked framing", async () => {
            const tunnel = await startTunnelClient();
            const endpoint = await tunnel.mockServer.forPost('/').thenReply(200);

            const reply = await rawPublicRequest(
                `POST / HTTP/1.1\r\n` +
                `Host: ${publicHostHeader(tunnel.endpointId)}\r\n` +
                `Transfer-Encoding: chunked\r\n` +
                `Connection: close\r\n\r\n` +
                `zzzz\r\nhello\r\n0\r\n\r\n`
            );

            expect(reply.toString()).to.not.match(/HTTP\/1\.1 2\d\d/);
            const seen = await endpoint.getSeenRequests();
            expect(seen).to.have.length(0);

            await tunnel.close();
        });

    });

    describe("trailers", () => {

        it("forwards request trailers to the backend", async () => {
            const tunnel = await startTunnelClient();
            const endpoint = await tunnel.mockServer.forPost('/').thenReply(200);

            await rawPublicRequest(
                `POST / HTTP/1.1\r\n` +
                `Host: ${publicHostHeader(tunnel.endpointId)}\r\n` +
                `Transfer-Encoding: chunked\r\n` +
                `Trailer: X-After\r\n` +
                `Connection: close\r\n\r\n` +
                `5\r\nhello\r\n` +
                `0\r\n` +
                `X-After: trailer-value\r\n\r\n`
            );

            const [seen] = await endpoint.getSeenRequests();
            const trailers = seen!.rawTrailers ?? [];
            const found = trailers.find(([n]) => n.toLowerCase() === 'x-after');
            expect(found?.[1]).to.equal('trailer-value');

            await tunnel.close();
        });

        it("forwards response trailers to the public client", async () => {
            const tunnel = await startTunnelClient();
            await tunnel.mockServer.forGet('/').thenReply(
                200, 'body',
                { 'Trailer': 'X-Final', 'Transfer-Encoding': 'chunked' },
                { 'X-Final': 'trailer-set' }
            );

            const data = await rawPublicRequest(
                `GET / HTTP/1.1\r\n` +
                `Host: ${publicHostHeader(tunnel.endpointId)}\r\n` +
                `TE: trailers\r\n` +
                `Connection: close\r\n\r\n`
            );

            expect(data.toString()).to.match(/x-final:\s*trailer-set/i);

            await tunnel.close();
        });

    });

    describe("informational responses", () => {

        it("forwards 1xx informational responses ahead of the final response", async () => {
            const tunnel = await startTunnelClient();
            await tunnel.mockServer.forGet('/')
                .sendInfoResponse(103, { 'Link': '</style.css>; rel=preload' })
                .thenReply(200, 'final-body');

            const data = await rawPublicRequest(
                `GET / HTTP/1.1\r\n` +
                `Host: ${publicHostHeader(tunnel.endpointId)}\r\n` +
                `Connection: close\r\n\r\n`
            );

            const text = data.toString();
            const earlyIdx = text.indexOf('103');
            const finalIdx = text.indexOf('200');
            expect(earlyIdx).to.be.greaterThan(-1);
            expect(finalIdx).to.be.greaterThan(earlyIdx);
            expect(text).to.match(/Link:\s*<\/style\.css>;\s*rel=preload/i);
            expect(text).to.match(/final-body/);

            await tunnel.close();
        });

        it("forwards multiple 1xx informationals in order", async () => {
            const tunnel = await startTunnelClient();
            await tunnel.mockServer.forGet('/')
                .sendInfoResponse(103, { 'Link': '</a.css>; rel=preload' })
                .sendInfoResponse(103, { 'Link': '</b.css>; rel=preload' })
                .thenReply(200, 'final-body');

            const data = await rawPublicRequest(
                `GET / HTTP/1.1\r\n` +
                `Host: ${publicHostHeader(tunnel.endpointId)}\r\n` +
                `Connection: close\r\n\r\n`
            );

            const text = data.toString();
            const firstHint = text.indexOf('a.css');
            const secondHint = text.indexOf('b.css');
            const finalIdx = text.indexOf('200');
            expect(firstHint).to.be.greaterThan(-1);
            expect(secondHint).to.be.greaterThan(firstHint);
            expect(finalIdx).to.be.greaterThan(secondHint);
            expect(text).to.match(/final-body/);

            await tunnel.close();
        });

    });

    describe("tunnel teardown", () => {

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

});
