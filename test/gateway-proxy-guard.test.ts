// Only the HTTPS proxy reaches the gateway's public port (PP-26): its name's addresses are let in (IPv4 written as
// IPv6 too); anyone else is refused; a miss looks the name up again, at most once a second, so a restarted proxy with a
// new address gets in at once; a failed lookup refuses.
import assert from "node:assert/strict";
import { test } from "node:test";
import { trustedProxy } from "../src/gateway/proxy-guard.ts";

test("the proxy's addresses only, looked up again on a miss at most once a second", async () => {
    let clock = 0;
    let addresses = ["172.18.0.3"];
    let lookups = 0;
    const allowed = trustedProxy(
        "caddy",
        async (name) => {
            assert.equal(name, "caddy");
            lookups++;

            if (addresses.length === 0) {
                throw new Error("ENOTFOUND");
            }

            return addresses;
        },
        () => clock,
    );

    assert.equal(await allowed("172.18.0.3"), true);
    assert.equal(await allowed("::ffff:172.18.0.3"), true, "IPv4 written as IPv6");
    assert.equal(lookups, 1);
    // A person's container: refused, and it can't make the gateway look up on every try.
    assert.equal(await allowed("172.19.0.2"), false);
    assert.equal(await allowed("172.19.0.2"), false);
    assert.equal(lookups, 1, "within a second of the last lookup: none");
    assert.equal(await allowed(undefined), false);

    // The proxy restarted with a new address: a second later it is looked up again and let in.
    addresses = ["172.18.0.9"];
    clock = 1500;
    assert.equal(await allowed("172.18.0.9"), true);
    assert.equal(await allowed("172.18.0.3"), false, "the old address no longer");

    // No answer from DNS: refused.
    addresses = [];
    clock = 3000;
    assert.equal(await allowed("10.0.0.1"), false);
});
