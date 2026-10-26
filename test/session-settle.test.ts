// When a session settles (`web/session-settle.js`): idle a day, settled by hand, kept up by work or a waiting call;
// a pinned session never settles by being idle (the owner, 2026-10-26: "pinned, but pushed into Settled").
import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error: a browser module, without types.
import { SETTLE_IDLE_MS, settledOf } from "../web/session-settle.js";

const now = 10 * SETTLE_IDLE_MS;
const idle = { id: 1, updatedAt: now - SETTLE_IDLE_MS - 60_000 };

test("idle a day settles a session, unless it is pinned", () => {
    assert.equal(settledOf(idle, now), "idle a day");
    assert.equal(settledOf(idle, now, false), "idle a day");
    assert.equal(settledOf(idle, now, true), null, "pinned: it stays up");
    assert.equal(settledOf({ ...idle, updatedAt: now - 60_000 }, now), null, "touched a minute ago");
});

test("settled by hand stays settled, pinned or not; work or a waiting call keeps it up", () => {
    const byHand = { ...idle, settle: { state: "settled", at: now - 1000 } };

    assert.equal(settledOf(byHand, now), "settled");
    assert.equal(settledOf(byHand, now, true), "settled");
    assert.equal(settledOf({ ...idle, busy: true }, now), null);
    assert.equal(settledOf({ ...idle, waiting: true }, now), null);
});
