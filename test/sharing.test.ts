// Sharing sessions from a pi-phone on the team server (PP-55): sharing makes a scoped account per teammate and level
// (Can write: a guest, Can watch: a viewer), limited to the sessions shared that way, and sends the gateway that list
// with the account's token; a second session joins the same account; a spend limit goes on the writer; the token signs
// in as that account only; unsharing takes the session away and the account with its last one; only the owner shares.
import { cleanUp, context, home, modelTexts, newSession, owner, root, say, scriptedModel, until, work } from "./helpers.ts";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { ownRequest } from "../src/server/requests.ts";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createHandler } from "../src/server/http.ts";
import { PocketApp } from "../src/server/app.ts";
import { mayUseMachines } from "../src/server/extensions/sharing.ts";

const OWNER = "o".repeat(43);
/** Pi's tool calls by what the message says (PP-60), and what the tools answered. */
const calls: Record<string, [string, Record<string, unknown>]> = {};
const results: string[] = [];
const route: FauxResponseStep = (ctx) => {
    const last = (ctx as { messages: { role: string; content: unknown }[] }).messages.at(-1)!;

    if (last.role === "toolResult") {
        results.push(JSON.stringify(last.content));

        return fauxAssistantMessage([fauxText("done")]);
    }

    const text = JSON.stringify(last.content);
    const found = Object.entries(calls).find(([ask]) => text.includes(ask));

    return found === undefined ? fauxAssistantMessage([fauxText(`heard: ${text}`)]) : fauxAssistantMessage([fauxToolCall(found[1][0], found[1][1] as never)], { stopReason: "toolUse" });
};
const puts: { teammate: string; level: string; token: string; sessions: { id: string; title: string; machines: boolean }[] }[] = [];
let gateway: Server;
let server: Server;
let app: PocketApp;
let base = "";

before(async () => {
    // A stand-in for the gateway's /internal/shares: teammates Mai and Lan; every put recorded.
    gateway = createServer((request, response) => {
        let text = "";

        request.on("data", (chunk) => (text += chunk));
        request.on("end", () => {
            const body = JSON.parse(text) as Record<string, unknown>;

            assert.equal(request.headers.authorization, `Bearer ${OWNER}`, "with this pi-phone's own token");
            const value = body.method === "teammates" ? [{ id: "u-mai", name: "Mai" }, { id: "u-lan", name: "Lan" }] : body.method === "put" ? (puts.push(body as never), { added: [], removed: [] }) : [];

            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ value }));
        });
    });
    await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
    const model = scriptedModel(route);

    app = await PocketApp.open({
        dataDir: join(root, "sharing-data"),
        defaultCwd: work,
        supervised: false,
        log: () => {},
        configureModels: (models) => models.registerNativeProvider(model.provider),
        home,
        officecli: { runs: false },
        ownerToken: OWNER,
        gatewayUrl: `http://127.0.0.1:${(gateway.address() as { port: number }).port}`,
    });
    server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
    server?.closeAllConnections();
    server?.close();
    gateway?.close();
    await app?.close();
    cleanUp();
});

const call = (token: string, path: string, body?: unknown) =>
    fetch(`${base}/api/x/sharing/${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${token}`, "x-pocket": "1", "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
const session = async (title: string) => {
    const owner = app.config.users.find((each) => each.role === "owner")!;
    const { id } = await app.commands.createSession(owner, { cwd: work });

    await app.commands.updateSession(id, owner, { title });

    return String(id);
};
const account = (name: string) => app.config.users.find((each) => each.name === name);

test("share, a second session, watch, a spend limit, the scoped token, unshare", async () => {
    const plan = await session("Release plan");
    const notes = await session("Notes");

    // Can write: a guest limited to the session, and the gateway gets its token.
    assert.equal((await call(OWNER, "share", { session: plan, teammate: "u-mai", level: "write", budget: 5 })).status, 200);
    const writer = account("Mai (team)");

    assert.deepEqual([writer?.role, writer?.sessions, writer?.budget], ["guest", [plan], 5]);
    assert.deepEqual([puts.at(-1)?.teammate, puts.at(-1)?.level, puts.at(-1)?.sessions.map((each) => each.id)], ["u-mai", "write", [plan]]);
    const token = puts.at(-1)!.token;

    // The token signs in as that account only: it may not share, nor see the owner's other sessions.
    const me = (await (await fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${token}` } })).json()) as { user?: { role?: string; name?: string } };

    assert.equal(me.user?.role ?? (me as { role?: string }).role, "guest");
    assert.equal((await call(token, "share", { session: notes, teammate: "u-lan", level: "write" })).status, 404, "the owner's routes: not there for anyone else");

    // Can watch, on another session: a second account, a viewer.
    assert.equal((await call(OWNER, "share", { session: notes, teammate: "u-mai", level: "watch" })).status, 200);
    assert.deepEqual([account("Mai (team, watching)")?.role, account("Mai (team, watching)")?.sessions], ["viewer", [notes]]);
    assert.deepEqual(((await (await call(OWNER, `session/${notes}`)).json()) as { shares: { teammate: string; level: string }[] }).shares.map((each) => [each.teammate, each.level]), [["u-mai", "watch"]]);

    // Unshared: the writer had only that one, so it goes, and the gateway hears an empty list with the same token.
    assert.equal((await call(OWNER, "unshare", { session: plan, teammate: "u-mai" })).status, 200);
    assert.equal(account("Mai (team)"), undefined);
    const last = puts.findLast((each) => each.level === "write");

    assert.deepEqual([last?.token, last?.sessions], [token, []]);
    assert.equal((await fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${token}` } })).status, 401, "its token no longer works");

    // No such teammate, no such session, nonsense level.
    assert.equal((await call(OWNER, "share", { session: plan, teammate: "u-nobody", level: "write" })).status, 404);
    assert.equal((await call(OWNER, "share", { session: "99999", teammate: "u-mai", level: "write" })).status, 404);
    assert.equal((await call(OWNER, "share", { session: plan, teammate: "u-mai", level: "edit" })).status, 400);
});

