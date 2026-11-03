// The Creator flow's cards (PP-369) in a real browser at a phone's width and a desktop's: Pi's "Make a drop-in" card
// (Make it / Not now), the one progress card that follows the drop-in (written, checks, installed off, waiting for you
// to switch it on, checked in the app) with Switch it on and Open the subagent, the end with Keep, Undo and Restore…
// and the versions, and the same list in Settings › Extensions. With PHONE_SHOTS, screenshots go there.
import { type App, cleanUp, cleanUpAll, context, home, lastText, newSession, owner, pastWelcome, root, scriptedModel, until, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "./support/browser.ts";
import { findBrowser } from "./support/browser/discovery.ts";
import type { BrowserPage } from "./support/browser/page.ts";
import { VIEWPORTS } from "./support/browser/viewport.ts";
import { BUILDER_TEMPLATES } from "../src/server/extension-builder.ts";
import { createHandler } from "../src/server/http.ts";

const { PocketApp } = await import("../src/server/app.ts");

const real = { skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false } as const;
const SHOTS = process.env.PHONE_SHOTS;
const dataDir = join(root, "creator-ui-data");
const scratch = join(work, ".made", "made-clock");

let ready = "READY made-clock: first build";
const calls: Record<string, [string, Record<string, unknown>]> = {
    "make a clock": ["extension_create", { name: "clock", title: "Clock", brief: "A rail page with a clock that counts focus rounds today, and a strip above the message box while a round runs.", places: ["rail", "page", "dock"] }],
    "make it bigger": ["extension_create", { name: "clock", title: "Clock", brief: "Bigger digits, and the round count kept after midnight.", places: ["rail", "page", "dock"] }],
    "install the clock": ["extension_made", { action: "install", name: "clock" }],
    "the clock is checked": ["extension_made", { action: "checked", name: "clock", note: "the rail opens the page, the timer runs, nothing spills at 390 px" }],
};
const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);

    if (role === "user" && text.includes("pi-phone drop-in made-clock")) {
        return fauxAssistantMessage([fauxText(`Written from the rail page template; the check says ok.\n\n${ready}`)]);
    }

    for (const [ask, [tool, args]] of Object.entries(calls)) {
        if (role === "user" && text.endsWith(ask)) {
            return fauxAssistantMessage([fauxToolCall(tool, args as never)], { stopReason: "toolUse" });
        }
    }

    return fauxAssistantMessage([fauxText(role === "toolResult" ? "Done." : "ok")]);
};

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let session: ConversationId;

function goodFolder(extra = ""): void {
    mkdirSync(scratch, { recursive: true });

    for (const ending of [".ts", ".js"]) {
        const text = readFileSync(join(BUILDER_TEMPLATES, "focus-timer", `focus-timer${ending}`), "utf8").replaceAll("focus-timer", "made-clock");

        writeFileSync(join(scratch, `made-clock${ending}`), ending === ".js" ? `${text}${extra}` : text);
    }
}

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

const seen = (script: string, what: string) => until(async () => (await inPage<boolean>(script)) === true, what, 30_000);

/** Wait until `selector` has stopped moving: a tap on something sliding lands elsewhere. */
const still = (selector: string) =>
    seen(
        `const box = document.querySelector(${JSON.stringify(selector)}); return JSON.stringify(box !== null && document.getAnimations().every((each) => each.playState !== "running" || !(each.effect?.target instanceof Element) || !(box.contains(each.effect.target) || each.effect.target.contains(box))))`,
        `${selector} still`,
    );

/** The text of the last element `selector` finds. */
const textOf = (selector: string) => inPage<string>(`const all = document.querySelectorAll(${JSON.stringify(selector)}); return JSON.stringify(all.length === 0 ? "" : all[all.length - 1].innerText)`);

const sees = (selector: string, text: string) =>
    until(async () => (await textOf(selector)).includes(text), `${text} in ${selector}`, 30_000).catch(async (error: Error) => {
        throw new Error(`${error.message}; it shows: ${JSON.stringify((await textOf(selector)).slice(0, 800))}`);
    });

