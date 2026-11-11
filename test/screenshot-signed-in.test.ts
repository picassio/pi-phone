// screenshot and redline of a page behind a sign-in (PP-500), on a real Chrome (CI has one): a site the session signed in
// to in Pi's browser renders with that browser's sign-in, in a tab of its own there (the session's tabs untouched), at
// each width with the layout check; a page rendered without it that shows a password field says why and what to do;
// steps type a saved secret into a password field (a sign-in form sent, the steps going on on the next page), and its
// value is in no answer, log or page read; a phone app too old to render with Pi's browser's profile is refused. On a
// machine (PP-501): the session's tab is the same, read in the page, after a screenshot with steps, and a site signed in
// to renders signed in after the idle sweep closed the session's tabs.
import { type App, cleanUp, context, lastText, modelTexts, newSession, openApp, owner, root, scriptedModel } from "./helpers.ts";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, get, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { BROWSER_IDLE_MS } from "../src/server/app.ts";
import { BROWSER_DIR, stopScript } from "../src/server/browser/machine-engine.ts";
import { ChromeEngine } from "../src/server/browser/pi-browser.ts";
import { ChromeRenderer } from "../src/server/chrome-renderer.ts";
import { checkSteps, stepsScript, stepWords } from "../src/server/render-steps.ts";
import { renderRequest, Screenshots } from "../src/server/screenshots.ts";
import { shootInTab } from "../src/server/tab-render.ts";
import { NO_CARD } from "./no-card.ts";

after(() => cleanUp());

const chrome = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"].find((name) => {
    try {
        execFileSync("which", [name], { stdio: "ignore" });

        return true;
    } catch {
        return false;
    }
});
const skip = chrome === undefined ? "no Chrome on this machine (CI runs it)" : false;

/** The fixture site's password, a saved secret: in no answer, log or page read. */
const PASSWORD = "shop-pass-90817";
const VIEW = `<meta name="viewport" content="width=device-width"><style>body{margin:16px;font:16px sans-serif} input,button{display:block;width:240px;height:44px;margin:8px 0}</style>`;
const LOGIN = `<!doctype html><title>Sign in</title>${VIEW}<form method="post" action="/login"><input id="user" name="user" placeholder="User"><input id="pass" name="pass" type="password" placeholder="Password"><button id="go">Sign in</button></form>`;
/** The signed-in page: its 10 px welcome line is a layout finding that names it. */
const APP = `<!doctype html><title>Orders</title>${VIEW}<h1>Orders</h1><p id="welcome" style="font-size:10px">Signed in as Han</p>`;
/**
 * A case page as visa-dashboard's (PP-501): nothing but "Loading" until its data comes (`/api/case`, signed in only,
 * `apiDelay` ms later), then the case with its "Thêm lịch hẹn" icon button, which opens a Radix dialog: the page hidden
 * around it, the dialog's 10 px note a finding inside it.
 */
const CASE = `<!doctype html><title>Case</title>${VIEW}<div id="app">Loading</div><script>
fetch("/api/case").then((r) => r.ok ? r.json() : Promise.reject(new Error("Sign in first"))).then((c) => {
  document.getElementById("app").innerHTML = "<h1>" + c.name + "</h1><button aria-label=\\"Thêm lịch hẹn\\">+</button>";
  document.querySelector("button").onclick = () => {
    document.getElementById("app").setAttribute("aria-hidden", "true");
    document.body.insertAdjacentHTML("beforeend", "<div style=\\"position:fixed;inset:0;background:rgba(0,0,0,0.5)\\"></div><div role=\\"dialog\\" id=\\"appt\\" data-state=\\"open\\" style=\\"position:fixed;left:16px;right:16px;top:30%;padding:16px;background:#fff\\"><p id=\\"note\\" style=\\"font-size:10px\\">New appointment</p></div>");
  };
}, (error) => { document.getElementById("app").textContent = error.message; });
</script>`;
/** How long the case's data takes. */
let apiDelay = 1500;

let server: Server;
let port = 0;
/** Whether every request reached the site with the sign-in's cookie, by path. */
const visits: { path: string; signedIn: boolean }[] = [];

