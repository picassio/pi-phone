// Pi and signed-in devices (extensions/devices.ts): it lists them as the person it works for sees them, and signs one
// out only after a yes on the card; a no leaves it signed in.
import { type App, cleanUp, context, lastText, modelTexts, newSession, openApp, owner, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

let target = "";
const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);

    if (role === "user" && text.endsWith("list devices")) {
        return fauxAssistantMessage([fauxToolCall("devices", {})], { stopReason: "toolUse" });
    }

    if (role === "user" && text.endsWith("sign it out")) {
        return fauxAssistantMessage([fauxToolCall("device_sign_out", { id: target })], { stopReason: "toolUse" });
    }

    return fauxAssistantMessage([fauxText(role === "toolResult" ? `told: ${text.slice(0, 800)}` : "ok")]);
};
let app: App;

before(async () => {
    app = await openApp(scriptedModel(route));
});

after(async () => {
    await app?.close();
    cleanUp();
});

const turn = async (id: number, text: string, answer?: boolean) => {
    const { submissionId } = await app.commands.submit(id as never, owner(app), { text, requestId: crypto.randomUUID() });

    if (answer !== undefined) {
        await until(() => app.approvals.forConversation(id as never).some((each) => each.tool === "device_sign_out"), "the card");
        const card = app.approvals.forConversation(id as never).find((each) => each.tool === "device_sign_out")!;

        assert.match(card.subject, /^Sign out Firefox on Linux \(/);
        await app.answerApproval(card.id, answer, owner(app));
    }

    await (await app.harness.submission(submissionId, context))!.wait(context);
    await app.harness.waitForIdle(context);

    return (await modelTexts(app, id as never)).at(-1)!;
};

test("Pi lists the devices, and signs one out only when the person says yes", async () => {
    const id = await newSession(app);
    const { device } = app.config.addDevice(owner(app).id, "Firefox on Linux", "100.64.1.2");

    target = device.id;
    const listed = await turn(id, "list devices");

    assert.match(listed, new RegExp(`${device.id} · .*\\(owner\\) · Firefox on Linux · 100\\.64\\.1\\.2 · last active`));

    assert.match(await turn(id, "sign it out", false), /said no: Firefox on Linux stays signed in/);
    assert.ok(app.config.deviceById(device.id), "still signed in");

    assert.match(await turn(id, "sign it out", true), /Signed out Firefox on Linux/);
    assert.equal(app.config.deviceById(device.id), undefined);
});
