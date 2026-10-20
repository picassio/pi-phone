// Pi and the app's settings (extensions/settings.ts, settings-registry.ts): settings lists them with their values;
// setting_change asks on the app's card (the value now → the new one) and applies through the app's own method only on
// a yes; a no leaves it; a setting of one session needs its target; a guest is refused owner settings before any card;
// app_action asks too.
import { type App, cleanUp, context, lastText, modelTexts, newSession, openApp, owner, scriptedModel, until } from "./helpers.ts";
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
};
const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);

    for (const [ask, [tool, args]] of Object.entries(calls)) {
        if (role === "user" && text.endsWith(ask)) {
            return fauxAssistantMessage([fauxToolCall(tool, JSON.parse(JSON.stringify(args).replaceAll("__SESSION__", sessionTarget)) as never)], { stopReason: "toolUse" });
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