test("a teammate never writes files, runs shell commands, or allows calls; Pi uses the owner's machines and secrets for them only where the share says (PP-57)", async () => {
    const notes = await session("Shared notes");

    assert.equal((await call(OWNER, "share", { session: notes, teammate: "u-lan", level: "write" })).status, 200);
    const lan = account("Lan (team)")!;
    const id = Number(notes) as never;

    assert.equal(lan.team, true);
    await assert.rejects(app.workspace.putFile(id, lan, "", "x.txt", Buffer.from("x")), /can't add files/);
    await assert.rejects(app.workspace.revertChange(id, lan, "x.txt"), /can't undo files/);
    await assert.rejects(app.workspace.switchBranch(id, lan, { name: "main" }), /can't switch branches/);
    await assert.rejects(app.shell.start(id, lan, { command: "ls", requestId: "r1" }), /can't run shell commands/);
    assert.match(app.cannotAllow(lan, { id: "a", conversationId: id, taskId: 1 as never, tool: "bash", subject: "ls", reason: "", createdAt: 0 }) ?? "", /only they allow/);

    // Machines and secrets: by who asked last, and the share's switch.
    const fake = (requester: string | undefined) => ({ teamServer: { url: "x", token: "y" }, dataDir: join(root, "sharing-data"), requesterOf: () => requester }) as never;

    assert.equal(mayUseMachines(fake(app.config.users.find((each) => each.role === "owner")!.id), Number(notes)), true, "the owner");
    assert.equal(mayUseMachines(fake(lan.id), Number(notes)), false, "a teammate, switch off (the default)");
    assert.equal((await call(OWNER, "share", { session: notes, teammate: "u-lan", level: "write", machines: true })).status, 200);
    assert.equal(mayUseMachines(fake(lan.id), Number(notes)), true, "switch on for that share");
    assert.equal(mayUseMachines({ teamServer: undefined, requesterOf: () => lan.id } as never, Number(notes)), true, "the phone has no shares");
});

test("Continue in my space (PP-59): a shared session as a Pi session file, continued as a new session with its messages", async () => {
    const id = await newSession(app as never);

    await app.commands.updateSession(id, app.config.users.find((each) => each.role === "owner")!, { title: "To carry on" });
    await say(app as never, id, "remember the number 4242");
    // Only a shared session leaves this pi-phone.
    assert.equal((await call(OWNER, `export/${id}`)).status, 404);
    assert.equal((await call(OWNER, "share", { session: String(id), teammate: "u-mai", level: "watch" })).status, 200);

    const exported = (await (await call(OWNER, `export/${id}`)).json()) as { title: string; text: string };

    assert.equal(exported.title, "To carry on");
    assert.match(exported.text, /^\{"type":"session"/);
    assert.match(exported.text, /remember the number 4242/);

    // The teammate's pi-phone continues it: a new session here with the same messages.
    const owner = app.config.users.find((each) => each.role === "owner")!;
    const { path } = await app.piSessions.import(owner, "shared-copy.jsonl", Buffer.from(exported.text));
    const { id: copy } = await app.commands.continuePiSession(owner, path, work);

    assert.notEqual(Number(copy), Number(id));
    assert.match(JSON.stringify(await modelTexts(app as never, copy)), /remember the number 4242/);
});

test("Pi's sharing tools (PP-60): list, share on the card, unshare without one", async () => {
    const id = await newSession(app as never);
    const me = owner(app as never);
    const turn = async (text: string) => {
        const { submissionId } = await app.commands.submit(id, me, { text, requestId: ownRequest(me.id, crypto.randomUUID()) });

        return submissionId;
    };

    calls["share it with mai"] = ["session_share", { session: Number(id), teammate: "mai", level: "watch", reason: "to show her the plan" }];
    calls["who is it shared with"] = ["sessions_shared", {}];
    calls["stop sharing with mai"] = ["session_unshare", { session: Number(id), teammate: "Mai" }];

    // Sharing waits for the owner's card.
    const sharing = await turn("share it with mai");

    await until(() => app.approvals.forConversation(id).length > 0, "the card");
    const card = app.approvals.forConversation(id)[0]!;

    assert.equal(card.tool, "session_share");
    assert.match(card.subject, /with Mai: can watch/);
    await app.answerApproval(card.id, true, me);
    await (await app.harness.submission(sharing, context))!.wait(context);
    await app.harness.waitForIdle(context);
    assert.match(results.at(-1)!, /Shared #\d+ .*with Mai \(can watch\)/);
    assert.deepEqual(account("Mai (team, watching)")?.sessions?.includes(String(id)), true);

    await say(app as never, id, "who is it shared with");
    assert.match(results.at(-1)!, new RegExp(`#${id}.*Mai can watch`));

    // Unsharing: no card.
    await say(app as never, id, "stop sharing with mai");
    assert.match(results.at(-1)!, /no longer shared with Mai/);
    assert.equal(app.approvals.forConversation(id).length, 0);
});