before(async () => {
    server = createServer((request, response) => {
        const path = (request.url ?? "/").split("?")[0]!;
        const signedIn = /(^|;\s*)sid=ok/.test(request.headers.cookie ?? "");

        if (path === "/favicon.ico") {
            response.writeHead(404);
            response.end();

            return;
        }

        visits.push({ path, signedIn });

        if (path === "/signin") {
            // A sign-in that lasts, as a site's "stay signed in": a session cookie did not outlive the session's last tab
            // closing in this Chrome (the profile's own sign-in is gone then, in Pi's browser too).
            response.writeHead(302, { location: "/case", "set-cookie": "sid=ok; path=/; HttpOnly; Max-Age=86400" });
            response.end();

            return;
        }

        if (path === "/api/case") {
            setTimeout(() => {
                response.writeHead(signedIn ? 200 : 401, { "content-type": "application/json" });
                response.end(JSON.stringify(signedIn ? { name: "Case HS-0089" } : { error: "sign in" }));
            }, apiDelay);

            return;
        }

        if (path === "/login" && request.method === "POST") {
            let body = "";

            request.on("data", (chunk: Buffer) => (body += chunk.toString()));
            request.on("end", () => {
                const right = new URLSearchParams(body).get("pass") === PASSWORD;

                response.writeHead(303, { location: right ? "/app" : "/login", ...(right ? { "set-cookie": "sid=ok; path=/; HttpOnly" } : {}) });
                response.end();
            });

            return;
        }

        if (path === "/app" && !signedIn) {
            response.writeHead(302, { location: "/login" });
            response.end();

            return;
        }

        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(path === "/app" ? APP : path === "/case" ? CASE : LOGIN);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
});

after(() => server?.close());

/** The tool calls the scripted model makes, by the message that asks. */
const CALLS: Record<string, [string, Record<string, unknown>]> = {
    "shoot the orders": ["screenshot", { url: "http://shop.test/app", widths: [390, 1280] }],
    "redline the orders": ["redline", { url: "http://shop.test/app", width: 390 }],
    "sign in and shoot": [
        "screenshot",
        { url: "http://shop.test/app", widths: [390], steps: [{ type: "#user", text: "han" }, { type: "#pass", secret: "SHOP_PW" }, { click: "#go" }, { wait: "#welcome" }] },
    ],
    "type the secret in the open": ["screenshot", { url: "http://shop.test/login", widths: [390], steps: [{ type: "#user", secret: "SHOP_PW" }] }],
    // Its button only once its data came (PP-501): no wait before the click, no settle, as #214022 asked first.
    "add an appointment": ["screenshot", { url: "http://shop.test/case", widths: [390], settle: 0, fullPage: false, steps: [{ click: 'button[aria-label="Thêm lịch hẹn"]' }, { wait: "[role=dialog]" }] }],
};
const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);

    for (const [ask, [tool, args]] of Object.entries(CALLS)) {
        if (role === "user" && text.endsWith(ask)) {
            return fauxAssistantMessage([fauxToolCall(tool, args as never)], { stopReason: "toolUse" });
        }
    }

    return fauxAssistantMessage([fauxText(role === "toolResult" ? `saw: ${text}` : "ok")]);
};

/** Send `text` as the owner and wait for the turn: what the tool answered (Pi's last words quote it). */
async function turn(app: App, id: Awaited<ReturnType<typeof newSession>>, text: string): Promise<string> {
    const { submissionId } = await app.commands.submit(id, owner(app), { text, requestId: crypto.randomUUID() });

    await (await app.harness.submission(submissionId, context))!.wait(context);

    return (await modelTexts(app, id)).at(-1)!;
}

