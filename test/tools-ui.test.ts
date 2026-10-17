// pi-phone's own screens in a real browser: the terminal (a shell through the local pi-env daemon, its key row, Paste
// and Select, and taking the shell up again after the sheet closed), the Files panel's upload and empty folder, and
// the Continue in Pi sheet of a session that has not gone to Pi.
import { type App, cleanUp, home, owner, root, scriptedModel, until, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Browsers } from "./support/browser.ts";
import { findBrowser } from "./support/browser/discovery.ts";
import type { BrowserPage } from "./support/browser/page.ts";
import { VIEWPORTS } from "./support/browser/viewport.ts";
import { Auth } from "../src/server/auth.ts";
import { createHandler } from "../src/server/http.ts";
import { attachTerminals } from "../src/server/terminal.ts";

const { PocketApp } = await import("../src/server/app.ts");

const chromium = findBrowser();
const real = { skip: chromium === undefined ? "no Chromium-based browser on this machine" : false } as const;

let app: App;
let server: Server;
let closeTerminals: () => void;
let browsers: Browsers;
let page: BrowserPage;
let base = "";

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

const see = (script: string, what: string) => until(async () => (await inPage<boolean>(script)) === true, what);
const settled = () => new Promise((resolve) => setTimeout(resolve, 450));

const problems = () =>
    inPage<string[]>(`
        const { store } = await import("/store.js");

        return JSON.stringify([
            ...window.pageErrors,
            ...store.state.notices.filter((notice) => notice.level === "error").map((notice) => notice.message),
        ]);
    `);

/** Signed in as the owner, at phone size, in session `id`. */
async function open(id: number): Promise<void> {
    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await see(`return JSON.stringify((await import("/store.js")).store.state.me?.role === "owner")`, "signed in");
    await page.evaluate(`
        window.pageErrors = [];
        addEventListener("error", (event) => window.pageErrors.push(String(event.message)));
        (await import("/store.js")).navigate(${id});

        return "true";
    `);
    await see(`return JSON.stringify((await import("/store.js")).store.state.view.agent?.cwd !== undefined)`, "the session");
}

before(async () => {
    if (chromium === undefined) {
        return;
    }

    // The daemon starts `SHELL`, as PiService sets it in the app.
    process.env.SHELL = execFileSync("sh", ["-c", "command -v bash"], { encoding: "utf8" }).trim();
    const faux = scriptedModel();

    app = await PocketApp.open({
        dataDir: join(root, "tools-ui-data"),
        defaultCwd: work,
        supervised: false,
        log: () => {},
        home,
        configureModels: (models) => models.registerNativeProvider(faux.provider),
    });
    server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
    closeTerminals = attachTerminals(server, app, new Auth(app.config));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({ dataDir: mkdtempSync(join(root, "tools-ui-browser-")), load: async () => undefined, save: () => {} });
    page = await browsers.open(1);
});

