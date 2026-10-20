/**
 * The README's pictures (docs/images/*.png), made from a demo app, never the owner's: a fresh data folder and home in a
 * temporary folder, a scripted model ("demo") that answers with made-up work in a made-up "todo-app" project, and a
 * real Chrome that shoots the app's own pages at phone and desktop sizes. Nothing of the person running it shows: no
 * sessions, folders, accounts, machines, or costs of theirs.
 *
 *     node scripts/readme-shots.ts [out folder, default docs/images]   # needs Chrome or Chromium on PATH
 *
 * Not for the phone (it runs Chrome): run it on a computer with a clone of the repository.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fauxAssistantMessage, fauxProvider, type FauxResponseStep, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { PocketApp } from "../src/server/app.ts";
import { ChromeEngine } from "../src/server/browser/pi-browser.ts";
import type { Cdp } from "../src/server/browser/cdp.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createHandler } from "../src/server/http.ts";
import { Projects } from "../src/server/projects.ts";

const out = resolve(process.argv[2] ?? "docs/images");

// The app shortens paths by HOME (~/projects/todo-app): run again with HOME in the demo folder, so neither the real home
// nor the temporary folder's name shows.
if (process.env.PI_SHOTS_ROOT === undefined) {
    const made = mkdtempSync(join(tmpdir(), "pi-phone-shots-"));

    mkdirSync(join(made, "home"), { recursive: true });
    try {
        execFileSync(process.execPath, [process.argv[1]!, out], { stdio: "inherit", env: { ...process.env, PI_SHOTS_ROOT: made, HOME: join(made, "home") } });
    } finally {
        rmSync(made, { recursive: true, force: true });
    }
    process.exit(0);
}

const root = process.env.PI_SHOTS_ROOT;
const home = join(root, "home");
const app1 = join(home, "projects", "todo-app");

// ─── A made-up project for Pi to work in ───
mkdirSync(join(app1, "src"), { recursive: true });
mkdirSync(join(app1, "test"), { recursive: true });
writeFileSync(join(app1, "package.json"), JSON.stringify({ name: "todo-app", version: "2.3.0", type: "module" }, null, 2));
writeFileSync(join(app1, "src", "settings.js"), "export const settings = { theme: 'light', compact: false };\n");
writeFileSync(join(app1, "src", "app.js"), "import { settings } from './settings.js';\nexport function render() { return settings.theme; }\n");
writeFileSync(
    join(app1, "test", "theme.test.js"),
    "import test from 'node:test';\nimport assert from 'node:assert';\nimport { settings } from '../src/settings.js';\n" +
        "test('light by default', () => assert.equal(settings.theme, 'light'));\n" +
        "test('dark is offered', () => assert.ok(['light', 'dark'].includes('dark')));\n" +
        "test('compact is off', () => assert.equal(settings.compact, false));\n",
);

const THEME_CSS = `:root { --bg: #ffffff; --text: #1f2328; }
:root[data-theme="dark"] { --bg: #16181d; --text: #e6e6e6; }
body { background: var(--bg); color: var(--text); }`;

/** What Pi says, by the session's first message: each a list of steps, one per model turn. */
const SCRIPTS: Record<string, FauxResponseStep[]> = {
    "Add a dark mode toggle to the settings page": [
        () => fauxAssistantMessage([fauxText("I'll look at how settings are stored first."), fauxToolCall("bash", { command: "ls src test && cat src/settings.js" })], { stopReason: "toolUse" }),
        () => fauxAssistantMessage([fauxToolCall("write", { path: "src/theme.css", content: THEME_CSS })], { stopReason: "toolUse" }),
        () => fauxAssistantMessage([fauxToolCall("bash", { command: "node --test test/ 2>&1 | grep -E 'tests|pass|fail' | tail -3" })], { stopReason: "toolUse" }),
        () =>
            fauxAssistantMessage([
                fauxText(
                    "Dark mode is in, and the 3 tests pass.\n\n" +
                        "- **`src/theme.css`:** colors as variables, with a dark set under `data-theme=\"dark\"`.\n" +
                        "- **Settings:** a toggle that sets the attribute and remembers the choice.\n\n" +
                        "```css\n:root[data-theme=\"dark\"] { --bg: #16181d; --text: #e6e6e6; }\n```\n\n" +
                        "| File | Change |\n|---|---|\n| `src/theme.css` | new, 3 rules |\n| `src/settings.js` | `theme` saved |\n\n" +
                        "Want me to follow the phone's own light or dark setting too?",
                ),
            ]),
    ],
    "How does a request flow through the app?": [
        () =>
            fauxAssistantMessage([
                fauxText(
                    "A request goes through three layers:\n\n" +
                        "```mermaid\nflowchart LR\n  UI[Settings page] -->|toggle| Store[(settings store)]\n  Store --> Theme[theme.css variables]\n  Store --> Save[localStorage]\n```\n\n" +
                        "| Layer | File | Job |\n|---|---|---|\n| View | `src/app.js` | draws the page |\n| State | `src/settings.js` | holds the choice |\n| Style | `src/theme.css` | colors per theme |\n\n" +
                        "The store is the only place the theme changes, so the toggle and the saved value never disagree.",
                ),
            ]),
    ],
    "Use Jev for browser runs": [
        () =>
            fauxAssistantMessage(
                [
                    fauxText("I'll switch the run model for `browser_run`. You approve it on the card."),
                    fauxToolCall("setting_change", { id: "browser.runModel", value: "typesafe/jev-1.13", reason: "You asked for Jev to decide each browser_run step: about a second and a tiny cost a step." }),
                ],
                { stopReason: "toolUse" },
            ),
        () => fauxAssistantMessage([fauxText("Done: browser runs now use Jev.")]),
    ],
};

