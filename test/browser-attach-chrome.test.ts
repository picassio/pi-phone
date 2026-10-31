// browser_attach with a real Chrome (PP-274): a Chrome started with --remote-debugging-port on "the machine" (this
// computer, its port reached as through the forward), named by its DevToolsActivePort file. The owner's card shows its
// profile; then a sign-in card fills its page with what the owner typed, which Pi never reads (PP-93, PP-228), a window
// its page opens becomes a tab (PP-249), and detaching leaves Chrome and its tabs running. CI and the devbox run it.
import { type App, cleanUp, context, lastText, modelTexts, newSession, openApp, owner, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

const chrome = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"].find((name) => {
    try {
        execFileSync("which", [name], { stdio: "ignore" });

        return true;
    } catch {
        return false;
    }
});

const PAGES: Record<string, string> = {
    "/login": `<!doctype html><title>Sign in</title>
        <form onsubmit="event.preventDefault(); document.body.innerHTML = '<p>Hello ' + email.value + ', signed in</p>'">
            <label>Email <input id="email" type="email"></label>
            <label>Password <input id="pw" type="password"></label>
            <button>Sign in</button>
        </form>`,
    "/sign": `<!doctype html><title>App</title><p id="out">Signed out</p>
        <button onclick="window.open('/popup', 'msal', 'width=480,height=640')">Sign in again</button>`,
    "/popup": `<!doctype html><title>Popup</title><p>Signing in</p>`,
};

const calls: Record<string, [string, Record<string, unknown>]> = {};
const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);

    for (const [ask, [tool, args]] of Object.entries(calls)) {
        if (role === "user" && text.endsWith(ask)) {
            return fauxAssistantMessage([fauxToolCall(tool, args as never)], { stopReason: "toolUse" });
        }
    }

    return fauxAssistantMessage([fauxText(role === "toolResult" ? `told: ${text}` : "ok")]);
};

let app: App | undefined;
let server: Server | undefined;
let browser: ChildProcess | undefined;
const home = mkdtempSync(join(tmpdir(), "pi-attach-home-"));
const profile = join(home, "own-chrome");
let devtools = 0;

