// The waiting bar (PP-375; the owner's decisions of 2026-11-03): every card that waits for the person and is scrolled
// out of view is pinned at the top of the session (interview cards, approvals of any kind, a made drop-in's card while it
// waits), in the bar's look of PP-284. Past two rows it folds to one line, as the person last left it in this session
// (kept across a reload). A row's tap scrolls to its card, centred, and lights its border a moment. In a real browser at a
// phone's width and a desktop's. With PHONE_SHOTS, screenshots go there.
import { type App, cleanUp, cleanUpAll, lastText, newSession, openApp, owner, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Browsers } from "./support/browser.ts";
import { findBrowser } from "./support/browser/discovery.ts";
import type { BrowserPage } from "./support/browser/page.ts";
import { VIEWPORTS } from "./support/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = { skip: chromium === undefined ? "no Chromium-based browser on this machine" : false } as const;
const SHOTS = process.env.PHONE_SHOTS;

const QUESTIONS = JSON.stringify({
    title: "Which first",
    questions: [{ id: "order", type: "single", question: "Which do we build first?", options: ["The board", "The cards"] }],
});

// Three cards at once: a question (it does not hold Pi), and two calls that wait on the owner's card.
const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);

    if (role === "user" && text === "need you") {
        return fauxAssistantMessage(
            [
                fauxToolCall("interview", { questions: QUESTIONS, async: true }),
                fauxToolCall("setting_change", { id: "extensions.formal.ts", value: "off", reason: "Not needed here" }),
                fauxToolCall("app_action", { id: "extensions.reload", args: { file: "formal.ts" }, reason: "Its file changed" }),
            ],
            { stopReason: "toolUse" },
        );
    }

    return fauxAssistantMessage([fauxText("ok")]);
};

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";

const inPage = async <T>(script: string): Promise<T> => JSON.parse(await page.evaluate(script)) as T;
const see = (script: string, what: string) => until(async () => (await inPage<boolean>(script)) === true, what, 30_000);

async function shot(name: string, settle = 500): Promise<void> {
    assert.equal(await inPage<boolean>(`return JSON.stringify(document.documentElement.scrollWidth > innerWidth + 1)`), false, `${name}: nothing wider than the screen`);

    if (SHOTS !== undefined) {
        mkdirSync(SHOTS, { recursive: true });
        await new Promise((resolve) => setTimeout(resolve, settle));
        writeFileSync(join(SHOTS, `${name}.jpg`), Buffer.from((await page.screenshot()).data, "base64"));
    }
}

/** The bar as it shows: folded or open, and the rows' titles. */
const bar = () =>
    inPage<{ state: string | null; folded: string | null; rows: string[]; fold: boolean }>(`
        const bar = document.querySelector('[data-part="decision-bar"]');
        return JSON.stringify({
            state: bar?.dataset.state ?? null,
            folded: bar?.querySelector('[data-part="decision-unfold"] b')?.textContent.trim() ?? null,
            rows: [...(bar?.querySelectorAll('.decision:not(.decision-folded) b') ?? [])].map((each) => each.textContent.trim()),
            fold: bar?.querySelector('[data-part="decision-fold"]') != null,
        });
    `);