const firstUserText = (messages: readonly { role: string; content: unknown }[]): string => {
    const first = messages.find((message) => message.role === "user");
    const content = first?.content;

    if (typeof content === "string") {
        return content;
    }

    return Array.isArray(content) ? content.map((part: { type: string; text?: string }) => (part.type === "text" ? (part.text ?? "") : "")).join("") : "";
};

const route: FauxResponseStep = (context) => {
    const messages = (context as { messages: readonly { role: string; content: unknown }[] }).messages;
    const script = Object.entries(SCRIPTS).find(([start]) => firstUserText(messages).includes(start))?.[1];
    const turn = messages.filter((message) => message.role === "assistant").length;

    return script?.[turn] !== undefined ? (script[turn] as (c: unknown) => ReturnType<typeof fauxAssistantMessage>)(context) : fauxAssistantMessage([fauxText("Done.")]);
};

const demo = fauxProvider({ provider: "demo", tokensPerSecond: 4000, models: [{ id: "demo-model", name: "Demo model" }] });

demo.setResponses(Array.from({ length: 200 }, () => route));

const app = await PocketApp.open({
    dataDir: join(root, "data"),
    defaultCwd: app1,
    supervised: false,
    log: () => {},
    home,
    configureModels: (models) => models.registerNativeProvider(demo.provider),
    officecli: { runs: false },
});
const owner = app.config.users.find((user) => user.role === "owner")!;

app.config.lastModel = { provider: "demo", modelId: "demo-model", thinkingLevel: "off" };

async function session(text: string, wait = true): Promise<number> {
    const { id } = await app.commands.createSession(owner, { cwd: app1 });

    await app.commands.configure(id, owner, { model: { provider: "demo", modelId: "demo-model" }, thinkingLevel: "off" });
    const { submissionId } = await app.commands.submit(id, owner, { text, requestId: crypto.randomUUID() });

    if (wait) {
        await (await app.harness.submission(submissionId, BACKGROUND_CONTEXT))!.wait(BACKGROUND_CONTEXT);
    } else {
        await new Promise((done) => setTimeout(done, 1500));
    }

    return id as number;
}

// ─── Demo sessions (oldest first: the list shows the newest on top) ───
for (const title of ["Write the release notes for 2.3", "Weekly dependency updates", "Fix the flaky login test"]) {
    await session(title);
}

