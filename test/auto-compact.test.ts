// Auto-compact at a context percentage (PP-78): a setting for all sessions and a session's own, checked; when a run
// ends with the context at or past it, the session compacts; at "full" (the default) or below it, it doesn't.
import { type App, cleanUp, fakeTab, newSession, openApp, owner, say, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { checkCompactAt } from "../src/server/auto-compact.ts";

/** faux-1 has a window of 100,000 tokens: Pi's prompt and tools with a few answers fill about a quarter of it. */
const faux = fauxProvider({ tokensPerSecond: 100_000, models: [{ id: "faux-1", contextWindow: 100_000 }, { id: "faux-2" }] });

faux.setResponses(Array.from({ length: 200 }, () => fauxAssistantMessage([fauxText("word ".repeat(300))])));

let app: App;

before(async () => {
    app = await openApp(faux as never);
});

after(async () => {
    await app.close();
    cleanUp();
});

test("values: a whole percentage from 10 to 95, full, and inherit for a session", () => {
    assert.equal(checkCompactAt("70", false), 70);
    assert.equal(checkCompactAt("70%", false), 70);
    assert.equal(checkCompactAt(" FULL ", false), "full");
    assert.equal(checkCompactAt("inherit", true), "inherit");
    assert.throws(() => checkCompactAt("inherit", false), /whole percentage from 10 to 95/);

    for (const bad of ["5", "96", "70.5", "", "soon"]) {
        assert.throws(() => checkCompactAt(bad, true), /whole percentage/, bad);
    }
});

test("a session's own setting comes before the one for all; the owner sets that one", async () => {
    const me = owner(app);
    const id = await newSession(app);
    const viewer = app.config.addUser("Viewer", "viewer").user;

    assert.equal(app.config.compactAt, "full", "the default: only when nearly full");
    await app.setCompactAt(me, "80");
    assert.equal(app.autoCompact.effective(id), 80);
    await app.setSessionCompactAt(id, me, 50);
    assert.equal(app.autoCompact.effective(id), 50);
    await app.setSessionCompactAt(id, me, "inherit");
    assert.equal(app.autoCompact.effective(id), 80);
    await assert.rejects(app.setCompactAt(viewer, 50), { status: 403 });
    await assert.rejects(app.setSessionCompactAt(id, viewer, 50), { status: 403 });
    await app.setCompactAt(me, "full");
});

test("a run that ends past the session's percentage compacts it; below it, or at full, nothing", async () => {
    const me = owner(app);
    const id = await newSession(app);
    const tab = fakeTab(id, me);
    const notices = () => tab.events.filter((each) => each.event === "notice").map((each) => String(each.data.text ?? each.data.message ?? ""));

    await app.attach(tab.client);

    try {
        // The default: never early.
        await say(app, id, "a long answer, please");
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.ok(!notices().some((text) => /auto-compact/.test(text)), "full: nothing");

        // 95%: the context (about a quarter) is below it.
        await app.setSessionCompactAt(id, me, 95);
        await say(app, id, "again");
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.ok(!notices().some((text) => /auto-compact/.test(text)), `below: nothing (${notices().join(" | ")})`);

        // 10%: past it, so it compacts as the run ends.
        await app.setSessionCompactAt(id, me, 10);
        await say(app, id, "once more");
        await until(() => notices().some((text) => /The context is at \d+%: compacting \(auto-compact at 10%\)/.test(text)), "the auto-compact notice", 10_000);
    } finally {
        app.detach(tab.client);
    }
});
