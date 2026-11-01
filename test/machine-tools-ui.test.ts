// Pi's machine_tools card in a real browser (PP-325): the machine, each tool with its version from and to and its size
// (a need of another marked), fitting a phone's column; Update answers it allowed, and the owner alone may (a guest's
// Approve is refused by the server). With MACHINE_TOOLS_SHOTS set to a folder, screenshots at 390 and 1280 px go there.
import { type App, cleanUp, context, newSession, openApp, owner, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import type { ApprovalRequest } from "../src/server/host.ts";
import { createHandler } from "../src/server/http.ts";
import { Browsers } from "./support/browser.ts";
import { findBrowser } from "./support/browser/discovery.ts";
import type { BrowserPage } from "./support/browser/page.ts";
import { VIEWPORTS } from "./support/browser/viewport.ts";

const chromium = findBrowser();
const real = { skip: chromium === undefined ? "no Chromium-based browser on this machine" : false } as const;
const SHOTS = process.env.MACHINE_TOOLS_SHOTS;

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";

const inPage = async <T>(script: string): Promise<T> => JSON.parse(await page.evaluate(script)) as T;
const see = (script: string, what: string, timeoutMs?: number) => until(async () => (await inPage<boolean>(script)) === true, what, timeoutMs);
const text = (selector: string) => inPage<string>(`return JSON.stringify(document.querySelector(${JSON.stringify(selector)})?.innerText ?? "")`);

async function shot(name: string): Promise<void> {
    if (SHOTS !== undefined) {
        mkdirSync(SHOTS, { recursive: true });
        await new Promise((resolve) => setTimeout(resolve, 400));
        writeFileSync(join(SHOTS, `${name}.jpg`), Buffer.from((await page.screenshot()).data, "base64"));
    }
}

before(async () => {
    if (chromium === undefined) {
        return;
    }

    app = await openApp(scriptedModel(() => fauxAssistantMessage([fauxText("ok")])));
    server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({ dataDir: mkdtempSync(join(root, "machine-tools-ui-")), load: async () => undefined, save: () => {} });
    page = await browsers.open(1);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await see(`return JSON.stringify((await import("/store.js")).store.state.me?.role === "owner")`, "signed in");
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test("the card shows the machine and each tool from and to with its size, fits a phone, and Update allows it", real, async () => {
    const id = await newSession(app);
    const request: ApprovalRequest = {
        id: "machine_tools-ui-1",
        conversationId: id,
        taskId: 1 as never,
        callId: "call-1",
        tool: "machine_tools",
        subject: "Update on tuanlh-devbox-01: ocu 1.1.2-pp.2 → 1.1.2-pp.3 (about 2.5 MB)",
        reason: "ocu is behind the current build",
        form: {
            type: "machine-tools",
            machine: "m1",
            machineName: "tuanlh-devbox-01",
            platform: "linux x64",
            action: "update",
            tools: [
                { id: "ocu", name: "Computer use (ocu)", from: "1.1.2-pp.2", to: "1.1.2-pp.3", size: "about 2.5 MB" },
                { id: "chrome", name: "Chrome (headless)", to: "155.0.8059.84", size: "about 285 MB", needed: true },
            ],
        },
        createdAt: Date.now(),
    };
    const answered = app.approvals.request(request, context);

    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/s/${id}`);
    await see(`return JSON.stringify(document.querySelector(".machine-tools-card") !== null)`, "the card");
    const card = await text(".machine-tools-card");

    assert.match(card, /Update these tools on tuanlh-devbox-01\?/);
    assert.match(card, /ocu is behind the current build/);
    assert.match(card, /tuanlh-devbox-01\s+linux x64/);
    assert.match(card, /Computer use \(ocu\)\s+1\.1\.2-pp\.2 → 1\.1\.2-pp\.3 · about 2\.5 MB/);
    assert.match(card, /Chrome \(headless\)\s+155\.0\.8059\.84, new · about 285 MB · needed by the others/);
    assert.match(card, /pinned versions, each download checked before it is kept\. Deny changes nothing\./);
    const fits = await inPage<{ card: number; column: number; page: number; screen: number }>(`
        const card = document.querySelector(".machine-tools-card");
        const box = card.getBoundingClientRect();

        return JSON.stringify({ card: box.right, column: card.parentElement.getBoundingClientRect().right, page: document.documentElement.scrollWidth, screen: innerWidth });
    `);

    assert.ok(fits.card <= fits.column + 1 && fits.page <= fits.screen, JSON.stringify(fits));
    await shot("machine-tools-390");

    // Only the owner approves it: a guest's Approve is refused.
    await assert.rejects(app.answerApproval(request.id, true, { ...owner(app), role: "guest" } as never), /Changing a machine's tools is the owner's/);

    await page.setViewport(VIEWPORTS.desktop);
    await page.navigate(`${base}/s/${id}`);
    await see(`return JSON.stringify(document.querySelector(".machine-tools-card .button.primary")?.disabled === false)`, "Update enabled");
    await shot("machine-tools-1280");
    assert.equal((await text(".machine-tools-card .button.primary")).trim(), "Update");
    await page.click({ selector: ".machine-tools-card .button.primary" });
    const answer = await answered;

    assert.equal(answer.allow, true);
    await see(`return JSON.stringify(document.querySelector(".machine-tools-card") === null)`, "the card gone");
});
