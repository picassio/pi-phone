// The owner's secrets: Pi uses them in bash by name and never sees their values. The store keeps values to itself, a
// command that names a secret runs with it, any output that holds a value shows [secret NAME], a person's pasted value
// is replaced before it is sent, and Pi asks for one through a hidden field, never the chat.
import { type App, cleanUp, context, lastText, modelTexts, newSession, openApp, owner, root, scriptedModel, until, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { namesIn, Secrets } from "../src/server/secrets.ts";
import { browserSecretNames } from "../src/server/extensions/secrets.ts";

const VALUE = "s3cr3t-value-0123456789";
const notes = join(work, "secret-notes.txt");
let told = "";

const calls: Record<string, [string, Record<string, unknown>]> = {
    "use the token": ["bash", { command: 'printf \'%s\' "$TEST_TOKEN" | wc -c; echo "token is $TEST_TOKEN"; echo "$TEST_TOKEN" | base64' }],
    "use the other one": ["bash", { command: 'echo "$ELSEWHERE_TOKEN"' }],
    // Pi's browser typing a secret by name (PP-32): the same folder rule, before the browser is touched.
    "type the other one": ["browser_type", { index: 2, secret: "ELSEWHERE_TOKEN" }],
    "read the notes": ["read", { path: notes }],
    "ask for a key": ["secret_request", { name: "NEW_KEY", description: "The test service's key" }],
    "save a key": ["secret_save", { name: "MADE_KEY", command: "printf 'generated-%s-%s' abcdefgh 123", description: "made by a command" }],
    "list them": ["secrets_list", {}],
};

const route: FauxResponseStep = (request) => {
    for (const message of (request as { messages: { role: string; sections?: Record<string, string | null> }[] }).messages) {
        if (message.role === "system" && message.sections?.secrets) {
            told = message.sections.secrets;
        }
    }

    const { role, text } = lastText(request as never);

    for (const [ask, [tool, args]] of Object.entries(calls)) {
        if (role === "user" && text.endsWith(ask)) {
            return fauxAssistantMessage([fauxToolCall(tool, args as never)], { stopReason: "toolUse" });
        }
    }

    return fauxAssistantMessage([fauxText(role === "toolResult" ? `tool said: ${text}` : `heard: ${text}`)]);
};

let app: App;

before(async () => {
    app = await openApp(scriptedModel(route));
    app.secrets.set("TEST_TOKEN", { value: VALUE, description: "the test service" });
    app.secrets.set("ELSEWHERE_TOKEN", { value: "elsewhere-value-987654", folders: [join(root, "elsewhere")] });
});

after(async () => {
    await app?.close();
    cleanUp();
});

async function turn(id: Parameters<App["commands"]["submit"]>[0], text: string): Promise<string> {
    const { submissionId } = await app.commands.submit(id, owner(app), { text, requestId: crypto.randomUUID() });

    await (await app.harness.submission(submissionId, context))!.wait(context);
    await app.harness.waitForIdle(context);

    return (await modelTexts(app, id)).at(-1)!;
}

test("the store keeps values to itself, in a file only the app reads, and checks what it is given", () => {
    const dir = mkdtempSync(join(root, "secrets-"));
    const secrets = new Secrets(dir);

    secrets.set("API_KEY", { value: "abcdefgh12345", description: "x", folders: ["/work/a/"], machines: false });

    assert.deepEqual(Object.keys(secrets.get("API_KEY")!).sort(), ["ask", "createdAt", "description", "folders", "machines", "name", "updatedAt"]);
    assert.ok(!JSON.stringify(secrets.list()).includes("abcdefgh12345"));
    assert.equal(statSync(join(dir, "secrets.json")).mode & 0o777, 0o600);
    assert.equal(new Secrets(dir).environment(["API_KEY"], "/work/a/b")["API_KEY"], "abcdefgh12345", "it reloads");

    // Where it may be used: the folder and below, on the phone alone.
    assert.ok(secrets.allowed("API_KEY", "/work/a"));
    assert.ok(secrets.allowed("API_KEY", "/work/a/b"));
    assert.ok(!secrets.allowed("API_KEY", "/work/ab"));
    assert.ok(!secrets.allowed("API_KEY", "machine:m1:/work/a"));
    assert.deepEqual(secrets.environment(["API_KEY", "OTHER"], "/elsewhere"), {});

    assert.throws(() => secrets.set("lower", { value: "abcdefgh12345" }), /environment variable/);
    assert.throws(() => secrets.set("SHORT", { value: "abc" }), /shorter than 8/);
    assert.throws(() => secrets.set("NO_VALUE", {}), /needs a value/);

    // A change without a value keeps it.
    secrets.set("API_KEY", { description: "changed" });
    assert.equal(secrets.environment(["API_KEY"], "/work/a")["API_KEY"], "abcdefgh12345");
    assert.deepEqual(namesIn('echo "$API_KEY" ${OTHER} $3 \\$NOPE'), ["API_KEY", "OTHER", "NOPE"]);
});

test("output with a value, raw, base64, or URL-encoded, shows the name instead, even split across chunks", async () => {
    const secrets = new Secrets(mkdtempSync(join(root, "secrets-")));

    secrets.set("API_KEY", { value: "hunter2-hunter2-hunter2" });

    assert.equal(secrets.redact("a hunter2-hunter2-hunter2 b"), "a [secret API_KEY] b");
    assert.equal(secrets.redact(Buffer.from("hunter2-hunter2-hunter2").toString("base64")), "[secret API_KEY]");
    assert.equal(secrets.redact(encodeURIComponent("hunter2-hunter2-hunter2")), "[secret API_KEY]");

    // An environment whose command prints the value in three pieces.
    const pieces = ["start hunt", "er2-hunter2-hun", "ter2 end\n"];
    const env = {
        cwd: "/",
        exec: async (_command: unknown, options: { onOutput?: (text: string, context: unknown, info: { stream: "stdout" }) => void }) => {
            for (const piece of pieces) {
                options.onOutput?.(piece, context, { stream: "stdout" });
            }

            return { ok: true, value: { exitCode: 0 } };
        },
    } as unknown as ExecutionEnv;
    let seen = "";

    await secrets.guard(env).exec("x", { onOutput: (text) => (seen += text) }, context);

    assert.equal(seen, "start [secret API_KEY] end\n");
    assert.equal(secrets.guard(env), secrets.guard(env), "one guard per environment");
});

test("Pi uses a secret in bash by name: the command keeps the name, the output and transcript never show the value", async () => {
    const id = await newSession(app);
    const answer = await turn(id, "use the token");

    assert.match(answer, /\b23\b/, "the command had the value: 23 characters");
    assert.match(answer, /token is \[secret TEST_TOKEN\]/);
    assert.match(answer, /\[secret TEST_TOKEN\]/);

    const transcript = (await modelTexts(app, id)).join("\n");

    assert.ok(!transcript.includes(VALUE), "no value in what the model has");
    assert.ok(!transcript.includes(Buffer.from(`${VALUE}\n`).toString("base64").slice(0, 20)), "nor its base64");
    assert.match(transcript, /\$TEST_TOKEN/, "the call keeps the name");
    assert.ok(app.secrets.get("TEST_TOKEN")!.usedAt !== undefined, "its use is noted");
    assert.match(told, /\$TEST_TOKEN \(the test service\)/, "the prompt names what it may use");
    assert.doesNotMatch(told, /ELSEWHERE_TOKEN/, "and not what it may not");
});

test("a secret is refused outside its folders, and other tools' results are redacted too", async () => {
    const id = await newSession(app);

    assert.match(await turn(id, "use the other one"), /may not be used in this folder/);
    assert.match(await turn(id, "type the other one"), /\$ELSEWHERE_TOKEN may not be used in this folder/);

    mkdirSync(work, { recursive: true });
    writeFileSync(notes, `the key: ${VALUE}\n`);
    const read = await turn(id, "read the notes");

    assert.match(read, /the key: \[secret TEST_TOKEN\]/);
    assert.ok(!(await modelTexts(app, id)).join("\n").includes(VALUE));
    assert.match(await turn(id, "list them"), /\$TEST_TOKEN — the test service/);
});

test("a value someone pastes into a message is replaced by its name before it is sent", async () => {
    const id = await newSession(app);
    const heard = await turn(id, `here it is ${VALUE}`);

    assert.match(heard, /here it is \[secret TEST_TOKEN\]/);
    assert.ok(!(await modelTexts(app, id)).join("\n").includes(VALUE));
});

test("Pi asks for a secret through a hidden field: the value goes to the store, never the chat", async () => {
    const id = await newSession(app);
    const { submissionId } = await app.commands.submit(id, owner(app), { text: "ask for a key", requestId: crypto.randomUUID() });

    await until(() => app.approvals.forConversation(id).some((each) => each.form?.type === "secret"), "the request");
    const asked = app.approvals.forConversation(id).find((each) => each.form?.type === "secret")!;

    assert.equal(asked.form?.type === "secret" && asked.form.name, "NEW_KEY");
    await assert.rejects(app.answerApproval(asked.id, true, owner(app)), /type it into the card/);
    await assert.rejects(app.answerSecretRequest(asked.id, "short", owner(app)), /shorter than 8/);
    assert.ok(await app.answerSecretRequest(asked.id, "new-key-value-424242", owner(app)));

    await (await app.harness.submission(submissionId, context))!.wait(context);
    await app.harness.waitForIdle(context);
    const transcript = (await modelTexts(app, id)).join("\n");

    assert.match(transcript, /Saved NEW_KEY\. Use it in bash as \$NEW_KEY/);
    assert.ok(!transcript.includes("new-key-value-424242"));
    assert.equal(app.secrets.get("NEW_KEY")?.description, "The test service's key");
    assert.deepEqual(app.secrets.environment(["NEW_KEY"], work), { NEW_KEY: "new-key-value-424242" });
});

test("secret_save keeps a command's output as a secret without showing it", async () => {
    const id = await newSession(app);
    const answer = await turn(id, "save a key");

    assert.match(answer, /Saved MADE_KEY \(22 characters\)/);
    assert.ok(!(await modelTexts(app, id)).join("\n").includes("generated-abcdefgh-123"));
    assert.deepEqual(app.secrets.environment(["MADE_KEY"], work), { MADE_KEY: "generated-abcdefgh-123" });
    assert.match(readFileSync(join(root, "data", "secrets.json"), "utf8"), /generated-abcdefgh-123/, "in the store's file");
});

test("Pi's browser names the secrets it types, for the folder and ask-first rules (PP-32)", async () => {
    assert.deepEqual(browserSecretNames("browser_type", { index: 3, secret: "LOGIN" }), { names: ["LOGIN"], subject: "Type [secret LOGIN] into [3]" });
    assert.equal(browserSecretNames("browser_type", { index: 3, text: "hello" }), undefined);
    assert.deepEqual(browserSecretNames("browser_run", { goal: "Sign in", values: { user: "tuan", password: { secret: "LOGIN" } } })?.names, ["LOGIN"]);
    assert.equal(browserSecretNames("browser_run", { goal: "Search", values: { q: "lamp" } }), undefined);
    assert.equal(browserSecretNames("bash", { command: "echo $LOGIN" }), undefined);
});