const flow = await session("How does a request flow through the app?");
const approval = await session("Use Jev for browser runs", false);
const work = await session("Add a dark mode toggle to the settings page");

// ─── A board for the made-up project ───
await app.setExtensionEnabled(owner, "projects.ts", true);
{
    const projects = new Projects(join(root, "data"), () => app.config.users.map((user) => ({ id: user.id, name: user.name, role: user.role })) as never);
    const as = { kind: "person", person: { id: owner.id, name: owner.name, role: "owner" } } as never;

    projects.create(as, { key: "TODO", name: "Todo app", folder: "~/projects/todo-app" });
    const epic = projects.createTask(as, "TODO", { title: "Themes", type: "epic" });
    const tasks: [string, string, string, number][] = [
        ["Dark mode toggle in settings", "task", "review", 3],
        ["Follow the phone's light or dark setting", "story", "planning", 2],
        ["Flaky login test on CI", "bug", "in_progress", 4],
        ["Release notes for 2.3", "task", "done", 1],
        ["Weekly dependency updates", "task", "assigned", 1],
        ["Offline mode", "story", "inbox", 2],
        ["Export tasks as CSV", "task", "testing", 2],
    ];

    for (const [title, type, state, priority] of tasks) {
        const made = projects.createTask(as, "TODO", { title, type, priority, ...(type === "story" || type === "task" ? { parent: epic.ref } : {}) } as never);

        projects.updateTask(as, made.ref, { state, assignee: state === "inbox" ? "" : "pi" } as never);
    }

    projects.close();
}

// ─── Serve it, and shoot it in Chrome ───
const server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));

await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const chrome = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"].find((name) => {
    try {
        execFileSync("which", [name], { stdio: "ignore" });

        return true;
    } catch {
        return false;
    }
});

if (chrome === undefined) {
    throw new Error("No Chrome or Chromium on PATH.");
}

const engine = new ChromeEngine(chrome, ["--no-sandbox", "--hide-scrollbars", "--force-dark-mode"]);
const cdp: Cdp = await engine.connect((await engine.tabs())[0]!);
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
const evaluate = async (expression: string) =>
    ((await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })) as { result: { value?: unknown } }).result.value;

await cdp.send("Page.enable");
mkdirSync(out, { recursive: true });

async function shot(name: string, path: string, size: "phone" | "desktop", then?: string): Promise<void> {
    const phone = size === "phone";

    await cdp.send("Emulation.setDeviceMetricsOverride", { width: phone ? 390 : 1280, height: phone ? 844 : 800, deviceScaleFactor: phone ? 2 : 1.5, mobile: phone });
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: phone });
    await cdp.send("Page.navigate", { url: base + path });
    await pause(3500);

    if (then !== undefined) {
        await evaluate(then);
        await pause(1500);
    }

    const { data } = (await cdp.send("Page.captureScreenshot", { format: "png" })) as { data: string };

    writeFileSync(join(out, `${name}.png`), Buffer.from(data, "base64"));
    console.log(`${name}.png`);
}

await cdp.send("Page.navigate", { url: `${base}/login?token=${encodeURIComponent(app.config.ownerToken)}` });
await pause(2500);
await shot("phone-sessions", "/", "phone");
await shot("phone-session", `/s/${work}`, "phone");
await shot("phone-approval", `/s/${approval}`, "phone");
await shot(
    "phone-menu",
    `/s/${work}`,
    "phone",
    `(async () => {
        document.querySelector('.topbar [aria-label="Menu"]')?.click();
        await new Promise((done) => setTimeout(done, 1200));
        [...document.querySelectorAll('.group-title')].find((title) => title.textContent.trim() === 'App')?.scrollIntoView({ block: 'start' });
    })()`,
);
await shot("desktop-session", `/s/${flow}`, "desktop");
await shot("desktop-board", "/?page=projects:projects", "desktop");

cdp.close();
await engine.close();
server.closeAllConnections();
server.close();
await app.close();
process.exit(0);
