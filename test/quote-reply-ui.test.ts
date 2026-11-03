// Reply to a passage in a real browser (PP-345, from pi-pocket): words selected in one of Pi's replies show a Reply
// button; it puts them above the message box, and the message goes to Pi with the passage first as a quote and shows
// with a quote block. On a phone (390 px, touch) the button docks at the conversation's edge, clear of the selection,
// its handles, and the band above and below it where Android's selection toolbar goes in pi-phone's WebView. Appearance's
// switch turns it off. With PHONE_SHOTS set to a folder, screenshots at 390 and 1280 px go there.
import { type App, cleanUp, cleanUpAll, lastText, newSession, openApp, owner, root, say, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "./support/browser.ts";
import { findBrowser } from "./support/browser/discovery.ts";
import type { BrowserPage } from "./support/browser/page.ts";
import { type Viewport, VIEWPORTS } from "./support/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = { skip: chromium === undefined ? "no Chromium-based browser on this machine" : false } as const;
const SHOTS = process.env.PHONE_SHOTS;
/** How far a selection handle hangs under its line, and the room Android's selection toolbar takes beside it. */
const HANDLE = 28;
const MENU = 64;
const PARAGRAPHS = Array.from({ length: 18 }, (_, index) => `Paragraph ${index + 1} says something worth quoting about the build and its tests.`);
const heard: string[] = [];
const route: FauxResponseStep = (context) => {
    const said = lastText(context as never).text;

    heard.push(said);

    return fauxAssistantMessage([fauxText(said.startsWith(">") ? "Answered the quote." : PARAGRAPHS.join("\n\n"))]);
};

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let id: ConversationId;

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

async function shot(name: string): Promise<void> {
    if (SHOTS === undefined) {
        return;
    }

    mkdirSync(SHOTS, { recursive: true });
    await new Promise((resolve) => setTimeout(resolve, 400));
    writeFileSync(join(SHOTS, `${name}.jpg`), Buffer.from((await page.screenshot()).data, "base64"));
}

/** The session open at `viewport`, its reply drawn. */
async function opened(viewport: Viewport): Promise<void> {
    await page.setViewport(viewport);
    await page.navigate(`${base}/s/${Number(id)}`);
    await until(
        async () => await inPage<boolean>(`return JSON.stringify([...document.querySelectorAll(".reply p")].some((p) => p.textContent.startsWith("Paragraph 18")))`),
        "the reply",
        20_000,
    );
}

type Box = { top: number; bottom: number; left: number; right: number };
type Placed = { button: Box | null; first: Box; last: Box; view: Box; text: string };

/** Select paragraph `n` of the reply, scrolled to `where` in the conversation, and where the Reply button shows. */
async function select(n: number, where: "top" | "bottom" | "middle"): Promise<Placed> {
    return await inPage<Placed>(`
        const box = (rect) => (rect ? { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right } : null);
        const scroller = document.querySelector(".scroller");
        const view = scroller.getBoundingClientRect();
        const p = [...document.querySelectorAll(".reply p")].find((each) => each.textContent.startsWith(${JSON.stringify(`Paragraph ${n} `)}));
        const at = p.getBoundingClientRect();
        const want = ${JSON.stringify(where)} === "top" ? view.top + 8 : ${JSON.stringify(where)} === "bottom" ? view.bottom - at.height - 8 : (view.top + view.bottom - at.height) / 2;

        scroller.scrollTop += at.top - want;
        await new Promise((resolve) => setTimeout(resolve, 300));
        getSelection().removeAllRanges();
        await new Promise((resolve) => setTimeout(resolve, 300));

        const range = document.createRange();

        range.selectNodeContents(p);
        getSelection().addRange(range);

        let button = null;

        for (let tries = 0; tries < 40 && !button; tries++) {
            await new Promise((resolve) => setTimeout(resolve, 50));
            button = document.querySelector('[data-part="quote-reply-button"]');
        }

        const rects = [...range.getClientRects()].filter((rect) => rect.width > 0);

        return JSON.stringify({
            button: box(button?.getBoundingClientRect()),
            first: box(rects[0]),
            last: box(rects[rects.length - 1]),
            view: box(scroller.getBoundingClientRect()),
            text: getSelection().toString(),
        });
    `);
}

/** The button sits in the conversation, clear of the words, their handles, and the toolbar's room above and below. */
function clearOfTheMenu(placed: Placed, what: string): void {
    const button = placed.button;

    assert.ok(button, `${what}: the Reply button shows`);
    assert.ok(button.top >= placed.view.top && button.bottom <= placed.view.bottom, `${what}: inside the conversation`);
    assert.ok(
        button.bottom <= placed.first.top - MENU || button.top >= placed.last.bottom + HANDLE + MENU,
        `${what}: clear of the selection, its handles and Android's toolbar (${JSON.stringify(placed)})`,
    );
}

before(async () => {
    if (chromium === undefined) {
        return;
    }

    app = await openApp(scriptedModel(route));
    id = await newSession(app);
    await say(app, id, "Explain the build");
    const handler = createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} });

    server = createServer((request, response) => {
        void handler(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "quote-reply-ui-")),
        load: async () => undefined,
        save: () => {},
        // A mouse; the phone size's touch emulation makes it a touch screen.
        args: ["--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4"],
    });
    page = await browsers.open(1);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
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

