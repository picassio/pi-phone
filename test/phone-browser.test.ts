import assert from "node:assert/strict";
import { test } from "node:test";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { PhoneEngine, type PopupMode, type WindowAsk } from "../src/server/browser/pi-browser.ts";
import { PhoneRequests } from "../src/server/phone-requests.ts";

/** The page is not asked: the phone's pictures come from its display, not DevTools (whose capture hangs every other call). */
const page = {} as BrowserPage;

test("the phone's browser takes a tab's picture from the app's service (its display's frames), not DevTools (PP-114)", async () => {
    const requests = new PhoneRequests("Pi's browser");
    const engine = new PhoneEngine(requests, () => "allow");
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

test("a window a page asks to open goes to the browser whose tab asked: opened as a tab of the size it says, or refused; one nobody takes is refused; the phone is told the popups setting (PP-249)", async () => {
    const requests = new PhoneRequests("Pi's browser");
    let mode: PopupMode = "allow";
    const engine = new PhoneEngine(requests, () => mode);
    const polling = new AbortController();
    let seq = 0;
    /** The service takes the next request, and answers it. */
    const next = async (answer: Record<string, unknown> = { pid: 7 }) => {
        const { requests: asked } = await requests.after(seq, polling.signal);

        seq = asked[0]!.seq;
        requests.answer(asked[0]!.id, answer);

        return asked[0]!;
    };

    await requests.after(-1, polling.signal);
    // Each request that makes or lists tabs says what pages may do with windows.
    const listed = engine.tabs();

    assert.equal((await next({ pid: 7, tabs: [] })).popups, "allow");
    await listed;

    const asks: WindowAsk[] = [];

    engine.watchWindows((ask) => ask.opener === "pi-browser-a" && asks.push(ask) > 0);
    // Nobody's tab: refused.
    engine.windowAsked({ opener: "pi-browser-x", tab: "pi-browser-w0", gesture: true });
    const refused = await next();

    assert.deepEqual([refused.op, refused.marker, refused.open], ["window", "pi-browser-w0", false]);

    engine.windowAsked({ opener: "pi-browser-a", tab: "pi-browser-w1", gesture: true });
    assert.equal(asks.length, 1);
    assert.equal(asks[0]!.gesture, true);

    const opening = asks[0]!.open({ width: 412, height: 860 });
    const open = await next();

    assert.deepEqual([open.op, open.marker, open.open, open.width, open.height], ["window", "pi-browser-w1", true, 412, 860]);
    await opening;

    // The setting changed: the phone is told at once.
    mode = "off";

    const told = engine.popupsChanged();
    const popups = await next();

    assert.deepEqual([popups.op, popups.popups], ["popups", "off"]);
    await told;
});
