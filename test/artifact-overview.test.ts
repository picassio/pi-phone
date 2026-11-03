// All artifacts (PP-349, from pi-pocket 0.28 #237): every artifact in every session a person can see, with its current
// version, over the route and with Pi's artifacts_list; and in a real Chromium, the sheet, a row that opens the current
// version, and Keep as a page from the row. With PHONE_SHOTS, screenshots at 390 and 1280 px go there.
import { type App, cleanUp, lastText, newSession, openApp, owner, root, say, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "./support/browser.ts";
import { findBrowser } from "./support/browser/discovery.ts";
import { VIEWPORTS } from "./support/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const SHOTS = process.env.PHONE_SHOTS;

/** "publish <id> <type> <n>" publishes version content n of artifact <id>; the rest is echoed. */
const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);
    const asked = /publish (\S+) (html|markdown) (\d+)$/.exec(text);

    if (role === "user" && asked !== null) {
        const [, id = "", type = "html", n] = asked;

        return fauxAssistantMessage([fauxToolCall("artifact", { id, title: `Artifact ${id}`, type, content: type === "markdown" ? `# Version ${n}` : `<h1>Version ${n}</h1>` })], { stopReason: "toolUse" });
    }

    return fauxAssistantMessage([fauxText(role === "toolResult" ? "published" : `echo: ${text}`)]);
};

let app: App;
let server: Server;
let base: string;

const publish = async (session: ConversationId, id: string, n: number, type = "html") => {
    // A version's time is the real one: wait, so that each has a time of its own and "newest first" has one answer.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await say(app, session, `publish ${id} ${type} ${n}`);
};