test("on a phone, Reply docks clear of the selection and Android's toolbar, quotes the passage, and sends it first", real, async () => {
    await opened(VIEWPORTS.mobile);
    assert.equal(await inPage<boolean>(`return JSON.stringify(matchMedia("(pointer: coarse)").matches)`), true, "a touch screen");

    // At the top of the conversation Android puts its toolbar under the selection; at the bottom, above it.
    const top = await select(3, "top");

    clearOfTheMenu(top, "a selection at the top");
    await shot("quote-reply-top-390");

    const bottom = await select(9, "bottom");

    clearOfTheMenu(bottom, "a selection at the bottom");
    await shot("quote-reply-bottom-390");

    const middle = await select(6, "middle");

    clearOfTheMenu(middle, "a selection in the middle");
    assert.match(middle.text, /^Paragraph 6 says/);

    // A finger's tap on it: the passage waits above the message box.
    const button = middle.button!;

    await page.tap({ x: (button.left + button.right) / 2, y: (button.top + button.bottom) / 2 });
    await until(async () => (await inPage<string>(`return JSON.stringify(document.querySelector('[data-part="quote-strip"]')?.textContent ?? "")`)).includes("Paragraph 6 says"), "the quote strip");
    assert.equal(await inPage<boolean>(`return JSON.stringify(document.querySelector('[data-part="quote-reply-button"]') === null)`), true, "the button goes");
    await page.type({ selector: '[data-part="composer"] textarea' }, "why does it matter?");
    await shot("quote-reply-strip-390");

    await page.click({ selector: '[data-part="send-button"]' });
    await until(() => heard.some((each) => each.startsWith(">")), "Pi gets the message");
    assert.equal(heard.findLast((each) => each.startsWith(">")), `> ${PARAGRAPHS[5]}\n\nwhy does it matter?`, "the passage first, as a quote");
    await until(async () => (await inPage<string>(`return JSON.stringify(document.querySelector('[data-part="reply-quote"]')?.textContent ?? "")`)) === PARAGRAPHS[5], "the quote block in the conversation");
    assert.equal(await inPage<boolean>(`return JSON.stringify(document.querySelector('[data-part="quote-strip"]') === null)`), true, "the strip goes once sent");
    await until(async () => await inPage<boolean>(`return JSON.stringify([...document.querySelectorAll(".reply")].some((each) => each.textContent.includes("Answered the quote.")))`), "Pi's answer");
    await inPage(`document.querySelector(".scroller").scrollTop = 1e9; return "true"`);
    await shot("quote-reply-sent-390");
});

test("Appearance's switch turns Reply off on every device of theirs, and back on", real, async () => {
    await opened(VIEWPORTS.mobile);
    await page.navigate(`${base}/?sheet=appearance`);
    await until(async () => await inPage<boolean>(`return JSON.stringify(document.querySelector('[role="switch"][aria-label="Reply to a passage"]') !== null)`), "the switch", 20_000);
    await inPage(`document.querySelector('[role="switch"][aria-label="Reply to a passage"]').scrollIntoView({ block: "center" }); return "true"`);
    await shot("quote-reply-switch-390");
    await page.click({ selector: '[role="switch"][aria-label="Reply to a passage"]' });
    await until(() => app.config.userById(owner(app).id)?.appearance?.quoteReply === false, "off for the person");
    await until(async () => await inPage<boolean>(`return JSON.stringify((await import("/store.js")).store.state.me.appearance.quoteReply === false)`), "off here");

    await opened(VIEWPORTS.mobile);
    assert.equal((await select(4, "middle")).button, null, "no Reply button while off");

    app.setAppearance(owner(app), "quoteReply", true);
    await until(async () => await inPage<boolean>(`return JSON.stringify((await import("/store.js")).store.state.me.appearance.quoteReply === true)`), "on again here, set elsewhere");
    assert.ok((await select(4, "middle")).button, "the Reply button again");
});

test("with a mouse, Reply sits by the selection, above it", real, async () => {
    await opened(VIEWPORTS.desktop);
    assert.equal(await inPage<boolean>(`return JSON.stringify(matchMedia("(pointer: coarse)").matches)`), false, "a mouse");

    const placed = await select(5, "middle");

    assert.ok(placed.button, "the Reply button shows");
    assert.ok(placed.button.bottom <= placed.first.top, "above the selection");
    assert.ok(placed.button.top >= placed.first.top - 48, "right by it");
    await shot("quote-reply-1280");
});
