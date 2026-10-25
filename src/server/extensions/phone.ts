/**
 * Pi controls phones (PP-141): Pi reads and operates Android apps on this phone through pi-phone's accessibility service
 * (`phone-control.ts`, `PhoneControl.java`), as it does pages in its browser.
 * - `phone_control`: start a control session (one card the owner approves: the apps, the minutes), stop it, or say how
 *   it stands. Only the apps on the card (and the home screen, to open them); another app needs a new card.
 * - `phone_screen`: the screen as numbered elements (`phone-outline.ts`, ported from lycorp-jp/sim-use).
 * - `phone_act`: tap, long press, type a text, swipe, scroll, a button, open an app, wait; answers with the screen
 *   after it. A password field is never typed into by Pi (the owner types it on the phone).
 * - `phone_screenshot`: a picture of the screen, with marks.
 * The owner's alone; never on the team server, never in plan mode (`plan.ts` blocks tools that change things).
 */
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import type { PocketHost } from "../host.ts";
import { AREA, MARK_STYLE, MARKS_NOTE } from "../mark-schema.ts";
import { type Mark, markUp } from "../markup.ts";
import { type ControlSession, MINUTES, type PhoneApp } from "../phone-control.ts";
import { clockText } from "../phone-events.ts";

const reply = (text: string, isError = false) => ({ output: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) });
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** How long the screen gets to settle after an action before it is read again. */
const SETTLE_MS = 800;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const PACKAGE = /^[A-Za-z][\w]*(\.[A-Za-z_][\w]*)+$/;

/** In every prompt while the module is on. */
export const PHONE = `Phone control: you can see and operate Android apps on the owner's phone, in a control session the owner approves on a card. phone_control start names the apps (and minutes, 15 by default); only those apps and the home screen may be read or touched, so ask with a new card for another app; or, when the work will lead into screens of other apps (on a Samsung, Settings' Battery is Device care, an app of its own), ask with follow: true, so an app the named ones open while you act in them joins (one step). Then phone_act open_app opens one, phone_screen reads the screen as numbered elements ([3] Button "Send"), phone_act taps, types, swipes, scrolls, presses back or home, and answers with the screen after it (use the newest numbers); phone_screenshot shows it as a picture. Never type into a password field: ask the owner to type a password or code on the phone himself. pi-phone itself, banking and payment apps, password managers and apps on the owner's Never list are never read or controlled. Ask the owner before anything that pays, sends, books, or deletes. Stop the session with phone_control stop when you are done.`;

