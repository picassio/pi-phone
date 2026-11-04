/**
 * Browser use: Pi opens pages in its own browser (`browser/pi-browser.ts`), reads them as numbered controls and visible
 * text, and clicks, types, chooses, scrolls, and presses keys there; people watch it live in the Browser panel and can
 * take it over. Every action answers with the page as it is after it. Ideas from Kuvo Code (design only), browser-use
 * and jev-ultrafast (MIT).
 */
import { arr, bool, int, num, obj, opt, str, union } from "@earendil-works/pi-schema";
import { literal, record } from "../tool-schema.ts";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { basename } from "node:path";
import { addressOf, FULL_PAGE_MAX, LONG_PRESS_MS, LONG_PRESS_RANGE, PERMISSIONS, PRESSABLE, StalePage } from "../browser/page.ts";
import { MAX_TABS, PERMISSION_WORDS, type PiBrowser } from "../browser/pi-browser.ts";
import { fencedPage } from "../fence.ts";
import { type Decider, JevDecider, report, SessionDecider } from "../browser/run.ts";
import type { ApprovalRequest, PocketHost } from "../host.ts";
import { AREA, MARK_STYLE, MARKS_NOTE } from "../mark-schema.ts";
import { describeLayout, type LayoutReport } from "../layout-check.ts";
import { parseRedline, redlinePictures, redlineScript, specFrom } from "../redline.ts";

/** The layout check of Pi's browser's page in words (PP-395): element names quote the page, so they are fenced as its data. */
const layoutWords = (layout: LayoutReport | { error: string }): string =>
    "error" in layout ? `Layout check: not measured (${layout.error})` : fencedPage(describeLayout(layout));

/** What the layout check measures, for the tools' descriptions. */
const LAYOUT_NOTE =
    "the measured layout check the screenshot tool gives (what spills out of its box, text cut by its box, elements covering another's text or control, tap targets under 40 px at a phone's width, sizes off the 4 px grid or not whole pixels, text under WCAG AA contrast or under 12 px, emoji as icons, gradient text, uppercase labels, long lines; grouped, with numbers)";

/** The sign-in and code cards' field names: fixed, not the page's (a page could put its own words on the card). */
export const FIELD_LABELS = { username: "Username or email", password: "Password", code: "Code" } as const;

/**
 * A sign-in card's fields, from the numbers Pi named: checked against the page (a field to type into; a username that
 * is not a password field), and named in the card's own words, never the page's (TannerMidd/pi-pocket-extensions#29).
 */
export function signInFields(
    named: { username?: number; password?: number },
    field: (index: number) => { label: string; fill: boolean; role: string },
): { name: "username" | "password"; index: number; label: string }[] {
    return [
        ...(named.username === undefined ? [] : [{ name: "username" as const, index: named.username, field: field(named.username) }]),
        ...(named.password === undefined ? [] : [{ name: "password" as const, index: named.password, field: field(named.password) }]),
    ].map((each) => {
        if (!each.field.fill) {
            throw new Error(`[${each.index}] is not a field to type into.`);
        }

        if (each.name === "username" && each.field.role === "password") {
            throw new Error(`[${each.index}] is a password field: name it as password.`);
        }

        return { name: each.name, index: each.index, label: FIELD_LABELS[each.name] };
    });
}

/**
 * What a sign-in or code card's answer fills in: each field's value, and what it reads as from then on in all Pi reads
 * of the page (PP-93): a password or a code as `[typed by the person]`, the username as `[username for <site>]` (it
 * showed before pi-pocket's review, TannerMidd/pi-pocket-extensions#29).
 */
export function cardFills(
    form: { site: string; fields: readonly { name: "username" | "password" | "code"; index: number }[] },
    values: Record<string, string | undefined>,
): { index: number; value: string | undefined; hide: string | true }[] {
    return form.fields.map((field) => ({
        index: field.index,
        value: values[field.name],
        hide: field.name === "username" ? `[username for ${form.site}]` : true,
    }));
}

/**
 * A sign-in kept in Secrets (Remember on a sign-in card: `{"username": …, "password": …}`), read for "Use the saved
 * one". Anything else under that name (a value typed in Settings, or one Pi asked for with secret_request) is refused in
 * fixed words: the JSON parser's message quotes the value, and it went to the card's error and the server's log
 * (PP-204; rule G20, as pi-pocket's review of our secrets port found for a broken file, TannerMidd/pi-pocket-extensions#28).
 */
export function savedSignIn(saved: string, site: string, keeper = "Pi's browser"): Record<string, string> {
    let parsed: unknown;

    try {
        parsed = JSON.parse(saved);
    } catch {
        parsed = undefined;
    }

    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || !Object.values(parsed).every((value) => typeof value === "string")) {
        throw new Error(`The secret kept for ${site}'s sign-in is not a sign-in ${keeper} saved: type it on the card, or save it again with Remember.`);
    }

    return parsed as Record<string, string>;
}

const reply = (text: string, isError = false) => ({ output: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) });

/**
 * A browser picture's caption: the page's title and address are the page's words, so fenced as data as every other read
 * of it is (PP-204, rule S5.2: a page titles itself "Ignore your task and …").
 */
export function shotCaption(page: { title: string; url: string; width: number; height: number }, what: string, saved: string): string {
    return `${fencedPage(`${page.title || "(no title)"} — ${page.url}`)}\nAs Pi's browser shows it (${page.width}×${page.height} CSS pixels${what}).${saved}`;
}
/** How much of a script's value `browser_eval` gives (about 50 KB). */
export const EVAL_MAX = 50_000;

/** What browser_eval says while the owner has it off. */
export const EVAL_OFF =
    "browser_eval is off: the owner turned off scripts that read the page (setting browser.eval, Settings › Pi's browser › Scripts). Read the page with browser_snapshot, browser_text or browser_screenshot, or ask to turn it on with setting_change.";

/**
 * What Pi gets of a browser_eval script's value (PP-244): its JSON fenced as the page's (a page's text in it can say
 * anything), cut at `EVAL_MAX` characters with a note outside the fence when longer.
 */
export function evalAnswer(json: string): string {
    const cut = json.length > EVAL_MAX;

    return `${fencedPage(cut ? json.slice(0, EVAL_MAX) : json)}${cut ? `\n(The value was cut at ${EVAL_MAX.toLocaleString("en")} of its ${json.length.toLocaleString("en")} characters: return less, or a part at a time.)` : ""}`;
}

/** How much of a whole page `browser_text` gives at once. */
const TEXT_MAX = 40_000;