/** Press the last button in `scope` whose text is `label`. */
async function press(scope: string, label: string): Promise<void> {
    const selector = `${scope} button`;

    await seen(`return JSON.stringify([...document.querySelectorAll(${JSON.stringify(selector)})].some((each) => each.innerText.trim() === ${JSON.stringify(label)}))`, `${label} in ${scope}`);
    await still(scope);

    // The conversation keeps itself at its end as things arrive: scroll the button into view until it stays there, and
    // tap it only when it is what is under that point.
    for (let tries = 0; tries < 20; tries++) {
        const box = await inPage<{ x: number; y: number; on: boolean }>(
            `const all = [...document.querySelectorAll(${JSON.stringify(selector)})].filter((each) => each.innerText.trim() === ${JSON.stringify(label)}); const button = all[all.length - 1]; button.scrollIntoView({ block: "center" }); await new Promise((done) => setTimeout(done, 150)); const box = button.getBoundingClientRect(); const x = Math.round(box.left + box.width / 2); const y = Math.round(box.top + box.height / 2); return JSON.stringify({ x, y, on: document.elementFromPoint(x, y)?.closest("button") === button })`,
        );

        if (box.on) {
            await page.input([{ type: "click", x: box.x, y: box.y }]);

            return;
        }
    }

    throw new Error(`${label} in ${scope} never stayed in view to be tapped`);
}

async function shot(name: string): Promise<void> {
    assert.equal(await inPage<boolean>(`return JSON.stringify(document.documentElement.scrollWidth > innerWidth)`), false, `${name}: nothing wider than the screen`);

    if (SHOTS !== undefined) {
        mkdirSync(SHOTS, { recursive: true });
        await new Promise((resolve) => setTimeout(resolve, 500));
        writeFileSync(join(SHOTS, name), Buffer.from((await page.screenshot()).data, "base64"));
    }
}

/** Show the card in view, for its picture. */
const into = (selector: string) =>
    page.evaluate(`const all = document.querySelectorAll(${JSON.stringify(selector)}); all[all.length - 1]?.scrollIntoView({ block: "center" }); return "null"`);

const madeJson = () => JSON.parse(readFileSync(join(dataDir, "extensions", ".versions", "made-clock", "made.json"), "utf8")) as { subagent?: { conversationId: number }; current: number | null };

