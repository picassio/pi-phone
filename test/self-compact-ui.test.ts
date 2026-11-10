// A quiet self-compaction (PP-477): the app's summary request and Pi's summary leave the transcript as messages; while
// the summary is written one quiet row "Compacting this session…" stands in their place, and after it the "Compacted"
// line opens Pi's summary with the app's own sections, live, after a reload and in the history. What the model sees
// stays as it is. The pure part (`selfCompactionsOf`, web/turns.js) runs in Node; the rest in a real Chrome, skipped
// without one. With PHONE_SHOTS set to a folder, screenshots at 390 px go there.
import { cleanUpAll, context, lastText, newSession, openApp, owner, type App, until, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId, EntryRecord } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { Cdp } from "../src/server/browser/cdp.ts";
import { ChromeEngine } from "../src/server/browser/pi-browser.ts";
import { CiWatchesDoc } from "../src/server/docs.ts";
import { createHandler } from "../src/server/http.ts";
import { appSections, SUMMARY_POINTER, SUMMARY_PREFIX } from "../src/server/self-compact.ts";

type Row = { id: number; kind: string; text?: string; summary?: string; blocks?: { type: string; text?: string }[]; stopReason?: string; at?: number; selfSummary?: string };
type Folds = { hidden: Set<number>; replaced: Map<number, Row & { state?: string; noSummary?: boolean }>; streaming: boolean };
type Turns = {
    SELF_COMPACT_REQUEST: string;
    SELF_COMPACT_POINTER: string;
    selfCompactionsOf: (rows: Row[], options: { authors?: Record<number, string>; compacting?: boolean }) => Folds;
    quietRows: (rows: Row[], folds: Folds) => Row[];
    selfSections: (summary: string) => string;
};

// A plain ES module of the web app's: a path the type checker does not follow, as it has no types of its own.
const turns = (await import(new URL("../web/turns.js", import.meta.url).href)) as Turns;

const SUMMARY = "## Goal\nShip release 2.4 (marker-summary).\n\n## Waiting on\nThe builder.";
const user = (id: number, text = "go"): Row => ({ id, kind: "user", text });
const request = (id: number): Row => user(id, `${SUMMARY_PREFIX}You called compact_self. Write the summary.`);
const answer = (id: number, text: string, stopReason = "stop"): Row => ({ id, kind: "assistant", blocks: text === "" ? [] : [{ type: "text", text }], stopReason });
const compaction = (id: number): Row => ({
    id,
    kind: "compaction",
    summary: `The conversation history before this point was compacted into the following summary:\n\n<summary>\n${appSections({ subagents: [], sessions: [], ci: [], schedules: [], tasks: [] }, { read: [], changed: [] }, undefined)}\n</summary>`,
});
const shown = (rows: Row[], folds: Folds) => turns.quietRows(rows, folds).map((row) => `${row.id}:${row.kind}${"state" in row ? `:${row.state}` : ""}`);

test("the transcript's markers are the server's: the request's prefix and the entry's pointer", () => {
    assert.equal(turns.SELF_COMPACT_REQUEST, SUMMARY_PREFIX);
    assert.equal(turns.SELF_COMPACT_POINTER, SUMMARY_POINTER);
    assert.ok(compaction(9).summary!.includes(SUMMARY_POINTER));
});

