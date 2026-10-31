/**
 * Pi controls computers (PP-178): desktop apps on the owner's machines, through open-computer-use (`computer-control.ts`),
 * as phone control does Android apps (`extensions/phone.ts`).
 * - `computer_control`: start a session (one card the owner approves: the machine, the apps, the minutes Pi asks for),
 *   stop it, say how the machines stand, or set a machine's desktop setup line.
 * - `computer_screen`: an app's window as numbered elements (ocu's outline).
 * - `computer_act`: click (an element or a point of the window's picture), set a value, type, press a key, scroll, an
 *   element's other action, wait; answers with the window after it. A password field only by a saved secret's name
 *   (`secret`, as Pi's browser's `browser_type`): the secrets module checks the folder and asks first when the secret
 *   says so (`extensions/secrets.ts`), and its value reaches ocu alone, never Pi.
 * - `computer_screenshot`: a picture of the window, with marks; what the owner typed on a sign-in card blacked out.
 * - `computer_sign_in`: the owner types a username, a password or a one-time code on a card (PP-183), each straight into
 *   the element Pi named through ocu; Pi never sees them, and reads `[password for <app>]` and the like in their place.
 * - `computer_control setup` with crd (PP-263): Chrome Remote Desktop on a Windows machine, so the owner unlocks its locked
 *   screen from their phone (ocu cannot pass the lock screen): install, connect, remove, each on a card. Connect's card
 *   takes Google's command and a PIN, which go to the machine through the server (`answerCrdConnect`), never to Pi.
 * The owner's alone; never on the team server, never in plan mode.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import type { ComputerApp, ComputerSession } from "../computer-control.ts";
import { MINUTES } from "../computer-control.ts";
import { lockedNote } from "../computer-windows.ts";
import { ChromeRemoteDesktop, CRD_HEADLESS, crdConnected, crdWord, installPlan, removePlan } from "../crd.ts";
import type { DesktopApp } from "../computer-outline.ts";
import { fencedScreen } from "../fence.ts";
import type { PocketHost } from "../host.ts";
import { AREA, MARK_STYLE, MARKS_NOTE } from "../mark-schema.ts";
import { type Mark, markUp } from "../markup.ts";
import { clockText } from "../phone-events.ts";

const reply = (text: string, isError = false) => ({ output: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) });
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The sign-in card's field names: fixed, never the window's (a window could put its own words on the card). */
export const SIGN_IN_LABELS = { username: "Username", password: "Password", code: "Code" } as const;

/** The Secrets name a sign-in to an app on a machine is kept under (Remember on the card). */
export const signInSecret = (machineName: string, app: string) => `LOGIN_${`${machineName}_${app}`.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "")}`;

/** In every prompt while the module is on. */
export const COMPUTER = `Computer control: you can see and operate desktop apps on the owner's machines (Linux, and Windows with pi-phone's task: computer_control status says), in a control session the owner approves on a card. computer_control start names the machine, the apps (as computer_control status or the card's error lists them: their window titles or names) and the minutes you need (5 to 60; ask again with a new card for more); only those apps may be read or touched, so ask with a new card for another, or with follow: true when the work opens other apps (a dialog of another program). Then computer_screen reads an app's window as numbered elements, computer_act clicks, sets values, types, presses keys and scrolls, and answers with the window after it (use the newest numbers), and computer_screenshot shows the window as a picture. Prefer set_value and elements to points. Never type a password or a one-time code as text: fill a password field ([password] in the outline) with set_value or type_text and secret: "NAME" (one of the owner's saved secrets you may use, secrets_list), whose value goes into the field and never to you; otherwise call computer_sign_in with the fields' numbers (username, password, code): the owner types them on a card, they go straight into the window, and you read [password for <app>] and the like in their place. Never ask for a password or a code in the chat. pi-phone itself, banking and payment apps, password managers and the owner's Never list are never read or controlled. While the owner has taken the computer over (the panel's Take over), wait until they hand it back. Ask the owner before anything that pays, sends, books, or deletes. Stop the session with computer_control stop as soon as you are done; it also ends shortly after your turn ends. A window on the machine shows that you are using it, with Stop. Say plainly what you read or did, and what you could not.`;