export default function createPhone(host: PocketHost) {
    const control = host.phone;
    const device = Type.Optional(Type.String({ description: 'The device: "phone" (this phone, the default)' }));

    /** The owner's Pi only: refused for guests, and on a server without a phone. */
    const refusedFor = (conversationId: unknown): string | undefined => {
        const unavailable = control.unavailable();

        if (unavailable !== undefined) {
            return unavailable;
        }

        const asker = host.requesterOf(Number(conversationId) as never);

        return asker === undefined || host.person(asker).role !== "owner" ? "Phone control is the owner's: it works only for what the owner asks." : undefined;
    };

    /** The session this conversation's Pi controls a device in, or why not. */
    const sessionOf = (conversationId: unknown, id: string | undefined): ControlSession => {
        const refused = refusedFor(conversationId);

        if (refused !== undefined) {
            throw new Error(refused);
        }

        return control.sessionFor(control.device(id).id, Number(conversationId));
    };

    const left = (session: ControlSession) => `${Math.max(0, Math.ceil((session.until - Date.now()) / 60_000))} min left, until ${clockText(session.until)}`;

    /** The screen in words, with the session's time; a screen Pi may not read says why instead. */
    const screenText = async (session: ControlSession): Promise<string> => {
        try {
            const outline = await control.screen(session);

            return `${outline.text}\n(Phone control: ${left(session)}.)`;
        } catch (error) {
            return `${message(error)}\n(Phone control: ${left(session)}.)`;
        }
    };

    /** An app of the phone by its name or package. */
    const findApp = (apps: readonly PhoneApp[], wanted: string): PhoneApp | PhoneApp[] => {
        const name = wanted.trim().toLowerCase();
        const exact = apps.find((each) => each.package.toLowerCase() === name) ?? apps.find((each) => each.label.toLowerCase() === name);

        if (exact !== undefined) {
            return exact;
        }

        const near = apps.filter((each) => each.label.toLowerCase().includes(name));

        return near.length === 1 ? near[0]! : near;
    };

    const controlTool = defineTool({
        name: "phone_control",
        description:
            "Start, stop, or check a phone control session: Pi reads and operates Android apps on the owner's phone through pi-phone's accessibility service. " +
            "start shows the owner one card with the apps (names or packages) and the minutes (default 15, 5 to 60); on Approve, a banner and a notification on the phone say Pi is using it, with Stop. " +
            "Only those apps and the home screen may be read or touched; another app needs a new card, unless you ask with follow: true, which lets an app the named ones open while you act in them (Settings' Battery opening Device care) join the session (one step: not apps those open, nor apps opened from the home screen). pi-phone itself, banking and payment apps, password managers and the owner's Never list are refused either way. " +
            "It ends at its time, on Stop (the phone's banner or notification, the app's live line), or with stop. Owner only.",
        parameters: Type.Object({
            action: Type.Union([Type.Literal("start"), Type.Literal("stop"), Type.Literal("status")]),
            apps: Type.Optional(Type.Array(Type.String(), { description: "start: the apps, by name as the launcher shows it or by package (com.grab.food)" })),
            minutes: Type.Optional(Type.Integer({ minimum: MINUTES.min, maximum: MINUTES.max, description: "start: how long (default 15)" })),
            follow: Type.Optional(Type.Boolean({ description: "start: also the apps the named ones open while you act in them (default false: only the named apps)" })),
            reason: Type.Optional(Type.String({ description: "start: what you will do, in a sentence: shown on the card" })),
            device,
        }),
        execute: async (args, api, context) => {
            const refused = refusedFor(api.conversationId);

            if (refused !== undefined) {
                return reply(refused, true);
            }

            try {
                const phone = control.device(args.device);
                const mine = control.active(phone.id);

                if (args.action === "status") {
                    if (!control.present(phone.id)) {
                        return reply(`${phone.name}: pi-phone's service is not polling (open pi-phone on the phone).`);
                    }

                    const status = await control.status(phone.id);
                    const lines = [
                        `${phone.name}: Android ${status.android}, accessibility service ${status.enabled ? "on" : "off (Menu › Phone control › Set up this phone)"}, screenshots ${status.screenshot ? "supported" : "need Android 11"}.`,
                        mine === undefined
                            ? control.noSession(phone.id)
                            : `Session #${mine.session} controls it: ${[...mine.apps, ...(mine.followed ?? [])].map((each) => `${each.label} (${each.package})`).join(", ")}, and the home screen${mine.follow === true ? "; apps these open join it" : ""}; ${left(mine)}.`,
                    ];

                    return reply(lines.join("\n"));
                }

                if (args.action === "stop") {
                    if (mine === undefined || mine.conversationId !== Number(api.conversationId)) {
                        return reply(mine === undefined ? control.noSession(phone.id) : `This session does not control ${phone.name.toLowerCase()}: session #${mine.session} does.`, true);
                    }

                    await control.end(phone.id, "Pi stopped it");

                    return reply(`Phone control on ${phone.name.toLowerCase()} is stopped.`);
                }

                const wanted = args.apps ?? [];

                if (wanted.length === 0 || wanted.length > 8) {
                    return reply("Name the apps the session may use (1 to 8): apps: [\"GrabMart\"].", true);
                }

                const minutes = args.minutes ?? MINUTES.default;

                if (!Number.isInteger(minutes) || minutes < MINUTES.min || minutes > MINUTES.max) {
                    return reply(`minutes is a whole number from ${MINUTES.min} to ${MINUTES.max}.`, true);
                }

                if (mine !== undefined && mine.conversationId !== Number(api.conversationId)) {
                    return reply(`Session #${mine.session}'s Pi is using ${phone.name.toLowerCase()} until ${clockText(mine.until)}: one session controls it at a time.`, true);
                }

                if (!control.present(phone.id)) {
                    return reply("Phone control needs the pi-phone app's service, which polls the server on the phone itself: open pi-phone on the phone.", true);
                }

                const status = await control.status(phone.id);

                if (!status.enabled) {
                    return reply("pi-phone's accessibility service is off: the owner turns it on in Menu › Phone control › Set up this phone (Android's Accessibility settings).", true);
                }

                const installed = await control.apps(phone.id);
                const apps: PhoneApp[] = [];

                for (const each of wanted) {
                    const found = findApp(installed, each);
                    const app = Array.isArray(found) ? (PACKAGE.test(each.trim()) ? { label: each.trim(), package: each.trim() } : undefined) : found;

                    if (app === undefined) {
                        const near = found as PhoneApp[];

                        return reply(
                            near.length > 1
                                ? `${each} could be ${near.slice(0, 8).map((app) => `${app.label} (${app.package})`).join(", ")}: name one by its package.`
                                : `There is no app ${each} on the phone: name it as the launcher shows it, or by its package.`,
                            true,
                        );
                    }

                    const never = control.neverReason(app.package);

                    if (never !== undefined) {
                        return reply(`${app.label} (${app.package}) is ${never}: Pi never reads or controls it.`, true);
                    }

                    if (!apps.some((other) => other.package === app.package)) {
                        apps.push(app);
                    }
                }

                const conversationId = Number(api.conversationId);
                const follow = args.follow === true;
                const answer = await host.approvals.request(
                    {
                        id: `phone_control-${String(api.conversationId)}-${String(api.callId)}`,
                        conversationId: conversationId as never,
                        taskId: api.taskId as never,
                        ...(api.callId === undefined ? {} : { callId: api.callId }),
                        tool: "phone_control",
                        subject: `Control ${phone.name.toLowerCase()} for ${minutes} min: ${apps.map((each) => each.label).join(", ")}${follow ? ", and the apps these open" : ""}`,
                        reason: args.reason ?? "",
                        form: { type: "phone", device: phone.id, deviceName: phone.name, apps, minutes, follow },
                        createdAt: Date.now(),
                    },
                    context as never,
                );

                if (!answer.allow) {
                    return reply(`${answer.by === "superseded" ? "The request was replaced" : `${answer.by} said no`}: Pi does not control the phone.`, true);
                }

                const session = await control.start({
                    device: phone.id,
                    conversationId,
                    session: host.rootOf(conversationId),
                    approvedBy: host.requesterOf(conversationId as never) ?? "",
                    apps,
                    follow,
                    reason: args.reason ?? "",
                    minutes,
                });

                return reply(
                    `Phone control is on for ${minutes} minutes (until ${clockText(session.until)}): ${apps.map((each) => `${each.label} (${each.package})`).join(", ")}, and the home screen${follow ? ", and apps these open while you act in them" : ""}. The phone shows a banner with Stop. Open an app with phone_act open_app, then read the screen with phone_screen.`,
                );
            } catch (error) {
                return reply(message(error), true);
            }
        },
    });

    const screenTool = defineTool({
        name: "phone_screen",
        description:
            "Read the phone's screen in a control session: the app in front, its elements numbered top to bottom ([3] Button \"Send\" (x,y wxh) and states), in regions (Top, Content, Bottom, toolbars, lists with their rows), the keyboard, and the session's time left. Apps outside the session are not read.",
        parameters: Type.Object({ device }),
        replay: "safe",
        execute: async (args, api) => {
            try {
                const session = sessionOf(api.conversationId, args.device);

                return reply(await screenText(session));
            } catch (error) {
                return reply(message(error), true);
            }
        },
    });

    const actTool = defineTool({
        name: "phone_act",
        description:
            "Act on the phone in a control session, then answer with the screen after it (use its numbers next). " +
            "tap / long_press: an element by index (from the newest phone_screen) or a point x, y in screen pixels. " +
            "type: text into the field index (default: the focused one; never a password field); clear (default true) replaces what is there, submit presses the keyboard's Enter. " +
            "swipe: the finger moves direction (up, down, left, right) from index, x, y, or the screen's middle. scroll: shows more of index (a scrollable element) or the screen in direction (down: what is below). " +
            "button: back, home, recents, notifications, quick_settings. open_app: an app of the session (app: name or package). wait: seconds (default 2, at most 10). " +
            "Only in the session's apps and the home screen.",
        parameters: Type.Object({
            action: Type.Union([
                Type.Literal("tap"),
                Type.Literal("long_press"),
                Type.Literal("type"),
                Type.Literal("swipe"),
                Type.Literal("scroll"),
                Type.Literal("button"),
                Type.Literal("open_app"),
                Type.Literal("wait"),
            ]),
            index: Type.Optional(Type.Integer({ minimum: 1, description: "An element's number from the newest phone_screen" })),
            x: Type.Optional(Type.Number({ description: "A point on the screen, in pixels from the left" })),
            y: Type.Optional(Type.Number({ description: "A point on the screen, in pixels from the top" })),
            text: Type.Optional(Type.String({ description: "type: the text" })),
            clear: Type.Optional(Type.Boolean({ description: "type: replace what is in the field (default true)" })),
            submit: Type.Optional(Type.Boolean({ description: "type: press Enter afterwards" })),
            direction: Type.Optional(Type.Union([Type.Literal("up"), Type.Literal("down"), Type.Literal("left"), Type.Literal("right")])),
            button: Type.Optional(Type.Union([Type.Literal("back"), Type.Literal("home"), Type.Literal("recents"), Type.Literal("notifications"), Type.Literal("quick_settings")])),
            app: Type.Optional(Type.String({ description: "open_app: the app's name or package" })),
            seconds: Type.Optional(Type.Number({ minimum: 0, maximum: 10, description: "wait: how long" })),
            device,
        }),
        execute: async (args, api) => {
            let session: ControlSession;

            try {
                session = sessionOf(api.conversationId, args.device);
            } catch (error) {
                return reply(message(error), true);
            }

            try {
                /** Where to act: an element's middle, or the point given. */
                const point = (): { x: number; y: number; what: string } => {
                    if (args.index !== undefined) {
                        const entry = control.entry(session, args.index);

                        return { x: Math.round(entry.frame.x + entry.frame.width / 2), y: Math.round(entry.frame.y + entry.frame.height / 2), what: `[${args.index}] ${entry.role} ${JSON.stringify(entry.label)}` };
                    }

                    if (args.x === undefined || args.y === undefined) {
                        throw new Error(`${args.action} needs index, or x and y.`);
                    }

                    return { x: Math.round(args.x), y: Math.round(args.y), what: `(${Math.round(args.x)},${Math.round(args.y)})` };
                };
                let done: string;

                switch (args.action) {
                    case "tap": {
                        const at = point();

                        await control.act(session, { op: "tap", x: at.x, y: at.y });
                        done = `Tapped ${at.what}.`;
                        break;
                    }

                    case "long_press": {
                        const at = point();

                        await control.act(session, { op: "press", x: at.x, y: at.y, ms: 800 });
                        done = `Long-pressed ${at.what}.`;
                        break;
                    }

                    case "type": {
                        if (args.text === undefined) {
                            return reply("type needs text.", true);
                        }

                        const entry = args.index === undefined ? undefined : control.entry(session, args.index);
                        const value = args.text;

                        if (entry?.password === true) {
                            return reply(`[${args.index}] is a password field: Pi does not type into it. Ask the owner to type it on the phone.`, true);
                        }

                        await control.act(session, {
                            op: "type",
                            text: value,
                            clear: args.clear ?? true,
                            submit: args.submit ?? false,
                            ...(entry === undefined ? {} : { node: { w: entry.ref.w, p: entry.ref.p, b: [entry.frame.x, entry.frame.y, entry.frame.x + entry.frame.width, entry.frame.y + entry.frame.height] } }),
                        });
                        done = `Typed ${JSON.stringify(value)} into ${entry === undefined ? "the focused field" : `[${args.index}] ${JSON.stringify(entry.label)}`}${args.submit ? " and pressed Enter" : ""}.`;
                        break;
                    }

                    case "swipe":
                    case "scroll": {
                        if (args.direction === undefined) {
                            return reply(`${args.action} needs a direction: up, down, left, or right.`, true);
                        }

                        const { width, height } = (await control.lastOutline(session)).size;
                        const entry = args.index === undefined ? undefined : control.entry(session, args.index);
                        const area = entry?.frame ?? { x: 0, y: Math.round(height * 0.2), width, height: Math.round(height * 0.6) };
                        // A scroll shows what is that way: the finger moves the other way.
                        const finger = args.action === "swipe" ? args.direction : ({ up: "down", down: "up", left: "right", right: "left" } as const)[args.direction];
                        const from =
                            args.action === "swipe" && entry === undefined && args.x !== undefined && args.y !== undefined
                                ? { x: Math.round(args.x), y: Math.round(args.y) }
                                : { x: Math.round(area.x + area.width / 2), y: Math.round(area.y + area.height / 2) };
                        const reach = { x: Math.round(area.width * 0.3), y: Math.round(area.height * 0.3) };
                        const start = args.action === "scroll"
                            ? { x: finger === "left" ? from.x + reach.x : finger === "right" ? from.x - reach.x : from.x, y: finger === "up" ? from.y + reach.y : finger === "down" ? from.y - reach.y : from.y }
                            : from;
                        const end = {
                            x: Math.max(1, Math.min(width - 1, start.x + (finger === "left" ? -2 : finger === "right" ? 2 : 0) * reach.x)),
                            y: Math.max(1, Math.min(height - 1, start.y + (finger === "up" ? -2 : finger === "down" ? 2 : 0) * reach.y)),
                        };

                        await control.act(session, { op: "swipe", x: start.x, y: start.y, x2: end.x, y2: end.y, ms: 350 });
                        done = args.action === "swipe" ? `Swiped ${args.direction} from (${start.x},${start.y}).` : `Scrolled ${entry === undefined ? "the screen" : `[${args.index}]`} ${args.direction}.`;
                        break;
                    }

                    case "button": {
                        if (args.button === undefined) {
                            return reply("button needs which: back, home, recents, notifications, or quick_settings.", true);
                        }

                        // Back and home get out of any app; the others act in the app in front.
                        await control.act(session, { op: "button", name: args.button }, args.button === "back" || args.button === "home");
                        done = `Pressed ${args.button.replace("_", " ")}.`;
                        break;
                    }

                    case "open_app": {
                        const found = args.app === undefined ? [] : findApp(session.apps, args.app);

                        if (Array.isArray(found)) {
                            return reply(`open_app needs one of this session's apps: ${session.apps.map((each) => `${each.label} (${each.package})`).join(", ")}. Another app needs phone_control start.`, true);
                        }

                        await control.open(session, found);
                        done = `Opened ${found.label}.`;
                        break;
                    }

                    case "wait": {
                        await pause(Math.max(0, Math.min(10, args.seconds ?? 2)) * 1000);
                        done = "Waited.";
                        break;
                    }
                }

                if (args.action !== "wait") {
                    await pause(SETTLE_MS);
                }

                return reply(`${done}\n\n${await screenText(session)}`);
            } catch (error) {
                return reply(message(error), true);
            }
        },
    });

    const shotTool = defineTool({
        name: "phone_screenshot",
        description: `See the phone's screen as a picture in a control session (Android 11 or later; screens an app protects come out black). With path, also save it (.jpg) where this session works. ${MARKS_NOTE} Each mark is on an element (index, from the newest phone_screen) or an area in screen pixels.`,
        parameters: Type.Object({
            path: Type.Optional(Type.String({ description: "Save it here too, ending in .jpg: absolute or relative to this session's folder" })),
            marks: Type.Optional(
                Type.Array(Type.Object({ index: Type.Optional(Type.Integer({ minimum: 1, description: "An element, by its number" })), area: Type.Optional(AREA), ...MARK_STYLE }), {
                    maxItems: 40,
                    description: "Marks drawn on the picture",
                }),
            ),
            device,
        }),
        replay: "safe",
        execute: async (args, api, context) => {
            try {
                const session = sessionOf(api.conversationId, args.device);

                if (args.path !== undefined && !/\.jpe?g$/i.test(args.path)) {
                    return reply("Give a path ending in .jpg.", true);
                }

                const marks: Mark[] = (args.marks ?? []).map((mark) => {
                    const { index, area, ...style } = mark;

                    if ((index === undefined) === (area === undefined)) {
                        throw new Error("Each mark is on an element (index) or an area, not both.");
                    }

                    return { ...style, area: area ?? control.entry(session, index!).frame };
                });
                const shot = await control.picture(session);
                let bytes: Uint8Array = Buffer.from(shot.jpeg, "base64");

                if (marks.length > 0) {
                    bytes = markUp(bytes, marks, { png: false, cssWidth: shot.width }).bytes;
                }

                let saved = "";

                if (args.path !== undefined) {
                    const env = host.envOf((await api.agent(context)).cwd ?? "");
                    const absolute = await env.absolutePath(args.path, context);

                    if (!absolute.ok) {
                        throw new Error(`Cannot save to ${args.path}: ${absolute.error.message}`);
                    }

                    const written = await env.writeFile(absolute.value, bytes, context);

                    if (!written.ok) {
                        throw new Error(`Could not save ${absolute.value}: ${written.error.message}`);
                    }

                    saved = ` Saved as ${absolute.value}.`;
                }

                return {
                    output: [
                        { type: "text" as const, text: `The phone's screen (${shot.width}x${shot.height} px; marks in screen pixels).${saved} (Phone control: ${left(session)}.)` },
                        { type: "image" as const, data: Buffer.from(bytes).toString("base64"), mimeType: "image/jpeg" },
                    ],
                };
            } catch (error) {
                return reply(message(error), true);
            }
        },
    });

    return defineExtension({
        name: "pocket-phone",
        tools: [controlTool, screenTool, actTool, shotTool],
        sections: [section("phone", () => (control.unavailable() === undefined ? PHONE : ""))],
    });
}
