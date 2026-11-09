// Pi's browser, PP-469, with a Chrome on the machine (CI), in the app: the calls of one assistant message are written
// against the read Pi saw before it. On Azure DevOps's production approval, Pi sent browser_type([62]) and
// browser_click([64]) in one message; typing showed a link above "Approve", the controls were numbered again, and the
// click went to [64] of the new read: the environment's link. Now each call's numbers are those of the read before its
// message: when an earlier call of the message changed what a number names, the call is refused and nothing is done;
// when it did not (three checkboxes ticked in one message), the calls work as before; calls in messages of their own
// use the newest read, as before. A sign-in card's fields are checked so too. And the browser calls of one message run
// in its order: a click after an upload no longer runs first.
import { cleanUp, cleanUpAll, context, lastText, modelTexts, newSession, openApp, owner, root, scriptedModel, work } from "./helpers.ts";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { ChromeEngine } from "../src/server/browser/pi-browser.ts";
import { callerOf } from "../src/server/extensions/browser.ts";

const chrome = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"].find((name) => {
    try {
        execFileSync("which", [name], { stdio: "ignore" });

        return true;
    } catch {
        return false;
    }
});
const skip = chrome === undefined ? "no Chrome on this machine (CI runs it)" : false;

const PAGES: Record<string, string> = {
    // A stage waiting for approval: typing a comment shows the environment's link above Approve, as Azure DevOps does.
    "/approve": `<!doctype html><title>Run 4681</title><meta name="viewport" content="width=device-width">
        <label>Comment <textarea id="comment"></textarea></label>
        <div id="slot"></div>
        <button onclick="out.textContent = 'Approved with ' + JSON.stringify(comment.value)">Approve</button>
        <button onclick="out.textContent = 'Rejected'">Reject</button>
        <p id="out">Waiting for approval</p>
        <script>
            comment.addEventListener('input', () => {
                if (!slot.firstChild) slot.innerHTML = '<a href="#environment" onclick="out.textContent = \\'Opened Production - Infrastructure\\'">Production - Infrastructure</a>';
            });
        </script>`,
    // Checks that change nothing but themselves.
    "/checks": `<!doctype html><title>Checks</title><meta name="viewport" content="width=device-width">
        <label><input type="checkbox" onchange="tell()"> Domains</label><br>
        <label><input type="checkbox" onchange="tell()"> Certificates</label><br>
        <label><input type="checkbox" onchange="tell()"> Routing</label>
        <p id="out">0 checked</p>
        <script>function tell() { out.textContent = document.querySelectorAll(':checked').length + ' checked'; }</script>`,
    // A sign-in whose email field, once typed in, shows a promo code field above the password.
    "/signin": `<!doctype html><title>Sign in</title><meta name="viewport" content="width=device-width">
        <label>Email <input id="email"></label>
        <div id="slot"></div>
        <label>Password <input id="pw" type="password"></label>
        <script>email.addEventListener('input', () => { if (!slot.firstChild) slot.innerHTML = '<label>Promo code <input id="promo"></label>'; });</script>`,
    // A report with a file: Done tells how many files were chosen.
    "/report": `<!doctype html><title>Report</title><meta name="viewport" content="width=device-width">
        <label>Evidence <input id="file" type="file"></label>
        <button onclick="out.textContent = 'Done with ' + file.files.length + ' file'">Done</button>
        <p id="out">Not done</p>`,
};

let server: Server;
let port = 0;