before(async () => {
    app = await openApp(scriptedModel(route));
    server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test("each artifact is one entry, with the number of its latest version and how many versions it has", async () => {
    const first = await newSession(app);
    const second = await newSession(app);

    await publish(first, "chart", 1);
    await publish(first, "chart", 2);
    await publish(first, "chart", 3);
    await publish(second, "notes", 1, "markdown");

    const list = await app.artifactOverview(owner(app));
    const chart = list.find((entry) => entry.id === "chart" && entry.session === Number(first));
    const notes = list.find((entry) => entry.id === "notes" && entry.session === Number(second));

    assert.equal(chart?.current, 3);
    assert.equal(chart?.versions, 3);
    assert.equal(notes?.current, 1);
    assert.equal(notes?.type, "markdown");
    assert.equal(list.filter((entry) => entry.id === "chart").length, 1);
    // Newest first: notes was published last.
    assert.ok(list.indexOf(notes!) < list.indexOf(chart!));

    // An archived session's are left out.
    await app.commands.updateSession(second, owner(app), { archived: true });
    assert.ok(!(await app.artifactOverview(owner(app))).some((entry) => entry.id === "notes"));
    await app.commands.updateSession(second, owner(app), { archived: false });
});

test("a person sees only the artifacts of the sessions shared with them, over the route", async () => {
    const shared = await newSession(app);
    const hidden = await newSession(app);

    await publish(shared, "open-one", 1);
    await publish(hidden, "closed-one", 1);

    const { token, user } = app.config.addUser("Guest", "guest", [String(shared)]);

    try {
        const response = await fetch(new URL("/api/artifacts", base), { headers: { authorization: `Bearer ${token}` } });
        const ids = ((await response.json()) as { id: string }[]).map((entry) => entry.id);

        assert.equal(response.status, 200);
        assert.deepEqual(ids, ["open-one"]);
    } finally {
        app.config.removeUser(user.id);
    }
});

test("a share removed while the list is read takes its entries out", async () => {
    const shared = await newSession(app);

    await publish(shared, "was-shared", 1);

    const { user } = app.config.addUser("Late guest", "guest", [String(shared)]);
    const snapshot = app.harness.snapshot.bind(app.harness) as (...args: unknown[]) => unknown;

    app.harness.snapshot = (async (...args: unknown[]) => {
        app.config.updateUser(user.id, { sessions: [] });

        return snapshot(...args);
    }) as never;

    try {
        assert.deepEqual(await app.artifactOverview(user), []);
    } finally {
        app.harness.snapshot = snapshot as never;
        app.config.removeUser(user.id);
    }
});

test("Pi lists them with artifacts_list, as the person it works for, with what they keep as pages", async () => {
    const asker = await newSession(app);

    await publish(asker, "kept-one", 1);
    await app.keptPages.set(owner(app), { conversation: Number(asker), artifact: "kept-one", kept: true });

    const lines = (await app.sessionControl.artifacts(asker)).split("\n");
    const kept = lines.find((line) => line.includes("kept-one"));

    assert.match(kept ?? "", new RegExp(`^#${Number(asker)} .* · kept-one “Artifact kept-one” · html · v1 of 1 · kept as a page$`));
    assert.match(lines.find((line) => line.includes(" chart ")) ?? "", / · v3 of 3$/);
    assert.equal(await app.sessionControl.artifacts(asker, "no such words"), "No artifacts match.");
    assert.match(await app.sessionControl.artifacts(asker, "", 1), /\(\d+ more\)$/);
});

test(
    "the sheet lists every session's artifacts, opens the current version, and keeps one as a page",
    { skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false },
    async () => {
        const session = (await app.artifactOverview(owner(app))).find((entry) => entry.id === "chart")!.session;
        const browsers = new Browsers({ dataDir: mkdtempSync(join(root, "all-artifacts-ui-")), load: async () => undefined, save: () => {} });

        try {
            const page = await browsers.open(1);
            const inPage = async <T>(script: string) => JSON.parse(await page.evaluate(script)) as T;
            const shot = async (name: string) => {
                if (SHOTS !== undefined) {
                    mkdirSync(SHOTS, { recursive: true });
                    await new Promise((resolve) => setTimeout(resolve, 400));
                    writeFileSync(join(SHOTS, name), Buffer.from((await page.screenshot()).data, "base64"));
                }
            };

            await page.setViewport(VIEWPORTS.mobile);
            await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
            await until(async () => await inPage<boolean>(`return JSON.stringify(document.querySelector('[data-rail="all-artifacts"]') !== null)`), "the rail's All artifacts", 20_000);
            await page.evaluate(`document.querySelector('[data-rail="all-artifacts"]').click(); return "null";`);
            await until(async () => await inPage<boolean>(`return JSON.stringify(document.querySelector('[data-part="artifact-row"][data-artifact="chart"]') !== null)`), "the list");
            assert.equal(await inPage<string>(`return JSON.stringify(document.querySelector('[data-part="artifact-row"][data-artifact="chart"] .overview-version').textContent.replace(/\\s+/g, " ").trim())`), "v3 / 3");
            await shot("all-artifacts-390.jpg");
            await page.setViewport(VIEWPORTS.desktop);
            await shot("all-artifacts-1280.jpg");
            await page.setViewport(VIEWPORTS.mobile);

            // Keep as a page from its row: kept for the person, and the row says so.
            await page.evaluate(`document.querySelector('[data-part="artifact-row"][data-artifact="chart"] [data-part="keep-page"]').click(); return "null";`);
            await until(async () => (await app.keptPages.list(owner(app))).pages.some((each) => each.artifact === "chart" && each.conversation === session), "kept as a page");
            await until(async () => await inPage<boolean>(`return JSON.stringify(document.querySelector('[data-part="artifact-row"][data-artifact="chart"] [data-part="kept-page-state"]') !== null)`), "the row says it is kept");

            // A tap on the row opens its current version in its session.
            await page.evaluate(`document.querySelector('[data-part="artifact-row"][data-artifact="chart"] .overview-open').click(); return "null";`);
            await until(async () => (await inPage<string>(`return JSON.stringify(location.pathname)`)) === `/s/${session}`, "its session");
            await until(async () => await inPage<boolean>(`return JSON.stringify(document.querySelector("iframe") !== null && document.body.textContent.includes("Artifact chart"))`), "the viewer");
        } finally {
            await browsers.closeAll({ final: true });
        }
    },
);
