// pi-pocket 0.22.0's extension points for people's values, in pi-phone (adapted from pi-pocket's
// test/extension-points.test.ts, commits 46d7353 and 8fe0121): `host.commandEnv` puts a value into a command's
// environment, and `host.hide` keeps it out of command output as it streams, every tool's result, and people's messages,
// through the same redaction as the owner's secrets (`secrets.ts`).
import { type App, cleanUp, context, lastText, modelTexts, newSession, openApp, owner, root, scriptedModel, until, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CommandEnvs, commandEnvLimits, HiddenValues } from "../src/server/hidden.ts";
import { Secrets } from "../src/server/secrets.ts";

const SECRET = "s3cr3t-token-value";
const notes = join(work, "points-notes.txt");
/** Everything the model was sent, to check that no value reached it. */
const sent: string[] = [];

const route: FauxResponseStep = (request) => {
    sent.push(JSON.stringify(request));

    const { role, text } = lastText(request as never);
    const call = (name: string, args: Record<string, unknown>) =>
        fauxAssistantMessage([fauxToolCall(name, args as never)], { stopReason: "toolUse" });

    if (role === "toolResult") {
        return fauxAssistantMessage([fauxText(`ok: ${text}`)]);
    }

    if (text.endsWith("use the token")) {
        return call("bash", { command: 'printf "%s" "$POINTS_TOKEN"; echo; printf "%s" "$POINTS_TOKEN" | wc -c' });
    }

    if (text.endsWith("read the notes")) {
        return call("read", { path: notes });
    }

    return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
};

let app: App;
const stops: (() => void)[] = [];

before(async () => {
    app = await openApp(scriptedModel(route));
    // As an extension does through `host.hide` and `host.commandEnv` (the host's members are these two calls).
    stops.push(app.hidden.add({ value: SECRET, label: "secret POINTS_TOKEN" }));
    stops.push(
        app.commandEnvs.add(({ command }) =>
            String(command).includes("$POINTS_TOKEN") ? { POINTS_TOKEN: SECRET } : undefined,
        ),
    );
});

after(async () => {
    for (const stop of stops) {
        stop();
    }

    await app?.close();
    cleanUp();
});

const stored = async (id: ConversationId) => JSON.stringify(await app.transcripts.allEntries(id, true));

/** One turn as the owner, to its end. */
async function turn(id: ConversationId, text: string): Promise<void> {
    const { submissionId } = await app.commands.submit(id, owner(app), { text, requestId: crypto.randomUUID() });

    await (await app.harness.submission(submissionId, context))!.wait(context);
    await app.harness.waitForIdle(context);
}

/** An environment whose command prints `pieces`, one chunk each, on `stream`s. */
function printing(pieces: { text: string; stream: "stdout" | "stderr" }[]): ExecutionEnv {
    return {
        cwd: "/",
        exec: async (
            _command: unknown,
            options: { onOutput?: (text: string, context: unknown, info: { stream: "stdout" | "stderr" }) => void },
        ) => {
            for (const piece of pieces) {
                options.onOutput?.(piece.text, context, { stream: piece.stream });
            }

            return { ok: true, value: { exitCode: 0 } };
        },
    } as unknown as ExecutionEnv;
}

test("a hidden value leaves streamed output with the secrets, also split across two chunks, in its session only", async () => {
    const hidden = new HiddenValues((id) => (id === 7 ? 3 : id));
    const secrets = new Secrets(mkdtempSync(join(root, "points-")), Date.now, () => {}, hidden);

    secrets.set("API_KEY", { value: "hunter2-hunter2-hunter2" });
    const stop = hidden.add({ value: "abcdefgh", label: "secret X", conversationId: 3 });
    const env = printing(
        ["one abc", "def", "gh two ", "abcdefgh", " three hunter2-hun", "ter2-hunter2 end"].map((text) => ({ text, stream: "stdout" })),
    );
    let seen = "";

    await secrets.guard(env, 3).exec("x", { onOutput: (text) => (seen += text) }, context);
    assert.equal(seen, "one [secret X] two [secret X] three [secret API_KEY] end");

    // In a subagent of session 3 too; in another session, and with no session, only the secrets.
    let subagent = "";

    await secrets.guard(env, 7).exec("x", { onOutput: (text) => (subagent += text) }, context);
    assert.equal(subagent, seen);
    assert.equal(secrets.redact("abcdefgh hunter2-hunter2-hunter2", 4), "abcdefgh [secret API_KEY]");
    assert.equal(secrets.redact("abcdefgh", undefined), "abcdefgh");
    assert.equal(secrets.guard(env, 3), secrets.guard(env, 3), "one guard per environment and session");

    // Output keeps its order across the two streams.
    let ordered = "";

    await secrets
        .guard(printing([{ text: "ERR ", stream: "stderr" }, { text: "OUT ", stream: "stdout" }, { text: "ERR2", stream: "stderr" }]), 3)
        .exec("x", { onOutput: (text) => (ordered += text) }, context);
    assert.equal(ordered, "ERR OUT ERR2");

    stop();
    assert.equal(secrets.redact("abcdefgh", 3), "abcdefgh", "a value taken away hides nothing");

    for (const bad of [
        { value: "abc", label: "x" },
        { value: "abcd", label: "two\nlines" },
        { value: "abcd", label: "x", conversationId: 0 },
    ]) {
        assert.throws(() => hidden.add(bad));
    }
});