before(async () => {
    server = createServer((request, response) => {
        const page = PAGES[(request.url ?? "/").split("?")[0]!];

        response.writeHead(page === undefined ? 404 : 200, { "content-type": "text/html; charset=utf-8" });
        response.end(page ?? "not here");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
});

after(() => cleanUpAll(() => server?.close(), () => cleanUp()));

test("which message a browser call is in: a model's call names its assistant entry; a script's call its model call's, unchecked; a task that names none is an error (PP-469)", async () => {
    const tasks: Record<number, unknown> = {
        1: { kind: "model", assistant: 41, callId: "c1" },
        2: { kind: "nested", parent: 1, parentCallId: "c1", key: "1", call: {} },
        3: { kind: "nested", parent: 2, parentCallId: "c1/1", key: "c1", call: {} },
        4: { assistant: 42, callId: "c4" },
        5: { kind: "nested", parent: 9, parentCallId: "c9", key: "1", call: {} },
    };
    const api = (taskId: number) => ({
        taskId: taskId as never,
        conversationId: 7 as never,
        getTask: (async (id: number) => (id in tasks ? { input: tasks[id] } : undefined)) as never,
    });

    assert.deepEqual(await callerOf(api(1), context), { session: 7, message: 41, checks: true });
    assert.deepEqual(await callerOf(api(2), context), { session: 7, message: 41, checks: false });
    assert.deepEqual(await callerOf(api(3), context), { session: 7, message: 41, checks: false });
    // A version 1 tool task: a model's call without kind.
    assert.deepEqual(await callerOf(api(4), context), { session: 7, message: 42, checks: true });
    await assert.rejects(callerOf(api(5), context), /cannot tell which of Pi's messages this call is in: its tool task \(9\) names none/);
});

/** What a message of the person asks Pi to call: one or more calls in one assistant message. */
type Calls = Record<string, [string, Record<string, unknown>][]>;

/** The app with a scripted model making `calls`, a session in it, and a turn: the tool results of that turn, and the page then. */
async function appWith(name: string, calls: Calls) {
    const engine = new ChromeEngine(chrome!, [`--host-resolver-rules=MAP pi.test 127.0.0.1:${port}`, "--no-sandbox"]);
    const route: FauxResponseStep = (request) => {
        const { role, text } = lastText(request as never);

        for (const [ask, list] of Object.entries(calls)) {
            if (role === "user" && text.endsWith(ask)) {
                return fauxAssistantMessage(list.map(([tool, args]) => fauxToolCall(tool, args as never)), { stopReason: "toolUse" });
            }
        }

        return fauxAssistantMessage([fauxText("ok")]);
    };
    const app = await openApp(scriptedModel(route), join(root, name), undefined, { browserEngine: engine });
    const id = await newSession(app);
    /** Cards the turns showed, each answered Not now. */
    const cards: string[] = [];
    const turn = async (text: string) => {
        const before = (await modelTexts(app, id)).length;
        const { submissionId } = await app.commands.submit(id, owner(app), { text, requestId: crypto.randomUUID() });
        const submission = (await app.harness.submission(submissionId, context))!;
        let done = false;
        const waited = submission.wait(context).then(() => (done = true));

        while (!done) {
            for (const card of app.approvals.forConversation(id)) {
                cards.push(`${card.tool}: ${card.subject}: ${JSON.stringify(card.form?.type === "browser" ? card.form.fields : [])}`);
                await app.answerApproval(card.id, false, owner(app));
            }

            await Promise.race([waited, new Promise((resolve) => setTimeout(resolve, 50))]);
        }

        // The tool results of this turn, in order.
        const view = await (await app.harness.conversation(id, context))!.context(context);

        return view.messages
            .slice(before)
            .flatMap((message) => (message.role === "toolResult" ? [(message.content as { type: string; text?: string }[]).map((part) => part.text ?? "").join("")] : []));
    };

    return { app, engine, turn, cards };
}

test("with Chrome, in the app: a click written in the same message as typing that showed a link above its button is refused, and nothing is clicked (PP-469)", { skip }, async () => {
    const { app, engine, turn } = await appWith("browser-batched-refused", {
        "open the run": [["browser_open", { url: "http://pi.test/approve" }]],
        "comment and approve": [
            ["browser_type", { index: 1, text: "TL-73 ok" }],
            ["browser_click", { index: 2 }],
        ],
        "read it": [["browser_snapshot", {}]],
    });

    try {
        const [page] = await turn("open the run");

        // As Pi read it: [1] the comment, [2] Approve.
        assert.match(page!, /\[1\] textbox "Comment"[\s\S]*\[2\] button "Approve"/);

        const [typed, clicked] = await turn("comment and approve");

        // Typing showed the link: Approve is [3] now.
        assert.match(typed!, /\[2\] link "Production - Infrastructure"[\s\S]*\[3\] button "Approve"/);
        assert.doesNotMatch(clicked!, /Opened Production - Infrastructure/, "the click went to the link");
        assert.match(clicked!, /\[2\] was button "Approve" when this call was written; an earlier call in the same message changed the page, and \[2\] is now link "Production - Infrastructure"\. Nothing was done/);

        const [now] = await turn("read it");

        assert.match(now!, /Waiting for approval/);
        assert.doesNotMatch(now!, /Opened Production - Infrastructure|Approved/);
    } finally {
        await app.close();
        await engine.close();
    }
});

test("with Chrome, in the app: calls of one message on controls that stay where they were all work: three checkboxes ticked (PP-469)", { skip }, async () => {
    const { app, engine, turn } = await appWith("browser-batched-stable", {
        "open the checks": [["browser_open", { url: "http://pi.test/checks" }]],
        "tick all": [
            ["browser_click", { index: 1 }],
            ["browser_click", { index: 2 }],
            ["browser_click", { index: 3 }],
        ],
    });

    try {
        await turn("open the checks");

        const results = await turn("tick all");

        assert.equal(results.length, 3);
        assert.match(results[2]!, /3 checked/);

        for (const result of results) {
            assert.doesNotMatch(result, /when this call was written/);
        }
    } finally {
        await app.close();
        await engine.close();
    }
});

test("with Chrome, in the app: a sign-in card on a field that an earlier call of the message moved is refused, and no card shows (PP-469)", { skip }, async () => {
    const { app, engine, turn, cards } = await appWith("browser-batched-sign-in", {
        "open the sign-in": [["browser_open", { url: "http://pi.test/signin" }]],
        "email and password": [
            ["browser_type", { index: 1, text: "tuan@example.com" }],
            ["browser_sign_in", { password: 2 }],
        ],
    });

    try {
        const [page] = await turn("open the sign-in");

        assert.match(page!, /\[2\] password "Password"/);

        const [typed, asked] = await turn("email and password");

        assert.match(typed!, /\[2\] textbox "Promo code"/);
        assert.deepEqual(cards, [], "no card was shown");
        assert.match(asked!, /\[2\] was password "Password" when this call was written; an earlier call in the same message changed the page, and \[2\] is now textbox "Promo code"\. Nothing was done/);
    } finally {
        await app.close();
        await engine.close();
    }
});

test("with Chrome, in the app: the browser calls of one message run in its order: Done after the upload sees the file (PP-469)", { skip }, async () => {
    mkdirSync(work, { recursive: true });
    writeFileSync(join(work, "evidence.txt"), "proof");

    const { app, engine, turn } = await appWith("browser-batched-order", {
        "open the report": [["browser_open", { url: "http://pi.test/report" }]],
        "attach and finish": [
            ["browser_upload", { index: 1, paths: ["evidence.txt"] }],
            ["browser_click", { index: 2 }],
        ],
    });

    try {
        await turn("open the report");

        const [uploaded, clicked] = await turn("attach and finish");

        assert.match(uploaded!, /Chose evidence\.txt/);
        assert.match(clicked!, /Done with 1 file/);
    } finally {
        await app.close();
        await engine.close();
    }
});

test("with Chrome, in the app: calls in messages of their own use the newest read, as before (PP-469)", { skip }, async () => {
    const { app, engine, turn } = await appWith("browser-batched-sequential", {
        "open the run": [["browser_open", { url: "http://pi.test/approve" }]],
        "comment": [["browser_type", { index: 1, text: "TL-73 ok" }]],
        "approve": [["browser_click", { index: 3 }]],
    });

    try {
        await turn("open the run");

        const [typed] = await turn("comment");

        assert.match(typed!, /\[3\] button "Approve"/);

        const [approved] = await turn("approve");

        assert.match(approved!, /Approved with "TL-73 ok"/);
    } finally {
        await app.close();
        await engine.close();
    }
});
