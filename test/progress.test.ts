// The progress board (PP-283, GitHub issue #5): what waits for the owner first, then the longest at work, each saying
// what it does now; counts in the title; a new version only when what it says changes; and, in the app, a session at
// work and its subagent with their steps, and the board's settings.
import { cleanUp, context, lastText, newSession, openApp, owner, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { ApprovalRequest } from "../src/server/host.ts";
import { translator } from "../src/server/i18n.ts";
import { doingText, MAX_ROWS, Progress, type ProgressSource } from "../src/server/progress.ts";
import type { PeekLine } from "../src/server/projection.ts";

const en = translator("en");
const id = (n: number) => n as unknown as ConversationId;

function source(over: Partial<ProgressSource> & { lines?: Record<number, PeekLine[]> }): ProgressSource {
    return {
        busy: () => [],
        approvals: () => [],
        title: (each) => `Session ${String(each)}`,
        rootOf: (each) => each,
        since: (each) => 1_000 + Number(each),
        peek: async (each) => over.lines?.[Number(each)],
        doneSince: () => 0,
        now: () => 100_000,
        ...over,
    };
}

test("what a step says it does: a file read or edited, a command, the web, a subagent, Pi's words, or thinking", () => {
    assert.equal(doingText({ kind: "tool", name: "edit", args: { path: "web/sheets/menu.js" }, status: "running" }, en), "editing web/sheets/menu.js");
    assert.equal(doingText({ kind: "tool", name: "read", args: { path: "a.ts" }, status: "running" }, en), "reading a.ts");
    assert.equal(doingText({ kind: "tool", name: "bash", args: { command: "npm test" }, status: "running" }, en), "running npm test");
    assert.equal(doingText({ kind: "tool", name: "web_search", args: { query: "pi phone" }, status: "running" }, en), "reading the web: pi phone");
    assert.equal(doingText({ kind: "tool", name: "subagent", args: { name: "x" }, status: "running" }, en), "waiting for its subagents");
    assert.equal(doingText({ kind: "tool", name: "browser_open", args: { url: "example.com" }, status: "running" }, en), "browser_open example.com");
    assert.equal(doingText({ kind: "text", text: "Now   the tests pass." }, en), "Now the tests pass.");
    assert.equal(doingText({ kind: "tool", name: "edit", args: {}, status: "done" }, en), "thinking");
    assert.equal(doingText(undefined, en), "working");
    assert.equal(doingText({ kind: "tool", name: "bash", args: { command: "x".repeat(200) }, status: "running" }, en).length, "running ".length + 70);
});

test("the board: what waits first, then the longest at work; counts in the title; a card with a form is not answered here", async () => {
    const approvals = [
        { id: "a1", conversationId: id(7), tool: "bash", subject: "az webapp config set", reason: "", createdAt: 5_000 },
        { id: "a2", conversationId: id(8), tool: "secret_request", subject: "TOKEN", reason: "", createdAt: 6_000, form: { type: "secret" } },
    ] as unknown as ApprovalRequest[];
    const progress = new Progress(
        source({
            busy: () => [id(3), id(2), id(9)],
            approvals: () => approvals,
            // 9 is not a session nor a subagent (the wiki's capture): left out.
            title: (each) => (Number(each) === 9 ? undefined : `Session ${String(each)}`),
            doneSince: () => 2,
            lines: { 2: [{ kind: "tool", name: "edit", args: { path: "menu.js" }, status: "running" }], 3: [{ kind: "shell", command: "npm test", status: "done" }] },
        }),
    );
    const board = await progress.board(en, "en");

    assert.equal(board.heading, "2 working · 2 waits for you · 2 done");
    assert.deepEqual(
        board.rows.map((row) => [row.conversationId, row.state, row.doing, row.approval?.simple]),
        [
            [7, "waiting", "waits: bash az webapp config set", true],
            [8, "waiting", "waits: secret_request TOKEN", false],
            [2, "working", "editing menu.js", undefined],
            [3, "working", "running npm test", undefined],
        ],
    );
    assert.equal(board.more, 0);
});

test("a new version only when what the board says changes; a poll waits for it, and one past the server's is answered at once", async () => {
    let lines: PeekLine[] = [{ kind: "tool", name: "read", args: { path: "a.ts" }, status: "running" }];
    let now = 100_000;
    const progress = new Progress(source({ busy: () => [id(1)], peek: async () => lines, now: () => now }));
    const first = await progress.board(en, "en");

    now += 60_000;
    assert.equal((await progress.board(en, "en")).version, first.version, "a minute going by is no change");

    const signal = new AbortController().signal;
    const waiting = progress.after(first.version, en, "en", signal, 10_000);

    lines = [{ kind: "tool", name: "edit", args: { path: "a.ts" }, status: "running" }];
    const next = await waiting;

    assert.equal(next.version, first.version + 1);
    assert.equal(next.rows[0]!.doing, "editing a.ts");
    assert.equal((await progress.after(next.version + 50, en, "en", signal, 10_000)).version, next.version, "a restarted server's version");
});

test("every row for the floating board, past five counted for the notification; nothing at work says Pi is idle", async () => {
    const many = new Progress(source({ busy: () => [1, 2, 3, 4, 5, 6, 7].map(id) }));
    const board = await many.board(en, "en");

    assert.equal(board.rows.length, 7);
    assert.equal(board.more, 7 - MAX_ROWS);
    assert.equal((await new Progress(source({})).board(en, "en")).heading, "Pi is idle");
    assert.equal((await new Progress(source({ doneSince: () => 1 })).board(en, "en")).heading, "Pi is idle · 1 done");
});

test("subagents at work fold under their session, counted for the notification; one waiting for the owner keeps its row", async () => {
    // Session 1 works with subagents 11 and 12; subagent 13 of session 2 (not at work itself) works; 14 of 1 waits.
    const progress = new Progress(
        source({
            busy: () => [1, 11, 12, 13].map(id),
            approvals: () => [{ id: "w", conversationId: id(14), tool: "bash", subject: "rm -rf build", reason: "", createdAt: 1 }] as unknown as ApprovalRequest[],
            rootOf: (each) => id(Number(each) > 10 ? (Number(each) === 13 ? 2 : 1) : Number(each)),
            title: (each) => (Number(each) > 10 ? `${Number(each) === 13 ? "Two" : "One"} · sub${String(each)}` : Number(each) === 2 ? "Two" : "One"),
            lines: { 11: [{ kind: "tool", name: "edit", args: { path: "a.ts" }, status: "running" }] },
        }),
    );
    const board = await progress.board(en, "en");

    assert.equal(board.heading, "4 working · 1 waits for you", "every one at work counts");
    assert.deepEqual(
        board.rows.map((row) => [row.conversationId, row.state, row.subagents?.map((sub) => sub.name), row.subagentsText]),
        [
            [14, "waiting", undefined, undefined],
            [1, "working", ["sub11", "sub12"], "2 subagents working"],
            [2, "working", ["sub13"], "1 subagent working"],
        ],
    );
    assert.equal(board.rows[1]!.subagents![0]!.doing, "editing a.ts");
    assert.equal(board.rows[2]!.title, "Two");
});

test("in the app: a session running a command is on the board with it, then gone when done; the board's settings", async () => {
    const route: FauxResponseStep = (request) => {
        const { role, text } = lastText(request as never);

        if (role === "user" && text === "wait a little") {
            return fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 2" })], { stopReason: "toolUse" });
        }

        return fauxAssistantMessage([fauxText("done")]);
    };
    const app = await openApp(scriptedModel(route));

    try {
        const session = await newSession(app);
        const { submissionId } = await app.commands.submit(session, owner(app), { text: "wait a little", requestId: crypto.randomUUID() });

        await until(async () => (await app.progress.board(en, "en")).rows.some((row) => row.doing === "running sleep 2"), "the command on the board");
        const board = await app.progress.board(en, "en");

        assert.equal(board.rows[0]!.session, Number(session));
        assert.equal(board.rows[0]!.title, "wait a little");
        assert.match(board.heading, /^1 working/);

        await (await app.harness.submission(submissionId, context))!.wait(context);
        await until(async () => (await app.progress.board(en, "en")).rows.length === 0, "off the board when done");

        assert.deepEqual(app.config.progressBoard, { notification: true, bubble: false, hideIdle: true });
        await app.setProgressBoard(owner(app), "bubble", true);
        assert.equal(app.config.progressBoard.bubble, true);
        await assert.rejects(app.setProgressBoard(owner(app), "colour", true), /notification, bubble and hideIdle/);
        await app.setProgressBoard(owner(app), "bubble", false);
    } finally {
        await app.close();
        cleanUp();
    }
});