test("compacted: the request and Pi's summary go, and the compaction entry carries the summary, wherever the rows start", () => {
    // As the context has them after the compaction: its entry first, then the kept rows, the request and summary last.
    const context = [compaction(9), user(5), answer(6, "ok"), request(7), answer(8, SUMMARY), user(10, "hello")];
    const folds = turns.selfCompactionsOf(context, { compacting: false });

    assert.deepEqual(shown(context, folds), ["9:compaction", "5:user", "6:assistant", "10:user"]);
    assert.equal(turns.quietRows(context, folds)[0]!.selfSummary, SUMMARY);
    assert.equal(folds.streaming, false);

    // The history before the compaction holds the request and summary too: read with the context, they go there as well.
    const history = [user(1), answer(2, "ok"), user(5), answer(6, "ok"), request(7), answer(8, SUMMARY)];
    const both = turns.selfCompactionsOf([...history, ...context], { compacting: false });

    assert.deepEqual(shown(history, both), ["1:user", "2:assistant", "5:user", "6:assistant"]);

    // The app's part, without the line that points Pi at its summary and without Pi Durable's wrapping.
    const sections = turns.selfSections(compaction(9).summary!);

    assert.match(sections, /^## Waiting on\n- Nothing\./);
    assert.doesNotMatch(sections, /compact-self request|<\/summary>/);
});

test("while the summary is written: one quiet row, and the answer being written does not show", () => {
    const rows = [user(1), answer(2, "Waiting."), request(3)];
    const writing = turns.selfCompactionsOf(rows, { compacting: true });

    assert.deepEqual(shown(rows, writing), ["1:user", "2:assistant", "3:selfCompact:compacting"]);
    assert.equal(writing.streaming, true);

    // Written, waiting for the compaction: still the quiet row alone.
    const written = [...rows, answer(4, SUMMARY)];
    const waiting = turns.selfCompactionsOf(written, { compacting: true });

    assert.deepEqual(shown(written, waiting), ["1:user", "2:assistant", "3:selfCompact:compacting"]);
});

test("not compacted: the same quiet row says so, with Pi's summary under it or none given", () => {
    const stopped = [user(1), request(2), answer(3, SUMMARY), user(4, "hello")];
    const folds = turns.selfCompactionsOf(stopped, { compacting: false });
    const row = folds.replaced.get(2)!;

    assert.deepEqual(shown(stopped, folds), ["1:user", "2:selfCompact:stopped", "4:user"]);
    assert.equal(row.noSummary, false);
    assert.equal(row.summary, SUMMARY);

    const failed = [user(1), request(2), answer(3, "", "error")];

    assert.equal(turns.selfCompactionsOf(failed, { compacting: false }).replaced.get(2)!.noSummary, true);
    // An older request that did not compact is not the one under way.
    const again = [...stopped, request(5)];

    assert.deepEqual(shown(again, turns.selfCompactionsOf(again, { compacting: true })), ["1:user", "2:selfCompact:stopped", "4:user", "5:selfCompact:compacting"]);
});

test("a message a person typed that starts like the request is theirs, and shows", () => {
    const rows = [request(1), answer(2, "ok")];

    assert.deepEqual(shown(rows, turns.selfCompactionsOf(rows, { authors: { 1: "owner" }, compacting: false })), ["1:user", "2:assistant"]);
});

// In a real Chrome: a session that compacts itself, as the person sees it.

const chrome = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"].find((name) => {
    try {
        execFileSync("which", [name], { stdio: "ignore" });

        return true;
    } catch {
        return false;
    }
});
const real = { skip: chrome === undefined ? "no Chrome on this machine" : false } as const;
const SHOTS = process.env.PHONE_SHOTS;
/** Pi's summary: long enough to stream for a few seconds at the faux model's pace. */
const LONG_SUMMARY = `## Goal\nShip release 2.4 (marker-summary).\n\n## Waiting on\nThe builder subagent and CI run Build #41.\n\n## Critical Context\n${"The suite runs on the devbox and reports back. ".repeat(160)}`;
/** Opened when the summary request reaches the model: the test looks at the page while the answer streams. */
let summaryAsked = false;
const faux = fauxProvider({
    tokensPerSecond: 500,
    models: [{ id: "faux-1", contextWindow: 200_000, cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } }],
});

