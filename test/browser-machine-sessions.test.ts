// A session browses on a machine though it works on the phone (PP-274: browser_open with machine, the panel's Browse on),
// and attaches Pi's browser to a browser already running on a machine (browser_attach): its DevTools on the machine's
// 127.0.0.1, reached through the forward; the owner's card first for a browser that is not pi-phone's own (machine, port,
// version, profile); its tabs in Pi's browser; browser_close closes only Pi's own tabs there; browser_detach lets go and
// leaves it running. The machine and both browsers are stand-ins (`support/fake-cdp.ts`).
import { type App, cleanUp, context, lastText, modelTexts, newSession, openApp, owner, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { isOwnProfile, profileFromInspect } from "../src/server/browser/attached-engine.ts";
import { Cdp } from "../src/server/browser/cdp.ts";
import type { BrowserEngine } from "../src/server/browser/pi-browser.ts";
import { FakeCdp } from "./support/fake-cdp.ts";

const calls: Record<string, [string, Record<string, unknown>]> = {
    "open on sandbox": ["browser_open", { url: "https://example.com/", machine: "sandbox" }],
    "open on the phone": ["browser_open", { url: "https://phone.test/", machine: "phone" }],
    "open on nope": ["browser_open", { url: "https://example.com/", machine: "nope" }],
    "attach to chrome": ["browser_attach", { machine: "sandbox", port: 9333, label: "Owner's Chrome" }],
    "attach to own": ["browser_attach", { machine: "sandbox", port: 9444 }],
    "attach by file": ["browser_attach", { machine: "sandbox", devtools_active_port: "~/pw/DevToolsActivePort", label: "Playwright", tabs: "all" }],
    "attach to my chrome": ["browser_attach", { machine: "sandbox" }],
    "read it": ["browser_snapshot", {}],
    "new tab": ["browser_new_tab", { url: "https://pi.test/" }],
    "close tabs": ["browser_close", {}],
    "detach it": ["browser_detach", {}],
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
/** pi-phone's own Chrome on the machine (port 9222 there), the owner's Chrome (9333), and pi-phone's profile on 9444. */
const own = new FakeCdp();
const owners = new FakeCdp();
const ownProfile = new FakeCdp();
const playwright = new FakeCdp();
/** The owner's Chrome with remote debugging turned on at chrome://inspect/#remote-debugging: its browser endpoint only. */
const optIn = new FakeCdp();
const remote: Record<number, FakeCdp> = { 9222: own, 9333: owners, 9444: ownProfile, 9555: playwright, 9666: optIn };
const forwards = { opened: [] as number[], closed: 0 };
const scripts: string[] = [];
let app: App;

/** A command line, as the inspect script says it on Linux (its arguments, a line each, base64). */
const argv = (...args: string[]) => `argv ${Buffer.from(args.join("\n")).toString("base64")}\ndone\n`;

before(async () => {
    for (const each of [phone.cdp, own, owners, ownProfile, playwright, optIn]) {
        await each.listen();
    }

    owners.add("https://mail.test/inbox", "Inbox");
    playwright.add("https://app.test/", "App under test");
    optIn.add("https://bank.test/", "Bank");
    optIn.httpOff = true;
    optIn.browserId = "opt-in-1";
    app = await openApp(scriptedModel(route), join(root, "browser-machine-sessions"), undefined, {
        browserEngine: phone,
        browserMachines: {
            list: () => [{ id: "m1", name: "sandbox", connected: true, platform: "linux" }],
            access: () => ({
                name: "sandbox",
                home: "/home/u",
                run: async (script) => {
                    scripts.push(script);

                    if (script.includes("MODE=")) {
                        return { code: 0, out: "port 9222\n" };
                    }

                    if (script.includes("ss -ltnpH")) {
                        const port = Number(/^N=(\d+)$/m.exec(script)?.[1]);

                        return {
                            code: 0,
                            out:
                                port === 9444
                                    ? argv("chrome", "--remote-debugging-port=0", "--user-data-dir=/home/u/.pi/mobile/browser/profile")
                                    : argv("/opt/google/chrome/chrome", "--remote-debugging-port=9333", "--user-data-dir=/home/u/.config/google-chrome"),
                        };
                    }

                    if (script.includes("'~/pw/DevToolsActivePort'")) {
                        return { code: 0, out: "dir /tmp/playwright_chromiumdev_profile-abc\nport 9555\nws /devtools/browser/b1\n" };
                    }

                    // No file named: the default profiles', where chrome://inspect/#remote-debugging writes it.
                    if (script.includes("'~/.config/google-chrome/DevToolsActivePort'")) {
                        return { code: 0, out: "dir /home/u/.config/google-chrome\nport 9666\nws /devtools/browser/opt-in-1\n" };
                    }

                    return { code: 0, out: "" };
                },
                writeFile: async () => {},
                forward: async (port) => {
                    forwards.opened.push(port);

                    return { port: remote[port]!.port, close: () => (forwards.closed += 1) };
                },
            }),
        },
    });
});

after(async () => {
    await app?.close();

    for (const each of [phone.cdp, own, owners, ownProfile, playwright, optIn]) {
        await each.close();
    }

    cleanUp();
});

async function turn(id: number, text: string, answer?: boolean) {
    const { submissionId } = await app.commands.submit(id as never, owner(app), { text, requestId: crypto.randomUUID() });
    let card: ReturnType<typeof app.approvals.all>[number] | undefined;

    if (answer !== undefined) {
        await until(() => app.approvals.forConversation(id as never).length > 0, "the card", 20_000);
        card = app.approvals.forConversation(id as never)[0]!;
        await app.answerApproval(card.id, answer, owner(app));
    }

    await (await app.harness.submission(submissionId, context))!.wait(context);

    return { said: (await modelTexts(app, id as never)).at(-1)!, card };
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

test("browser_attach to a browser that is not pi-phone's own waits for the owner's card (machine, port, version, profile, tabs); Pi owns only the tabs it opens (in the background) and their windows; close leaves the owner's tabs; detach leaves it running", async () => {
    const id = await newSession(app);
    const before = forwards.closed;
    const denied = await turn(id, "attach to chrome", false);

    assert.equal(denied.card?.tool, "browser_attach");
    assert.equal(
        denied.card?.subject,
        [
            "Attach Pi's browser to a browser on sandbox",
            "Machine: sandbox",
            "Port: 9333 (127.0.0.1 there, through the app's ssh)",
            "Browser: Chrome/156.0.8078.80",
            "Profile: /home/u/.config/google-chrome",
            "Tabs: only those Pi opens there (in the background) and windows they open; its 1 open tab stays yours",
        ].join("\n"),
    );
    assert.match(denied.card?.reason ?? "", /This browser carries its profile's sign-ins/);
    assert.match(denied.said, /said no: Pi's browser is not attached/);
    assert.equal(forwards.closed, before + 1, "the forward closed on a no");
    assert.equal(app.browserPlaces()[String(id)], undefined);

    const attached = await turn(id, "attach to chrome", true);

    assert.match(attached.said, /Pi's browser is attached to Owner's Chrome on sandbox \(port 9333, profile \/home\/u\/\.config\/google-chrome\)/);
    assert.match(attached.said, /<page>/, "the browser's words are fenced");
    assert.equal(app.browserPlaces()[String(id)], "attach:m1:9333");

    assert.match(attached.said, /the 1 tab open there stays the owner's/);

    // The owner's tab is not Pi's: its first look opens a tab of its own, in the background (the browser has a window).
    assert.doesNotMatch((await turn(id, "read it")).said, /Inbox/);
    assert.ok(owners.commands.some((each) => each.target === "browser" && each.method === "Target.createTarget" && each.params.background === true));
    assert.ok(!owners.commands.some((each) => each.target === "t1"), "the owner's tab is never touched");
    const state = app.browserFor(app.cwdOf(id), id).state();

    assert.equal(state.attached, "Owner's Chrome");
    assert.equal(state.where, "sandbox");

    // Another session cannot drive it at the same time, and this one cannot move elsewhere while attached.
    const other = await newSession(app);

    assert.match((await turn(other, "attach to chrome")).said, new RegExp(`Session ${id} is attached to that browser`));
    assert.throws(() => app.setBrowserPlace(app.cwdOf(id), id, "phone"), /detach it first/);

    // A tab Pi opens there; a window its page opens is Pi's too (Chrome's opener), one the owner's tab opens is not.
    assert.match((await turn(id, "new tab")).said, /pi\.test/);
    const piTab = [...owners.targets].find(([, each]) => each.url === "https://pi.test/")![0];

    owners.add("https://login.test/", "Login", piTab);
    owners.add("https://ads.test/", "Ad", "t1");
    const read = (await turn(id, "read it")).said;

    assert.match(read, /The page opened a window: https:\/\/login\.test\//);
    assert.doesNotMatch(read, /ads\.test/);
    assert.deepEqual(app.browserFor(app.cwdOf(id), id).state().tabs.map((each) => each.url), ["about:blank", "https://pi.test/", "https://login.test/"]);

    // browser_close closes the tabs Pi opened; the owner's stay (and the window, which Pi did not open, with them).
    await turn(id, "close tabs");
    await until(() => ![...owners.targets.values()].some((each) => each.url === "https://pi.test/"), "Pi's tabs closed");
    assert.deepEqual([...owners.targets.values()].map((each) => each.title).sort(), ["Ad", "Inbox", "Login"]);

    const closedBefore = forwards.closed;

    assert.match((await turn(id, "detach it")).said, /Pi's browser let go of Owner's Chrome on sandbox: it runs on, with its tabs/);
    assert.equal(forwards.closed, closedBefore + 1, "the forward closes");
    assert.equal(owners.targets.size, 3, "its tabs stay");
    assert.equal(app.browserPlaces()[String(id)], undefined);
    assert.match((await turn(id, "detach it")).said, /not attached to another browser/);
});

test("a browser's profile is read from its command line: its own argument, Chrome's one-line process title on Linux, Windows' quoted path", () => {
    const b64 = (text: string) => Buffer.from(text).toString("base64");

    assert.equal(profileFromInspect(`argv ${b64("chrome\n--user-data-dir=/home/u/My Profile\nabout:blank")}\ndone`), "/home/u/My Profile");
    // Chrome rewrites /proc/<pid>/cmdline as one line (tuanlh-sandbox-01, Chrome 156).
    assert.equal(profileFromInspect(`argv ${b64("/opt/chrome/chrome --headless=new --remote-debugging-port=9333 --user-data-dir=/home/u/tmp/foreign about:blank")}\ndone`), "/home/u/tmp/foreign");
    assert.equal(profileFromInspect(`cmdline ${b64('"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:\\Users\\Me\\AppData\\Local\\Temp\\pw profile"')}`), "C:\\Users\\Me\\AppData\\Local\\Temp\\pw profile");
    assert.equal(profileFromInspect(`argv ${b64("chrome\n--remote-debugging-port=9222")}\ndone`), undefined, "its default profile");
    assert.equal(profileFromInspect("done"), undefined);
    assert.equal(isOwnProfile("C:\\Users\\Me\\.pi\\mobile\\browser\\profile", "C:/Users/Me"), true);
    assert.equal(isOwnProfile("/home/u/.pi/mobile/browser/profile/", "/home/u"), true);
    assert.equal(isOwnProfile("/home/u/.config/google-chrome", "/home/u"), false);
});

test("pi-phone's own Chrome on the machine (its profile) attaches without a card; a DevToolsActivePort file names the port, the browser's endpoint and the profile; tabs: all takes its open tabs; the owner's own Chrome with chrome://inspect's opt-in (no HTTP endpoints) is found in its profile", async () => {
    const id = await newSession(app);
    const own = await turn(id, "attach to own");

    assert.equal(app.approvals.forConversation(id).length, 0);
    assert.match(own.said, /pi-phone's own Chrome there/);
    await turn(id, "detach it");

    const byFile = await turn(id, "attach by file", true);

    assert.match(byFile.card?.subject ?? "", /Port: 9555 .*\nBrowser: Chrome\/156\.0\.8078\.80\nProfile: \/tmp\/playwright_chromiumdev_profile-abc\nTabs: its 1 open tab, and those Pi opens$/);
    assert.ok(scripts.some((each) => each.includes("for c in '~/pw/DevToolsActivePort'; do")), "the file is read on the machine");
    assert.match((await turn(id, "read it")).said, /App under test — https:\/\/app\.test\//);
    assert.deepEqual(forwards.opened.filter((port) => port === 9555), [9555], "only its port, on the machine's 127.0.0.1");
    await turn(id, "detach it");

    // No port and no file: the owner's own Chrome, its remote debugging turned on at chrome://inspect/#remote-debugging.
    const optedIn = await turn(id, "attach to my chrome", true);

    assert.match(optedIn.card?.subject ?? "", /Port: 9666 .*\nBrowser: Chrome\/156\.0\.8078\.80\nProfile: \/home\/u\/\.config\/google-chrome\nTabs: only those Pi opens/);
    assert.doesNotMatch((await turn(id, "read it")).said, /Bank/, "the owner's bank tab is not Pi's");
    assert.ok(optIn.commands.some((each) => each.target === "browser" && each.method === "Target.attachToTarget"), "pages as sessions on the browser's own connection");
    assert.match((await turn(id, "new tab")).said, /pi\.test/);
    await turn(id, "detach it");

    // Attached again: the tabs it opened there are still its own (kept by the browser's identity).
    await turn(id, "attach to my chrome", true);
    assert.match((await turn(id, "read it")).said, /pi\.test/);
    assert.equal(optIn.targets.size, 3, "no new tab: its own were there");

    await turn(id, "detach it");
});
