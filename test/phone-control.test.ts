// Pi controls this phone (PP-141), against a fake phone answering the phone-control channel as the app's service does
// (`test/support/fake-phone.ts`): the outline of real-looking screens (Settings, a long list, a dialog, the keyboard
// up); one card (only the owner approves) starts a session for the apps it names and the home screen; another app,
// pi-phone itself, a bank, a password manager and an app on the owner's Never list are refused (on the server, and each
// scoped request carries what the service checks); a password field is never typed into; Stop and the time limit end
// it; a restart keeps it, and the banner comes back; guests, roles without phone.control, plan mode and the team server
// are refused.
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
import { createHandler } from "../src/server/http.ts";
import { PhoneControl } from "../src/server/phone-control.ts";
import { FLAG, renderOutline } from "../src/server/phone-outline.ts";
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

before(async () => {
    app = await openApp(scriptedModel(route), dataDir, clock);
    phone.attach(app.phoneControl.requests);
    // The service polls: the phone is there.
    await until(() => app.phoneControl.present(), "the phone polls");
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

const CONTACTS = "com.google.android.contacts";

/**
 * A contacts row, the k-th from the list's top. As Android reports them: bounds clipped to the list's bottom (`clip`),
 * a view clipped away entirely not sent (the service leaves out empty leaves), a row out of view marked so.
 */
function contact(k: number, shown = true, clip = 2274) {
    const top = 300 + 160 * k;
    const view = (c: string, [l, t, r, b]: [number, number, number, number], rest: Parameters<typeof node>[2], k2: Parameters<typeof node>[3] = []) => {
        const bounds: [number, number, number, number] = shown ? [l, Math.min(t, clip), r, Math.min(b, clip)] : [l, t, r, b];

        return shown ? node(c, bounds, rest, k2) : { ...node(c, bounds, rest, k2), f: ((rest?.f ?? 0) | FLAG.enabled) & ~FLAG.visible };
    };
    const texts = [
        view("android.widget.TextView", [200, top + 30, 1000, top + 90], { r: `${CONTACTS}:id/name`, t: `Contact ${k + 1}` }),
        view("android.widget.TextView", [200, top + 95, 1000, top + 140], { r: `${CONTACTS}:id/number`, t: `+84 90 000 ${String(k).padStart(4, "0")}` }),
    ].filter((each) => each.b[3] > each.b[1]);

    return view("android.widget.LinearLayout", [0, top, 1080, top + 160], { r: `${CONTACTS}:id/contact_row`, f: FLAG.clickable }, texts);
}

test("the outline of a long list: the rows in view only, its row count, a tab bar with the tab selected, at most 200 elements", () => {
    const tab = (label: string, x: number, selected = false) =>
        node("android.widget.FrameLayout", [x, 2274, x + 360, 2400], { f: FLAG.clickable | (selected ? FLAG.selected : 0) }, [node("android.widget.TextView", [x + 80, 2320, x + 280, 2370], { t: label })]);
    const root = node("android.widget.FrameLayout", [0, 0, 1080, 2400], {}, [
        node("androidx.appcompat.widget.Toolbar", [0, 132, 1080, 300], {}, [node("android.widget.TextView", [48, 170, 600, 260], { t: "Contacts" })]),
        node(
            "androidx.recyclerview.widget.RecyclerView",
            [0, 300, 1080, 2274],
            { r: `${CONTACTS}:id/contacts_list`, f: FLAG.scrollable | FLAG.collection },
            // 13 rows in view (the last one half), two laid out below it.
            [...Array.from({ length: 13 }, (_, k) => contact(k)), contact(13, false), contact(14, false)],
        ),
        node("com.google.android.material.bottomnavigation.BottomNavigationView", [0, 2274, 1080, 2400], {}, [tab("Favorites", 0), tab("Contacts", 360, true), tab("Fix & manage", 720)]),
    ]);
    const { text, entries } = renderOutline({ display: { width: 1080, height: 2400 }, foreground: CONTACTS, keyboard: false, windows: [{ id: 2, type: "application", package: CONTACTS, layer: 1, active: true, root }] }, "Contacts");

    assert.match(text, /\[\d+\] List "" :contacts_list: \(0,300 1080x1974\) list of 13 rows in view scrollable/);
    assert.ok(text.includes('"Contact 13" (200,2250 800x24)') && !text.includes('"+84 90 000 0012"'), "the half-shown row, as much as shows");
    assert.ok(!text.includes("Contact 14") && !text.includes("Contact 15"), "no row out of view");
    // Rows repeat their id: each is an element (to tap), its words indented under it.
    // (The half-shown row, 54 px of it, reads as a divider: its name is listed by itself.)
    assert.equal(entries.filter((entry) => entry.role === "LinearLayout").length, 12);
    assert.match(text, /\n {2}\[\d+\] LinearLayout "" :contact_row: \(0,300 1080x160\)\n {4}\[\d+\] TextView "Contact 1" \(200,330 800x60\)/);
    // The rows at the screen's foot stay in the list, not in the bottom band.
    assert.doesNotMatch(text, /\[Bottom\]/);
    assert.match(text, /\n {2}\[\d+\] TextView "Contact 13"/);
    assert.ok(text.includes("[TabBar]"));
    assert.match(text, /Button "Contacts" \(360,2274 360x126\) selected/);
    assert.match(text, /Button "Favorites" \(0,2274 360x126\)\n/);

    // A page of 300 links (a web view in an app): 200 listed, the rest counted.
    const links = Array.from({ length: 300 }, (_, k) => node("android.view.View", [0, 8 * k, 1080, 8 * k + 8], { t: `Link ${k + 1}`, f: FLAG.clickable }));
    const web = renderOutline(
        { display: { width: 1080, height: 2400 }, foreground: "org.example.reader", keyboard: false, windows: [{ id: 3, type: "application", package: "org.example.reader", layer: 1, active: true, root: node("android.webkit.WebView", [0, 0, 1080, 2400], { f: FLAG.scrollable }, links) }] },
        "Reader",
    );

    assert.equal(web.entries.length, 200);
    assert.match(web.text, /\(101 more elements not listed\)$/);
});

test("the outline of a dialog over the app: the dialog alone, said so, with its buttons", () => {
    const PHOTOS = "com.google.android.apps.photos";
    const gallery = node("android.widget.FrameLayout", [0, 0, 1080, 2400], {}, [
        node("androidx.appcompat.widget.Toolbar", [0, 132, 1080, 300], {}, [node("android.widget.TextView", [48, 170, 600, 260], { t: "3 selected" })]),
        node("android.widget.ImageButton", [900, 170, 1040, 260], { d: "Delete", f: FLAG.clickable }),
    ]);
    const dialog = node("android.widget.FrameLayout", [90, 880, 990, 1520], {}, [
        node("android.widget.TextView", [150, 940, 930, 1020], { r: "android:id/alertTitle", t: "Move 3 items to trash?" }),
        node("android.widget.TextView", [150, 1040, 930, 1200], { r: "android:id/message", t: "Items in trash are deleted after 60 days." }),
        node("android.widget.Button", [480, 1360, 700, 1480], { r: "android:id/button2", t: "Cancel", f: FLAG.clickable }),
        node("android.widget.Button", [720, 1360, 940, 1480], { r: "android:id/button1", t: "Move to trash", f: FLAG.clickable }),
    ]);
    // Android gives the dialog the focus: it is the active window, over the app's.
    const { text, entries } = renderOutline(
        {
            display: { width: 1080, height: 2400 },
            foreground: PHOTOS,
            keyboard: false,
            windows: [
                { id: 5, type: "application", package: PHOTOS, layer: 1, active: false, root: gallery },
                { id: 6, type: "application", package: PHOTOS, layer: 2, active: true, root: dialog },
                { id: 7, type: "system", package: "com.android.systemui", layer: 9, active: false },
            ],
        },
        "Photos",
    );

    assert.match(text, /popup or dialog is open over the app: only it is listed/);
    assert.deepEqual(
        entries.map((entry) => `${entry.role} ${entry.label}`),
        ["TextView Move 3 items to trash?", "TextView Items in trash are deleted after 60 days.", "Button Cancel", "Button Move to trash"],
    );
    assert.deepEqual(entries[3]!.ref, { w: 6, p: [3] });
    assert.doesNotMatch(text, /3 selected|Delete"/);
});

test("the outline with the keyboard up: said so, the focused field with its text and hint, nothing of the keyboard", () => {
    const CHAT = "com.example.chat";
    const root = node("android.widget.FrameLayout", [0, 0, 1080, 1400], {}, [
        node("androidx.appcompat.widget.Toolbar", [0, 132, 1080, 300], {}, [node("android.widget.TextView", [160, 170, 700, 260], { t: "Linh" })]),
        node("androidx.recyclerview.widget.RecyclerView", [0, 300, 1080, 1240], { r: `${CHAT}:id/messages`, f: FLAG.scrollable }, [
            node("android.widget.TextView", [400, 320, 1040, 420], { t: "Dinner tonight?" }),
            node("android.widget.TextView", [40, 440, 700, 540], { t: "Sure, where?" }),
        ]),
        node("android.widget.EditText", [40, 1250, 880, 1380], { r: `${CHAT}:id/compose`, t: "See you at 7", h: "Message", f: FLAG.clickable | FLAG.focusable | FLAG.editable | FLAG.focused }),
        node("android.widget.ImageButton", [900, 1250, 1040, 1380], { d: "Send", f: FLAG.clickable }),
    ]);
    const { text } = renderOutline(
        {
            display: { width: 1080, height: 2400 },
            foreground: CHAT,
            keyboard: true,
            windows: [
                { id: 2, type: "application", package: CHAT, layer: 1, active: true, root },
                // The keyboard's window: never read (the service sends no nodes but the app's).
                { id: 8, type: "input_method", package: "com.google.android.inputmethod.latin", layer: 3, active: false },
            ],
        },
        "Chat",
    );

    assert.equal(text.split("\n")[0], "Chat (com.example.chat) · screen 1080x2400 px · keyboard up");
    assert.match(text, /TextField "See you at 7" \(40,1250 840x130\) focused hint "Message"/);
    assert.match(text, /Button "Send" \(900,1250 140x130\)/);
    assert.match(text, /List "" :messages: \(0,300 1080x940\) list of 2 rows in view scrollable/);
    assert.doesNotMatch(text, /popup or dialog/);
});

test("which app in front a session may read and touch: its apps and the home screen; never pi-phone, a Never app, or another", () => {
    const control = new PhoneControl({ dataDir: mkdtempSync(join(root, "phone-scope-")), gateway: false });
    const session = {
        device: "phone",
        conversationId: 1,
        session: 1,
        approvedBy: "owner",
        apps: [{ label: "Settings", package: "com.android.settings" }],
        launcher: "com.android.launcher3",
        reason: "",
        startedAt: Date.now(),
        until: Date.now() + 60_000,
    };

    try {
        assert.equal(control.refusal(session, "com.android.settings"), undefined);
        assert.equal(control.refusal(session, "com.android.launcher3"), undefined, "the home screen");
        assert.match(control.refusal({ ...session, launcher: undefined }, "com.android.launcher3")!, /not in this session/, "no home screen known: not allowed");
        assert.match(control.refusal(session, "io.piphone")!, /pi-phone itself is in front/);
        assert.match(control.refusal({ ...session, apps: [{ label: "pi", package: "io.piphone" }] }, "io.piphone")!, /pi-phone itself/, "even when named");
        assert.match(control.refusal(session, "com.google.android.permissioncontroller")!, /not in this session \(Settings, and the home screen\)/);
        assert.match(control.refusal(session, "com.vietcombank.mobile")!, /banking or payment app/);
        assert.match(control.refusal(session, null)!, /no app in front/);
    } finally {
        control.close();
    }
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

        assert.deepEqual(card.form, { type: "phone", device: "phone", deviceName: "This phone", apps: [{ label: "Grab", package: "com.grabtaxi.passenger" }], minutes: 20, follow: false });
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

        // A password field: Pi does not type into it, and the phone is not asked.
        const field = app.phoneControl.entry(app.phoneControl.active()!, Number(/\[(\d+)\] TextField \\"\\" :password:/.exec(said)![1]));
        const search = app.phoneControl.entry(app.phoneControl.active()!, Number(/\[(\d+)\] TextField \\"\\" :search:/.exec(said)![1]));

        ({ said } = await call(id, "phone_act", { action: "type", index: field.index, text: "typed-as-text" }));
        assert.match(said, /is a password field: Pi does not type into it\. Ask the owner to type it on the phone/);
        assert.equal(phone.ops("type").length, 0);

        // Text into the search field: the node it was read as (window, child path, bounds), and Enter.
        ({ said } = await call(id, "phone_act", { action: "type", index: search.index, text: "pho bo", submit: true }));
        const typed = phone.ops("type").at(-1)!;

        assert.equal(typed.text, "pho bo");
        assert.deepEqual(typed.node, { w: 1, p: search.ref.p, b: [40, 160, 1040, 280] });
        assert.equal(typed.submit, true);
        assert.equal(typed.apps, "Grab", "the apps' names, for the banner");
        assert.match(said, /Typed \\"pho bo\\" into \[\d+\] \\"\\" and pressed Enter/);

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

test("strict, an app a named one opens is refused; following along, it joins, but not an app it opens in turn, nor one opened from the home screen", async () => {
    const id = await newSession(app);

    // Strict: Settings' Battery opens Device care, an app of its own (as on a Samsung): not in the session.
    await startSettings(id);
    let { said } = await call(id, "phone_act", { action: "open_app", app: "Settings" });

    assert.match(said, /Settings \(com\.android\.settings\)/);
    ({ said } = await call(id, "phone_act", { action: "tap", x: 540, y: 1370 }));
    assert.match(said, /com\.example\.devicecare is in front, and it is not in this session \(Settings, and the home screen\).*follow: true lets apps the named ones open join/);
    assert.ok(!said.includes("Battery health"), "not read");
    await call(id, "phone_act", { action: "button", button: "home" });
    await call(id, "phone_control", { action: "stop" });

    // Following along: the card says so; Device care joins as Settings opens it, and is read.
    ({ said } = await call(id, "phone_control", { action: "start", apps: ["Settings"], follow: true, reason: "Check the battery" }, { answer: true }));
    assert.match(said, /and the home screen, and apps these open while you act in them/);
    ({ said } = await call(id, "phone_act", { action: "open_app", app: "Settings" }));
    ({ said } = await call(id, "phone_act", { action: "tap", x: 540, y: 1370 }));
    assert.match(said, /Device care \(com\.example\.devicecare\)[\s\S]*Battery health: Good/);
    assert.deepEqual(
        app.phoneControl.view()[0]?.apps.map((each) => each.label),
        ["Settings", "Device care"],
        "the session's apps, as the live line shows them",
    );
    assert.equal(phone.ops("tap").at(-1)?.apps, "Settings", "the tap was sent with the card's apps");

    // One step only: Notes, which Device care opens, does not join.
    ({ said } = await call(id, "phone_act", { action: "tap", x: 540, y: 550 }));
    assert.match(said, /com\.example\.notes is in front, and it is not in this session \(Settings, Device care, and the home screen; apps the named ones open join it, but not this one/);
    assert.ok(!said.includes("My private note"), "not read");

    // Nor an app opened from the home screen.
    ({ said } = await call(id, "phone_act", { action: "button", button: "home" }));
    ({ said } = await call(id, "phone_act", { action: "tap", x: 450, y: 1900 }));
    assert.match(said, /com\.example\.notes is in front, and it is not in this session/);
    assert.ok(!said.includes("My private note"), "not read");
    await call(id, "phone_act", { action: "button", button: "home" });
    await call(id, "phone_control", { action: "stop" });
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
    // pi-phone's process started again too: its banner is gone, and comes back before Pi reads the screen.
    const end = phone.banner!.until;

    phone.banner = undefined;
    let { said } = await call(id, "phone_screen", {});

    assert.match(said, /Settings \(com\.android\.settings\)[\s\S]*TextView \\"Battery\\"/);
    assert.deepEqual(phone.banner, { until: end, apps: "Settings", again: true });

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
