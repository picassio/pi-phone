// A role's policy in a person's pi-phone (src/server/policy.ts, PP-22), as the server edition's gateway sends it: Pi's
// browser, web access and machines are turned off and kept off without their permissions; extensions can't be turned on
// again without extensions.manage; a refused tool says so with the role's name; the app's routes for the features left
// out are refused; only allowed models are offered and used (a session that picked another before is held to it); and
// the role's monthly spend cap stops new messages.
import { type App, cleanUp, context, newSession, openApp, owner, recordCost, root, say, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { FauxResponseStep } from "@earendil-works/pi-ai";

let app: App;
let lastResult = "";

const route: FauxResponseStep = (ctx) => {
    const messages = (ctx as { messages: { role: string; content: unknown }[] }).messages;
    const last = messages.at(-1)!;

    if (last.role === "toolResult") {
        lastResult = JSON.stringify(last.content);

        return fauxAssistantMessage([fauxText("done")]);
    }

    return fauxAssistantMessage([fauxToolCall("secrets_list", {})], { stopReason: "toolUse" });
};

before(async () => {
    app = await openApp(scriptedModel(route), join(root, "policy-data"));
});

after(async () => {
    await app?.close();
    cleanUp();
});

const MEMBER = { permissions: ["pi.use", "terminal.use", "providers.signin", "settings.change"], models: ["faux/faux-1"], spendLimit: 5, role: "Member" };

test("a role's policy: features off and kept off, tools and routes refused, models allowed, a monthly cap", async () => {
    const me = owner(app);
    const id = await newSession(app);
    const other = await newSession(app);

    // A session that picked a model the role leaves out, before the policy came.
    await app.commands.configure(other, me, { model: { provider: "faux", modelId: "faux-2" } });

    assert.equal(app.policy.get(), undefined, "no policy: everything allowed");
    assert.equal(app.policy.allows("browser.use"), true);

    await app.applyPolicy(me, MEMBER);

    // Pi's browser, web access and machines: off, so their tools are absent; not turned on again.
    for (const file of ["browser.ts", "web.ts", "machines.ts"]) {
        assert.equal(app.loader.list().find((each) => each.file === file)?.enabled, false, file);
    }

    await assert.rejects(app.setExtensionEnabled(me, "browser.ts", true), /Member does not include turning extensions on and off/);

    // A refused tool, with the role's name.
    await say(app, id, "list my secrets");
    assert.match(lastResult, /Member does not include secrets: ask your team's owner/);

    // The app's routes for what the role leaves out.
    assert.match(app.policy.routeRefusal("secrets", "GET") ?? "", /does not include secrets/);
    assert.match(app.policy.routeRefusal("machines", "GET") ?? "", /does not include machines/);
    assert.match(app.policy.routeRefusal("extensions", "POST") ?? "", /extensions/);
    assert.equal(app.policy.routeRefusal("extensions", "GET"), undefined, "seeing them is fine");
    assert.equal(app.policy.routeRefusal("providers", "POST"), undefined, "signing in is the role's");
    assert.equal(app.policy.routeRefusal("sessions", "POST"), undefined);

    // Models: only the allowed ones, however asked for.
    assert.deepEqual((await app.modelList()).map((model) => model.id), ["faux-1"]);
    await assert.rejects(app.commands.configure(id, me, { model: { provider: "faux", modelId: "faux-2" } }), /Member does not include faux\/faux-2/);
    await assert.rejects(app.commands.submit(other, me, { text: "hi", requestId: crypto.randomUUID() }), /Member does not include faux\/faux-2/);

    // The monthly cap: $5 spent this month stops new messages. What went to the team server's accounts doesn't count:
    // the team server holds that to the role's team spend limit (PP-73).
    await recordCost(app, id, 9, "faux~team-work/faux-1");
    await until(() => app.spend.personSpent(me.id) >= 9, "the team spend counted to the owner", 15_000);
    assert.doesNotThrow(() => app.spend.check(me, id), "team spend is not the role's own cap");
    await recordCost(app, id, 5.5);
    // Spend adds it to the person a moment later, as it stores counts.
    await until(() => app.spend.personSpent(me.id) >= 14.5, "the spend counted to the owner", 15_000);
    await assert.rejects(app.commands.submit(id, me, { text: "more", requestId: crypto.randomUUID() }), /monthly spend limit is reached/);

    // A role that allows them again: they come back.
    await app.applyPolicy(me, { ...MEMBER, permissions: [...MEMBER.permissions, "browser.use", "web.search", "machines.use", "secrets.use", "extensions.manage"], spendLimit: null });

    for (const file of ["browser.ts", "web.ts", "machines.ts"]) {
        assert.equal(app.loader.list().find((each) => each.file === file)?.enabled, true, file);
    }

    void context;
});