after(async () => {
    closeTerminals?.();
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test("the terminal runs a shell, takes Paste and the key row, selects its text, and is taken up again", real, async () => {
    const { id } = await app.commands.createSession(owner(app), { cwd: work });

    await open(Number(id));
    await page.evaluate(`(await import("/store.js")).openSheet({ type: "terminal", place: ${JSON.stringify(work)} }); return "true";`);
    await see(`return JSON.stringify(document.querySelector('[data-part="terminal"] .terminal-state')?.textContent.trim() === "")`, "the shell");
    await settled();

    // Paste: a box to paste into, sent as typed.
    await page.click({ label: "Paste" });
    await page.type({ selector: '[data-part="terminal"] textarea[name="text"]' }, "echo ui-$((6*7))");
    await page.click({ label: "Send" });
    await page.evaluate(`
        document.querySelector('[data-part="terminal"] .xterm-helper-textarea').focus();
        return "true";
    `);
    await page.press("Enter");
    await see(`return JSON.stringify(document.querySelector('[data-part="terminal"] .xterm-rows')?.textContent.includes("ui-42") === true)`, "the shell's answer");

    // The key row: Ctrl, then c, interrupts what is typed.
    await page.evaluate(`
        document.querySelector('[data-part="terminal"] .xterm-helper-textarea').focus();
        return "true";
    `);
    await page.type(undefined, "sleep 30");
    await page.click({ label: "Ctrl" });
    await page.evaluate(`
        document.querySelector('[data-part="terminal"] .xterm-helper-textarea').focus();
        return "true";
    `);
    await page.type(undefined, "c");
    await see(`return JSON.stringify(document.querySelector('[data-part="terminal"] .xterm-rows').textContent.includes("^C"))`, "Ctrl+C");

    // Select: the text, to select with a finger.
    await page.click({ label: "Select" });
    await see(`return JSON.stringify(document.querySelector('[data-part="terminal"] textarea.terminal-text')?.value.includes("ui-42") === true)`, "the text to select");
    await settled();
    await page.click({ label: "Done" });

    // Closed, the shell runs on; opened again at the same place, it is the same shell, with what it wrote.
    await page.click({ label: "Close the terminal; the shell runs on" });
    await see(`return JSON.stringify(document.querySelector('[data-part="terminal"]') === null)`, "the terminal closed");
    await page.evaluate(`(await import("/store.js")).openSheet({ type: "terminal", place: ${JSON.stringify(work)} }); return "true";`);
    await see(`return JSON.stringify(document.querySelector('[data-part="terminal"] .xterm-rows')?.textContent.includes("ui-42") === true)`, "the same shell");
    await settled();
    await page.click({ label: "End" });
    await see(`return JSON.stringify(document.querySelector('[data-part="terminal"]') === null)`, "the terminal ended");
    assert.deepEqual(await problems(), []);
});

test("the Files panel says a folder is empty, and uploads a file into it", real, async () => {
    const folder = join(work, "empty-for-upload");

    mkdirSync(folder, { recursive: true });
    const { id } = await app.commands.createSession(owner(app), { cwd: folder });

    await open(Number(id));
    await page.evaluate(`(await import("/files-panel.js")).setFilesOpen(true, "files"); return "true";`);
    await see(`return JSON.stringify(document.querySelector('[data-part="files-panel"]')?.textContent.includes("This folder is empty") === true)`, "the empty folder");
    await page.evaluate(`
        const input = document.querySelector('[data-part="files-panel"] input[type="file"]');
        const files = new DataTransfer();

        files.items.add(new File(["from the browser\\n"], "notes.txt", { type: "text/plain" }));
        input.files = files.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));

        return "true";
    `);
    await see(`return JSON.stringify([...document.querySelectorAll('[data-part="files-panel"] .ft-name')].some((each) => each.textContent === "notes.txt"))`, "the uploaded file listed");
    assert.equal(readFileSync(join(folder, "notes.txt"), "utf8"), "from the browser\n");
    assert.deepEqual(await problems(), []);
});

test("Continue in Pi, for a session that has not gone to Pi, offers a folder on a machine", real, async () => {
    const { id } = await app.commands.createSession(owner(app), { cwd: work });

    await open(Number(id));
    await page.evaluate(`(await import("/store.js")).openSheet({ type: "pi-handoff" }); return "true";`);
    await see(`return JSON.stringify(document.body.textContent.includes("This session has not gone to Pi."))`, "the sheet");
    await settled();
    // No machine here: picking one says how to get one, by name.
    await page.click({ label: "Pick a folder on a machine" });
    await see(
        `return JSON.stringify((await import("/store.js")).store.state.notices.some((notice) => notice.message.startsWith("Connect a machine first")))`,
        "what to do",
    );
});

test("This phone backs up from a browser, and a file in the Files panel downloads", real, async () => {
    const folder = join(work, "with-a-file");

    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "report.txt"), "the report\n");
    const { id } = await app.commands.createSession(owner(app), { cwd: folder });

    await open(Number(id));
    // Downloads: in a browser, as a link the page clicks; what it fetched is what is checked.
    await page.evaluate(`
        window.downloaded = [];
        const click = HTMLAnchorElement.prototype.click;

        HTMLAnchorElement.prototype.click = function () {
            if (this.download) {
                window.downloaded.push(this.download);
            } else {
                click.call(this);
            }
        };

        return "true";
    `);
    await page.evaluate(`(await import("/store.js")).openSheet({ type: "phone" }); return "true";`);
    await see(`return JSON.stringify(document.body.textContent.includes("Keep it private"))`, "the phone sheet");
    await settled();
    await page.click({ label: "Back up" });
    await see(`return JSON.stringify(window.downloaded.some((name) => name.startsWith("pi-phone-backup-")))`, "the backup");

    await page.evaluate(`(await import("/store.js")).closeSheet(); (await import("/files-panel.js")).setFilesOpen(true, "files"); return "true";`);
    await see(`return JSON.stringify([...document.querySelectorAll('[data-part="files-panel"] .ft-name')].some((each) => each.textContent === "report.txt"))`, "the file");
    await page.evaluate(`[...document.querySelectorAll('[data-part="files-panel"] .ft-row')].find((each) => each.textContent.includes("report.txt")).click(); return "true";`);
    await see(`return JSON.stringify(document.querySelector('[aria-label="Download report.txt"]') !== null)`, "the viewer");
    await settled();
    await page.click({ label: "Download report.txt" });
    await see(`return JSON.stringify(window.downloaded.includes("report.txt"))`, "the download");
    assert.deepEqual(await problems(), []);
});