before(async () => {
    if (chrome === undefined) {
        return;
    }

    server = createServer((request, response) => {
        const page = PAGES[request.url ?? "/"];

        response.writeHead(page === undefined ? 404 : 200, { "content-type": "text/html; charset=utf-8" });
        response.end(page ?? "not here");
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;

    // A browser pi-phone did not start: its own profile, its DevTools on 127.0.0.1.
    mkdirSync(profile);
    browser = spawn(chrome, ["--headless=new", "--no-sandbox", "--remote-debugging-port=0", `--user-data-dir=${profile}`, `--host-resolver-rules=MAP pi.test 127.0.0.1:${port}`, "about:blank"], { stdio: "ignore" });
    await until(() => existsSync(join(profile, "DevToolsActivePort")) && readFileSync(join(profile, "DevToolsActivePort"), "utf8").includes("\n"), "Chrome's DevTools port", 20_000);
    devtools = Number(readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]);

    app = await openApp(scriptedModel(route), join(root, "browser-attach-chrome"), undefined, {
        browserMachines: {
            list: () => [{ id: "m1", name: "devbox", connected: true, platform: "linux" }],
            access: () => ({
                name: "devbox",
                home,
                // The machine's scripts run here, as on a machine.
                run: (script) =>
                    new Promise((resolve) => {
                        const child = spawn("sh", ["-c", script], { env: { ...process.env, HOME: home } });
                        let out = "";

                        child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
                        child.stderr.on("data", (chunk: Buffer) => (out += chunk.toString()));
                        child.on("close", (code) => resolve({ code: code ?? 1, out }));
                    }),
                writeFile: async () => {},
                forward: async (remote) => ({ port: remote, close: () => {} }),
            }),
        },
    });
});

after(async () => {
    await app?.close();
    server?.close();
    browser?.kill();
    cleanUp();
});

async function turn(id: number, text: string, answer?: (card: ReturnType<App["approvals"]["all"]>[number]) => Promise<unknown>) {
    const { submissionId } = await app!.commands.submit(id as never, owner(app!), { text, requestId: crypto.randomUUID() });
    let card: ReturnType<App["approvals"]["all"]>[number] | undefined;

    if (answer !== undefined) {
        await until(() => app!.approvals.forConversation(id as never).length > 0, "the card", 20_000);
        card = app!.approvals.forConversation(id as never)[0]!;
        await answer(card);
    }

    await (await app!.harness.submission(submissionId, context))!.wait(context);

    return { said: (await modelTexts(app!, id as never)).at(-1)!, card };
}

test("with Chrome: attached by its DevToolsActivePort after the owner's card, a sign-in card fills its page unseen by Pi, a window its page opens is a tab, and detach leaves it running", { skip: chrome === undefined ? "no Chrome on this machine (CI runs it)" : false }, async () => {
    const id = await newSession(app!);

    calls["attach it"] = ["browser_attach", { machine: "devbox", devtools_active_port: "~/own-chrome/DevToolsActivePort", label: "My Chrome" }];
    const attached = await turn(id, "attach it", (card) => app!.answerApproval(card.id, true, owner(app!)));

    assert.match(attached.card?.subject ?? "", new RegExp(`Port: ${devtools} .*\\nBrowser: (Headless)?Chrome/[\\d.]+ \\(headless\\)\\nProfile: ${profile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\nTabs: only those Pi opens there`));
    assert.match(attached.said, /attached to My Chrome on devbox/);

    calls["open the login"] = ["browser_open", { url: "http://pi.test/login" }];
    const login = (await turn(id, "open the login")).said;
    const user = Number(/\[(\d+)\] textbox \\"Email\\"/.exec(login)?.[1]);
    const pw = Number(/\[(\d+)\] password \\"Password\\"/.exec(login)?.[1]);

    assert.ok(user > 0 && pw > 0, login);

    calls["sign in"] = ["browser_sign_in", { username: user, password: pw }];
    const signed = await turn(id, "sign in", async (card) => {
        assert.equal(card.form?.type, "browser");
        assert.equal((card.form as { place?: string }).place, `attach:m1:${devtools}`, "the card fills the attached browser's page");
        await app!.answerBrowserAsk(card.id, { values: { username: "tuan@example.com", password: "hunter2-secret" } }, owner(app!));
    });

    assert.doesNotMatch(signed.said, /hunter2-secret|tuan@example\.com/, "what the owner typed never reaches Pi");
    assert.match(signed.said, /\[username for pi\.test\]/);

    calls["submit"] = ["browser_click", { index: Number(/\[(\d+)\] button \\"Sign in\\"/.exec(signed.said)?.[1]) }];
    const welcomed = (await turn(id, "submit")).said;

    assert.match(welcomed, /Hello \[username for pi\.test\], signed in/);
    assert.doesNotMatch(welcomed, /tuan@example\.com/);

    calls["open the app"] = ["browser_open", { url: "http://pi.test/sign" }];
    const appPage = (await turn(id, "open the app")).said;

    calls["sign in again"] = ["browser_click", { index: Number(/\[(\d+)\] button \\"Sign in again\\"/.exec(appPage)?.[1]) }];
    assert.match((await turn(id, "sign in again")).said, /The page opened a window: http:\/\/pi\.test\/popup; it is tab 2 now \(in front\)/);

    calls["let go"] = ["browser_detach", {}];
    assert.match((await turn(id, "let go")).said, /let go of My Chrome on devbox: it runs on/);

    // Chrome runs on, with its tabs.
    const listed = (await (await fetch(`http://127.0.0.1:${devtools}/json/list`)).json()) as { url: string }[];

    assert.ok(listed.some((each) => each.url === "http://pi.test/sign"), JSON.stringify(listed));
    assert.ok(listed.some((each) => each.url === "http://pi.test/popup"));
});