/** In every prompt while the module is on. */
export const BROWSING = `Pi's browser: browser_open opens a page in a browser the person can watch (the Browser panel) and gives you the page as numbered controls ([3] button "Search") and its visible text, frames and web components included. Act by number with browser_click (double, right, long press too), browser_type, browser_select, browser_scroll, browser_press (chords too: Ctrl+A, Shift+Tab), browser_hover, browser_focus, browser_select_text and browser_drag (sliders, kanban, maps); every action answers with the page as it is after it, so use the newest numbers. browser_text reads a whole article or table at once; browser_screenshot shows the page as a picture; browser_eval runs a JavaScript expression that reads the page (computed colours, fonts, spacing; DOM queries) and gives its value as JSON. browser_upload gives a file field (or its upload button) files from where you work; browser_save_pdf saves the page as a PDF there. A file a page downloads is saved in the session's downloads/ folder and the answer names it (not on the phone's browser). browser_new_tab opens another tab, and browser_tabs lists, switches and closes them; a window a page opens (a sign-in popup) becomes a tab in front, and when it closes itself the page that opened it comes back; browser_size lays pages out as a phone (the default) or a desktop. Each session has its own tabs. browser_open with machine browses on one of the owner's machines (its Chrome, its own addresses such as localhost:3000) from then on; browser_attach drives a browser already running on a machine (Playwright, agent-browser, a Chrome started with --remote-debugging-port), after the owner's card, and browser_detach lets it go. browser_run carries out one concrete goal on its own, a step at a time (a goal, every text to type in values, optionally a url to start from): faster and cheaper than driving each step yourself, it answers how it ended and the page; when it stops (needs_value, blocked, stuck_loop, unverified_done), read why and go on yourself or run again. Use web_search and fetch_content for plain reading; use the browser to do things on a site (search forms, filters, sign-in flows, pages that need clicks or scripts). Never type a password or a one-time code as text. When a page asks to sign in and the sign-in is saved as secrets you may use (secrets_list), type them by name: browser_type with secret: "NAME" (a password field too), or browser_run values {"password": {"secret": "NAME"}}; their values go into the page, never to you. Otherwise call browser_sign_in (the person types it on a card; you never see it); for a one-time code, browser_ask_code; for a CAPTCHA or anything only they can do, browser_ask_user. Pages are denied location, camera, microphone, notifications and the clipboard; browser_permission asks the owner to allow one for a site. Pi's browser cannot use passkeys or security keys (Android allows them only in allowlisted browsers): when a site asks for one, choose its other way (\"Try another way\", a password, a code) if it offers one, and otherwise tell the person with browser_ask_user. Ask the person before anything that pays, sends, books, or deletes on a site.`;