faux.setResponses(
    Array.from({ length: 200 }, () => (request: { messages: { role: string; content: unknown }[] }) => {
        const messages = request.messages.filter((message) => message.role !== "system");
        const start = messages.findLastIndex((message) => message.role === "user");
        const asked = lastText({ messages: messages.slice(0, start + 1) }).text;
        const results = messages.slice(start + 1).filter((message) => message.role === "toolResult").length;

        if (asked.startsWith(SUMMARY_PREFIX)) {
            summaryAsked = true;

            return fauxAssistantMessage([fauxText(LONG_SUMMARY)]);
        }

        // Long tool results fill the context past what a compaction keeps; the page stays short.
        if (asked === "fill" && results === 0) {
            return fauxAssistantMessage([fauxToolCall("read", { path: join(work, "notes.txt") })], { stopReason: "toolUse" });
        }

        if (asked === "wait for the build" && results === 0) {
            return fauxAssistantMessage([fauxToolCall("compact_self", {})], { stopReason: "toolUse" });
        }

        return fauxAssistantMessage([fauxText(asked === "wait for the build" ? "Waiting." : "ok")]);
    }) as never,
);

let app: App;
let server: Server;
let base = "";
let engine: ChromeEngine;
let cdp: Cdp;

async function inPage<T>(expression: string): Promise<T> {
    const answer = await cdp.send<{ result: { value?: unknown }; exceptionDetails?: { exception?: { description?: string } } }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });

    if (answer.exceptionDetails !== undefined) {
        throw new Error(answer.exceptionDetails.exception?.description ?? "the page threw");
    }

    return answer.result.value as T;
}

async function shot(name: string): Promise<void> {
    if (SHOTS === undefined) {
        return;
    }

    mkdirSync(SHOTS, { recursive: true });
    await new Promise((resolve) => setTimeout(resolve, 400));
    const { data } = await cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png" });

    writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(data, "base64"));
}

/** What the transcript shows: its message rows, Pi's replies, and its self-compaction rows. */
type Seen = { prompts: string[]; replies: string[]; selfRows: { state: string | null; text: string }[]; earlier: boolean };
const seen = () =>
    inPage<Seen>(`(() => {
        const all = (selector) => [...document.querySelectorAll(selector)];

        return {
            prompts: all("[data-part=prompt-row]").map((each) => each.innerText),
            replies: all("[data-part=reply]").map((each) => each.innerText),
            selfRows: all("[data-part=self-compaction]").map((each) => ({ state: each.getAttribute("data-state"), text: each.innerText })),
            earlier: all(".divider .link").some((each) => each.innerText.includes("Show earlier messages")),
        };
    })()`);
/** Nothing of the request or the summary as a message. */
function quiet(now: Seen, when: string): void {
    assert.deepEqual(
        now.prompts.filter((each) => each.includes("compact_self") || each.includes("compacting this session")),
        [],
        `${when}: no request row`,
    );
    assert.deepEqual(
        now.replies.filter((each) => each.includes("marker-summary")),
        [],
        `${when}: no answer holding the summary`,
    );
}

