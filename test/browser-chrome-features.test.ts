// Chrome features for Pi's browser on machines (PP-454, the owner's setting browser.chromeFeatures): names checked
// (letters, digits, underscores; at most 10); changed on the owner's card, whose answer says the machines' Chrome stops
// and starts with them; the launch script gives them as --enable-features, in both modes and on Windows, and starts a
// Chrome running with other features again. The screenshot renderer (the phone's WebView, which takes no flags) says
// when a page uses HTML-in-Canvas it lacks. The machine and the phone's browser are stand-ins (`support/fake-cdp.ts`).
import { type App, cleanUp, context, lastText, modelTexts, newSession, openApp, owner, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Cdp } from "../src/server/browser/cdp.ts";
import { launchScript, parseChromeFeatures, stopScript, WINDOW_FLAGS } from "../src/server/browser/machine-engine.ts";
import { BrowserPage } from "../src/server/browser/page.ts";
import { type BrowserEngine, ChromeEngine, PiBrowser } from "../src/server/browser/pi-browser.ts";
import { describeLayout, layoutCheck, type LayoutReport, parseLayout } from "../src/server/layout-check.ts";
import { appSettings } from "../src/server/settings-registry.ts";
import { FakeCdp } from "./support/fake-cdp.ts";

const calls: Record<string, [string, Record<string, unknown>]> = {
    "turn on html in canvas": ["setting_change", { id: "browser.chromeFeatures", value: "CanvasDrawElement", reason: "HTML-in-Canvas in Pi's browser" }],
    "turn features off": ["setting_change", { id: "browser.chromeFeatures", value: "none", reason: "Back to plain Chrome" }],
    "a bad feature": ["setting_change", { id: "browser.chromeFeatures", value: "Canvas-Draw", reason: "x" }],
    "open on sandbox": ["browser_open", { url: "https://example.com/", machine: "sandbox" }],
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

/** The phone's browser, standing in: nothing opens there in these tests. */
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
/** pi-phone's Chrome on the machine. */
const machineChrome = new FakeCdp();
const scripts: string[] = [];
let app: App;

before(async () => {
    await phone.cdp.listen();
    await machineChrome.listen();
    app = await openApp(scriptedModel(route), join(root, "browser-chrome-features"), undefined, {
        browserEngine: phone,
        browserMachines: {
            list: () => [{ id: "m1", name: "sandbox", connected: true, platform: "linux" }],
            access: () => ({
                name: "sandbox",
                home: "/home/u",
                run: async (script) => {
                    scripts.push(script);

                    return script.includes("MODE=") ? { code: 0, out: "port 9222\n" } : { code: 0, out: "" };
                },
                writeFile: async () => {},
                forward: async () => ({ port: machineChrome.port, close: () => {} }),
            }),
        },
    });
});

after(async () => {
    await app?.close();
    await phone.cdp.close();
    await machineChrome.close();
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

const launches = () => scripts.filter((each) => each.includes("MODE="));

test("feature names: letters, digits and underscores, at most 10, each once; none or empty for none", () => {
    assert.deepEqual(parseChromeFeatures("CanvasDrawElement"), { features: ["CanvasDrawElement"] });
    assert.deepEqual(parseChromeFeatures(" CanvasDrawElement, Foo_2  Foo_2,"), { features: ["CanvasDrawElement", "Foo_2"] });
    assert.deepEqual(parseChromeFeatures("none"), { features: [] });
    assert.deepEqual(parseChromeFeatures(""), { features: [] });
    assert.deepEqual(parseChromeFeatures("Canvas-Draw, ok, $(reboot)"), { bad: ["Canvas-Draw", "$(reboot)"] });
    assert.deepEqual(parseChromeFeatures(Array.from({ length: 11 }, (_, n) => `F${n}`).join(",")), { tooMany: 11 });
});

test("browser.chromeFeatures: none by default, changed on the owner's card, whose answer says the machine's Chrome stops and starts with them; launched with --enable-features; bad names refused", async () => {
    const id = await newSession(app);
    const setting = appSettings(app).settings.find((each) => each.id === "browser.chromeFeatures");

    assert.ok(setting !== undefined, "listed");
    assert.equal(setting.owner, true);
    assert.equal(await setting.read(undefined), "none");

    // Chrome on the machine runs without features first.
    assert.match((await turn(id, "open on sandbox")).said, /example\.com/);
    assert.doesNotMatch(launches().at(-1)!, /--enable-features/);

    const denied = await turn(id, "turn on html in canvas", false);

    assert.match(denied.card?.subject ?? "", /Chrome features for Pi's browser on machines: none → CanvasDrawElement/);
    assert.deepEqual(app.config.browserChromeFeatures, [], "a no changes nothing");

    const stopsBefore = scripts.filter((each) => each.includes("pkill")).length;
    const changed = (await turn(id, "turn on html in canvas", true)).said;

    assert.deepEqual(app.config.browserChromeFeatures, ["CanvasDrawElement"]);
    assert.match(changed, /Changed browser\.chromeFeatures: none → CanvasDrawElement\. Pi's browser's Chrome on sandbox stopped \(its tabs closed, sign-ins stay\)\. Chrome on each machine starts with --enable-features=CanvasDrawElement at Pi's browser's next use there\./);
    assert.ok(scripts.filter((each) => each.includes("pkill")).length > stopsBefore, "the machine's Chrome was stopped");

    const opened = launches().length;

    assert.match((await turn(id, "open on sandbox")).said, /example\.com/);
    assert.ok(launches().length > opened, "launched again");
    assert.match(launches().at(-1)!, /H="--headless=new --disable-gpu --enable-features=CanvasDrawElement"/);
    assert.match(launches().at(-1)!, /^FEATURES="CanvasDrawElement"$/m);

    assert.match((await turn(id, "a bad feature", true)).said, /only letters, digits and underscores, like CanvasDrawElement: not Canvas-Draw/);
    assert.deepEqual(app.config.browserChromeFeatures, ["CanvasDrawElement"]);

    assert.match((await turn(id, "turn features off", true)).said, /CanvasDrawElement → none\. .*starts without --enable-features/);
    assert.deepEqual(app.config.browserChromeFeatures, []);
    await assert.rejects(app.setBrowserChromeFeatures({ ...owner(app), role: "member" } as never, "X"), /Only the owner/);
});

/**
 * A machine of the test's own: a home, and a PATH of the tools the launch script uses with a stand-in Chrome that writes
 * the arguments it got and a DevTools port file, then waits.
 */
function machine(): { home: string; path: string; args: () => string[]; pid: () => string } {
    const home = mkdtempSync(join(tmpdir(), "pi-features-home-"));
    const bin = join(home, "bin");
    const log = join(home, "chrome-args");

    mkdirSync(bin);

    for (const tool of ["sh", "printf", "mkdir", "head", "sleep", "kill", "rm", "find", "cat", "tail", "grep", "pkill", "id", "setsid", "tr", "dirname"]) {
        try {
            symlinkSync(execFileSync("sh", ["-c", `command -v ${tool}`]).toString().trim(), join(bin, tool));
        } catch {
            // Not on this computer: the script copes (setsid).
        }
    }

    writeFileSync(
        join(bin, "google-chrome"),
        [
            `#!${join(bin, "sh")}`,
            `for a in "$@"; do echo "$a"; done > ${JSON.stringify(log)}`,
            'for a in "$@"; do case "$a" in --user-data-dir=*) D="${a#--user-data-dir=}";; esac; done',
            '{ echo 9333; echo /devtools/browser/x; } > "$D/DevToolsActivePort"',
            "i=0; while [ $i -lt 60 ]; do sleep 0.5; i=$((i+1)); done",
        ].join("\n"),
    );
    chmodSync(join(bin, "google-chrome"), 0o755);

    return {
        home,
        path: bin,
        args: () => readFileSync(log, "utf8").split("\n"),
        pid: () => readFileSync(join(home, ".pi/mobile/browser/chrome.pid"), "utf8").trim(),
    };
}

const run = (script: string, home: string, path: string): Promise<{ code: number; out: string }> =>
    new Promise((resolve) => {
        const child = spawn(join(path, "sh"), ["-c", script], { env: { HOME: home, PATH: path } });
        let out = "";

        child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
        child.stderr.on("data", (chunk: Buffer) => (out += chunk.toString()));
        child.on("close", (code) => resolve({ code: code ?? 1, out }));
    });

test("the launch script starts Chrome with --enable-features, keeps one running with the same features, and starts it again with others", async () => {
    const box = machine();

    try {
        const first = await run(launchScript({ features: ["CanvasDrawElement", "Foo_2"] }), box.home, box.path);

        assert.equal(first.code, 0, first.out);
        assert.ok(box.args().includes("--enable-features=CanvasDrawElement,Foo_2"), box.args().join(" "));
        assert.ok(box.args().includes("--headless=new"));
        assert.equal(readFileSync(join(box.home, ".pi/mobile/browser/features"), "utf8").trim(), "CanvasDrawElement,Foo_2");

        const pid = box.pid();
        const same = await run(launchScript({ features: ["CanvasDrawElement", "Foo_2"] }), box.home, box.path);

        assert.equal(same.code, 0, same.out);
        assert.equal(box.pid(), pid, "the same Chrome, kept");

        const none = await run(launchScript(), box.home, box.path);

        assert.equal(none.code, 0, none.out);
        assert.notEqual(box.pid(), pid, "started again");
        assert.ok(!box.args().some((each) => each.startsWith("--enable-features")), box.args().join(" "));
        assert.equal(readFileSync(join(box.home, ".pi/mobile/browser/features"), "utf8").trim(), "");
    } finally {
        await run("pkill -f -- \"$HOME/.pi/mobile/browser/profile\"; true", box.home, box.path);
    }

    // A window has them too, on Linux and on Windows; stopping forgets them.
    assert.match(launchScript({ mode: "window", features: ["CanvasDrawElement"] }), new RegExp(`H="${WINDOW_FLAGS} --enable-features=CanvasDrawElement"`));
    assert.match(launchScript({ mode: "window", windows: true, features: ["CanvasDrawElement"] }), new RegExp(`PI_FLAGS="${WINDOW_FLAGS} --enable-features=CanvasDrawElement"`));
    assert.match(launchScript({ features: ["CanvasDrawElement"] }), /\*chrome-headless-shell\*\) H="--disable-gpu --enable-features=CanvasDrawElement"/);
    assert.match(stopScript(), /rm -f "\$P\/mode" "\$P\/features"/);
});

test("a page that uses HTML-in-Canvas the renderer lacks is said once a width, naming what it uses, the renderer's Chrome, and the setting", () => {
    const report: LayoutReport = {
        width: 390,
        height: 844,
        checked: 4,
        issues: [],
        more: 0,
        found: [],
        totals: {},
        summary: { fontSizes: [16], colors: ["#000000"], families: ["sans-serif"], icons: [], strokes: [] },
    };
    const parsed = parseLayout(JSON.stringify({ ...report, canvas: { uses: "canvas[layoutsubtree]", chrome: "156" } }), 390);

    assert.deepEqual(parsed?.canvas, { uses: "canvas[layoutsubtree]", chrome: "156" });
    assert.match(
        describeLayout(parsed!),
        /\nThe page uses HTML-in-Canvas \(canvas\[layoutsubtree\]\), which this renderer \(Chrome 156\) lacks: its canvas shows what the page draws without it\. Pi's browser on a machine draws it when the setting browser\.chromeFeatures has CanvasDrawElement\.$/,
    );
    assert.equal(parseLayout(JSON.stringify({ ...report, canvas: { uses: 3 } }), 390)?.canvas, undefined, "a wrong one is left out");
    assert.doesNotMatch(describeLayout(parseLayout(JSON.stringify(report), 390)!), /HTML-in-Canvas/);
});

const chrome = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"].find((name) => {
    try {
        execFileSync("which", [name], { stdio: "ignore" });

        return true;
    } catch {
        return false;
    }
});

test("the layout check finds HTML-in-Canvas in a Chrome without it (a canvas with layoutsubtree, or drawElementImage in a script), and not in one with CanvasDrawElement on", { skip: chrome === undefined ? "no Chrome on this machine (CI runs it)" : false }, async () => {
    const pages: Record<string, string> = {
        "/subtree": `<!doctype html><canvas width="300" height="100" layoutsubtree><div>Drawn</div></canvas>`,
        "/script": `<!doctype html><canvas id="c"></canvas><script>const x = c.getContext("2d"); if (x.drawElementImage) x.drawElementImage(document.body, 0, 0);</script>`,
        "/plain": `<!doctype html><canvas width="300" height="100"></canvas><p>No HTML in it</p>`,
    };
    const server = createServer((request, response) => {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(pages[request.url ?? "/"] ?? "");
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const measure = async (flags: string[]) => {
        const engine = new ChromeEngine(chrome!, [`--host-resolver-rules=MAP pi.test 127.0.0.1:${port}`, "--no-sandbox", ...flags]);

        try {
            const page = new BrowserPage(await engine.connect((await engine.tabs())[0]!));
            const reports: Record<string, LayoutReport | undefined> = {};

            await page.init({ width: 390, height: 844, mobile: true });

            for (const path of Object.keys(pages)) {
                await page.navigate(`http://pi.test${path}`);
                reports[path] = parseLayout(await page.evaluate<string>(layoutCheck()), 390);
            }

            return { reports, has: await page.evaluate<string>("typeof CanvasRenderingContext2D.prototype.drawElementImage") };
        } finally {
            await engine.close();
        }
    };

    try {
        const without = await measure([]);

        if (without.has !== "function") {
            assert.equal(without.reports["/subtree"]?.canvas?.uses, "canvas[layoutsubtree]");
            assert.match(without.reports["/subtree"]?.canvas?.chrome ?? "", /^\d+$/);
            assert.equal(without.reports["/script"]?.canvas?.uses, "drawElementImage");
        }

        assert.equal(without.reports["/plain"]?.canvas, undefined);

        const flagged = await measure(["--enable-features=CanvasDrawElement"]);

        // A Chrome that has it behind this flag (155 and 156; the flag may change later) draws it: nothing to say.
        if (flagged.has === "function") {
            assert.equal(flagged.reports["/subtree"]?.canvas, undefined);
        }

        // browser_eval detects it as the ticket's check does: CanvasRenderingContext2D is there to read, its methods refuse,
        // and no context can be had.
        const evaluated = async (flags: string[]) => {
            const browser = new PiBrowser({
                engine: new ChromeEngine(chrome!, [`--host-resolver-rules=MAP pi.test 127.0.0.1:${port}`, "--no-sandbox", ...flags]),
                changed: () => {},
                frame: () => {},
                log: () => {},
            });

            try {
                await browser.open(1, "http://pi.test/subtree");

                const answer = await browser.evaluate(1, "typeof CanvasRenderingContext2D.prototype.drawElementImage", false);

                await assert.rejects(browser.evaluate(1, "document.querySelector('canvas').getContext('2d')", false), /getContext[^:]* is not available in browser_eval/);
                await assert.rejects(browser.evaluate(1, "CanvasRenderingContext2D.prototype.fillRect.call(null, 0, 0, 1, 1)", false), /fillRect[^:]* is not available in browser_eval/);

                return "json" in answer ? (JSON.parse(answer.json) as string) : answer.withheld;
            } finally {
                await browser.close();
            }
        };

        assert.equal(await evaluated([]), without.has);
        assert.equal(await evaluated(["--enable-features=CanvasDrawElement"]), flagged.has);
    } finally {
        server.close();
    }
});