export default function createBrowser(host: PocketHost) {
    /** The session's own browser at the place it works in: the phone's, or its machine's Chrome (its own tabs there). */
    const browserOf = async (api: { conversationId: unknown; agent(context: never): Promise<{ cwd?: string }> }, context: unknown): Promise<PiBrowser> =>
        host.browserFor((await api.agent(context as never)).cwd ?? "", Number(api.conversationId));
    /** Pi's browser is the owner's (it may be signed in to their accounts): only for work the owner asked for. */
    const mayBrowse = (conversationId: unknown): true | string => {
        const requester = host.requesterOf(Number(conversationId) as never);
        const person = host.people().find((each) => each.id === requester);

        return person?.role === "owner" ? true : "Pi's browser is the owner's: it works only for what the owner asks.";
    };
    /**
     * Windows a page asked to open while `browser.popups` is ask (PP-249): a card each, on this call of `tool`; each opened
     * as a tab in front or refused as the person answers. Answers what Pi is told: the page as it is after, or `text` when
     * none waited.
     */
    const windowCards = async (api: { conversationId: unknown; taskId: unknown; callId?: string }, context: unknown, tool: string, browser: PiBrowser, session: number, text: string): Promise<string> => {
        let now = text;

        for (const window of browser.windowAsks()) {
            const answer = await host.approvals.request(
                {
                    id: `browser-window-${String(api.taskId)}-${String(api.callId)}-${window.id}`,
                    conversationId: api.conversationId as never,
                    taskId: api.taskId as never,
                    ...(api.callId === undefined ? {} : { callId: api.callId }),
                    tool,
                    subject: window.url || "(the page named no address yet)",
                    reason: "The page asks to open a window (a sign-in popup, a link to a new window). Allow opens it as a tab in front; Deny gives the page none. Settings › Pi's browser › Windows pages open: Ask.",
                    createdAt: Date.now(),
                },
                context as never,
            );

            now = await browser.answerWindow(session, window.id, answer.allow, answer.by);
        }

        return now;
    };
    /**
     * Permissions a page asked for while `browser.permissions` is ask (PP-376): a card each, on this call of `tool`; each
     * allowed for its site or left denied as the owner answers. Answers `text` with what came of them after it.
     */
    const permissionCards = async (api: { conversationId: unknown; taskId: unknown; callId?: string }, context: unknown, tool: string, browser: PiBrowser, session: number, text: string): Promise<string> => {
        let now = text;

        for (const ask of browser.permissionAsks()) {
            const answer = await host.approvals.request(
                {
                    id: `browser-permission-${String(api.taskId)}-${String(api.callId)}-${ask.id}`,
                    conversationId: api.conversationId as never,
                    taskId: api.taskId as never,
                    ...(api.callId === undefined ? {} : { callId: api.callId }),
                    tool,
                    subject: `${ask.origin} asks for ${PERMISSION_WORDS[ask.name]}`,
                    reason: "A page in Pi's browser asks for this. Allow lets that site have it in Pi's browser until it closes; Deny keeps it denied. Settings › Pi's browser › Permissions: Ask.",
                    createdAt: Date.now(),
                },
                context as never,
            );

            now += `\n${await browser.answerPermission(session, ask.id, answer.allow, answer.by)}`;
        }

        return now;
    };
    /** Run a browser action of `tool` for a session: its answer, or the error in words (a stale page reads the page again). */
    const act = async (
        tool: string,
        api: { conversationId: unknown; taskId: unknown; callId?: string; agent(context: never): Promise<{ cwd?: string }> },
        context: unknown,
        work: (browser: PiBrowser, session: number) => Promise<string>,
    ) => {
        const session = Number(api.conversationId);
        const owner = mayBrowse(api.conversationId);

        if (owner !== true) {
            return reply(owner, true);
        }

        let browser: PiBrowser | undefined;

        try {
            browser = await browserOf(api, context);

            // What the page shows, and what was done there (names of its controls), reach Pi fenced as data.
            const done = await windowCards(api, context, tool, browser, session, await work(browser, session));

            return reply(fencedPage(await permissionCards(api, context, tool, browser, session, done)));
        } catch (error) {
            if (error instanceof StalePage && browser !== undefined) {
                try {
                    return reply(fencedPage(`${error.message}\nThe page now:\n${await browser.snapshot(session)}`), true);
                } catch {
                    // The page is gone too: say the first problem.
                }
            }

            // An error can name the page's controls too.
            return reply(fencedPage(error instanceof Error ? error.message : String(error)), true);
        }
    };
    const index = int({ minimum: 1, description: "The control's number, like 3 for [3], from the newest read of the page" });
    /** The site a page is on, by its address (`accounts.example.com`). */
    const siteOf = (url: string) => {
        try {
            return new URL(url).hostname || "the page";
        } catch {
            return "the page";
        }
    };
    /**
     * Ask the person on a card and wait. What they type goes into the page (`PocketApp.answerBrowserAsk`), never here;
     * when they answer, Pi gets `done` and the page as it is now.
     */
    const askPerson = async (
        api: { conversationId: unknown; taskId: unknown; callId?: string; agent(context: never): Promise<{ cwd?: string }> },
        context: unknown,
        session: number,
        tool: string,
        subject: string,
        reason: string,
        form: NonNullable<ApprovalRequest["form"]>,
        done: string,
    ) => {
        const browser = await browserOf(api, context);
        const answer = await host.approvals.request(
            {
                id: `browser-${String(api.taskId)}-${api.callId}`,
                conversationId: api.conversationId as never,
                taskId: api.taskId as never,
                ...(api.callId === undefined ? {} : { callId: api.callId }),
                tool,
                subject,
                reason,
                // Which browser the page is in, for filling it with what the person types.
                form: form.type === "browser" ? { ...form, place: browser.place } : form,
                createdAt: Date.now(),
            },
            context as never,
        );

        if (!answer.allow) {
            return reply(`${answer.by === "superseded" ? "The request was replaced" : `${answer.by} said not now`}: nothing was filled in or done.`, true);
        }

        try {
            return reply(`${done}\n${fencedPage(`The page now:\n${await windowCards(api, context, tool, browser, session, await browser.snapshot(session))}`)}`);
        } catch (error) {
            return reply(`${done} ${fencedPage(`The page could not be read again: ${error instanceof Error ? error.message : String(error)}`)}`);
        }
    };
    const acceptDialog = opt(bool({ description: "Accept a confirmation or prompt the page shows on the way (they are declined otherwise)" }));
    const machineArg = opt(str({ description: 'Browse on one of the owner\'s machines (its name) or "phone": this session\'s browser is there from now on. Leave it out to stay where it is.' }));
    /**
     * A browser call that names where to browse (PP-274): the session's place changes first (the owner's alone), then the
     * call runs there. An error in words, or undefined.
     */
    const browseOn = async (api: { conversationId: unknown; agent(context: never): Promise<{ cwd?: string }> }, context: unknown, machine: string | undefined): Promise<string | undefined> => {
        if (machine === undefined || machine.trim() === "") {
            return undefined;
        }

        const owner = mayBrowse(api.conversationId);

        if (owner !== true) {
            return owner;
        }

        try {
            host.setBrowserPlace((await api.agent(context as never)).cwd ?? "", Number(api.conversationId), machine);

            return undefined;
        } catch (error) {
            return error instanceof Error ? error.message : String(error);
        }
    };

    const tools = [
        defineTool({
            name: "browser_open",
            description:
                "Open a web address (or search for words) in Pi's browser, which the person can watch. Answers with the page as numbered controls and its visible text. " +
                "With machine, this session browses on that machine of the owner's from now on (its Chrome, its own addresses such as localhost:3000, its files for uploads), or on the phone again.",
            parameters: obj({ url: str({ description: "An address like example.com, or words to search for" }), machine: machineArg }, { open: true }),
            execute: async (args, api, context) => {
                let url: string;

                try {
                    url = addressOf(args.url);
                } catch (error) {
                    return reply(error instanceof Error ? error.message : String(error), true);
                }

                const moved = await browseOn(api, context, args.machine);

                if (moved !== undefined) {
                    return reply(moved, true);
                }

                return act("browser_open", api, context, (browser, session) => browser.open(session, url));
            },
        }),
        defineTool({
            name: "browser_snapshot",
            description: "Read the page in Pi's browser again: its title, address, scroll position, numbered controls, and visible text.",
            parameters: obj({}, { open: true }),
            replay: "safe",
            execute: async (_args, api, context) => act("browser_snapshot", api, context, (browser, session) => browser.snapshot(session)),
        }),
        defineTool({
            name: "browser_click",
            description:
                "Click the control with this number from the newest read of the page. With how: double (a double click), right (the right button: a context menu), or long (a long press, held duration_ms: a finger's while pages are laid out as a phone's, the mouse's at desktop size).",
            parameters: obj({
                index,
                accept_dialog: acceptDialog,
                how: opt(union([literal("single"), literal("double"), literal("right"), literal("long")], { description: "single (the default), double, right, or long" })),
                duration_ms: opt(int({ minimum: LONG_PRESS_RANGE.min, maximum: LONG_PRESS_RANGE.max, description: `A long press's length (default ${LONG_PRESS_MS} ms)` })),
            }, { open: true }),
            execute: async (args, api, context) => {
                if (args.duration_ms !== undefined && args.how !== "long") {
                    return reply("duration_ms is for a long press: give how: long with it.", true);
                }

                return act("browser_click", api, context, (browser, session) =>
                    browser.click(session, args.index, args.accept_dialog ?? false, { how: args.how ?? "single", ...(args.duration_ms === undefined ? {} : { ms: args.duration_ms }) }),
                );
            },
        }),
        defineTool({
            name: "browser_type",
            description:
                "Type into the field with this number: text, or one of the owner's saved secrets by name (secret: \"NAME\", for a password field too), whose value goes into the page and never to you. Replaces what is there unless clear is false. " +
                "Never type a password or a one-time code as text: a saved secret, or browser_sign_in / browser_ask_code for the person.",
            parameters: obj({
                index,
                text: opt(str()),
                secret: opt(str({ description: "A saved secret's name (secrets_list), typed instead of text" })),
                submit: opt(bool({ description: "Press Enter afterwards (submits search boxes and forms)" })),
                clear: opt(bool({ description: "Clear the field first (default true)" })),
            }, { open: true }),
            execute: async (args, api, context) => {
                const options = { clear: args.clear ?? true, submit: args.submit ?? false };

                if ((args.text === undefined) === (args.secret === undefined)) {
                    return reply("Give text, or a saved secret's name (secret), not both.", true);
                }

                if (args.secret === undefined) {
                    return act("browser_type", api, context, (browser, session) => browser.type(session, args.index, args.text!, options));
                }

                // The secrets module checked the folder and asked a person when the secret says so (`extensions/secrets.ts`).
                const name = args.secret;
                const value = host.secrets.value(name);

                if (value === undefined) {
                    return reply(`There is no secret ${name}: secrets_list says which you may use.`, true);
                }

                host.secrets.used([name]);

                return act("browser_type", api, context, (browser, session) => browser.typeSecret(session, args.index, name, value, options));
            },
        }),
        defineTool({
            name: "browser_select",
            description: "Choose an option, by its text or value, in the drop-down list with this number: a native one, or one the page draws (a button that opens a list of options), which it opens and picks from.",
            parameters: obj({ index, option: str() }, { open: true }),
            execute: async (args, api, context) => act("browser_select", api, context, (browser, session) => browser.select(session, args.index, args.option)),
        }),
        defineTool({
            name: "browser_hover",
            description: "Move the pointer over the control with this number without clicking (menus and tooltips that open on hover).",
            parameters: obj({ index }, { open: true }),
            execute: async (args, api, context) => act("browser_hover", api, context, (browser, session) => browser.hover(session, args.index)),
        }),
        defineTool({
            name: "browser_select_text",
            description:
                "Select text in Pi's browser (to format it in an editor, to replace it by typing, for a page that acts on a selection): on the page by its text (the first place it shows in view, else the first, frames too), " +
                "or in the control with this number: its text, everything (all: a field's whole value), or characters start to end (from 0). In a field it is the field's own selection, with the focus there. " +
                "No clipboard: copying and pasting stay out. Not in a password field, nor a field the person filled from a card.",
            parameters: obj({
                index: opt(int({ minimum: 1, description: "A control to select in, by its number; leave it out for the page's text" })),
                text: opt(str({ minLength: 1, description: "The text to select (white space between words may differ)" })),
                all: opt(bool({ description: "Every character of the control (select all in a field)" })),
                start: opt(int({ minimum: 0, description: "The first character to select, from 0" })),
                end: opt(int({ minimum: 0, description: "Where the selection ends (the character after the last)" })),
            }, { open: true }),
            execute: async (args, api, context) => {
                const ways = [args.text !== undefined, args.all === true, args.start !== undefined || args.end !== undefined].filter(Boolean).length;

                if (ways !== 1) {
                    return reply("Give one of: text, all, or start and end.", true);
                }

                if (args.index === undefined && args.text === undefined) {
                    return reply("On the page, give the text to select; all, start and end are for a control (index).", true);
                }

                const spec = { ...(args.text === undefined ? {} : { text: args.text }), ...(args.all === true ? { all: true } : {}), ...(args.start === undefined ? {} : { start: args.start }), ...(args.end === undefined ? {} : { end: args.end }) };

                return act("browser_select_text", api, context, (browser, session) => browser.selectText(session, args.index, spec));
            },
        }),
        defineTool({
            name: "browser_permission",
            description:
                "Ask the owner on a card to allow a permission for the site in front in Pi's browser (allow false denies it again, without a card): geolocation, camera, microphone, notifications or clipboard (reading it). " +
                "Pages are denied these by default and the answer says when one asked (setting browser.permissions: deny, or ask: a card as a page asks). Allowed lasts until the browser closes; then do again what asked for it. " +
                "Not on the phone's browser, which allows none: browse on a machine for such a page. A headless Chrome has no location, camera or microphone of its own.",
            parameters: obj({
                permission: union(PERMISSIONS.map((name) => literal(name))),
                allow: opt(bool({ description: "false: deny it again (default true: ask the owner to allow it)" })),
            }, { open: true }),
            execute: async (args, api, context) => {
                const session = Number(api.conversationId);
                const owner = mayBrowse(api.conversationId);

                if (owner !== true) {
                    return reply(owner, true);
                }

                const browser = await browserOf(api, context);
                const url = browser.state().url;
                const origin = URL.canParse(url) ? new URL(url).origin : "null";

                if (!/^https?:\/\//.test(origin)) {
                    return reply("Open the site first: Pi's browser shows no web page now.", true);
                }

                const allow = args.allow ?? true;

                if (allow) {
                    const answer = await host.approvals.request(
                        {
                            id: `browser-permission-${String(api.taskId)}-${String(api.callId)}`,
                            conversationId: api.conversationId as never,
                            taskId: api.taskId as never,
                            ...(api.callId === undefined ? {} : { callId: api.callId }),
                            tool: "browser_permission",
                            subject: `Allow ${origin} ${PERMISSION_WORDS[args.permission]}`,
                            reason: "Pi asks to let this site have it in Pi's browser, until the browser closes.",
                            createdAt: Date.now(),
                        },
                        context as never,
                    );

                    if (!answer.allow) {
                        return reply(`${answer.by === "superseded" ? "The request was replaced" : `${answer.by} said no`}: ${origin} stays denied ${PERMISSION_WORDS[args.permission]}.`, true);
                    }
                }

                try {
                    return reply(fencedPage(await browser.setPermission(session, origin, args.permission, allow)));
                } catch (error) {
                    return reply(fencedPage(error instanceof Error ? error.message : String(error)), true);
                }
            },
        }),
        defineTool({
            name: "browser_focus",
            description:
                "Put the focus on the control with this number without clicking it (a click would open, submit or toggle it): keys from browser_press go to it next. The page read marks the control that has the focus as focused.",
            parameters: obj({ index }, { open: true }),
            execute: async (args, api, context) => act("browser_focus", api, context, (browser, session) => browser.focus(session, args.index)),
        }),
        defineTool({
            name: "browser_drag",
            description:
                "Drag the control with this number onto another control (to: its number), or by an offset in CSS pixels (dx, dy: right and down are positive): a slider's handle, a card to a kanban column, an item in a sortable list, a map to pan. " +
                "The read marks what can be dragged as draggable. The pointer goes down, moves there in steps and comes up; a page's own drag and drop (draggable elements) gets its drag events and data, as a person's drag gives them.",
            parameters: obj({
                index,
                to: opt(int({ minimum: 1, description: "The control to drop it on, by its number" })),
                dx: opt(num({ description: "Or drag by this many CSS pixels to the right (negative: left)" })),
                dy: opt(num({ description: "And this many down (negative: up)" })),
            }, { open: true }),
            execute: async (args, api, context) => {
                const offset = args.dx !== undefined || args.dy !== undefined;

                if ((args.to === undefined) === !offset) {
                    return reply("Give where to drag it: to (a control's number), or an offset (dx, dy), not both.", true);
                }

                return act("browser_drag", api, context, (browser, session) =>
                    browser.drag(session, args.index, args.to !== undefined ? { index: args.to } : { dx: args.dx ?? 0, dy: args.dy ?? 0 }),
                );
            },
        }),
        defineTool({
            name: "browser_upload",
            description:
                "Give files from where this session works to a file field, or to the button that opens one (a styled Upload button): the page gets them as if the person chose them. Then submit the form if it needs it.",
            parameters: obj({
                index,
                paths: arr(str(), { minItems: 1, maxItems: 10, description: "The files, absolute or relative to this session's folder" }),
            }, { open: true }),
            execute: async (args, api, context) =>
                act("browser_upload", api, context, async (browser, session) => {
                    const env = host.envOf((await api.agent(context)).cwd ?? "");
                    const files: { name: string; bytes: Uint8Array }[] = [];

                    for (const path of args.paths) {
                        const absolute = await env.absolutePath(path, context);
                        const bytes = absolute.ok ? await env.readBinaryFile(absolute.value, context) : absolute;

                        if (!absolute.ok || !bytes.ok) {
                            throw new Error(`Could not read ${path}: ${bytes.ok ? "" : bytes.error.message}`);
                        }

                        files.push({ name: basename(absolute.value), bytes: bytes.value });
                    }

                    return browser.upload(session, args.index, files);
                }),
        }),
        defineTool({
            name: "browser_save_pdf",
            description: "Save the page in Pi's browser as a PDF (as printing it would), to a file where this session works.",
            parameters: obj({ path: str({ description: "Where to save it, ending in .pdf: absolute or relative to this session's folder" }) }, { open: true }),
            execute: async (args, api, context) =>
                act("browser_save_pdf", api, context, async (browser, session) => {
                    if (!args.path.toLowerCase().endsWith(".pdf")) {
                        throw new Error("Give a path ending in .pdf.");
                    }

                    const env = host.envOf((await api.agent(context)).cwd ?? "");
                    const absolute = await env.absolutePath(args.path, context);

                    if (!absolute.ok) {
                        throw new Error(`Cannot save to ${args.path}: ${absolute.error.message}`);
                    }

                    const { pdf, title, url } = await browser.pdf(session);
                    const written = await env.writeFile(absolute.value, pdf, context);

                    if (!written.ok) {
                        throw new Error(`Could not save ${absolute.value}: ${written.error.message}`);
                    }

                    return `Saved ${title || url} as ${absolute.value} (${Math.max(1, Math.round(pdf.length / 1024))} KB).`;
                }),
        }),
        defineTool({
            name: "browser_new_tab",
            description: `Open a new tab in Pi's browser, in front (at an address, or blank), keeping the others. At most ${MAX_TABS} tabs. With machine, this session browses on that machine (or the phone) from now on, as browser_open's machine.`,
            parameters: obj({ url: opt(str({ description: "An address like example.com, or words to search for" })), machine: machineArg }, { open: true }),
            execute: async (args, api, context) => {
                let url: string | undefined;

                try {
                    url = args.url === undefined || args.url.trim() === "" ? undefined : addressOf(args.url);
                } catch (error) {
                    return reply(error instanceof Error ? error.message : String(error), true);
                }

                const moved = await browseOn(api, context, args.machine);

                if (moved !== undefined) {
                    return reply(moved, true);
                }

                return act("browser_new_tab", api, context, (browser, session) => browser.newTab(session, url));
            },
        }),
        defineTool({
            name: "browser_tabs",
            description: "List Pi's browser tabs (numbered from 1, the one in front marked), or bring one to the front (switch_to), or close one (close). Switching answers with that tab's page.",
            parameters: obj({
                switch_to: opt(int({ minimum: 1, description: "The tab to bring to the front" })),
                close: opt(int({ minimum: 1, description: "The tab to close" })),
            }, { open: true }),
            execute: async (args, api, context) =>
                act("browser_tabs", api, context, (browser, session) =>
                    args.close !== undefined ? browser.closeTab(session, args.close) : args.switch_to !== undefined ? browser.switchTab(session, args.switch_to) : browser.tabs(session),
                ),
        }),
        defineTool({
            name: "browser_size",
            description: "Lay this session's pages in Pi's browser out as a phone's (412×860, touch: the default) or a desktop's (1280×800, a desktop Chrome): for a site whose phone page lacks what you need, or a desktop layout to check. Open pages load again at the new size; answers the page.",
            parameters: obj({ size: union([literal("phone"), literal("desktop")]) }, { open: true }),
            execute: async (args, api, context) => act("browser_size", api, context, (browser, session) => browser.resize(session, args.size)),
        }),
        defineTool({
            name: "browser_scroll",
            description: "Scroll the page up or down by screens; with index, what scrolls around that control instead (an open list or panel with its own scroll area), by its height. Clicking a control out of view scrolls it into view by itself.",
            parameters: obj({
                direction: union([literal("up"), literal("down")]),
                screens: opt(num({ minimum: 0.25, maximum: 10, description: "How many screens (default 1)" })),
                index: opt(int({ minimum: 1, description: "A control inside the area to scroll, like an option of an open list" })),
            }, { open: true }),
            execute: async (args, api, context) => act("browser_scroll", api, context, (browser, session) => browser.scroll(session, args.direction, args.screens ?? 1, args.index)),
        }),
        defineTool({
            name: "browser_press",
            description:
                `Press a key on the focused control: ${PRESSABLE.join(", ")}, or one character (a list's type-ahead: "G" jumps to the first option starting with G); ` +
                `or a chord, modifiers joined by + (Ctrl, Alt, Shift, Meta or Cmd): Ctrl+A, Ctrl+Enter, Shift+Tab, Ctrl+K, Meta+K for a macOS page, Ctrl+Shift+P. ` +
                "A key that types a character is refused while the focus is in a password field. For text, use browser_type.",
            parameters: obj({ key: str(), accept_dialog: acceptDialog }, { open: true }),
            execute: async (args, api, context) => act("browser_press", api, context, (browser, session) => browser.press(session, args.key, args.accept_dialog ?? false)),
        }),
        defineTool({
            name: "browser_back",
            description: "Go back a page in Pi's browser.",
            parameters: obj({}, { open: true }),
            execute: async (_args, api, context) => act("browser_back", api, context, (browser, session) => browser.history(session, -1)),
        }),
        defineTool({
            name: "browser_forward",
            description: "Go forward a page in Pi's browser.",
            parameters: obj({}, { open: true }),
            execute: async (_args, api, context) => act("browser_forward", api, context, (browser, session) => browser.history(session, 1)),
        }),
        defineTool({
            name: "browser_text",
            description: "Read all the text on the current page at once (an article, docs, a list, a table), its frames' too, without scrolling through it.",
            parameters: obj({}, { open: true }),
            replay: "safe",
            execute: async (_args, api, context) =>
                act("browser_text", api, context, async (browser, session) => {
                    const page = await browser.text(session, TEXT_MAX);

                    if ("withheld" in page) {
                        return page.withheld;
                    }

                    return `${page.title} — ${page.url}\n\n${page.text}${page.cut ? `\n\n(cut at ${TEXT_MAX} characters)` : ""}`;
                }),
        }),
        defineTool({
            name: "browser_eval",
            description:
                "Run a JavaScript expression that reads the page in Pi's browser, such as computed styles (colours, fonts, spacing) or DOM queries, and get its value back as JSON (about 50 KB at most). " +
                "It runs in a world of its own that shares the page's DOM but not its scripts, and only reads: no cookies, storage, network (fetch, XMLHttpRequest, WebSocket, sendBeacon), timers, listeners, workers or windows, and nothing it sets or calls changes the page (methods that only read, such as querySelectorAll, getComputedStyle, getPropertyValue, getAttribute and getBoundingClientRect, work). " +
                "Password fields and what the person typed on a card read as empty. With await, a promise it gives is awaited; 10 seconds at most. Return plain data (strings, numbers, booleans, arrays and objects of them): a page's element comes back as {}.",
            parameters: obj({
                expression: str({ description: "A JavaScript expression, like [...document.querySelectorAll('h1,h2')].map(e => getComputedStyle(e).fontFamily)" }),
                await: opt(bool({ description: "Await the promise it gives (an async function called at once)" })),
            }, { open: true }),
            replay: "safe",
            execute: async (args, api, context) => {
                if (!host.browserEval()) {
                    return reply(EVAL_OFF, true);
                }

                const owner = mayBrowse(api.conversationId);

                if (owner !== true) {
                    return reply(owner, true);
                }

                try {
                    const browser = await browserOf(api, context);
                    const answer = await browser.evaluate(Number(api.conversationId), args.expression, args.await ?? false);

                    return "withheld" in answer ? reply(answer.withheld, true) : reply(evalAnswer(answer.json));
                } catch (error) {
                    // A script's error can quote the page.
                    return reply(fencedPage(error instanceof Error ? error.message : String(error)), true);
                }
            },
        }),
        defineTool({
            name: "browser_screenshot",
            description:
                `See what is in view in Pi's browser as a picture (for models that take images). With path, also save it to a file where this session works (.png or .jpg), for documents (doc_image) or reports. With index, picture only the dialog, menu or list that control is in, or else the control. The picture is what is in view; with full_page, the whole page from its top, past the view (its first ${FULL_PAGE_MAX.toLocaleString("en")} CSS pixels at most; not on the phone's browser, whose pictures come from its display: scroll there), where marks and areas are in the page's coordinates. Pi's browser takes calls in the order they come: one made in the same batch as other browser calls (or a codemode script that uses the browser) may land between their steps, so take the picture after them. ${MARKS_NOTE} Each mark is on a control (index), on every place a text shows (text: for a secret that is not a control), or on an area of the view in CSS pixels; a control out of view or a text not shown is an error, never a picture with it left showing. Without index, it comes with the screenshot tool's layout check (overlaps in view).`,
            parameters: obj({
                path: opt(str({ description: "Save it here too, ending in .png or .jpg: absolute or relative to this session's folder" })),
                index: opt(int({ minimum: 1, description: "A control: the picture is of the dialog, menu or list it is in, or of the control" })),
                full_page: opt(bool({ description: `The whole page from its top, past the view (${FULL_PAGE_MAX.toLocaleString("en")} CSS pixels at most)` })),
                marks: opt(arr(obj({
                            index: opt(int({ minimum: 1, description: "A control, by its number" })),
                            text: opt(str({ minLength: 1, description: "A text on the page: every place it shows" })),
                            area: opt(AREA),
                            ...MARK_STYLE,
                        }, { open: true }), { maxItems: 40, description: "Marks drawn on the picture" })),
            }, { open: true }),
            replay: "safe",
            execute: async (args, api, context) => {
                const owner = mayBrowse(api.conversationId);

                if (owner !== true) {
                    return reply(owner, true);
                }

                const kind = args.path === undefined ? "jpeg" : /\.png$/i.test(args.path) ? "png" : /\.jpe?g$/i.test(args.path) ? "jpeg" : undefined;

                if (kind === undefined) {
                    return reply("Give a path ending in .png or .jpg.", true);
                }

                const browser = await browserOf(api, context);

                try {
                    // The caption is of the page as pictured, read with it (PP-129), not the browser's state afterwards.
                    const shot = await browser.screenshot(Number(api.conversationId), { png: kind === "png", index: args.index, marks: args.marks ?? [], full: args.full_page === true });

                    // A short value the person typed on a card shows: no picture, nothing saved (PP-228).
                    if ("withheld" in shot) {
                        return reply(shot.withheld, true);
                    }

                    const state = shot;
                    const what =
                        shot.page !== undefined
                            ? shot.page.of > shot.page.height
                                ? `, the page's first ${shot.page.height.toLocaleString("en")} of ${shot.page.of.toLocaleString("en")} px`
                                : ", the whole page"
                            : shot.whole === undefined
                              ? ""
                              : shot.whole === "control"
                                ? `, only [${args.index}]`
                                : `, only the ${shot.whole} that [${args.index}] is in`;
                    let saved = "";

                    if (args.path !== undefined) {
                        const env = host.envOf((await api.agent(context)).cwd ?? "");
                        const absolute = await env.absolutePath(args.path, context);

                        if (!absolute.ok) {
                            throw new Error(`Cannot save to ${args.path}: ${absolute.error.message}`);
                        }

                        const bytes = Buffer.from(shot.data, "base64");
                        const written = await env.writeFile(absolute.value, bytes, context);

                        if (!written.ok) {
                            throw new Error(`Could not save ${absolute.value}: ${written.error.message}`);
                        }

                        saved = ` Saved as ${absolute.value} (${Math.max(1, Math.round(bytes.length / 1024))} KB).`;
                    }

                    return {
                        output: [
                            { type: "text" as const, text: shotCaption({ title: state.title, url: state.url, width: state.viewport.width, height: shot.page?.height ?? state.viewport.height }, what, saved) },
                            { type: "image" as const, data: shot.data, mimeType: kind === "png" ? "image/png" : "image/jpeg" },
                            ...(shot.layout === undefined ? [] : [{ type: "text" as const, text: layoutWords(shot.layout) }]),
                        ],
                    };
                } catch (error) {
                    // An error can name the page's controls or texts too.
                    return reply(fencedPage(error instanceof Error ? error.message : String(error)), true);
                }
            },
        }),
        defineTool({
            name: "browser_layout_check",
            description: `Measure the page in front in Pi's browser without a picture: ${LAYOUT_NOTE}, at the view's width (browser_size changes it). Overlaps are measured in view: scroll to check further down.`,
            parameters: obj({}, { open: true }),
            replay: "safe",
            execute: async (_args, api, context) => {
                const owner = mayBrowse(api.conversationId);

                if (owner !== true) {
                    return reply(owner, true);
                }

                try {
                    const browser = await browserOf(api, context);
                    const layout = await browser.layoutCheck(Number(api.conversationId));

                    return "withheld" in layout ? reply(layout.withheld, true) : reply(layoutWords(layout));
                } catch (error) {
                    return reply(fencedPage(error instanceof Error ? error.message : String(error)), true);
                }
            },
        }),
        defineTool({
            name: "browser_redline",
            description:
                "The redline tool's measure on the page in front in Pi's browser (what is in view, at the view's width): padding and gaps between blocks as coloured strips with their pixels, corner radii, control sizes (tap targets under 40 px on a phone in red), type, and a legend of the values used, drawn on its picture. " +
                "Auto mode measures the main blocks; selector the elements it finds. With spec (a tokens.css path, or a plain list like \"padding 16, gap 8/16, radius 24/12/20, font 22/13/12\"), values off it are red with the spec's nearest value and listed.",
            parameters: obj({
                selector: opt(str({ description: "A CSS selector: measure the elements it finds (at most 40) instead of the main blocks" })),
                spec: opt(str({ description: "A tokens.css path, or a plain list like \"padding 16, radius 24/12/20, font 22/13/12\"" })),
                save: opt(str({ description: "Save the marked picture too, .png or .jpg" })),
            }, { open: true }),
            replay: "safe",
            execute: async (args, api, context) => {
                const owner = mayBrowse(api.conversationId);

                if (owner !== true) {
                    return reply(owner, true);
                }

                const png = args.save === undefined || /\.png$/i.test(args.save);

                if (args.save !== undefined && !png && !/\.jpe?g$/i.test(args.save)) {
                    return reply("Give save a path ending in .png or .jpg.", true);
                }

                try {
                    const env = host.envOf((await api.agent(context)).cwd ?? "");
                    const spec = await specFrom(args.spec, async (path) => {
                        const read = await env.readTextFile(path, context);

                        if (!read.ok) {
                            throw new Error(`Could not read the spec ${path}: ${read.error.message}`);
                        }

                        return read.value;
                    });
                    const browser = await browserOf(api, context);
                    const shot = await browser.screenshot(Number(api.conversationId), { png: true, script: redlineScript(args.selector === undefined ? {} : { selector: args.selector }) });

                    if ("withheld" in shot) {
                        return reply(shot.withheld, true);
                    }

                    const measure = parseRedline(shot.measured);

                    if (measure === undefined) {
                        throw new Error("The page gave no measure: its script could not run there.");
                    }

                    const { pictures, text } = redlinePictures([{ bytes: Buffer.from(shot.data, "base64"), top: 0 }], measure, spec, {
                        cssWidth: shot.viewport.width,
                        cssHeight: shot.viewport.height,
                        png,
                    });
                    const picture = pictures[0]!;
                    let saved = "";

                    if (args.save !== undefined) {
                        const absolute = await env.absolutePath(args.save, context);

                        if (!absolute.ok) {
                            throw new Error(`Cannot save to ${args.save}: ${absolute.error.message}`);
                        }

                        const written = await env.writeFile(absolute.value, picture, context);

                        if (!written.ok) {
                            throw new Error(`Could not save ${absolute.value}: ${written.error.message}`);
                        }

                        saved = ` Saved as ${absolute.value}.`;
                    }

                    return {
                        output: [
                            { type: "text" as const, text: `${shotCaption({ title: shot.title, url: shot.url, width: shot.viewport.width, height: shot.viewport.height }, "", saved)}\n${fencedPage(text)}` },
                            { type: "image" as const, data: Buffer.from(picture).toString("base64"), mimeType: png ? "image/png" : "image/jpeg" },
                        ],
                    };
                } catch (error) {
                    return reply(fencedPage(error instanceof Error ? error.message : String(error)), true);
                }
            },
        }),
        defineTool({
            name: "browser_wait",
            description: "Wait for the page, then read it again: until a text shows on it (up to 30 seconds), or for some seconds (up to 10).",
            parameters: obj({
                text: opt(str({ description: "Text to wait for, like a result's title or \"Saved\"" })),
                seconds: opt(num({ minimum: 0, maximum: 10 })),
            }, { open: true }),
            execute: async (args, api, context) =>
                act("browser_wait", api, context, (browser, session) => browser.wait(session, { ...(args.text === undefined ? {} : { text: args.text }), ...(args.seconds === undefined ? {} : { seconds: args.seconds }) })),
        }),
        defineTool({
            name: "browser_run",
            description:
                "Carry out one concrete goal in Pi's browser on its own, a step at a time, each step decided by the run model the owner picked (Settings › Browser: this session's model, or Jev). " +
                "Give every text it may type in values (a name for each: {\"from\": \"Zurich\"}); it never types anything else. Optionally a url to open first. " +
                "Answers how it ended (done, or why it stopped: needs_value, blocked, stuck_loop, unverified_done, budget, decision_error), its steps, time and cost, and the page as it is. " +
                "What each step sends: with Jev, OpenRouter (openrouter.ai) gets, with the owner's OpenRouter key, the goal, the values (a secret by its name only), the page's address, title and visible text, the controls in view with their values, and the recent steps; with this session's model, its provider gets the same. " +
                "A run clicks and types without asking anyone, on a page that may be signed in, so a hostile page can steer it: never give it a goal that pays, sends, books or deletes.",
            parameters: obj({
                goal: str({ description: "One concrete goal, with everything it requires (\"Search one-way flights Zurich to London on 3 November, and stop when results show\")" }),
                values: opt(record(union([str(), obj({ secret: str({ description: "A saved secret's name: typed into the page (a password field too), never shown to you or the run model" }) }, { open: true })]), {
                        description: "Texts it may type, by name: a text, or { secret: NAME } for one of the owner's saved secrets",
                    })),
                url: opt(str({ description: "An address to open first; without it, the run starts on the page open now" })),
                max_steps: opt(int({ minimum: 1, maximum: 60, description: "Steps at most (default 25)" })),
            }, { open: true }),
            execute: async (args, api, context) => {
                const session = Number(api.conversationId);
                const owner = mayBrowse(api.conversationId);

                if (owner !== true) {
                    return reply(owner, true);
                }

                const browser = await browserOf(api, context);

                const model = host.browserRunModel(api.conversationId as never);
                let decider: Decider;

                if (model === "session") {
                    decider = new SessionDecider((prompt) => host.askSessionModel(api.conversationId as never, prompt, 600));
                } else {
                    const key = await host.apiKey("openrouter");

                    if (key === undefined) {
                        return reply(`The run model is ${model}, through OpenRouter, which is not signed in: sign in to OpenRouter in Settings › Providers, or pick this session's model in Settings › Browser.`, true);
                    }

                    decider = new JevDecider(key, model);
                }

                try {
                    if (args.url !== undefined && args.url.trim() !== "") {
                        await browser.open(session, addressOf(args.url));
                    }

                    // Secrets by name (PP-32): their values for the page only; the run model is told their names.
                    const values: Record<string, string> = {};
                    const secrets: string[] = [];

                    for (const [name, given] of Object.entries(args.values ?? {})) {
                        if (typeof given === "string") {
                            values[name] = given;
                            continue;
                        }

                        const value = host.secrets.value(given.secret);

                        if (value === undefined) {
                            return reply(`There is no secret ${given.secret}: secrets_list says which you may use.`, true);
                        }

                        values[name] = value;
                        secrets.push(name);
                        host.secrets.used([given.secret]);
                    }

                    const { result, page } = await browser.run(session, { goal: args.goal, values, secrets, maxSteps: args.max_steps ?? 25, decider });

                    if (model !== "session" && result.decisions > 0) {
                        await host.chargeSession(api.conversationId as never, `openrouter/${model}`, { ...result.tokens, cost: result.cost });
                    }

                    // Windows the pages asked to open during the run, while popups is ask: the person's cards now (PP-249).
                    const windows = browser.windowAsks().length === 0 ? "" : `\n${fencedPage(await windowCards(api, context, "browser_run", browser, session, ""))}`;
                    // Permissions the pages asked for, while browser.permissions is ask: the owner's cards now (PP-376).
                    const permissions = browser.permissionAsks().length === 0 ? "" : `\n${fencedPage((await permissionCards(api, context, "browser_run", browser, session, "")).trim())}`;

                    return reply(report(result, decider.label, page) + windows + permissions, result.status !== "done");
                } catch (error) {
                    // A failed step or page can say the page's words: fenced as the report is.
                    return reply(fencedPage(error instanceof Error ? error.message : String(error)), true);
                }
            },
        }),
        defineTool({
            name: "browser_sign_in",
            description:
                "Sign in on the page with the person's own username and password: they type them on a card (or use a sign-in kept in Secrets), and they go straight into the fields you name. You never see them. " +
                "Use this for every sign-in and never ask for a password in the chat; whenever a page asks to sign in, call it right away (the card is how you ask; they can say Not now). " +
                "Name the fields the page has now (a sign-in that asks for the username and the password on pages of their own: call it on each). Then submit the form yourself.",
            parameters: obj({
                username: opt(int({ minimum: 1, description: "The number of the username or email field, if the page has one" })),
                password: opt(int({ minimum: 1, description: "The number of the password field, if the page has one" })),
            }, { open: true }),
            execute: async (args, api, context) => {
                const session = Number(api.conversationId);
                const owner = mayBrowse(api.conversationId);

                if (owner !== true) {
                    return reply(owner, true);
                }

                const browser = await browserOf(api, context);

                if (args.username === undefined && args.password === undefined) {
                    return reply("Name the username field, the password field, or both, by their numbers.", true);
                }

                let fields: { name: "username" | "password"; index: number; label: string }[];

                try {
                    fields = signInFields(args, (index) => browser.field(index));
                } catch (error) {
                    return reply(error instanceof Error ? error.message : String(error), true);
                }

                const site = siteOf(browser.state().url);
                const secret = `LOGIN_${site.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "")}`;

                return askPerson(api, context, session, "browser_sign_in", `Sign in to ${site}`, `Pi's browser is at ${site}'s sign-in.`, {
                    type: "browser",
                    kind: "sign-in",
                    site,
                    fields,
                    secret,
                    saved: host.secrets.has(secret),
                }, "The person filled in the sign-in (you do not see what). Now submit the form: click its sign-in or next button.");
            },
        }),
        defineTool({
            name: "browser_ask_code",
            description:
                "Ask the person for a one-time code (from a text message, an email, or an authenticator app), which goes straight into the field with this number. You never see it. Then submit it if the page does not on its own.",
            parameters: obj({
                index,
                prompt: opt(str({ description: "What to tell the person, like \"Enter the 6-digit code texted to your phone\"" })),
            }, { open: true }),
            execute: async (args, api, context) => {
                const session = Number(api.conversationId);
                const owner = mayBrowse(api.conversationId);

                if (owner !== true) {
                    return reply(owner, true);
                }

                const browser = await browserOf(api, context);

                let field: { label: string; fill: boolean };

                try {
                    field = browser.field(args.index);
                } catch (error) {
                    return reply(error instanceof Error ? error.message : String(error), true);
                }

                if (!field.fill) {
                    // The label is the page's.
                    return reply(fencedPage(`[${args.index}] ${field.label} is not a field to type into.`), true);
                }

                const site = siteOf(browser.state().url);

                return askPerson(api, context, session, "browser_ask_code", `A code for ${site}`, args.prompt ?? "Enter the one-time code the site sent you.", {
                    type: "browser",
                    kind: "code",
                    site,
                    fields: [{ name: "code", index: args.index, label: FIELD_LABELS.code }],
                    instruction: args.prompt ?? "Enter the one-time code the site sent you.",
                }, "The person entered the code (you do not see it). Submit it if the page did not.");
            },
        }),
        defineTool({
            name: "browser_ask_user",
            description:
                "Ask the person to do something on the page themselves: a CAPTCHA, approving the sign-in on their phone, or anything else you cannot do. They take over Pi's browser, and you wait until they say it is done; then you get the page as it is.",
            parameters: obj({ instruction: str({ description: "What they should do, in a sentence" }) }, { open: true }),
            execute: async (args, api, context) => {
                const session = Number(api.conversationId);
                const owner = mayBrowse(api.conversationId);

                if (owner !== true) {
                    return reply(owner, true);
                }

                const browser = await browserOf(api, context);

                const site = siteOf(browser.state().url);

                return askPerson(api, context, session, "browser_ask_user", `Pi needs your hand on ${site}`, args.instruction, {
                    type: "browser",
                    kind: "do",
                    site,
                    fields: [],
                    instruction: args.instruction,
                }, "The person says it is done.");
            },
        }),
        defineTool({
            name: "browser_attach",
            description:
                "Attach this session's Pi's browser to a browser that runs on one of the owner's machines with its DevTools on that machine's 127.0.0.1: Playwright's, agent-browser's, a Chrome you started there with --remote-debugging-port=N, or the owner's own Chrome started with remote debugging. " +
                "Give its port, or the path of its DevToolsActivePort file (in its profile folder); with neither, the owner's own Chrome (or Chromium, Edge, Brave) whose remote debugging they turned on at chrome://inspect/#remote-debugging. It is reached through the app's ssh; no other host can be named. " +
                "Unless it is pi-phone's own Chrome there, the owner approves on a card that shows the machine, the port, the browser's version and its profile (it carries that profile's sign-ins). " +
                'This session owns the tabs it opens there (in the background) and the windows their pages open; the tabs already open stay the owner\'s, unless tabs is "all" (for a browser you started, such as Playwright\'s). ' +
                "Then every browser_* tool, the panel, take over and the sign-in cards work on its tabs; browser_detach lets go and leaves it running.",
            parameters: obj({
                machine: str({ description: "The machine's name" }),
                port: opt(int({ minimum: 1, maximum: 65535, description: "Its DevTools port on the machine's 127.0.0.1" })),
                devtools_active_port: opt(str({ description: "Or the path of its DevToolsActivePort file on the machine (~/ is its home), in its profile folder: Chrome writes it when started with --remote-debugging-port=0" })),
                label: opt(str({ maxLength: 60, description: 'What to call it in the panel ("Playwright")' })),
                tabs: opt(union([literal("own"), literal("all")], { description: 'own (the default): only the tabs this session opens there; all: its open tabs too' })),
            }, { open: true }),
            execute: async (args, api, context) => {
                const owner = mayBrowse(api.conversationId);

                if (owner !== true) {
                    return reply(owner, true);
                }

                try {
                    const said = await host.attachBrowser(
                        (await api.agent(context)).cwd ?? "",
                        Number(api.conversationId),
                        {
                            machine: args.machine,
                            ...(args.port === undefined ? {} : { port: args.port }),
                            ...(args.devtools_active_port === undefined ? {} : { activePort: args.devtools_active_port }),
                            ...(args.label === undefined ? {} : { label: args.label }),
                            ...(args.tabs === undefined ? {} : { tabs: args.tabs }),
                        },
                        (request) =>
                            host.approvals.request(
                                {
                                    id: `browser-attach-${String(api.taskId)}-${String(api.callId)}`,
                                    conversationId: api.conversationId as never,
                                    taskId: api.taskId as never,
                                    ...(api.callId === undefined ? {} : { callId: api.callId }),
                                    tool: "browser_attach",
                                    subject: request.subject,
                                    reason: request.reason,
                                    createdAt: Date.now(),
                                },
                                context as never,
                            ),
                    );

                    // The browser's version and profile are the machine's words.
                    return reply(fencedPage(said));
                } catch (error) {
                    return reply(fencedPage(error instanceof Error ? error.message : String(error)), true);
                }
            },
        }),
        defineTool({
            name: "browser_detach",
            description: "Let go of the browser this session attached to (browser_attach): it runs on, with every tab; this session browses where it did before.",
            parameters: obj({}, { open: true }),
            execute: async (_args, api) => {
                const owner = mayBrowse(api.conversationId);

                if (owner !== true) {
                    return reply(owner, true);
                }

                try {
                    return reply(await host.detachBrowser(Number(api.conversationId)));
                } catch (error) {
                    return reply(error instanceof Error ? error.message : String(error), true);
                }
            },
        }),
        defineTool({
            name: "browser_close",
            description: "Close this session's tabs in Pi's browser; its sign-ins stay for next time. The next browser_open starts it again.",
            parameters: obj({}, { open: true }),
            execute: async (_args, api, context) => {
                const owner = mayBrowse(api.conversationId);

                if (owner !== true) {
                    return reply(owner, true);
                }

                const browser = await browserOf(api, context);

                await browser.close();

                return reply("This session's tabs in Pi's browser are closed.");
            },
        }),
    ];

    return defineExtension({
        name: "pocket-browser",
        tools,
        sections: [section("browsing", () => BROWSING)],
    });
}
