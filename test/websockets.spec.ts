import { once } from 'events';
import * as net from 'net';
import { expect } from 'chai';

import {
    setupServers,
    startTunnelClient,
    publicHostHeader,
    PUBLIC_PORT,
} from './test-utils.ts';

describe("WebSocket tunneled requests", () => {

    setupServers();

    it("proxies a WebSocket Upgrade end-to-end", async () => {
        const tunnel = await startTunnelClient();
        await tunnel.mockServer.forAnyWebSocket().thenEcho();

        // Speak the WS handshake by hand and assert raw frame round-trip.
        const socket = net.createConnection(PUBLIC_PORT, '127.0.0.1');
        await once(socket, 'connect');
        const wsKey = Buffer.from('0123456789abcdef').toString('base64');
        socket.write(
            `GET / HTTP/1.1\r\n` +
            `Host: ${publicHostHeader(tunnel.endpointId)}\r\n` +
            `Upgrade: websocket\r\n` +
            `Connection: Upgrade\r\n` +
            `Sec-WebSocket-Key: ${wsKey}\r\n` +
            `Sec-WebSocket-Version: 13\r\n\r\n`
        );

        // Wait for the 101 handshake response
        const handshake = await new Promise<Buffer>((resolve) => {
            let buf = Buffer.alloc(0);
            socket.on('data', function onData(c) {
                buf = Buffer.concat([buf, c]);
                if (buf.includes('\r\n\r\n')) {
                    socket.removeListener('data', onData);
                    resolve(buf);
                }
            });
        });
        expect(handshake.toString()).to.match(/101 Switching Protocols/i);

        // Send a masked WS text frame ("hi") and expect the echoed unmasked frame back.
        const frame = Buffer.from([
            0x81, 0x82, // FIN + text, masked, len 2
            0x00, 0x00, 0x00, 0x00, // mask key (zeros so payload is sent verbatim)
            0x68, 0x69 // "hi"
        ]);
        const echoed = new Promise<Buffer>((resolve) => socket.once('data', resolve));
        socket.write(frame);
        const reply = await echoed;
        // Echoed frame from server is unmasked: 0x81 0x02 'h' 'i'
        expect(reply[0]).to.equal(0x81);
        expect(reply.slice(-2).toString()).to.equal('hi');

        socket.destroy();
        await tunnel.close();
    });

});
