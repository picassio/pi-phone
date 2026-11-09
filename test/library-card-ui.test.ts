// The owner's library cards (PP-468) in a real browser at 390, 1280 and 1920 px: a new skill's save shows each file
// whole; an edit shows the diff and the whole content a tap away; a pin says where; Approve (named for what it does)
// answers the card. Nothing in them runs past the screen, their text keeps its contrast and size, and their controls
// take a 40 px tap on a phone. With PHONE_SHOTS, screenshots and the layout check's report go there, the session
// without a card first (before).
import { type App, cleanUp, cleanUpAll, context, newSession, openApp, owner, root, scriptedModel } from "./helpers.ts";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { libraryDiff } from "../src/server/extensions/library.ts";
import type { ApprovalAnswer, LibraryForm } from "../src/server/host.ts";
import { createHandler } from "../src/server/http.ts";
import { describeLayout, layoutCheck, parseLayout } from "../src/server/layout-check.ts";
import { Browsers } from "./support/browser.ts";
import { findBrowser } from "./support/browser/discovery.ts";
import type { BrowserPage } from "./support/browser/page.ts";
import { VIEWPORTS } from "./support/browser/viewport.ts";

const real = { skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false } as const;
const SHOTS = process.env.PHONE_SHOTS;
const LARGE = { width: 1920, height: 1080, scale: 1, mobile: false };
const OLD = '---\nname: "ssp-review"\ndescription: "Review a change to SSP. Use when the owner asks to review an SSP PR."\n---\n\n# SSP review\n\n1. Run `npm test` in ~/work/ssp.\n2. Check the migrations.\n';
const NEW = OLD.replace("SSP PR.", "SSP PR or diff.").concat("3. Post the summary on the PR, with the failing tests named and a link to each migration that changed since the last release tag.\n");
const MIGRATIONS = "Check down migrations too.\n";

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let session: ConversationId;
let cards = 0;

