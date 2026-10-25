// Pi controls this phone (PP-141), against a fake phone answering the phone-control channel as the app's service does
// (`test/support/fake-phone.ts`): the outline of real-looking screens; one card (only the owner approves) starts a
// session for the apps it names and the home screen; another app, pi-phone itself, a bank, a password manager and an
// app on the owner's Never list are refused (on the server, and each scoped request carries what the service checks);
// a secret is typed unseen; Stop and the time limit end it; a restart keeps it; guests, roles without phone.control,
// plan mode and the team server are refused.
import { type App, cleanUp, context, lastText, modelTexts, newSession, openApp, owner, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { User } from "../src/server/config.ts";
import { blockedInPlanMode } from "../src/server/extensions/plan.ts";
import { browserSecretNames } from "../src/server/extensions/secrets.ts";
import { createHandler } from "../src/server/http.ts";
import { PhoneControl } from "../src/server/phone-control.ts";
import { renderOutline } from "../src/server/phone-outline.ts";
import { FakePhone, GRAB, node, SETTINGS } from "./support/fake-phone.ts";

/** What Pi calls, by the end of the owner's message: a tool and its arguments. */
let calls: Record<string, [string, Record<string, unknown>]> = {};

const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);

    for (const [ask, [tool, args]] of Object.entries(calls)) {
        if (role === "user" && text.endsWith(ask)) {
            return fauxAssistantMessage([fauxToolCall(tool, args as never)], { stopReason: "toolUse" });
        }
    }

    return fauxAssistantMessage([fauxText(role === "toolResult" ? `told: ${text}` : "ok")]);
};

const dataDir = join(root, "phone-data");
let shift = 0;
const clock = () => Date.now() + shift;
let app: App;
const phone = new FakePhone();
const VALUE = "s3cret-pin-4471-value";

before(async () => {
    app = await openApp(scriptedModel(route), dataDir, clock);
    phone.attach(app.phoneControl.requests);
    // The service polls: the phone is there.
    await until(() => app.phoneControl.present(), "the phone polls");
    app.secrets.set("GRAB_PASSWORD", { value: VALUE, description: "Grab sign-in" });
});

after(async () => {
    phone.detach();
    await app?.close();
    cleanUp();
});

/** One turn of `who` (the owner by default); with `answer`, the card it waits on is answered so (by `by`) and returned. */
async function turn(id: number, text: string, options: { answer?: boolean; by?: User; who?: User } = {}) {
    const { submissionId } = await app.commands.submit(id as never, options.who ?? owner(app), { text, requestId: crypto.randomUUID() });
    let card: ReturnType<typeof app.approvals.all>[number] | undefined;

    if (options.answer !== undefined) {
        await until(() => app.approvals.forConversation(id as never).length > 0, "the card");
        card = app.approvals.forConversation(id as never)[0]!;
        await app.answerApproval(card.id, options.answer, options.by ?? owner(app));
    }

    await (await app.harness.submission(submissionId, context))!.wait(context);
    await app.harness.waitForIdle(context);

    return { said: (await modelTexts(app, id as never)).at(-1)!, card };
}

/** Pi calls `tool` with `args` for this message. */
async function call(id: number, tool: string, args: Record<string, unknown>, options: Parameters<typeof turn>[2] = {}) {
    const ask = `ask ${crypto.randomUUID()}`;

    calls = { [ask]: [tool, args] };

    return turn(id, ask, options);
}

test("the outline of a real-looking Settings screen: regions, the list and its rows, toggles, no skeleton or dividers", () => {
    const { text, entries } = renderOutline({ display: { width: 1080, height: 2400 }, foreground: "com.android.settings", keyboard: false, windows: [{ id: 7, type: "application", package: "com.android.settings", layer: 1, active: true, root: SETTINGS }] }, "Settings");
    const lines = text.split("\n");

    assert.equal(lines[0], "Settings (com.android.settings) · screen 1080x2400 px");
    assert.ok(lines.includes("[NavBar]"), text);
    assert.match(text, /\[1\] TextView "Settings" \(48,170 552x90\)/);
    // The list, with its rows in view and scrollable, and every row's words under it.
    assert.match(text, /\[\d+\] List "" :recycler_view: \(0,300 1080x1974\) list of 10 rows in view scrollable/);
    assert.match(text, /Button "Search settings" \(40,310 1000x140\)/, "a clickable bar around one text is one button");

    for (const title of ["Network & internet", "Connected devices", "Apps", "Notifications", "Battery", "Storage", "Sound & vibration"]) {
        assert.ok(entries.some((entry) => entry.role === "TextView" && entry.label === title), title);
    }

    assert.match(text, /Switch "" :switch_widget: \(900,1520 120x100\) on/);
    assert.doesNotMatch(text, /FrameLayout|main_content|\(0,2070 1080x2\)/, "no skeleton, no divider");
    // Numbered 1 to n, in the order printed; each knows its node again (window and child indices).
    assert.deepEqual(entries.map((entry) => entry.index), entries.map((_, at) => at + 1));
    const battery = entries.find((entry) => entry.label === "Battery")!;

    assert.deepEqual(battery.ref, { w: 7, p: [0, 1, 5, 1, 0] });
});