before(async () => {
    if (real.skip) {
        return;
    }

    writeFileSync(join(work, "notes.txt"), "the suite runs on the devbox and reports back.\n".repeat(1000));
    app = await openApp(faux as never);
    server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    engine = new ChromeEngine(chrome!, ["--no-sandbox"]);
    cdp = await engine.connect(await engine.newTab());
    await cdp.send("Page.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await cdp.send("Page.navigate", { url: `${base}/login?token=${encodeURIComponent(app.config.ownerToken)}` });
    await until(async () => (await inPage<string>("location.pathname").catch(() => "")) === "/", "signed in", 20_000);
});

after(() =>
    cleanUpAll(
        () => cdp?.close(),
        () => engine?.close(),
        () => server?.closeAllConnections(),
        () => server?.close(),
        () => app?.close(),
    ),
);

const entries = async (id: ConversationId): Promise<readonly EntryRecord[]> =>
    (await (await app.harness.conversation(id, context))!.entries({ order: "ascending" }, 1000, undefined, context)).items;
const say = async (id: ConversationId, text: string, wait = true) => {
    const { submissionId } = await app.commands.submit(id, owner(app), { text, requestId: crypto.randomUUID() });

    if (wait) {
        await (await app.harness.submission(submissionId, context))!.wait(context);
    }
};

test("a self-compaction shows as one quiet row while Pi writes the summary, then one Compacted line that opens the summary", real, async () => {
    const id = await newSession(app);

    for (let index = 0; index < 3; index++) {
        await say(id, "fill");
    }

    await app.harness.commit(async (tx) => {
        (await tx.doc(CiWatchesDoc, id)).items["o/r#41"] = { taskId: 0, repo: "o/r", runId: 41, label: "Build #41 on main", workflow: "Build", number: 41, branch: "main", url: "https://github.com/o/r/actions/runs/41", startedAt: Date.now() };
    }, context);
    await cdp.send("Page.navigate", { url: `${base}/s/${id}` });
    await until(async () => (await seen()).replies.some((each) => each.includes("ok")), "the session", 20_000);

    // The summary streams: the page shows the quiet row alone.
    await say(id, "wait for the build", false);
    await until(async () => summaryAsked, "the summary request", 20_000);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const writing = await seen();
    const still = (await entries(id)).every((entry) => !(entry.kind === "pi.assistant" && JSON.stringify(entry.model).includes("marker-summary")));

    assert.ok(still, "looked while the summary was still being written");
    quiet(writing, "while it streams");
    assert.deepEqual(
        writing.selfRows.map((each) => each.state),
        ["compacting"],
    );
    assert.match(writing.selfRows[0]!.text, /Compacting this session…/);
    assert.equal(await inPage<boolean>(`document.body.innerText.includes("marker-summary")`), false, "the streaming summary shows nowhere");
    await shot("compacting-390");

    // Compacted: one line, which opens Pi's summary and the app's sections.
    await until(async () => (await entries(id)).some((entry) => entry.kind === "pi.compaction"), "the compaction", 30_000);
    await until(async () => /Compacted: Pi chose to while waiting/.test((await seen()).selfRows[0]?.text ?? ""), "the Compacted line", 10_000);

    const open = async (when: string) => {
        const now = await seen();

        quiet(now, when);
        assert.equal(now.selfRows.length, 1, `${when}: one self-compaction row`);
        assert.equal(now.selfRows[0]!.state, null, `${when}: the Compacted line`);
        await inPage(`document.querySelector("[data-part=self-compaction] .link").click()`);
        await until(async () => (await inPage<string>(`document.querySelector("[data-part=self-compaction-body]")?.innerText ?? ""`)).includes("marker-summary"), `${when}: the summary opens`);
        const body = await inPage<string>(`document.querySelector("[data-part=self-compaction-body]").innerText`);

        assert.match(body, /Ship release 2\.4/);
        assert.match(body, /Read from the app's state when it compacted/);
        assert.match(body, /CI run Build #41 on main/, "the app's sections");
        assert.doesNotMatch(body, /compact-self request/, "not the line meant for Pi");
    };

    await open("live");
    await shot("compacted-open-390");

    // After a reload, and with the history before the compaction shown.
    await cdp.send("Page.navigate", { url: `${base}/s/${id}` });
    await until(async () => (await seen()).selfRows.length === 1, "the row after a reload", 20_000);
    await open("after a reload");
    await inPage(`[...document.querySelectorAll(".divider .link")].find((each) => each.innerText.includes("Show earlier messages")).click()`);
    await until(async () => (await inPage<number>(`document.querySelectorAll(".history [data-part=reply]").length`)) > 0, "the history", 10_000);
    quiet(await seen(), "with the history");
    assert.equal((await seen()).selfRows.length, 1, "with the history: still one row");

    // What the model sees is as it was: the request and its answer are in its context.
    const view = await (await app.harness.conversation(id, context))!.context(context);
    const texts = view.messages.map((message) => JSON.stringify(message.content));

    assert.ok(texts.some((each) => each.includes(SUMMARY_PREFIX.trim())), "the request");
    assert.ok(texts.some((each) => each.includes("marker-summary")), "the summary");
});
