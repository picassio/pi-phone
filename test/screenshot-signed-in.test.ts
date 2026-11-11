// screenshot and redline of a page behind a sign-in (PP-500), on a real Chrome (CI has one): a site the session signed in
// to in Pi's browser renders with that browser's sign-in, in a tab of its own there (the session's tabs untouched), at
// each width with the layout check; a page rendered without it that shows a password field says why and what to do;
// steps type a saved secret into a password field (a sign-in form sent, the steps going on on the next page), and its
// value is in no answer, log or page read; a phone app too old to render with Pi's browser's profile is refused.
import { type App, cleanUp, context, lastText, modelTexts, newSession, openApp, owner, root, scriptedModel } from "./helpers.ts";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { ChromeEngine } from "../src/server/browser/pi-browser.ts";
import { ChromeRenderer } from "../src/server/chrome-renderer.ts";
import { checkSteps, stepsScript, stepWords } from "../src/server/render-steps.ts";
import { Screenshots } from "../src/server/screenshots.ts";
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
        response.end(path === "/app" ? APP : LOGIN);
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
