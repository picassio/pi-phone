// A session browses on a machine though it works on the phone (PP-274: browser_open with machine, the panel's Browse on):
// its own tabs at each place, the panel's title naming the machine. The machine and its Chrome are stand-ins
// (`support/fake-cdp.ts`).
import { type App, cleanUp, context, lastText, modelTexts, newSession, openApp, owner, root, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Cdp } from "../src/server/browser/cdp.ts";
import type { BrowserEngine } from "../src/server/browser/pi-browser.ts";
import { FakeCdp } from "./support/fake-cdp.ts";

const calls: Record<string, [string, Record<string, unknown>]> = {
    "open on sandbox": ["browser_open", { url: "https://example.com/", machine: "sandbox" }],
    "open on the phone": ["browser_open", { url: "https://phone.test/", machine: "phone" }],
    "open on nope": ["browser_open", { url: "https://example.com/", machine: "nope" }],
};
const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);

    for (const [ask, [tool, args]] of Object.entries(calls)) {
        if (role === "user" && text.endsWith(ask)) {
            return fauxAssistantMessage([fauxToolCall(tool, args as never)], { stopReason: "toolUse" });
        }
    }

    return fauxAssistantMessage([fauxText(role === "toolResult" ? `told: ${text}` : "ok")]);
};

/** The phone's browser, standing in: a fake DevTools whose tabs are made on request. */
class FakePhone implements BrowserEngine {
    readonly label = "the fake phone";
    readonly popups = false;
    readonly asksWindows = false;
    readonly local = false;
    readonly actAsPhone = false;
    readonly reopensToResize = false;
    readonly cdp = new FakeCdp();
    watchWindows = () => () => {};
    tabs = async () => [];
    newTab = async () => this.cdp.add("about:blank", "");
    connect = (id: string) => Cdp.connect({ url: `ws://127.0.0.1:${this.cdp.port}/devtools/page/${id}` });
    closeTab = async (id: string) => this.cdp.gone(id);
    close = async () => {};
    pdf = async () => Buffer.alloc(0);
    picture = async () => "";
    stage = async (name: string) => name;
}

const phone = new FakePhone();
/** pi-phone's own Chrome on the machine (port 9222 there). */
const own = new FakeCdp();
let app: App;

before(async () => {
    await phone.cdp.listen();
    await own.listen();
    app = await openApp(scriptedModel(route), join(root, "browser-machine-sessions"), undefined, {
        browserEngine: phone,
        browserMachines: {
            list: () => [{ id: "m1", name: "sandbox", connected: true, platform: "linux" }],
            access: () => ({
                name: "sandbox",
                home: "/home/u",
                run: async (script) => ({ code: 0, out: script.includes("MODE=") ? "port 9222\n" : "" }),
                writeFile: async () => {},
                forward: async () => ({ port: own.port, close: () => {} }),
            }),
        },
    });
});

after(async () => {
    await app?.close();
    await phone.cdp.close();
    await own.close();
    cleanUp();
});

async function turn(id: number, text: string) {
    const { submissionId } = await app.commands.submit(id as never, owner(app), { text, requestId: crypto.randomUUID() });

    await (await app.harness.submission(submissionId, context))!.wait(context);

    return { said: (await modelTexts(app, id as never)).at(-1)! };
}

test("a session on the phone browses on a machine, and on the phone again: its own tabs at each place, the panel's title naming the machine", async () => {
    const id = await newSession(app);

    assert.match((await turn(id, "open on sandbox")).said, /example\.com — https:\/\/example\.com\//);
    assert.equal(app.browserPlaces()[String(id)], "machine:m1");
    assert.ok([...own.targets.values()].some((each) => each.url === "https://example.com/"), "the page opened in the machine's Chrome");
    assert.equal(phone.cdp.targets.size, 0, "nothing on the phone");

    const there = app.browserFor(app.cwdOf(id), id).state();

    assert.equal(there.place, "machine:m1");
    assert.equal(there.where, "sandbox");

    assert.match((await turn(id, "open on the phone")).said, /phone\.test — https:\/\/phone\.test\//);
    assert.equal(app.browserPlaces()[String(id)], undefined, "the phone is where it works: no choice kept");
    assert.ok([...phone.cdp.targets.values()].some((each) => each.url === "https://phone.test/"));
    assert.match((await turn(id, "open on nope")).said, /There is no machine nope\. Machines: sandbox\./);

    // The panel's Browse on, the same through the app.
    assert.equal(app.setBrowserPlace(app.cwdOf(id), id, "sandbox"), "machine:m1");
    assert.equal(app.browserPlaces()[String(id)], "machine:m1");
    app.setBrowserPlace(app.cwdOf(id), id, "phone");
});
