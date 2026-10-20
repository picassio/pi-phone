// Pi and the app's settings (extensions/settings.ts, settings-registry.ts): settings lists them with their values;
// setting_change asks on the app's card (the value now → the new one) and applies through the app's own method only on
// a yes; a no leaves it; a setting of one session needs its target; a guest is refused owner settings before any card;
// app_action asks too.
import { type App, cleanUp, context, lastText, modelTexts, newSession, openApp, owner, scriptedModel, until, work } from "./helpers.ts";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { reachesIntoApp } from "../src/server/extensions/settings.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

let sessionTarget = "";
const calls: Record<string, [string, Record<string, unknown>]> = {
    "list models": ["settings", { area: "models" }],
    "list everything": ["settings", {}],
    "limit sends": ["setting_change", { id: "sessions.sendLimit", value: "40", reason: "Keep sessions from flooding each other" }],
    "limit spend": ["setting_change", { id: "spend.sessionLimit", value: "12.50", reason: "A budget for this work" }],
    "limit spend here": ["setting_change", { id: "spend.sessionLimit", value: "12.50", target: "__SESSION__", reason: "A budget for this work" }],
    "refresh models": ["app_action", { id: "models.refresh", reason: "A new model came out" }],
    "no such": ["setting_change", { id: "nope.nothing", value: "1", reason: "x" }],
    "list secrets": ["settings", { area: "secrets" }],
    "ask for it": ["setting_change", { id: "secrets.ask", value: "on", target: "TEST_KEY", reason: "Make every use wait for you" }],
    "drop it": ["app_action", { id: "secrets.delete", args: { name: "TEST_KEY" }, reason: "Not needed any more" }],
    "make Vic a viewer": ["setting_change", { id: "people.role", value: "viewer", target: "Vic", reason: "Only to read" }],
    "billing off": ["setting_change", { id: "phone.claudeCodeBilling", value: "off", reason: "Testing plain OAuth" }],
    "set instructions": ["setting_change", { id: "sessions.instructions", value: "Answer in Vietnamese.", target: "__SESSION__", reason: "The owner asked" }],
    "back up": ["app_action", { id: "backup.make", args: { folder: "__WORK__" }, reason: "Before the upgrade" }],
};
const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);

    for (const [ask, [tool, args]] of Object.entries(calls)) {
        if (role === "user" && text.endsWith(ask)) {
            return fauxAssistantMessage([fauxToolCall(tool, JSON.parse(JSON.stringify(args).replaceAll("__SESSION__", sessionTarget).replaceAll("__WORK__", work)) as never)], { stopReason: "toolUse" });
        }
    }

    return fauxAssistantMessage([fauxText(role === "toolResult" ? `told: ${text.slice(0, 20000)}` : "ok")]);
};
let app: App;

before(async () => {
    app = await openApp(scriptedModel(route));
});

after(async () => {
    await app?.close();
    cleanUp();
});

/** One turn as `user`; with `answer`, the card it waits on is answered so. */
async function turn(id: number, text: string, answer?: boolean, user = owner(app)): Promise<{ said: string; card?: { subject: string; reason?: string } }> {
    const { submissionId } = await app.commands.submit(id as never, user, { text, requestId: crypto.randomUUID() });
    let card: { subject: string; reason?: string } | undefined;

    if (answer !== undefined) {
        await until(() => app.approvals.forConversation(id as never).length > 0, "the card");
        const asked = app.approvals.forConversation(id as never)[0]!;

        card = { subject: asked.subject, ...(asked.reason === undefined ? {} : { reason: asked.reason }) };
        await app.answerApproval(asked.id, answer, owner(app));
    }

    await (await app.harness.submission(submissionId, context))!.wait(context);
    await app.harness.waitForIdle(context);

    return { said: (await modelTexts(app, id as never)).at(-1)!, ...(card === undefined ? {} : { card }) };
}

test("settings lists the app's settings with their values, by area, and the actions", async () => {
    const id = await newSession(app);
    const models = (await turn(id, "list models")).said;

    assert.match(models, /models\.default: none \(the last model picked\)/);
    assert.match(models, /models\.subagents: none/);
    assert.match(models, /models\.refresh: Refresh the model lists/);
    assert.doesNotMatch(models, /wiki\./, "only the area asked");

    const all = (await turn(id, "list everything")).said;

    assert.match(all, /approvals\.rule: anyone \[anyone \| others\]/);
    assert.match(all, /spend\.sessionLimit: \(per session: give a target\)/);
    assert.match(all, /Areas: .*models.*spend.*extensions/);
});

