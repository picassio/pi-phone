import assert from "node:assert/strict";
import { test } from "node:test";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { PhoneEngine } from "../src/server/browser/pi-browser.ts";
import { PhoneRequests } from "../src/server/phone-requests.ts";

/** The page is not asked: the phone's pictures come from its display, not DevTools (whose capture hangs every other call). */
const page = {} as BrowserPage;

test("the phone's browser takes a tab's picture from the app's service (its display's frames), not DevTools (PP-114)", async () => {
    const requests = new PhoneRequests("Pi's browser");
    const engine = new PhoneEngine(requests);
    const polling = new AbortController();

    // The service polls: it is there.
    await requests.after(-1, polling.signal);

    const picture = engine.picture("pi-browser-1", page, 60, 5000);
    const { requests: asked } = await requests.after(0, polling.signal);

    assert.equal(asked.length, 1);
    assert.equal(asked[0]!.op, "shot");
    assert.equal(asked[0]!.marker, "pi-browser-1");
    assert.equal(asked[0]!.quality, 60);
    requests.answer(asked[0]!.id, { pid: 7, jpeg: "/9j/AAAA" });
    assert.equal(await picture, "/9j/AAAA");

    // No picture in the answer is an error, not an empty image.
    const none = engine.picture("pi-browser-1", page, 70);
    const { requests: next } = await requests.after(asked[0]!.seq, polling.signal);

    requests.answer(next[0]!.id, { pid: 7 });
    await assert.rejects(none, /no picture/);

    // A PNG of a part of the view, to keep (PP-118): the phone is told both.
    const part = engine.picture("pi-browser-1", page, 80, 5000, { png: true, clip: { x: 8, y: 40, width: 258, height: 234 } });
    const { requests: last } = await requests.after(next[0]!.seq, polling.signal);

    assert.equal(last[0]!.png, true);
    assert.deepEqual(last[0]!.clip, { x: 8, y: 40, width: 258, height: 234 });
    requests.answer(last[0]!.id, { pid: 7, jpeg: "iVBORw0K" });
    assert.equal(await part, "iVBORw0K");
});
