import * as http2 from 'http2';
import { expect } from 'chai';

import {
    setupServers,
    startTunnelClient,
    fetchEndpoint,
    delay,
    ADMIN_PORT,
} from './test-utils.ts';

describe("graceful shutdown", () => {

    const ctx = setupServers();

    it("notifies connected admin clients with a shutdown command", async () => {
        const tunnel = await startTunnelClient();

        const notified = new Promise<boolean>((resolve) => {
            tunnel.lineStream.on('line', (line) => {
                if (!line) return;
                try {
                    const msg = JSON.parse(line);
                    if (msg.command === 'shutdown') resolve(true);
                } catch {}
            });
        });

        const shutdownPromise = ctx.adminServer.shutdown(200);

        const result = await Promise.race([
            notified,
            delay(500).then(() => false)
        ]);
        expect(result).to.equal(true);

        await shutdownPromise;
        await tunnel.close();
    });

    it("blocks new admin connections after shutdown", async () => {
        await ctx.adminServer.shutdown(50);

        const h2 = http2.connect(`http://localhost:${ADMIN_PORT}`);
        const errored = await new Promise<boolean>((resolve) => {
            h2.on('error', () => resolve(true));
            h2.on('connect', () => resolve(false));
            setTimeout(() => resolve(false), 200);
        });
        expect(errored).to.equal(true);
        h2.close();
    });

    it("kills active tunnels that don't drain within the grace window", async () => {
        const tunnel = await startTunnelClient();
        await tunnel.mockServer.forGet('/').thenTimeout();

        const inFlight = fetchEndpoint(tunnel.endpointId)
            .then(r => ({ status: r.status }))
            .catch(err => ({ error: err }));
        await delay(50);

        await ctx.adminServer.shutdown(50);

        const result = await inFlight;
        if ('error' in result) {
            expect(result.error).to.exist;
        } else {
            expect(result.status).to.be.at.least(500);
        }

        await tunnel.close();
    });

});