test("a site signed in to in Pi's browser: screenshot at 390 and 1280 and redline show it signed in, with the layout check, in a tab of their own (PP-500)", { skip }, async () => {
    const flags = [`--host-resolver-rules=MAP shop.test 127.0.0.1:${port}`, "--no-sandbox"];
    const engine = new ChromeEngine(chrome!, flags);
    const app = await openApp(scriptedModel(route), join(root, "shot-signed-in"), undefined, { browserEngine: engine });

    try {
        app.secrets.set("SHOP_PW", { value: PASSWORD });

        const id = await newSession(app);
        const session = Number(id);
        // The session signs in in Pi's browser, as Pi does with browser_type's secret and a click.
        const browser = app.browserFor(app.cwdOf(id), session);
        const login = await browser.open(session, "http://shop.test/login");
        const user = Number(/\[(\d+)\] textbox "User"/.exec(login)?.[1] ?? assert.fail(login));
        const pass = Number(/\[(\d+)\] password "Password"/.exec(login)?.[1] ?? assert.fail(login));

        await browser.type(session, user, "han", {}, NO_CARD);
        await browser.typeSecret(session, pass, "SHOP_PW", PASSWORD, {}, NO_CARD);

        const go = Number(/\[(\d+)\] button "Sign in"/.exec(await browser.snapshot(session))?.[1] ?? assert.fail("no Sign in button"));
        const signedIn = await browser.click(session, go, NO_CARD);

        assert.match(signedIn, /Signed in as Han/);

        const tabsBefore = await engine.tabs();
        const front = browser.state();

        visits.length = 0;

        const shot = await turn(app, id, "shoot the orders");

        assert.match(shot, /http:\/\/shop\.test\/app, rendered with the sign-in of Pi's browser on this phone \(out of sight: its tabs stay as they are\): 390×\d+, 1280×\d+/);
        assert.match(shot, /Layout check at 390 px/);
        assert.match(shot, /Layout check at 1280 px/);
        // The signed-in page, measured: its welcome line at both widths.
        assert.equal(shot.match(/p#welcome \\"Signed in as Han\\": 10 px/g)?.length, 2, shot);
        assert.doesNotMatch(shot, /password field/);
        assert.ok(visits.length >= 2 && visits.every((each) => each.path === "/app" && each.signedIn), JSON.stringify(visits));

        const lines = await turn(app, id, "redline the orders");

        assert.match(lines, /http:\/\/shop\.test\/app, measured and pictured, rendered with the sign-in of Pi's browser on this phone .* at 390×\d+ CSS px/);

        // The session's tabs as they were: the render's tabs closed, the one in front the same.
        assert.deepEqual(await engine.tabs(), tabsBefore);
        assert.equal(browser.state().tabs.length, front.tabs.length);
        assert.equal(browser.state().url, front.url);
        assert.ok(!(await modelTexts(app, id)).some((each) => each.includes(PASSWORD)), "the password is in no message");
    } finally {
        await app.close();
        await engine.close();
    }
});

test("a page that draws only once its data came: a click waits up to 5 s for its element, in the signed-in render's own tab, its first request signed in; a selector's wait gives up after 5 s (PP-501)", { skip }, async () => {
    const engine = new ChromeEngine(chrome!, [`--host-resolver-rules=MAP shop.test 127.0.0.1:${port}`, "--no-sandbox"]);
    const app = await openApp(scriptedModel(route), join(root, "shot-late-button"), undefined, { browserEngine: engine });

    try {
        const id = await newSession(app);
        const session = Number(id);
        const browser = app.browserFor(app.cwdOf(id), session);

        apiDelay = 300;
        await browser.open(session, "http://shop.test/signin");
        assert.match(await browser.wait(session, { text: "Case HS-0089" }), /Case HS-0089/);

        // The case's data 3.5 s after the page asks: the button shows long after the load, past the 2 s a click waited.
        apiDelay = 3500;
        visits.length = 0;

        const shot = await turn(app, id, "add an appointment");

        assert.match(shot, /rendered with the sign-in of Pi's browser on this phone \(out of sight: its tabs stay as they are\) after 2 steps \(click [^\n]*\): 390×844/, shot);
        assert.match(shot, /measured inside the open dialog div#appt/, shot);
        // The render's own tab, signed in from its first request: the session's tab loaded nothing.
        assert.deepEqual(
            visits.map((each) => `${each.path} ${each.signedIn}`),
            ["/case true", "/api/case true"],
        );

        // A selector's wait is 5 s, by the clock.
        const started = Date.now();
        const never = renderRequest("http://shop.test/case", { widths: [390], settleMs: 0, fullPage: false, steps: [{ wait: "#never" }] });

        await assert.rejects(shootInTab(engine, never, 390), /step 1 \(wait for "#never"\): nothing visible matched within 5 s: nothing matches "#never"/);
        assert.ok(Date.now() - started >= 5000 && Date.now() - started < 9000, `gave up after ${Date.now() - started} ms`);
    } finally {
        await app.close();
        await engine.close();
    }
});

/** A machine for Pi's browser that is this computer (as browser-machine.test.ts has it): its home a folder of the test's. */
function localMachine() {
    const home = mkdtempSync(join(tmpdir(), "pi-shot-machine-"));
    const run = (script: string): Promise<{ code: number; out: string }> =>
        new Promise((resolve) => {
            const child = spawn("sh", ["-c", script], { env: { ...process.env, HOME: home } });
            let out = "";

            child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
            child.stderr.on("data", (chunk: Buffer) => (out += chunk.toString()));
            child.on("close", (code) => resolve({ code: code ?? 1, out }));
        });
    // Its Chrome's pages, as DevTools lists them: id and address.
    const pages = async (): Promise<string[]> => {
        const devtools = Number(readFileSync(join(home, BROWSER_DIR, "profile/DevToolsActivePort"), "utf8").split("\n")[0]);
        const listed = await new Promise<string>((resolve, reject) => {
            get({ host: "127.0.0.1", port: devtools, path: "/json/list" }, (response) => {
                let body = "";

                response.on("data", (chunk: Buffer) => (body += chunk.toString()));
                response.on("end", () => resolve(body));
            }).on("error", reject);
        });

        return (JSON.parse(listed) as { id: string; type: string; url: string }[]).filter((each) => each.type === "page").map((each) => `${each.id} ${each.url}`);
    };

    return {
        run,
        pages,
        access: { name: "box", home, run, writeFile: async () => {}, forward: async (remote: number) => ({ port: remote, close: () => {} }) },
    };
}

test("a screenshot with steps leaves the session's tab on a machine as it was, and a site signed in to there still renders signed in after the idle sweep closed its tabs (PP-501)", { skip }, async () => {
    const machine = localMachine();
    const logs: string[] = [];
    const app = await openApp(scriptedModel(route), join(root, "shot-machine-tab"), undefined, {
        browserMachines: { list: () => [{ id: "m1", name: "box", connected: true, platform: "linux" }], access: () => machine.access },
        log: (line: string) => logs.push(line),
    });

    app.serverPort = 8798;

    // A render without Pi's browser's sign-in goes to the server's renderer, as the phone's would take it.
    const renderer = new ChromeRenderer(app.screenshots, { binary: chrome!, flags: ["--no-sandbox"], base: "http://127.0.0.1:8798", token: () => "owner-token", log: (line) => logs.push(line) });
    const running = renderer.run();
    const site = `http://127.0.0.1:${port}`;
    const button = 'button[aria-label="Thêm lịch hẹn"]';

    CALLS["shoot the case"] = ["screenshot", { url: `${site}/case`, widths: [390], steps: [{ wait: button }, { click: button }, { wait: "[role=dialog]" }] }];

    try {
        await renderer.ready();
        apiDelay = 1500;

        const id = await newSession(app);
        const session = Number(id);

        app.setBrowserPlace(app.cwdOf(id), session, "box");

        const browser = app.browserFor(app.cwdOf(id), session);

        await browser.open(session, `${site}/signin`);
        assert.match(await browser.wait(session, { text: "Case HS-0089" }), /Case HS-0089/);

        const href = async () => JSON.stringify(await browser.evaluate(session, "location.href", false));
        const before = await href();
        const pagesBefore = await machine.pages();

        assert.equal(before, JSON.stringify({ json: JSON.stringify(`${site}/case`) }));

        const shot = await turn(app, id, "shoot the case");

        assert.match(shot, /rendered with the sign-in of Pi's browser on box \(out of sight: its tabs stay as they are\) after 3 steps/, shot);
        assert.match(shot, /measured inside the open dialog div#appt/, shot);
        // Read in the page itself, not from what Pi's browser remembers: the same address, and the same tabs there.
        assert.equal(await href(), before);
        assert.deepEqual(await machine.pages(), pagesBefore);

        // 30 minutes without the browser (Build #490: a session building and deploying): the sweep closes its tabs, its
        // sign-in stays in the profile, and the next screenshot of the site still renders with it.
        await app.sweepBrowsers(Date.now() + BROWSER_IDLE_MS + 60_000);
        assert.equal(browser.state().tabs.length, 0, "the idle sweep closed the session's tabs");

        const later = await turn(app, id, "shoot the case");

        assert.match(later, /rendered with the sign-in of Pi's browser on box \(out of sight: its tabs stay as they are\) after 3 steps/, later);
        assert.match(later, /measured inside the open dialog div#appt/, later);
    } finally {
        await renderer.stop();
        await running;
        await app.close();
        await machine.run(stopScript());
    }
});

test("without Pi's browser's sign-in, a password field is said with what to do; steps type a saved secret into it, send the form and go on on the next page; its value shows nowhere (PP-500)", { skip }, async () => {
    const flags = [`--host-resolver-rules=MAP shop.test 127.0.0.1:${port}`, "--no-sandbox"];
    const logs: string[] = [];
    const app = await openApp(scriptedModel(route), join(root, "shot-secret-step"), undefined, { log: (line: string) => logs.push(line) });

    app.serverPort = 8799;

    const renderer = new ChromeRenderer(app.screenshots, { binary: chrome!, flags, base: "http://127.0.0.1:8799", token: () => "owner-token", log: (line) => logs.push(line) });
    const running = renderer.run();

    try {
        await renderer.ready();
        app.secrets.set("SHOP_PW", { value: PASSWORD });

        const id = await newSession(app);
        const plain = await turn(app, id, "shoot the orders");

        assert.match(plain, /http:\/\/shop\.test\/app, as the phone renders it: 390×\d+, 1280×\d+/);
        assert.match(plain, /The page shows a password field: this may be its sign-in screen[^"]*browser_open[^"]*\{type: css, secret: NAME\}/);

        visits.length = 0;

        const signed = await turn(app, id, "sign in and shoot");

        assert.match(signed, /after 4 steps \(type into \\"#user\\", type \[secret SHOP_PW\] into \\"#pass\\", click \\"#go\\", wait for \\"#welcome\\"\): 390×\d+/);
        assert.match(signed, /p#welcome \\"Signed in as Han\\": 10 px/);
        assert.doesNotMatch(signed, /password field/);
        assert.deepEqual(
            visits.map((each) => `${each.path} ${each.signedIn}`),
            ["/app false", "/login false", "/login false", "/app true"],
            "the form was sent with the password, and the next page loaded signed in",
        );

        const refused = await turn(app, id, "type the secret in the open");

        assert.match(refused, /step 1 \(type \[secret SHOP_PW\] into \\"#user\\"\): \\"#user\\" is not a password field: a secret is typed into a password field only/);
        assert.doesNotMatch(refused, /This render has no sign-in of yours/, "a field of the wrong kind is no missing sign-in");

        // Without the sign-in, the case page draws no button: the step's failure says the render had no sign-in, and
        // what to do (PP-501: it said only "nothing matches", and #214022 took the page for slow). At 127.0.0.1, a site
        // the steps above did not sign in to in this renderer.
        apiDelay = 300;
        CALLS["add an appointment there"] = ["screenshot", { ...CALLS["add an appointment"]![1], url: `http://127.0.0.1:${port}/case` }];

        const unsigned = await turn(app, id, "add an appointment there");

        assert.match(unsigned, /step 1 \(click [^)]*\): nothing matches [^\n]*\\nThis render has no sign-in of yours \(no tab of this session's Pi browser has shown this site\)[^"]*browser_open/, unsigned);

        const said = [...(await modelTexts(app, id)), ...logs].join("\n");

        assert.ok(!said.includes(PASSWORD), "the password is in no message or log line");
    } finally {
        await renderer.stop();
        await running;
        await app.close();
    }
});

test("a secret step: checked by its name, said by its name, its value only in the page's script; one not looked up is no script (PP-500)", () => {
    const steps = checkSteps([{ type: "#pass", secret: "SHOP_PW" }, { click: "#go" }]);

    assert.ok(!("error" in steps));
    assert.deepEqual(steps[0], { type: "#pass", secret: "SHOP_PW" });
    assert.equal(stepWords(steps[0]!), 'type [secret SHOP_PW] into "#pass"');
    assert.match(String((checkSteps([{ type: "#pass", secret: "not a name" }]) as { error: string }).error), /Step 1: each step is one of .*\{ type: selector, secret: NAME \}/);
    assert.throws(() => stepsScript(steps), /The secret SHOP_PW of a step was not looked up/);

    const script = stepsScript([{ type: "#pass", secret: "SHOP_PW", value: PASSWORD }]);

    assert.ok(script.includes(PASSWORD) && !script.includes('"secret":"SHOP_PW"'), "the page gets the value, not the name");
});

test("a phone app that does not say it rendered with Pi's browser's profile is refused, saying to update it; one that does is taken (PP-500)", async () => {
    const screenshots = new Screenshots();
    const stop = new AbortController();
    const answers: Record<string, unknown>[] = [{ width: 390, height: 844, parts: ["AA=="] }, { width: 390, height: 844, parts: ["AA=="], profile: "pi-browser" }];
    const asked: string[] = [];
    const phone = (async () => {
        let at = -1;

        while (!stop.signal.aborted && answers.length > 0) {
            const { seq, requests } = await screenshots.after(at, stop.signal);

            for (const request of requests) {
                asked.push(request.profile);
                screenshots.answer(request.id, { shots: [answers.shift()] });
            }

            at = seq;
        }
    })();

    await screenshots.after(-1, AbortSignal.abort());
    await assert.rejects(screenshots.render("https://shop.test/app", { widths: [390], profile: "pi-browser" }), /does not render with Pi's browser's sign-ins yet: update it/);

    const [shot] = await screenshots.render("https://shop.test/app", { widths: [390], profile: "pi-browser" });

    assert.equal(shot?.width, 390);
    assert.deepEqual(asked, ["pi-browser", "pi-browser"]);
    stop.abort();
    await phone;
});