before(async () => {
    if (real.skip) {
        return;
    }

    app = await openApp(scriptedModel(() => fauxAssistantMessage([fauxText("ok")])));
    server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({ dataDir: mkdtempSync(join(root, "library-ui-")), load: async () => undefined, save: () => {} });
    page = await browsers.open(1);
    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    session = await newSession(app);
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

async function until(check: () => Promise<boolean> | boolean, what: string, timeoutMs = 20_000): Promise<void> {
    const started = Date.now();

    while (!(await check())) {
        if (Date.now() - started > timeoutMs) {
            throw new Error(`Timed out waiting for ${what}`);
        }

        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}

const inPage = async <T>(script: string): Promise<T> => JSON.parse(await page.evaluate(script)) as T;
const present = (selector: string, what: string) => until(() => inPage<boolean>(`return JSON.stringify(document.querySelector(${JSON.stringify(selector)}) !== null)`), what);

const FORMS: Record<string, LibraryForm> = {
    new: {
        type: "library",
        action: "save",
        kind: "skill",
        name: "ssp-review",
        files: [
            { path: "SKILL.md", text: OLD },
            { path: "references/migrations.md", text: MIGRATIONS },
        ],
        pins: [],
        note: "first",
    },
    edit: {
        type: "library",
        action: "save",
        kind: "skill",
        name: "ssp-review",
        files: [
            { path: "SKILL.md", text: NEW },
            { path: "references/migrations.md", text: MIGRATIONS },
        ],
        diff: libraryDiff({ "SKILL.md": OLD }, { "SKILL.md": NEW }),
        from: 2,
        pins: [
            { scope: "session", target: "42", label: "SSP billing fix, invoice rounding" },
            { scope: "board", target: "PP", label: "pi-phone" },
        ],
    },
    pin: {
        type: "library",
        action: "pin",
        kind: "command",
        name: "ssp-review",
        pin: { scope: "board", target: "PP", label: "pi-phone", pinned: true },
        pins: [{ scope: "all", target: "" }],
    },
};

/** A library card waiting in the session, as the tool asks it; the promise is its answer. */
function ask(which: keyof typeof FORMS): Promise<ApprovalAnswer> {
    cards += 1;

    return app.approvals.request(
        {
            id: `library-ui-${cards}`,
            conversationId: session,
            taskId: cards as never,
            callId: `call-${cards}`,
            tool: which === "pin" ? "library_pin" : "skill_save",
            subject: which,
            reason: which,
            form: FORMS[which]!,
            createdAt: Date.now(),
        },
        context,
    );
}

/** The layout check's report now, as the screenshot tool gives it; with PHONE_SHOTS, a picture and the report saved too. */
async function measure(name: string, width: number) {
    await new Promise((resolve) => setTimeout(resolve, 600));
    const report = parseLayout(JSON.parse(await page.evaluate(`return JSON.stringify(${layoutCheck(width)})`)), width);

    assert.ok(report !== undefined, "the layout check answered");

    if (SHOTS !== undefined) {
        mkdirSync(SHOTS, { recursive: true });
        writeFileSync(join(SHOTS, `${name}.jpg`), Buffer.from((await page.screenshot()).data, "base64"));
        writeFileSync(join(SHOTS, `${name}.layout.txt`), `${describeLayout(report)}\nRAW ${JSON.stringify(report.found)}\n`);
    }

    return report;
}

/** The kinds the ui-verify skill must bring to zero, of what is in the card. */
async function mustFix(report: Awaited<ReturnType<typeof measure>>) {
    const kinds = report.found.filter((each) => ["cut", "covered", "contrast", "small-text", "emoji", "small-target", "nested-cards"].includes(each.kind));
    const inCard = await inPage<boolean[]>(
        `return JSON.stringify(${JSON.stringify(kinds.map((each) => each.what.split(" ")[0]))}.map((selector) => { try { return document.querySelector("[data-library]").querySelector(selector) !== null; } catch { return true; } }))`,
    );

    return kinds.filter((_, index) => inCard[index]);
}

const text = () => inPage<string>(`return JSON.stringify(document.querySelector("[data-library]").innerText.trim().replace(/\\s+/g, " "))`);
const click = (label: string) => page.evaluate(`[...document.querySelectorAll("[data-library] button")].find((each) => each.innerText.trim() === ${JSON.stringify(label)}).click(); return "true";`);
const gone = () => until(async () => !(await inPage<boolean>(`return JSON.stringify(document.querySelector("[data-library]") !== null)`)), "the card to go");

for (const [viewport, label] of [[VIEWPORTS.mobile, "390"], [VIEWPORTS.desktop, "1280"], [LARGE, "1920"]] as const) {
    test(`at ${label} px: a new skill's card shows each file whole; an edit's the diff, its pins and the whole content a tap away; Save answers it (PP-468)`, real, async () => {
        await page.setViewport(viewport);
        await page.navigate(`${base}/s/${Number(session)}`);
        await measure(`library-before-${label}`, viewport.width);

        const fresh = ask("new");

        await page.navigate(`${base}/s/${Number(session)}`);
        await present("[data-library]", "the card");
        assert.match(await text(), /^Save the new skill ssp-review\? Nothing is saved until you approve\. Only sessions you pin it to get it\. Pinned now Nowhere Note first SKILL\.md ---[^]*2\. Check the migrations\. references\/migrations\.md Check down migrations too\. Deny Save$/);
        assert.deepEqual(await mustFix(await measure(`library-new-${label}`, viewport.width)), []);
        await click("Save");
        assert.deepEqual(await fresh, { allow: true, by: owner(app).name });
        await gone();

        const edit = ask("edit");

        await page.navigate(`${base}/s/${Number(session)}`);
        await present("[data-library] .dv-block", "the edit's diff");
        assert.match(await text(), /^Save the skill ssp-review as a new version\? Nothing changes until you approve\. Version 2 is kept, so this can be undone\. Pinned now Session 42: SSP billing fix, invoice rounding Board PP: pi-phone [^]*3\. Post the summary[^]*Whole content after the change Deny Save$/);
        assert.equal(await inPage<string>(`return JSON.stringify(document.querySelector("[data-library] .library-whole-toggle").getAttribute("aria-expanded"))`), "false", "the whole content a tap away");

        const report = await measure(`library-edit-${label}`, viewport.width);

        assert.deepEqual(await mustFix(report), [], describeLayout(report));
        await page.evaluate(`document.querySelector("[data-library] .library-whole-toggle").click(); return "true";`);
        await present("[data-library] .library-file", "the whole content");
        assert.match(await text(), /Whole content after the change SKILL\.md ---[^]*release tag\. references\/migrations\.md Check down migrations too\. Deny Save$/);
        assert.deepEqual(await mustFix(await measure(`library-edit-open-${label}`, viewport.width)), []);
        await click("Deny");
        assert.equal((await edit).allow, false);
        await gone();
    });
}

test("at 390 px: a pin says what and where; Pin answers it (PP-468)", real, async () => {
    await page.setViewport(VIEWPORTS.mobile);
    const answered = ask("pin");

    await page.navigate(`${base}/s/${Number(session)}`);
    await present("[data-library]", "the card");
    assert.equal(await text(), "Pin the command /ssp-review? Sessions there get it from their next message. Pin to Board PP: pi-phone Pinned now Every session Deny Pin");
    assert.deepEqual(await mustFix(await measure("library-pin-390", 390)), []);
    await click("Pin");
    assert.equal((await answered).allow, true);
});