export default function createComputer(host: PocketHost) {
    const control = host.computer;
    const machine = Type.Optional(Type.String({ description: "The machine (name or id); default: the one this session controls" }));
    const appParam = Type.Optional(Type.String({ description: "The app, by its label on the card or its name; default: the one the panel shows" }));

    /** The owner's Pi only: refused for guests, and on the team server. */
    const refusedFor = (conversationId: unknown): string | undefined => {
        const unavailable = control.unavailable();

        if (unavailable !== undefined) {
            return unavailable;
        }

        const asker = host.requesterOf(Number(conversationId) as never);

        return asker === undefined || host.person(asker).role !== "owner" ? "Computer control is the owner's: it works only for what the owner asks." : undefined;
    };

    /** The session this conversation's Pi controls a machine in, or why not. */
    const sessionOf = (conversationId: unknown, wanted: string | undefined): ComputerSession => {
        const refused = refusedFor(conversationId);

        if (refused !== undefined) {
            throw new Error(refused);
        }

        if (wanted !== undefined) {
            return control.sessionFor(control.machine(wanted).id, Number(conversationId));
        }

        const session = control.sessionOfConversation(Number(conversationId));

        if (session === undefined) {
            throw new Error("This session controls no computer now. Ask for one with computer_control start, naming the machine and the apps: the owner approves it on a card.");
        }

        return session;
    };

    const left = (session: ComputerSession) => `${Math.max(0, Math.ceil((session.until - Date.now()) / 60_000))} min left, until ${clockText(session.until)}`;
    const footer = (session: ComputerSession) => `(Computer control on ${session.machineName}: ${left(session)}.)`;

    /** An app of the machine's list by window title or name: exact, else the one that contains it. */
    const findApp = (apps: readonly DesktopApp[], wanted: string): DesktopApp | DesktopApp[] => {
        const name = wanted.trim().toLowerCase();
        const exact = apps.find((each) => each.name.toLowerCase() === name) ?? apps.find((each) => each.window.toLowerCase() === name) ?? apps.find((each) => each.id.toLowerCase() === name);

        if (exact !== undefined) {
            return exact;
        }

        const near = apps.filter((each) => each.window.toLowerCase().includes(name) || each.name.toLowerCase().includes(name));

        return near.length === 1 ? near[0]! : near;
    };

    const listed = (apps: readonly DesktopApp[]) =>
        apps
            .filter((each) => each.running)
            .map((each) => `${each.window || each.name} (${each.name})`)
            .join(", ") || "none with a window";

    /** How Chrome Remote Desktop stands on a Windows machine, in words, or why that is unknown. */
    const crdLine = (id: string) => host.machineTools.crd.status(id).then(crdWord, (error: unknown) => `unknown (${message(error)})`);

    /**
     * `computer_control setup` with crd (PP-263): the owner's card first, each time. Install and remove show what changes
     * (`installPlan`, `removePlan`); connect's card takes Google's command and a PIN, sent by the owner straight to the
     * server (`answerCrdConnect`), which answers the card only once the machine is connected: Pi learns the outcome, never
     * the values.
     */
    const crdSetup = async (wanted: string, what: "install" | "connect" | "remove", reason: string, api: { conversationId: unknown; callId?: string; taskId: unknown }, context: unknown) => {
        const name = wanted.trim().toLowerCase();
        const machine = host.machineStore.list().find((each) => each.id === wanted.trim()) ?? host.machineStore.list().find((each) => each.name.toLowerCase() === name);

        if (machine === undefined) {
            return reply(`There is no machine ${wanted}.`, true);
        }

        if (machine.remote === undefined) {
            return reply(`${machine.name} is not connected: connect it in Settings › Machines.`, true);
        }

        if (!ChromeRemoteDesktop.supports(machine)) {
            return reply(`Chrome Remote Desktop is for the owner's own Windows x64 machines for now (Linux and macOS come later); ${machine.name} is ${machine.remote.platform} ${machine.remote.arch}${machine.team === undefined ? "" : ", a team machine"}.`, true);
        }

        const crd = host.machineTools.crd;
        const before = await crd.status(machine.id);

        if (what === "install" && before.installed) {
            return reply(`Chrome Remote Desktop ${before.version ?? ""} is installed on ${machine.name} already: ${crdWord(before)}.${crdConnected(before) ? "" : ' Connect it with crd: "connect".'}`);
        }

        if (what !== "install" && !before.installed) {
            return reply(`Chrome Remote Desktop is not installed on ${machine.name}${what === "connect" ? ': install it first (crd: "install")' : ": nothing to remove"}.`, what === "connect");
        }

        if (what === "connect" && crdConnected(before)) {
            return reply(`Chrome Remote Desktop on ${machine.name} is connected already: the owner unlocks it from the Chrome Remote Desktop app on their phone, with their PIN. To connect it to another account, remove it first.`);
        }

        const answer = await host.approvals.request(
            {
                id: `computer_setup-${String(api.conversationId)}-${String(api.callId)}`,
                conversationId: Number(api.conversationId) as never,
                taskId: api.taskId as never,
                ...(api.callId === undefined ? {} : { callId: api.callId }),
                tool: "computer_control",
                subject:
                    what === "install" ? installPlan(machine.name) : what === "remove" ? removePlan(machine.name) : `Connect Chrome Remote Desktop on ${machine.name} to your Google account`,
                reason: reason || (what === "connect" ? "So you can unlock it from your phone" : what === "install" ? `Unlock and see ${machine.name} from your phone` : `Remove Chrome Remote Desktop from ${machine.name}`),
                ...(what === "connect" ? { form: { type: "crd-connect" as const, machine: machine.id, machineName: machine.name } } : {}),
                createdAt: Date.now(),
            },
            context as never,
        );

        if (!answer.allow) {
            return reply(`${answer.by === "superseded" ? "The request was replaced" : `${answer.by} said ${what === "connect" ? "not now" : "no"}`}: nothing changed on ${machine.name}.`, true);
        }

        if (what === "install") {
            const done = await host.machineTools.installCrd(machine.id);

            return reply(`${done.said}${done.ok ? ' Next, crd: "connect" asks the owner to connect it to their Google account on a card.' : ""}`, !done.ok);
        }

        if (what === "remove") {
            await host.machineTools.removeCrd(machine.id);

            return reply(`Chrome Remote Desktop is removed from ${machine.name}, with its host config. It stays in the owner's list at https://remotedesktop.google.com/access, offline, until they delete it there.`);
        }

        const after = await crd.status(machine.id);

        return reply(
            crdConnected(after)
                ? `Chrome Remote Desktop on ${machine.name} is connected to the owner's Google account. They unlock and see it from the Chrome Remote Desktop app on their phone (or ${CRD_HEADLESS.replace("/headless", "/access")}), with the PIN they chose; you never saw the code or the PIN.`
                : `The owner answered the card, but Chrome Remote Desktop on ${machine.name} is ${crdWord(after)} now.`,
            !crdConnected(after),
        );
    };

    const controlTool = defineTool({
        name: "computer_control",
        description:
            "Start, stop, or check a computer control session: Pi reads and operates desktop apps on one of the owner's machines (Linux and Windows) through Computer use (ocu, a machine tool). " +
            "start shows the owner one card with the machine, the apps (their window titles or names, as status lists them) and the minutes you need (5 to 60; for more, ask again); on Approve, a window on the machine says Pi is using it, with Stop. " +
            "Only those apps may be read or touched; another needs a new card, unless you ask with follow: true, which lets an app the named ones open while you act in them join (one step). pi-phone itself, banking and payment apps, password managers and the owner's Never list are refused either way. " +
            "status: each machine's state and its apps (with machine). setup: the shell line run on a machine before ocu starts, for its desktop (e.g. a virtual desktop's environment script), as the owner may set it in Menu › Computer control; a new line waits for the owner to approve it on a card. " +
            "On Windows, ocu runs in the owner's signed-in desktop through pi-phone's task (a per-user scheduled task and a bridge on 127.0.0.1): setup with task: install makes it, task: remove removes it, each after the owner approves a card that shows what changes. " +
            "ocu cannot pass Windows' lock screen; Chrome Remote Desktop (Google's host, a service) can, from the owner's phone: setup with crd: install installs it, crd: connect shows the owner a card where they paste Google's code and choose a PIN (you never see either), crd: remove removes it, each on a card. " +
            "It ends at its time, on Stop (on the machine, in the panel or the menu), with stop, or shortly after your turn ends. Owner only.",
        parameters: Type.Object({
            action: Type.Union([Type.Literal("start"), Type.Literal("stop"), Type.Literal("status"), Type.Literal("setup")]),
            machine,
            apps: Type.Optional(Type.Array(Type.String(), { description: "start: the apps, by window title or name as status lists them" })),
            minutes: Type.Optional(Type.Integer({ minimum: MINUTES.min, maximum: MINUTES.max, description: `start: how long you need, ${MINUTES.min} to ${MINUTES.max}` })),
            follow: Type.Optional(Type.Boolean({ description: "start: also the apps the named ones open while you act in them (default false)" })),
            reason: Type.Optional(Type.String({ description: "start and setup: what you will do, in a sentence: shown on the card" })),
            prepare: Type.Optional(Type.String({ description: "setup: one shell line run before ocu starts (empty: none)" })),
            task: Type.Optional(Type.Union([Type.Literal("install"), Type.Literal("remove")], { description: "setup on Windows: make or remove pi-phone's task there" })),
            crd: Type.Optional(
                Type.Union([Type.Literal("install"), Type.Literal("connect"), Type.Literal("remove")], { description: "setup on Windows: install, connect (to the owner's Google account) or remove Chrome Remote Desktop there" }),
            ),
        }),
        execute: async (args, api, context) => {
            const refused = refusedFor(api.conversationId);

            if (refused !== undefined) {
                return reply(refused, true);
            }

            try {
                const conversationId = Number(api.conversationId);

                if (args.action === "status") {
                    const lines = await Promise.all(
                        control.machinesView().map(async (each) => {
                            const state = !each.connected
                                ? "not connected"
                                : each.platform !== "linux" && each.platform !== "windows"
                                  ? `${each.platform ?? "unknown system"}: not yet`
                                  : each.ocu === null
                                    ? `ocu not installed (Settings › Machines › Install tools)${each.platform === "windows" ? `; Chrome Remote Desktop: ${await crdLine(each.id)}` : ""}`
                                    : each.platform === "windows"
                                      ? `Windows, ocu ${each.ocu}, ${await control.windowsState(each.id).then((found) => `${control.describeWindows(control.machine(each.id), found)}; Chrome Remote Desktop: ${found.crd}`, (error: unknown) => `its state unknown: ${message(error)}`)}`
                                      : `ocu ${each.ocu}${each.prepare === "" ? "" : `, desktop setup: ${each.prepare}`}`;
                            const session = each.session === null ? "" : `; session #${each.session.session} controls it until ${clockText(each.session.until)}`;

                            return `- ${each.name}: ${state}${session}`;
                        }),
                    );

                    if (args.machine !== undefined) {
                        const found = await control.ready(args.machine);
                        const apps = await control.apps(found.id);

                        lines.push(`Apps with a window on ${found.name}: ${apps.filter((each) => each.running).map((each) => `${each.window || each.name} (${each.name})${each.never === null ? "" : ` - never: ${each.never}`}`).join(", ") || "none"}.`);
                    }

                    return reply(lines.join("\n") || "No machines: add one in Settings › Machines.");
                }

                if (args.action === "setup" && args.crd !== undefined) {
                    if (args.machine === undefined) {
                        return reply("setup with crd needs machine (a Windows machine).", true);
                    }

                    return await crdSetup(args.machine, args.crd, args.reason ?? "", api, context);
                }

                if (args.action === "setup" && args.task !== undefined) {
                    if (args.machine === undefined) {
                        return reply("setup with task needs machine (a Windows machine).", true);
                    }

                    return reply(await control.setupTask(args.machine, args.task, args.reason ?? "", (request) => host.approvals.request({ ...request, id: `computer_setup-${String(api.conversationId)}-${String(api.callId)}`, conversationId: Number(api.conversationId) as never, taskId: api.taskId as never, ...(api.callId === undefined ? {} : { callId: api.callId }), createdAt: Date.now() }, context as never)));
                }

                if (args.action === "setup") {
                    if (args.machine === undefined || args.prepare === undefined) {
                        return reply("setup needs machine and prepare (one shell line, or empty for none).", true);
                    }

                    const found = await control.ready(args.machine);
                    const line = args.prepare.trim();

                    if (/[\r\n]/.test(args.prepare) || line.length > 500) {
                        return reply("Give the desktop's setup as one shell line of at most 500 characters.", true);
                    }

                    // A shell line Pi chose, kept and run on the machine before every ocu start: the owner reads it on a
                    // card first (PP-230, rule G17). Clearing it, or setting what is set, runs nothing new.
                    if (line !== "" && line !== control.prepareOf(found.id)) {
                        const answer = await host.approvals.request(
                            {
                                id: `computer_setup-${String(api.conversationId)}-${String(api.callId)}`,
                                conversationId: Number(api.conversationId) as never,
                                taskId: api.taskId as never,
                                ...(api.callId === undefined ? {} : { callId: api.callId }),
                                tool: "computer_control",
                                subject: `On ${found.name}, run this before ocu starts, each time: ${line}`,
                                reason: args.reason ?? `The desktop setup line for computer control on ${found.name}`,
                                createdAt: Date.now(),
                            },
                            context as never,
                        );

                        if (!answer.allow) {
                            return reply(`${answer.by === "superseded" ? "The request was replaced" : `${answer.by} said no`}: ${found.name}'s desktop setup stays ${control.prepareOf(found.id) === "" ? "none" : JSON.stringify(control.prepareOf(found.id))}.`, true);
                        }
                    }

                    control.setPrepare(found.id, args.prepare);
                    const apps = await control.apps(found.id);

                    return reply(`${found.name}'s desktop setup is ${args.prepare.trim() === "" ? "none" : JSON.stringify(args.prepare.trim())}. ocu reads its desktop: ${listed(apps)}.`);
                }

                if (args.action === "stop") {
                    const session = sessionOf(api.conversationId, args.machine);

                    await control.end(session.machine, "Pi stopped it");

                    return reply(`Computer control on ${session.machineName} is stopped.`);
                }

                if (args.machine === undefined) {
                    return reply("Name the machine: machine: \"build-box\" (computer_control status lists them).", true);
                }

                const wanted = args.apps ?? [];

                if (wanted.length === 0 || wanted.length > 8) {
                    return reply('Name the apps the session may use (1 to 8): apps: ["Text Editor"].', true);
                }

                const minutes = args.minutes;

                if (minutes === undefined || !Number.isInteger(minutes) || minutes < MINUTES.min || minutes > MINUTES.max) {
                    return reply(`Say how long you need: minutes, a whole number from ${MINUTES.min} to ${MINUTES.max}.`, true);
                }

                const found = await control.ready(args.machine);
                const mine = control.active(found.id);

                if (mine !== undefined && mine.conversationId !== conversationId) {
                    return reply(`Session #${mine.session}'s Pi is using ${found.name} until ${clockText(mine.until)}: one session controls it at a time.`, true);
                }

                let available: Awaited<ReturnType<typeof control.apps>>;

                try {
                    available = await control.apps(found.id);
                } catch (error) {
                    return reply(
                        found.platform === "windows"
                            ? `ocu could not read ${found.name}'s desktop: ${message(error)}`
                            : `ocu could not read ${found.name}'s desktop: ${message(error)}\nIt needs a signed-in (or virtual) desktop session there. If its desktop needs its environment set first, the owner sets that line in Menu › Computer control (or you, with computer_control setup).`,
                        true,
                    );
                }

                const apps: ComputerApp[] = [];

                for (const each of wanted) {
                    const app = findApp(available, each);

                    if (Array.isArray(app)) {
                        return reply(
                            app.length > 1
                                ? `${each} could be ${app.slice(0, 8).map((one) => `${one.window || one.name} (${one.name})`).join(", ")}: name one exactly.`
                                : `There is no app ${each} with a window on ${found.name}. Its apps: ${listed(available)}. Open the app there first (computer_act cannot start apps), or ask the owner to.`,
                            true,
                        );
                    }

                    const never = control.neverReason(app);

                    if (never !== undefined) {
                        return reply(`${app.window || app.name} (${app.name}) is ${never}: Pi never reads or controls it.`, true);
                    }

                    if (!apps.some((other) => other.name === app.name)) {
                        apps.push({ label: app.window || app.name, name: app.name });
                    }
                }

                const follow = args.follow === true;
                const answer = await host.approvals.request(
                    {
                        id: `computer_control-${String(api.conversationId)}-${String(api.callId)}`,
                        conversationId: conversationId as never,
                        taskId: api.taskId as never,
                        ...(api.callId === undefined ? {} : { callId: api.callId }),
                        tool: "computer_control",
                        subject: `Control ${found.name} for ${minutes} min: ${apps.map((each) => each.label).join(", ")}${follow ? ", and the apps these open" : ""}`,
                        reason: args.reason ?? "",
                        form: {
                            type: "computer",
                            machine: found.id,
                            machineName: found.name,
                            platform: found.platform ?? "",
                            ocu: found.tools?.ocu ?? "",
                            apps,
                            minutes,
                            follow,
                        },
                        createdAt: Date.now(),
                    },
                    context as never,
                );

                if (!answer.allow) {
                    return reply(`${answer.by === "superseded" ? "The request was replaced" : `${answer.by} said no`}: Pi does not control ${found.name}.`, true);
                }

                const session = await control.start({
                    machine: found.id,
                    machineName: found.name,
                    conversationId,
                    session: host.rootOf(conversationId),
                    approvedBy: host.requesterOf(conversationId as never) ?? "",
                    apps,
                    follow,
                    reason: args.reason ?? "",
                    minutes,
                });

                // A locked Windows screen takes no clicks or keys (PP-263): Pi hears how the owner can unlock it.
                const locked = found.platform === "windows" ? await control.windowsState(found.id) : undefined;

                return reply(
                    `Computer control is on for ${minutes} minutes (until ${clockText(session.until)}) on ${found.name}: ${apps.map((each) => `${each.label} (${each.name})`).join(", ")}${follow ? ", and apps these open while you act in them" : ""}. A window there shows it, with Stop. Read a window with computer_screen.${locked?.locked === true ? ` Note: ${found.name}'s ${lockedNote(found.name, locked.crd)}.` : ""}`,
                );
            } catch (error) {
                return reply(message(error), true);
            }
        },
    });

    const screenTool = defineTool({
        name: "computer_screen",
        description:
            "Read an app's window in a computer control session: its elements numbered ([5] push button Greet Frame: {x, y, width, height} in the window), values, password fields marked [password], the element in focus, and the session's time left. Apps outside the session are not read. full: the whole text of long fields.",
        parameters: Type.Object({ machine, app: appParam, full: Type.Optional(Type.Boolean({ description: "The whole text of long fields (default: 500 characters each)" })) }),
        execute: async (args, api) => {
            try {
                const session = sessionOf(api.conversationId, args.machine);
                const { text } = await control.screen(session, args.app, args.full === true);

                // What the window shows reaches Pi fenced as data (PP-204, S5.2); an error can quote it too.
                return reply(`${fencedScreen(text)}\n${footer(session)}`);
            } catch (error) {
                return reply(fencedScreen(message(error)), true);
            }
        },
    });

    const actTool = defineTool({
        name: "computer_act",
        description:
            "Act in an app's window in a computer control session, then answer with the window after it (use its numbers next). " +
            "click / double_click / right_click: an element by index (from the newest computer_screen) or a point x, y in the window's picture (computer_screenshot's pixels). " +
            "set_value: value into the element index (a text field, a slider): prefer it to typing. type_text: text into the field in focus. " +
            "Either takes secret: \"NAME\" (one of the owner's saved secrets, secrets_list) instead of value or text: its value goes into the field and never to you; a password field takes only that. " +
            "press_key: key, like Return, Tab, Escape, ctrl+a, Down. " +
            "scroll: the element index, direction up, down, left or right, pages. secondary_action: the element's action name (from its Secondary Actions). wait: seconds (default 2, at most 10). " +
            "Never type a password as text: a saved secret by name, or the owner types it on a card (computer_sign_in). Only in the session's apps.",
        parameters: Type.Object({
            action: Type.Union([
                Type.Literal("click"),
                Type.Literal("double_click"),
                Type.Literal("right_click"),
                Type.Literal("set_value"),
                Type.Literal("type_text"),
                Type.Literal("press_key"),
                Type.Literal("scroll"),
                Type.Literal("secondary_action"),
                Type.Literal("wait"),
            ]),
            machine,
            app: appParam,
            index: Type.Optional(Type.Integer({ minimum: 0, description: "An element's number from the newest computer_screen" })),
            x: Type.Optional(Type.Number({ description: "A point in the window's picture, in pixels from the left" })),
            y: Type.Optional(Type.Number({ description: "A point in the window's picture, in pixels from the top" })),
            value: Type.Optional(Type.String({ description: "set_value: the value" })),
            text: Type.Optional(Type.String({ description: "type_text: the text" })),
            secret: Type.Optional(Type.String({ description: "set_value / type_text: a saved secret's name (secrets_list), filled in instead of value or text" })),
            key: Type.Optional(Type.String({ description: "press_key: the key or chord" })),
            direction: Type.Optional(Type.Union([Type.Literal("up"), Type.Literal("down"), Type.Literal("left"), Type.Literal("right")])),
            pages: Type.Optional(Type.Number({ minimum: 0.1, maximum: 10, description: "scroll: how many pages (default 1)" })),
            name: Type.Optional(Type.String({ description: "secondary_action: the action's name" })),
            seconds: Type.Optional(Type.Number({ minimum: 0, maximum: 10, description: "wait: how long" })),
        }),
        execute: async (args, api) => {
            try {
                const session = sessionOf(api.conversationId, args.machine);

                if (args.action === "wait") {
                    await pause(Math.max(0, Math.min(10, args.seconds ?? 2)) * 1000);
                    const { text } = await control.screen(session, args.app);

                    return reply(`${fencedScreen(`Waited.\n\n${text}`)}\n${footer(session)}`);
                }

                const needIndex = (what: string): number => {
                    if (args.index === undefined) {
                        throw new Error(`${what} needs index, an element's number from the newest computer_screen.`);
                    }

                    return args.index;
                };
                let done: Awaited<ReturnType<typeof control.act>>;
                /** A saved secret by name, for set_value and type_text: its value, never shown. The secrets module checked first. */
                const secretValue = (given: string | undefined): { value: string; secret: string } | { error: string } => {
                    const name = args.secret!;

                    if (given !== undefined) {
                        return { error: `Give ${args.action === "set_value" ? "value" : "text"}, or a saved secret's name (secret), not both.` };
                    }

                    const value = host.secrets.value(name);

                    if (value === undefined) {
                        return { error: `There is no secret ${name}: secrets_list says which you may use.` };
                    }

                    host.secrets.used([name]);

                    return { value, secret: name };
                };

                if (args.secret !== undefined && args.action !== "set_value" && args.action !== "type_text") {
                    return reply("secret goes with set_value or type_text.", true);
                }

                switch (args.action) {
                    case "click":
                    case "double_click":
                    case "right_click":
                        done = await control.act(session, args.app, {
                            op: "click",
                            ...(args.index === undefined ? { x: args.x, y: args.y } : { index: args.index }),
                            ...(args.action === "double_click" ? { count: 2 } : {}),
                            ...(args.action === "right_click" ? { button: "right" as const } : {}),
                        });
                        break;

                    case "set_value": {
                        if (args.secret !== undefined) {
                            const found = secretValue(args.value);

                            if ("error" in found) {
                                return reply(found.error, true);
                            }

                            done = await control.act(session, args.app, { op: "set_value", index: needIndex("set_value"), value: found.value, secret: found.secret });
                            break;
                        }

                        if (args.value === undefined) {
                            return reply("set_value needs value (or secret, a saved secret's name).", true);
                        }

                        done = await control.act(session, args.app, { op: "set_value", index: needIndex("set_value"), value: args.value });
                        break;
                    }

                    case "type_text": {
                        if (args.secret !== undefined) {
                            const found = secretValue(args.text);

                            if ("error" in found) {
                                return reply(found.error, true);
                            }

                            done = await control.act(session, args.app, { op: "type_text", text: found.value, secret: found.secret });
                            break;
                        }

                        if (args.text === undefined) {
                            return reply("type_text needs text (or secret, a saved secret's name).", true);
                        }

                        done = await control.act(session, args.app, { op: "type_text", text: args.text });
                        break;
                    }

                    case "press_key":
                        if (args.key === undefined || args.key.trim() === "") {
                            return reply("press_key needs key, like Return, Tab or ctrl+a.", true);
                        }

                        done = await control.act(session, args.app, { op: "press_key", key: args.key.trim() });
                        break;

                    case "scroll":
                        if (args.direction === undefined) {
                            return reply("scroll needs a direction: up, down, left, or right.", true);
                        }

                        done = await control.act(session, args.app, { op: "scroll", index: needIndex("scroll"), direction: args.direction, ...(args.pages === undefined ? {} : { pages: args.pages }) });
                        break;

                    case "secondary_action":
                        if (args.name === undefined) {
                            return reply("secondary_action needs name, one of the element's Secondary Actions.", true);
                        }

                        done = await control.act(session, args.app, { op: "secondary_action", index: needIndex("secondary_action"), name: args.name });
                        break;
                }

                const joined = done.joined.length === 0 ? "" : `\n${done.joined.map((each) => `${each.label} (${each.name})`).join(", ")} opened from it and joined the session.`;

                // What Pi did names the element by the window's words: inside the fence, with the window.
                return reply(`${fencedScreen(`${done.did}${joined}\n\n${done.text}`)}\n${footer(session)}`);
            } catch (error) {
                return reply(fencedScreen(message(error)), true);
            }
        },
    });

    const shotTool = defineTool({
        name: "computer_screenshot",
        description: `See an app's window as a picture in a computer control session. With path, also save it (.png) where this session works. ${MARKS_NOTE} Each mark is on an element (index, from the newest computer_screen) or an area in the picture's pixels.`,
        parameters: Type.Object({
            machine,
            app: appParam,
            path: Type.Optional(Type.String({ description: "Save it here too, ending in .png: absolute or relative to this session's folder" })),
            marks: Type.Optional(
                Type.Array(Type.Object({ index: Type.Optional(Type.Integer({ minimum: 0, description: "An element, by its number" })), area: Type.Optional(AREA), ...MARK_STYLE }), {
                    maxItems: 40,
                    description: "Marks drawn on the picture",
                }),
            ),
        }),
        execute: async (args, api, context) => {
            try {
                const session = sessionOf(api.conversationId, args.machine);

                if (args.path !== undefined && !/\.png$/i.test(args.path)) {
                    return reply("Give a path ending in .png.", true);
                }

                const shot = await control.picture(session, args.app);
                const window = control.outlineOf(session, shot.app)?.size;
                const scale = window === undefined ? 1 : shot.width / window.width;
                const marks: Mark[] = (args.marks ?? []).map((mark) => {
                    const { index, area, ...style } = mark;

                    if ((index === undefined) === (area === undefined)) {
                        throw new Error("Each mark is on an element (index) or an area, not both.");
                    }

                    if (area !== undefined) {
                        return { ...style, area };
                    }

                    const frame = control.element(session, shot.app, index!).frame;

                    if (frame === undefined) {
                        throw new Error(`[${index}] has no frame in the outline to mark.`);
                    }

                    return { ...style, area: { x: frame.x * scale, y: frame.y * scale, width: frame.width * scale, height: frame.height * scale } };
                });
                // What the owner typed on a sign-in card is blacked out, over every other mark (PP-183, as PP-228 in Pi's browser).
                const hidden: Mark[] = shot.hidden.map((frame) => ({ area: { x: frame.x * scale, y: frame.y * scale, width: frame.width * scale, height: frame.height * scale }, hide: "solid", box: false }));
                let bytes: Uint8Array = Buffer.from(shot.png, "base64");

                if (marks.length + hidden.length > 0) {
                    bytes = markUp(bytes, [...marks, ...hidden], { png: true }).bytes;
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
                        { type: "text" as const, text: `${shot.app.label} on ${session.machineName} (${shot.width}x${shot.height} px; points and marks in these pixels).${saved} ${footer(session)}` },
                        { type: "image" as const, data: Buffer.from(bytes).toString("base64"), mimeType: "image/png" },
                    ],
                };
            } catch (error) {
                return reply(message(error), true);
            }
        },
    });

    const signInTool = defineTool({
        name: "computer_sign_in",
        description:
            "Ask the owner to sign in in an app's window of a computer control session: they type the username, the password or a one-time code on a card (or use a sign-in kept in Secrets), and each goes straight into the element you name, by its number from the newest computer_screen. " +
            "You never see them: what you read of the window shows [username for <app>], [password for <app>] or [code for <app>] instead. " +
            "Use it whenever a window asks for a password or a code and no saved secret of yours fits; never ask for one in the chat. The owner can say Not now. Then submit the form yourself (its sign-in button, or computer_act press_key Return).",
        parameters: Type.Object({
            machine,
            app: appParam,
            username: Type.Optional(Type.Integer({ minimum: 0, description: "The username or email field's number, if the window has one" })),
            password: Type.Optional(Type.Integer({ minimum: 0, description: "The password field's number, if the window has one" })),
            code: Type.Optional(Type.Integer({ minimum: 0, description: "The one-time code field's number, if the window has one" })),
        }),
        execute: async (args, api, context) => {
            try {
                const session = sessionOf(api.conversationId, args.machine);
                const app = control.app(session, args.app);
                const named = (["username", "password", "code"] as const).flatMap((name) => {
                    const index = args[name];

                    return index === undefined ? [] : [{ name, index }];
                });

                if (named.length === 0) {
                    return reply("Name the username field, the password field or the code field (or several), by their numbers from the newest computer_screen.", true);
                }

                if (new Set(named.map((field) => field.index)).size !== named.length) {
                    return reply("Name a different element for each field.", true);
                }

                for (const field of named) {
                    // Still the element Pi read (or why not, in the window's words: fenced below).
                    const element = control.element(session, app, field.index);

                    if (field.name === "username" && element.password) {
                        return reply(`[${field.index}] is a password field: name it as password.`, true);
                    }
                }

                // A sign-in (not a code alone) may be kept in Secrets, and used from there next time.
                const secret = named.some((field) => field.name !== "code") ? signInSecret(session.machineName, app.name) : undefined;
                const answer = await host.approvals.request(
                    {
                        id: `computer_sign_in-${String(api.taskId)}-${String(api.callId)}`,
                        conversationId: Number(api.conversationId) as never,
                        taskId: api.taskId as never,
                        ...(api.callId === undefined ? {} : { callId: api.callId }),
                        tool: "computer_sign_in",
                        subject: `Sign in to ${app.label} on ${session.machineName}`,
                        reason: "What the owner types goes into the window; Pi never sees it.",
                        form: {
                            type: "computer-sign-in",
                            machine: session.machine,
                            machineName: session.machineName,
                            app,
                            fields: named.map((field) => ({ ...field, label: SIGN_IN_LABELS[field.name] })),
                            ...(secret === undefined ? {} : { secret, saved: host.secrets.has(secret) }),
                        },
                        createdAt: Date.now(),
                    },
                    context as never,
                );

                if (!answer.allow) {
                    return reply(`${answer.by === "superseded" ? "The request was replaced" : `${answer.by} said not now`}: nothing was filled in.`, true);
                }

                let window: string;

                try {
                    window = (await control.screen(session, app.name)).text;
                } catch (error) {
                    window = `The window could not be read again: ${message(error)}`;
                }

                return reply(
                    `The owner filled in the card's fields; you never see what. Submit the form yourself (its sign-in button, or computer_act press_key Return).\n${fencedScreen(`Filled ${named.map((field) => `[${field.name} for ${app.label}] into [${field.index}]`).join(", ")}.\n\n${window}`)}\n${footer(session)}`,
                );
            } catch (error) {
                return reply(fencedScreen(message(error)), true);
            }
        },
    });

    return defineExtension({
        name: "pocket-computer",
        tools: [controlTool, screenTool, actTool, shotTool, signInTool],
        sections: [section("computer", () => (control.unavailable() === undefined ? COMPUTER : ""))],
    });
}
