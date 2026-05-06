import { expect } from 'chai';

import {
    setupServers,
    startTunnelClient,
    fetchEndpoint,
    rawPublicRequest,
    PUBLIC_PORT,
    ROOT_DOMAIN,
} from './test-utils.ts';

describe("public endpoint routing", () => {

    setupServers();

    it("returns 404 for an unknown subdomain", async () => {
        const response = await fetchEndpoint('nonexistent', '/');
        expect(response.status).to.equal(404);
    });

    it("returns 404 for hostnames outside the root domain", async () => {
        const response = await fetch(`http://localhost:${PUBLIC_PORT}/`, {
            headers: { 'Host': 'attacker.example.com' }
        });
        expect(response.status).to.equal(404);
    });

    it("rejects requests with absolute URLs", async () => {
        // fetch() can't issue proxy-style absolute-URL requests; use a raw socket.
        const tunnel = await startTunnelClient();
        const data = await rawPublicRequest(
            `GET http://${tunnel.endpointId}.${ROOT_DOMAIN}/foo HTTP/1.1\r\n` +
            `Host: ${tunnel.endpointId}.${ROOT_DOMAIN}\r\n` +
            `Connection: close\r\n\r\n`
        );
        expect(data.toString()).to.match(/^HTTP\/1\.1 400/);
        await tunnel.close();
    });

    it("does not establish CONNECT tunnels", async () => {
        // The public server doesn't register a 'connect' handler, so Node closes
        // the socket without a successful CONNECT response. We just verify the
        // connection is not upgraded and produces no 2xx response.
        const tunnel = await startTunnelClient();
        const data = await rawPublicRequest(
            `CONNECT ${tunnel.endpointId}.${ROOT_DOMAIN}:${PUBLIC_PORT} HTTP/1.1\r\n` +
            `Host: ${tunnel.endpointId}.${ROOT_DOMAIN}\r\n\r\n`
        );
        expect(data.toString()).to.not.match(/HTTP\/1\.1 2\d\d/);
        await tunnel.close();
    });

});