test("a slow or throwing provider adds nothing, and the command runs with what the others give", async () => {
    const lines: string[] = [];
    const envs = new CommandEnvs((line) => lines.push(line));
    const was = commandEnvLimits.providerMs;

    commandEnvLimits.providerMs = 50;
    envs.add(() => new Promise(() => {}));
    envs.add(() => {
        throw new Error("broken");
    });
    envs.add(() => ({ "1BAD": "x", GOOD: "yes", PATH: "/nowhere" }));

    try {
        const env = envs.wrap(new NodeExecutionEnv({ cwd: work }), 1, work);
        let output = "";
        const result = await env.exec(
            'printf "%s %s" "$GOOD" "$KEEP"',
            { env: { KEEP: "mine" }, onOutput: (text) => (output += text) },
            context,
        );

        assert.ok(result.ok);
        assert.equal(output, "yes mine", "the command ran, with the good variable and the caller's own");
        assert.ok(lines.some((line) => /took more than 50 ms/.test(line)), lines.join("\n"));
        assert.ok(lines.some((line) => /a provider failed: broken/.test(line)));
        assert.ok(lines.some((line) => /not NAME=text: 1BAD/.test(line)));

        // What the caller sets itself (PATH) is not replaced.
        let path = "";

        await env.exec('printf "%s" "$PATH"', { env: { PATH: "/usr/bin:/bin" }, onOutput: (text) => (path += text) }, context);
        assert.equal(path, "/usr/bin:/bin");

        // One signal for many commands keeps no listener for those done.
        const signal = new AbortController().signal;

        for (let index = 0; index < 3; index += 1) {
            await envs.for({ conversationId: 1, command: "true", cwd: work }, signal);
        }

        assert.equal(getEventListeners(signal, "abort").length, 0);
    } finally {
        commandEnvLimits.providerMs = was;
    }
});

test("Pi's bash gets the provider's variable, and its value is in no output, result, or request to the model", async () => {
    const id = await newSession(app);
    const before = sent.length;

    await turn(id, "please use the token");
    await until(async () => (await stored(id)).includes("ok: "), "the answer");

    const transcript = await stored(id);

    assert.match(transcript, /\[secret POINTS_TOKEN\]/);
    // The value was there: its length counted.
    assert.match(transcript, /\[secret POINTS_TOKEN\]\\n18\\n/);
    assert.doesNotMatch(transcript, new RegExp(SECRET));
    assert.ok(sent.slice(before).every((request) => !request.includes(SECRET)));
});

test("any tool's result hides the value before it is stored", async () => {
    const id = await newSession(app);

    mkdirSync(work, { recursive: true });
    writeFileSync(notes, `the value is ${SECRET}\n`);
    await turn(id, "please read the notes");

    const transcript = await stored(id);

    assert.match(transcript, /the value is \[secret POINTS_TOKEN\]/);
    assert.doesNotMatch(transcript, new RegExp(SECRET));
    assert.ok(!(await modelTexts(app, id)).join("\n").includes(SECRET));
});

test("a value pasted into a message to Pi, or into an edit sent again, is replaced before it is stored", async () => {
    const id = await newSession(app);
    const me = owner(app);
    const before = sent.length;

    await turn(id, `the key is ${SECRET} ok`);
    assert.match(await stored(id), /the key is \[secret POINTS_TOKEN\] ok/);
    assert.doesNotMatch(await stored(id), new RegExp(SECRET));

    const entries = await (await app.conversation(id)).entries({}, 50, undefined, context);
    const user = entries.items.find((entry) => entry.kind === "pi.user")!;
    const { id: fork } = await app.commands.resend(id, me, { entryId: Number(user.id), text: `now ${SECRET} again` });

    await until(async () => (await stored(fork)).includes("echo: now"), "the fork's answer");
    assert.match(await stored(fork), /now \[secret POINTS_TOKEN\] again/);
    assert.doesNotMatch(await stored(fork), new RegExp(SECRET));
    assert.ok(sent.slice(before).every((request) => !request.includes(SECRET)));
});

test("a ! command that holds a hidden value is refused, so it is not stored as typed", async () => {
    const id = await newSession(app);

    await assert.rejects(app.shell.start(id, owner(app), { command: `echo ${SECRET}` }), /holds a hidden value/);
});
