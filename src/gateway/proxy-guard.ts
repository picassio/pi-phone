/**
 * Only the HTTPS proxy reaches the gateway's public port (PP-26). The gateway is on every person's Docker network (it
 * forwards to their pi-phones there), so without this their containers could call it directly, past Caddy: with a
 * made-up `X-Forwarded-For` on each try, better-auth's per-address sign-in limit would not hold. People's pi-phones
 * use the internal port (8081) instead.
 *
 * The proxy is named (`PP_TRUSTED_PROXY=caddy` in compose) and resolved by Docker's DNS; a connection from any other
 * address is refused. A miss looks the name up again, at most once a second, so a restarted proxy with a new address
 * is let in at once.
 */
import { lookup } from "node:dns/promises";

/** How often a miss may look the proxy's name up again. */
const AGAIN_MS = 1000;

const plain = (address: string) => address.replace(/^::ffff:/, "");

/** Whether a connection's address is the proxy's. */
export function trustedProxy(
    name: string,
    resolve: (name: string) => Promise<string[]> = async (host) => (await lookup(host, { all: true })).map((each) => each.address),
    now: () => number = Date.now,
): (address: string | undefined) => Promise<boolean> {
    let known = new Set<string>();
    let at = -Infinity;

    return async (address) => {
        if (address === undefined) {
            return false;
        }

        const ip = plain(address);

        if (known.has(ip)) {
            return true;
        }

        if (now() - at < AGAIN_MS) {
            return false;
        }

        at = now();

        try {
            known = new Set((await resolve(name)).map(plain));
        } catch {
            return false;
        }

        return known.has(ip);
    };
}