test("the outline of an app: a field's hint, a password field's value never shown, a folded button, the keyboard, a popup alone", () => {
    const screen = { display: { width: 1080, height: 2400 }, foreground: "com.grabtaxi.passenger", keyboard: true, windows: [{ id: 3, type: "application", package: "com.grabtaxi.passenger", layer: 1, active: true, root: GRAB }] };
    const { text } = renderOutline(screen, "Grab");

    assert.match(text.split("\n")[0]!, /keyboard up$/);
    assert.match(text, /TextField "" :search: \(40,160 1000x120\) hint "Search for food"/, "the hint shown as text is not a value");
    assert.match(text, /TextField "" :password: .* password \(hidden\)/);
    assert.ok(!text.includes("hunter2"), "a password's value never shows");
    assert.match(text, /Button "Checkout" \(40,2200 1000x140\)/);
    assert.match(text, /Button "Pho Thin"/);

    // A menu over the app: only it is listed.
    const menu = node("android.widget.ListView", [600, 200, 1040, 600], {}, [
        node("android.widget.TextView", [600, 200, 1040, 400], { t: "Share", f: 1 }),
        node("android.widget.TextView", [600, 400, 1040, 600], { t: "Report", f: 1 }),
    ]);
    const popped = renderOutline({ ...screen, windows: [...screen.windows, { id: 4, type: "application", package: "com.grabtaxi.passenger", layer: 2, active: false, root: menu }] }, "Grab");

    assert.match(popped.text, /popup or dialog is open over the app/);
    assert.match(popped.text, /TextView "Share"/);
    assert.doesNotMatch(popped.text, /Checkout/);
});

