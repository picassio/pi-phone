// The setting browser.machineMode (PP-274): how Pi's browser runs on a machine, headless (the default) or as a window on
// its screen. Pi changes it with setting_change, on the owner's card, for one machine; it is kept with the machine; a
// value it does not take, a team machine and macOS are refused; Settings › Machines sends the same change.
import { type App, cleanUp, context, lastText, modelTexts, newSession, openApp, owner, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { appSettings } from "../src/server/settings-registry.ts";

const calls: Record<string, [string, Record<string, unknown>]> = {
    "list browser settings": ["settings", { area: "browser" }],
    "show a window": ["setting_change", { id: "browser.machineMode", value: "window", target: "sandbox", reason: "To watch Pi browse on its screen" }],
    "make it purple": ["setting_change", { id: "browser.machineMode", value: "purple", target: "sandbox", reason: "x" }],
};
const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);

    for (const [ask, [tool, args]] of Object.entries(calls)) {
        if (role === "user" && text.endsWith(ask)) {
            return fauxAssistantMessage([fauxToolCall(tool, args as never)], { stopReason: "toolUse" });
        }
    }

    return fauxAssistantMessage([fauxText(role === "toolResult" ? `told: ${text}` : "ok")]);
};
let app: App;
let machineId = "";

before(async () => {
    app = await openApp(scriptedModel(route), join(root, "browser-machine-mode"));
    const key = await app.sshKeys.generate("mode-key");

    machineId = app.machines.add({ name: "sandbox", address: "ubuntu@sandbox", keyId: key.id }).id;
});

after(async () => {
    await app?.close();
    cleanUp();
});

async function turn(id: number, text: string, answer?: boolean) {
    const { submissionId } = await app.commands.submit(id as never, owner(app), { text, requestId: crypto.randomUUID() });
    let card: ReturnType<typeof app.approvals.all>[number] | undefined;

    if (answer !== undefined) {
        await until(() => app.approvals.forConversation(id as never).length > 0, "the card");
        card = app.approvals.forConversation(id as never)[0]!;
        await app.answerApproval(card.id, answer, owner(app));
    }

    await (await app.harness.submission(submissionId, context))!.wait(context);

    return { said: (await modelTexts(app, id as never)).at(-1)!, card };
}

test("browser.machineMode is headless by default, changed for one machine on the owner's card, kept with it; other values refused", async () => {
    const id = await newSession(app);
    const listed = (await turn(id, "list browser settings")).said;

    assert.match(listed, /browser\.machineMode/);
    assert.match(listed, /headless \(the default: no window\) or window/);
    assert.equal(await appSettings(app).settings.find((each) => each.id === "browser.machineMode")!.read("sandbox"), "headless");

    const denied = await turn(id, "show a window", false);

    assert.match(denied.card?.subject ?? "", /headless → window/);
    assert.equal(app.machines.get(machineId).browserMode, undefined, "a no changes nothing");

    await turn(id, "show a window", true);
    assert.equal(app.machines.get(machineId).browserMode, "window");
    assert.equal(app.browserMachines().find((each) => each.id === machineId)?.browserMode, "window");

    assert.match((await turn(id, "make it purple", true)).said, /headless or window/);
    assert.equal(app.machines.get(machineId).browserMode, "window");

    // Settings › Machines and the app's method: back to headless, which is not written down.
    await app.setMachineBrowserMode(owner(app), "sandbox", "headless");
    assert.equal(app.machines.get(machineId).browserMode, undefined);
    await assert.rejects(app.machines.edit(machineId, { browserMode: "sometimes" }), /browserMode is headless or window/);
});