/** The chat scrolled to its top above a tall gap, as a person scrolls up: the cards below are out of view. */
async function toTop(): Promise<void> {
    await see(`return JSON.stringify(document.querySelectorAll('.waiting-slot').length === 3)`, "the three cards");
    await page.evaluate(
        `if (!document.getElementById("test-gap")) { const gap = document.createElement("div"); gap.id = "test-gap"; gap.style.height = "2400px"; document.querySelector('[data-part="transcript"]').prepend(gap); } return "null"`,
    );

    for (let step = 0; step < 3; step++) {
        await page.evaluate(`const scroller = document.querySelector(".scroller"); scroller.scrollTop = 0; scroller.dispatchEvent(new Event("scroll")); return "null"`);
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
}

before(async () => {
    if (chromium === undefined) {
        return;
    }

    app = await openApp(scriptedModel(route));
    server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({ dataDir: mkdtempSync(join(root, "waiting-bar-ui-")), load: async () => undefined, save: () => {} });
    page = await browsers.open(1);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await see(`return JSON.stringify((await import("/store.js")).store.state.me?.role === "owner")`, "signed in");
});

after(() =>
    cleanUpAll(
        () => browsers?.closeAll({ final: true }),
        () => server?.closeAllConnections(),
        () => server?.close(),
        () => app?.close(),
        () => cleanUp(),
    ),
);

for (const [size, viewport] of [["390", VIEWPORTS.mobile], ["1280", VIEWPORTS.desktop]] as const) {
    test(`at ${size} px: the cards scrolled away wait in the bar, folded past two as left across a reload, and a row leads to its card, lit`, real, async () => {
        const id = await newSession(app);

        await app.commands.submit(id, owner(app), { text: "need you", requestId: `need-${id}` });
        await until(() => app.approvals.forConversation(id).length === 3, "three cards");
        await page.setViewport(viewport);
        await page.navigate(`${base}/s/${id}`);
        await toTop();

        // More than two: folded by default, one line that says how many.
        await see(`return JSON.stringify(document.querySelector('[data-part="decision-unfold"]') !== null)`, "the folded bar");
        assert.deepEqual(await bar(), { state: "folded", folded: "3 cards wait for you", rows: [], fold: false });
        await shot(`bar-folded-${size}`);

        // Unfolded: a row for each, the approvals' as well as the question's; and the control to fold it again.
        await page.evaluate(`document.querySelector('[data-part="decision-unfold"]').click(); return "null"`);
        await see(`return JSON.stringify(document.querySelectorAll('[data-part="decision-bar"] .decision').length === 3)`, "three rows");

        const open = await bar();

        assert.equal(open.state, "open");
        assert.equal(open.fold, true);
        assert.deepEqual([...open.rows].sort(), ["Pi asks before this app_action call", "Pi asks before this setting_change call", "Pi asks you: Which first"]);
        assert.match(
            await inPage<string>(`return JSON.stringify([...document.querySelectorAll('[data-part="decision-bar"] .decision')].find((each) => each.innerText.includes("app_action")).querySelector("small").textContent)`),
            /Reload the extension formal\.ts/,
        );
        await shot(`bar-open-${size}`);

        // Kept across a reload, in this session: open stays open, folded stays folded.
        await page.navigate(`${base}/s/${id}`);
        await toTop();
        await see(`return JSON.stringify(document.querySelector('[data-part="decision-bar"]')?.dataset.state === "open")`, "still open");
        await page.evaluate(`document.querySelector('[data-part="decision-fold"]').click(); return "null"`);
        await see(`return JSON.stringify(document.querySelector('[data-part="decision-bar"]')?.dataset.state === "folded")`, "folded");
        await page.navigate(`${base}/s/${id}`);
        await toTop();
        await see(`return JSON.stringify(document.querySelector('[data-part="decision-bar"]')?.dataset.state === "folded")`, "still folded");

        // A row's tap: the chat scrolls to its card, centred, and lights it a moment; on screen, its row leaves the bar.
        await page.evaluate(`document.querySelector('[data-part="decision-unfold"]').click(); return "null"`);
        await see(`return JSON.stringify(document.querySelectorAll('[data-part="decision-bar"] .decision').length === 3)`, "three rows again");
        await page.evaluate(`[...document.querySelectorAll('[data-part="decision-bar"] .decision')].find((each) => each.innerText.includes("app_action")).click(); return "null"`);
        await see(`return JSON.stringify(document.querySelector('.waiting-slot.waiting-lit')?.innerText.includes("app_action") === true)`, "the card lit");
        await see(
            `const box = document.querySelector('.waiting-slot.waiting-lit').getBoundingClientRect(); const middle = box.top + box.height / 2; return JSON.stringify(Math.abs(middle - innerHeight / 2) < innerHeight / 3)`,
            "the card in the middle of the screen",
        );
        await see(`return JSON.stringify(![...document.querySelectorAll('[data-part="decision-bar"] .decision')].some((each) => each.innerText.includes("app_action")))`, "its row gone");
        await see(
            `const card = document.querySelector('.waiting-slot.waiting-lit > .approval'); const probe = document.createElement("span"); probe.style.color = "var(--accent)"; document.body.append(probe); const accent = getComputedStyle(probe).color; probe.remove(); return JSON.stringify(card !== null && getComputedStyle(card).borderTopColor === accent)`,
            "its border in the accent",
        );
        // At once: the light lasts two seconds.
        await shot(`card-lit-${size}`, 0);
        await see(`return JSON.stringify(document.querySelector('.waiting-lit') === null)`, "the light gone after a moment");

        for (const card of app.approvals.forConversation(id)) {
            await app.answerApproval(card.id, false, owner(app));
        }

        await until(() => app.approvals.forConversation(id).length === 0, "all answered");
    });
}