before(async () => {
    if (real.skip !== false) {
        return;
    }

    const faux = scriptedModel(route);

    app = await PocketApp.open({
        dataDir,
        defaultCwd: work,
        supervised: false,
        log: () => {},
        home,
        configureModels: (models) => models.registerNativeProvider(faux.provider),
        officecli: { runs: false },
    });
    pastWelcome(app);
    app.config.setContextPart("tools", "all");
    session = await newSession(app);
    server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browsers = new Browsers({ dataDir: mkdtempSync(join(root, "creator-ui-browser-")), load: async () => undefined, save: () => {} });
    page = await browsers.open(1);
    await page.setViewport(VIEWPORTS.mobile);
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

const submit = (text: string) => app.commands.submit(session, owner(app), { text, requestId: crypto.randomUUID() });
/** A card answered in the page is gone from the session's cards. */
const answered = () => until(() => app.approvals.forConversation(session).length === 0, "the card answered", 30_000);
const settle = async (submissionId: Parameters<typeof app.harness.submission>[0]) => {
    await (await app.harness.submission(submissionId, context))!.wait(context);
    await app.harness.waitForIdle(context);
};

test("at 390 px: Make a drop-in, Make it, the progress card through install and Switch it on, then Keep, Undo and Restore…", real, async () => {
    goodFolder();
    await page.navigate(`${base}/s/${session}`);

    // 1. The card first.
    const made = await submit("please make a clock");

    await sees(".creator-card", "Make a drop-in: Clock");
    await sees(".creator-card", "It gets the same rights as any drop-in");
    await into(".creator-card");
    await shot("creator-card-390.jpg");
    await press(".creator-card", "Make it");
    await answered();
    await settle(made.submissionId);
    await until(async () => (await app.lastAnswer(madeJson().subagent!.conversationId as never, true)).includes("READY made-clock"), "the subagent's READY");

    // 2. The progress card, and the install card.
    const install = await submit("please install the clock");

    await sees(".extension-install-card", "made-clock.ts");
    await sees(".made-card", "Waiting for your install card");
    await into(".made-card");
    await shot("made-progress-390.jpg");
    await press(".extension-install-card", "Install");
    await answered();
    await settle(install.submissionId);
    await sees(".made-card", "Waiting for you to switch it on");
    await sees(".made-card", "Installed, switched off");
    await into(".made-card");
    await shot("made-waiting-390.jpg");

    // 3. The owner switches it on from the card.
    await press(".made-card", "Switch it on");
    await until(() => app.loader.enabled("made-clock.ts"), "made-clock on");
    await sees(".made-card", "Switched on");

    const checked = await submit("please the clock is checked");

    await settle(checked.submissionId);
    await sees(".made-card", "Checked in the app at 390 and 1280 px");

    // 4. A second version, on the owner's cards (answered here).
    ready = "READY made-clock: round count after midnight";
    goodFolder("\n// round count after midnight\n");

    const next = await submit("please make it bigger");

    await until(() => app.approvals.forConversation(session).length > 0, "the next card");
    await app.answerApproval(app.approvals.forConversation(session)[0]!.id, true, owner(app));
    await settle(next.submissionId);
    await until(async () => (await app.lastAnswer(madeJson().subagent!.conversationId as never, true)).includes("after midnight"), "its next READY");

    const second = await submit("please install the clock");

    await until(() => app.approvals.forConversation(session).length > 0, "the install card");
    await app.answerApproval(app.approvals.forConversation(session)[0]!.id, true, owner(app));
    await settle(second.submissionId);
    await app.setExtensionEnabled(owner(app), "made-clock.ts", true);
    await settle((await submit("please the clock is checked")).submissionId);
    await sees(".made-card", "Version 2");
    await sees(".made-card", "round count after midnight");
    await into(".made-card");
    await shot("made-result-390.jpg");

    // Restore… asks which, with the app's dropdown.
    await press(".made-card", "Restore…");
    await sees(".made-card .made-ask", "It installs switched off");
    await shot("made-restore-390.jpg");
    await press(".made-card .made-ask", "Cancel");

    // Undo asks first, then goes back one.
    await press(".made-card", "Undo");
    await sees(".made-card .made-ask", "Undo goes back to version 1");
    await press(".made-card .made-ask", "Undo");
    await until(() => madeJson().current === 1, "back at version 1");
    await sees(".made-card", "made-clock · version 1");
});

test("at 1280 px: the next version's card (Not now), the progress card, and the list in Settings › Extensions", real, async () => {
    await page.setViewport(VIEWPORTS.desktop);
    await page.navigate(`${base}/s/${session}`);
    await sees(".made-card", "made-clock · version 1");
    await into(".made-card");
    await shot("made-result-1280.jpg");

    const again = await submit("please make it bigger");

    await sees(".creator-card", "Make the next version: Clock");
    await into(".creator-card");
    await shot("creator-card-1280.jpg");
    await press(".creator-card", "Not now");
    await answered();
    await settle(again.submissionId);
    assert.match(await app.lastAnswer(session, true), /Done\./);

    for (const [size, viewport] of [["1280", VIEWPORTS.desktop], ["390", VIEWPORTS.mobile]] as const) {
        await page.setViewport(viewport);
        await page.navigate(`${base}/?sheet=extensions`);
        await sees('[data-part="made-section"]', "Drop-ins Pi made");
        await sees('[data-part="made-section"]', "Version 2");
        await into('[data-part="made-section"]');
        await shot(`settings-made-${size}.jpg`);
    }

    // Undo from Settings: version 1 was the first, so it goes; Restore… brings 2 back.
    await press('[data-part="made-section"]', "Undo");
    await sees('[data-part="made-section"] .made-ask', "Undo removes made-clock");
    await press('[data-part="made-section"] .made-ask', "Undo");
    await until(() => madeJson().current === null, "removed");
    await sees('[data-part="made-section"]', "Removed");
    await press('[data-part="made-section"]', "Restore…");
    await press('[data-part="made-section"] .made-ask', "Restore");
    await until(() => madeJson().current === 2, "restored to 2");
    assert.equal(app.loader.enabled("made-clock.ts"), false, "restored switched off");
});