test("setting_change asks on the app's card, old → new, and changes it only on a yes", async () => {
    const id = await newSession(app);
    const no = await turn(id, "limit sends", false);

    assert.equal(no.card?.subject, "Change Messages a session may send other sessions, an hour: 30 → 40");
    assert.equal(no.card?.reason, "Keep sessions from flooding each other");
    assert.match(no.said, /said no: sessions\.sendLimit stays 30/);
    assert.equal(app.config.sessionSendLimit, 30);

    const yes = await turn(id, "limit sends", true);

    assert.match(yes.said, /Changed sessions\.sendLimit: 30 → 40/);
    assert.equal(app.config.sessionSendLimit, 40);

    assert.match((await turn(id, "no such")).said, /There is no setting nope\.nothing/);
});

test("a setting of one session needs its target; with it, the session's own value changes", async () => {
    const id = await newSession(app);

    sessionTarget = String(id);
    assert.match((await turn(id, "limit spend")).said, /setting of one session: give its number as the target/);

    const yes = await turn(id, "limit spend here", true);

    assert.equal(yes.card?.subject, `Change Spend limit of one session (session ${String(id)}): none → 12.50`);
    assert.match(yes.said, /Changed spend\.sessionLimit \(\d+\): none → \$12\.50/);
    assert.equal(app.sessionMeta(id as never)?.budget, 12.5);
});

test("a guest is refused owner settings before any card; app_action asks on a card too", async () => {
    const id = await newSession(app);
    const guest = app.config.addUser("Gina", "guest");
    const refused = await turn(id, "limit sends", undefined, guest.user);

    assert.match(refused.said, /only the owner changes this/);
    assert.equal(app.approvals.forConversation(id as never).length, 0, "nobody was asked");

    const action = await turn(id, "refresh models", false);

    assert.equal(action.card?.subject, "Refresh every provider's model list");
    assert.match(action.said, /said no: nothing was done/);
});

test("actions and targeted settings: a secret's flag by name, deleting it, and a backup into a folder", async () => {
    const id = await newSession(app);

    app.secrets.set("TEST_KEY", { value: "a-test-value-123", description: "For the test" });

    const listed = (await turn(id, "list secrets")).said;

    assert.match(listed, /secrets\.ask: \(per secret: give a target\)/);
    assert.match(listed, /Targets:\\n- secret: TEST_KEY/);
    assert.match(listed, /secrets\.delete: Delete a secret/);

    const ask = await turn(id, "ask for it", true);

    assert.equal(ask.card?.subject, "Change A secret's uses wait for a person (secret TEST_KEY): off → on");
    assert.equal(app.secrets.list().find((each) => each.name === "TEST_KEY")?.ask, true);

    const drop = await turn(id, "drop it", true);

    assert.equal(drop.card?.subject, "Delete the secret TEST_KEY, for good");
    assert.match(drop.said, /Deleted TEST_KEY/);
    assert.equal(app.secrets.list().some((each) => each.name === "TEST_KEY"), false);

    mkdirSync(work, { recursive: true });

    const backup = await turn(id, "back up", true);

    assert.match(backup.said, /Saved the backup as /);
    assert.ok(readdirSync(work).some((name) => name.endsWith(".tar.gz") && existsSync(`${work}/${name}`)), "the backup is in the folder");
});

test("people, phone, and one session's settings, each through the app's own method", async () => {
    const id = await newSession(app);

    sessionTarget = String(id);
    app.config.addUser("Vic", "guest");

    const role = await turn(id, "make Vic a viewer", true);

    assert.equal(role.card?.subject, "Change What an invited person may do (person Vic): guest → viewer");
    assert.equal(app.config.users.find((user) => user.name === "Vic")?.role, "viewer");

    const billing = await turn(id, "billing off", true);

    assert.equal(billing.card?.subject, "Change Bill Anthropic sign-ins as Claude Code: on → off");
    assert.equal(app.phoneSettings.current().claudeCodeBilling.enabled, false);
    assert.match(readFileSync(app.phoneSettings.path, "utf8"), /"enabled": false/);

    const instructions = await turn(id, "set instructions", true);

    assert.match(instructions.said, /Changed sessions\.instructions \(\d+\): none → Answer in Vietnamese\./);
    assert.equal((await app.agentState(id as never))?.instructions, "Answer in Vietnamese.");
});

test("the guard: commands that reach into the app are refused; ordinary ones are not", () => {
    for (const command of [
        `curl -s -H "Authorization: Bearer $T" http://127.0.0.1:8787/api/machines/x/tools`,
        "T=$(node -e 'console.log(require(process.env.HOME+\"/.pi-pocket/config.json\").ownerToken)')",
        "curl localhost:8787/login?token=abc",
        `node -e 'http.request({ socketPath: "\\0webview_devtools_remote_123" })'`,
    ]) {
        assert.equal(reachesIntoApp(command, "http://127.0.0.1:8787"), true, command);
    }

    for (const command of ["curl -s https://example.com/api/x", "grep -rn ownerToken src/server", "curl localhost:5173/api/health", "git status"]) {
        assert.equal(reachesIntoApp(command, "http://127.0.0.1:8787"), false, command);
    }
});