test("one card for the apps, only the owner approves; then only those apps and the home screen, with what the service checks", async () => {
    const id = await newSession(app);
    const guest = app.config.addUser("Lan", "guest").user;

    try {
        // Refused before any card: the phone's own pi-phone, a bank, a password manager.
        for (const [name, why] of [["pi", /pi-phone itself/], ["Vietcombank", /banking or payment app/], ["com.x8bit.bitwarden", /password manager/]] as const) {
            const { said } = await call(id, "phone_control", { action: "start", apps: [name] });

            assert.match(said, why, name);
        }

        assert.equal(app.approvals.all().length, 0, "no card");

        // The card: the device, the apps, the minutes; a guest cannot approve it.
        const ask = `ask ${crypto.randomUUID()}`;

        calls = { [ask]: ["phone_control", { action: "start", apps: ["grab"], minutes: 20, reason: "Order lunch" }] };
        const { submissionId } = await app.commands.submit(id, owner(app), { text: ask, requestId: crypto.randomUUID() });

        await until(() => app.approvals.forConversation(id).length > 0, "the card");
        const card = app.approvals.forConversation(id)[0]!;

        assert.deepEqual(card.form, { type: "phone", device: "phone", deviceName: "This phone", apps: [{ label: "Grab", package: "com.grabtaxi.passenger" }], minutes: 20 });
        assert.equal(card.reason, "Order lunch");
        await assert.rejects(app.answerApproval(card.id, true, guest), /Controlling the phone is the owner's/);
        assert.equal(app.phoneControl.active(), undefined, "nothing started");
        await app.answerApproval(card.id, true, owner(app));
        await (await app.harness.submission(submissionId, context))!.wait(context);
        await app.harness.waitForIdle(context);
        assert.match((await modelTexts(app, id)).at(-1)!, /Phone control is on for 20 minutes .*Grab \(com\.grabtaxi\.passenger\), and the home screen/);
        assert.equal(phone.banner?.apps, "Grab", "the phone shows its banner");
        assert.ok(Math.abs(phone.banner!.until - (clock() + 20 * 60_000)) < 5000);

        // pi-phone is in front: not read.
        let { said } = await call(id, "phone_screen", {});
        assert.match(said, /pi-phone itself is in front: Pi never reads or controls pi-phone/);

        ({ said } = await call(id, "phone_act", { action: "open_app", app: "Grab" }));
        assert.match(said, /Opened Grab\.[\s\S]*Grab \(com\.grabtaxi\.passenger\)[\s\S]*Button \\"Checkout\\"/);
        assert.match(said, /Phone control: 20 min left/);

        // A tap by number: at the element's middle, with the session's apps, the home screen and the Never list.
        const checkout = app.phoneControl.entry(app.phoneControl.active()!, 0 + Number(/\[(\d+)\] Button \\"Checkout\\"/.exec(said)![1]));
        ({ said } = await call(id, "phone_act", { action: "tap", index: checkout.index }));
        const tap = phone.ops("tap").at(-1)!;

        assert.deepEqual([tap.x, tap.y], [540, 2270]);
        assert.deepEqual(tap.allowed, ["com.grabtaxi.passenger", "com.android.launcher3"]);
        assert.ok((tap.never as string[]).includes("io.piphone") && (tap.never as string[]).includes("com.vietcombank*"));
        assert.match(said, /Tapped \[\d+\] Button \\"Checkout\\"/);

        // A secret typed unseen: its value reaches the phone, never the transcript.
        const field = app.phoneControl.entry(app.phoneControl.active()!, Number(/\[(\d+)\] TextField \\"\\" :password:/.exec(said)![1]));
        ({ said } = await call(id, "phone_act", { action: "type", index: field.index, text: "typed-as-text" }));
        assert.match(said, /is a password field: type a saved secret/);
        ({ said } = await call(id, "phone_act", { action: "type", index: field.index, secret: "GRAB_PASSWORD", submit: true }));
        const typed = phone.ops("type").at(-1)!;

        assert.equal(typed.text, VALUE);
        assert.deepEqual(typed.node, { w: 1, p: field.ref.p, b: [40, 1560, 1040, 1680] });
        assert.equal(typed.submit, true);
        assert.match(said, /Typed \[secret GRAB_PASSWORD\] into/);
        assert.ok(!(await modelTexts(app, id)).join("\n").includes(VALUE), "the value is in no message");

        // Home is allowed; another app opened from there is not read, and acting in it is refused before the phone.
        ({ said } = await call(id, "phone_act", { action: "button", button: "home" }));
        assert.match(said, /the home screen \(com\.android\.launcher3\)/);
        const notes = Number(/\[(\d+)\] TextView \\"Notes\\"/.exec(said)![1]);

        ({ said } = await call(id, "phone_act", { action: "tap", index: notes }));
        assert.match(said, /com\.example\.notes is in front, and it is not in this session \(Grab, and the home screen\)/);
        assert.ok(!said.includes("My private note"), "not read");
        const taps = phone.ops("tap").length;

        ({ said } = await call(id, "phone_act", { action: "tap", x: 500, y: 350 }));
        assert.match(said, /not in this session/);
        assert.equal(phone.ops("tap").length, taps, "the phone was not asked to tap");
        ({ said } = await call(id, "phone_act", { action: "open_app", app: "Notes" }));
        assert.match(said, /open_app needs one of this session's apps: Grab/);

        // The owner puts an app on the Never list: a session with it ends, and a card for it is refused.
        await app.phoneControl.addNever({ label: "Grab", package: "com.grabtaxi.passenger" });
        assert.equal(app.phoneControl.active(), undefined);
        assert.equal(phone.banner, undefined, "the banner is down");
        ({ said } = await call(id, "phone_control", { action: "start", apps: ["Grab"] }));
        assert.match(said, /on the owner's Never list/);
        app.phoneControl.removeNever("com.grabtaxi.passenger");
    } finally {
        app.config.removeUser(guest.id);
    }
});

/** Start a session for Settings, approved by the owner. */
async function startSettings(id: number) {
    const { said } = await call(id, "phone_control", { action: "start", apps: ["Settings"] }, { answer: true });

    assert.match(said, /Phone control is on for 15 minutes/);
}

test("Stop on the phone (the app's service, with the owner's sign-in) ends it; Pi is told how it ended", async () => {
    const id = await newSession(app);

    await startSettings(id);
    const server: Server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
        const answer = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/phone-control/stop`, {
            method: "POST",
            headers: { authorization: `Bearer ${app.config.ownerToken}`, "x-pocket": "1", "content-type": "application/json" },
            body: JSON.stringify({ device: "phone", from: "phone" }),
        });

        assert.equal(answer.status, 200);
        assert.equal(((await answer.json()) as { ended: boolean }).ended, true);
    } finally {
        server.closeAllConnections();
        server.close();
    }

    assert.equal(app.phoneControl.active(), undefined);
    const { said } = await call(id, "phone_act", { action: "button", button: "back" });

    assert.match(said, /No phone control session is active on this phone \(the last one ended at \d\d:\d\d: Stop on the phone\)/);
});

test("a restart keeps a session; at its time it ends", async () => {
    const id = await newSession(app);

    await startSettings(id);
    phone.foreground = "com.android.settings";

    // The server starts again: the session goes on.
    phone.detach();
    await app.close();
    app = await openApp(scriptedModel(route), dataDir, clock);
    phone.attach(app.phoneControl.requests);
    await until(() => app.phoneControl.present(), "the phone polls again");
    assert.equal(app.phoneControl.active()?.conversationId, id);
    let { said } = await call(id, "phone_screen", {});

    assert.match(said, /Settings \(com\.android\.settings\)[\s\S]*TextView \\"Battery\\"/);

    // 16 minutes on: over.
    shift += 16 * 60_000;
    ({ said } = await call(id, "phone_screen", {}));
    assert.match(said, /No phone control session is active on this phone \(the last one ended at \d\d:\d\d: time ran out\)/);
});

test("guests, roles without phone.control, plan mode and the team server are refused", async () => {
    const id = await newSession(app);
    const guest = app.config.addUser("Mai", "guest").user;

    try {
        const { said } = await call(id, "phone_control", { action: "start", apps: ["Settings"] }, { who: guest });

        assert.match(said, /Phone control is the owner's/);
        assert.equal(app.approvals.all().length, 0);
    } finally {
        app.config.removeUser(guest.id);
    }

    // A secret typed into an app goes through the secrets module's rules (its folders, ask-first), as Pi's browser's do.
    assert.deepEqual(browserSecretNames("phone_act", { action: "type", secret: "GRAB_PASSWORD", index: 4 }), { names: ["GRAB_PASSWORD"], subject: "Type [secret GRAB_PASSWORD] into the phone's [4]" });

    for (const tool of ["phone_control", "phone_screen", "phone_act", "phone_screenshot"]) {
        assert.match(blockedInPlanMode(tool, { action: "status" }) ?? "", /Plan mode is on/, tool);
    }

    const team = new PhoneControl({ dataDir: mkdtempSync(join(root, "phone-team-")), gateway: true });

    assert.match(team.unavailable() ?? "", /the team server has no phone/);
    assert.throws(() => team.device("phone"), /the team server has no phone/);
    assert.deepEqual(team.devices(), []);

    // A role without phone.control (the team server's roles never have it): the module is off, its routes refused.
    const roled = await openApp(scriptedModel(route), join(root, "phone-role-data"));

    try {
        await roled.applyPolicy(owner(roled), { permissions: ["pi.use", "settings.change"], models: [], spendLimit: null, role: "Member" });
        assert.equal(roled.loader.list().find((each) => each.file === "phone.ts")?.enabled, false);
        assert.match(roled.policy.routeRefusal("phone-control", "GET") ?? "", /Member does not include controlling the phone/);
    } finally {
        await roled.close();
    }
});

test("a screenshot with a mark on an element, in screen pixels", async () => {
    const id = await newSession(app);

    await startSettings(id);
    phone.foreground = "com.android.settings";
    await call(id, "phone_screen", {});
    const { said } = await call(id, "phone_screenshot", { marks: [{ index: 1, label: "here" }] });

    assert.match(said, /The phone's screen \(1080x2400 px; marks in screen pixels\)/);
    assert.equal(phone.ops("shot").length, 1);
    await call(id, "phone_control", { action: "stop" });
    assert.equal(app.phoneControl.active(), undefined);
});
