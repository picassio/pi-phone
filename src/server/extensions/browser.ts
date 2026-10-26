/**
 * Browser use: Pi opens pages in its own browser (`browser/pi-browser.ts`), reads them as numbered controls and visible
 * text, and clicks, types, chooses, scrolls, and presses keys there; people watch it live in the Browser panel and can
 * take it over. Every action answers with the page as it is after it. Ideas from Kuvo Code (design only), browser-use
 * and jev-ultrafast (MIT).
 */
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { basename } from "node:path";
import { addressOf, PRESSABLE, StalePage } from "../browser/page.ts";
import { MAX_TABS, type PiBrowser } from "../browser/pi-browser.ts";
import { fencedPage } from "../fence.ts";
import { type Decider, JevDecider, report, SessionDecider } from "../browser/run.ts";
import type { ApprovalRequest, PocketHost } from "../host.ts";
import { AREA, MARK_STYLE, MARKS_NOTE } from "../mark-schema.ts";

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

const reply = (text: string, isError = false) => ({ output: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) });
/** How much of a whole page `browser_text` gives at once. */
const TEXT_MAX = 40_000;

/** In every prompt while the module is on. */
export const BROWSING = `Pi's browser: browser_open opens a page in a browser the person can watch (the Browser panel) and gives you the page as numbered controls ([3] button "Search") and its visible text. Act by number with browser_click, browser_type, browser_select, browser_scroll, browser_press and browser_hover; every action answers with the page as it is after it, so use the newest numbers. browser_text reads a whole article or table at once; browser_screenshot shows the page as a picture. browser_upload gives a file field (or its upload button) files from where you work; browser_save_pdf saves the page as a PDF there. browser_new_tab opens another tab, and browser_tabs lists, switches and closes them; browser_size lays pages out as a phone (the default) or a desktop. Each session has its own tabs. browser_run carries out one concrete goal on its own, a step at a time (a goal, every text to type in values, optionally a url to start from): faster and cheaper than driving each step yourself, it answers how it ended and the page; when it stops (needs_value, blocked, stuck_loop, unverified_done), read why and go on yourself or run again. Use web_search and fetch_content for plain reading; use the browser to do things on a site (search forms, filters, sign-in flows, pages that need clicks or scripts). Never type a password or a one-time code as text. When a page asks to sign in and the sign-in is saved as secrets you may use (secrets_list), type them by name: browser_type with secret: "NAME" (a password field too), or browser_run values {"password": {"secret": "NAME"}}; their values go into the page, never to you. Otherwise call browser_sign_in (the person types it on a card; you never see it); for a one-time code, browser_ask_code; for a CAPTCHA or anything only they can do, browser_ask_user. Pi's browser cannot use passkeys or security keys (Android allows them only in allowlisted browsers): when a site asks for one, choose its other way (\"Try another way\", a password, a code) if it offers one, and otherwise tell the person with browser_ask_user. Ask the person before anything that pays, sends, books, or deletes on a site.`;

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
    /** Run a browser action for a session: its answer, or the error in words (a stale page reads the page again). */
    const act = async (
        api: { conversationId: unknown; agent(context: never): Promise<{ cwd?: string }> },
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
            return reply(fencedPage(await work(browser, session)));
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
    const index = Type.Integer({ minimum: 1, description: "The control's number, like 3 for [3], from the newest read of the page" });
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
            return reply(`${done}\n${fencedPage(`The page now:\n${await browser.snapshot(session)}`)}`);
        } catch (error) {
            return reply(`${done} ${fencedPage(`The page could not be read again: ${error instanceof Error ? error.message : String(error)}`)}`);
        }
    };
    const acceptDialog = Type.Optional(Type.Boolean({ description: "Accept a confirmation or prompt the page shows on the way (they are declined otherwise)" }));

    const tools = [
        defineTool({
            name: "browser_open",
            description: "Open a web address (or search for words) in Pi's browser, which the person can watch. Answers with the page as numbered controls and its visible text.",
            parameters: Type.Object({ url: Type.String({ description: "An address like example.com, or words to search for" }) }),
            execute: async (args, api, context) => {
                let url: string;

                try {
                    url = addressOf(args.url);
                } catch (error) {
                    return reply(error instanceof Error ? error.message : String(error), true);
                }

                return act(api, context, (browser, session) => browser.open(session, url));
            },
        }),
        defineTool({
            name: "browser_snapshot",
            description: "Read the page in Pi's browser again: its title, address, scroll position, numbered controls, and visible text.",
            parameters: Type.Object({}),
            replay: "safe",
            execute: async (_args, api, context) => act(api, context, (browser, session) => browser.snapshot(session)),
        }),
        defineTool({
            name: "browser_click",
            description: "Click the control with this number from the newest read of the page.",
            parameters: Type.Object({ index, accept_dialog: acceptDialog }),
            execute: async (args, api, context) => act(api, context, (browser, session) => browser.click(session, args.index, args.accept_dialog ?? false)),
        }),
        defineTool({
            name: "browser_type",
            description:
                "Type into the field with this number: text, or one of the owner's saved secrets by name (secret: \"NAME\", for a password field too), whose value goes into the page and never to you. Replaces what is there unless clear is false. " +
                "Never type a password or a one-time code as text: a saved secret, or browser_sign_in / browser_ask_code for the person.",
            parameters: Type.Object({
                index,
                text: Type.Optional(Type.String()),
                secret: Type.Optional(Type.String({ description: "A saved secret's name (secrets_list), typed instead of text" })),
                submit: Type.Optional(Type.Boolean({ description: "Press Enter afterwards (submits search boxes and forms)" })),
                clear: Type.Optional(Type.Boolean({ description: "Clear the field first (default true)" })),
            }),
            execute: async (args, api, context) => {
                const options = { clear: args.clear ?? true, submit: args.submit ?? false };

                if ((args.text === undefined) === (args.secret === undefined)) {
                    return reply("Give text, or a saved secret's name (secret), not both.", true);
                }

                if (args.secret === undefined) {
                    return act(api, context, (browser, session) => browser.type(session, args.index, args.text!, options));
                }

                // The secrets module checked the folder and asked a person when the secret says so (`extensions/secrets.ts`).
                const name = args.secret;
                const value = host.secrets.value(name);

                if (value === undefined) {
                    return reply(`There is no secret ${name}: secrets_list says which you may use.`, true);
                }

                host.secrets.used([name]);

                return act(api, context, (browser, session) => browser.typeSecret(session, args.index, name, value, options));
            },
        }),
        defineTool({
            name: "browser_select",
            description: "Choose an option, by its text or value, in the drop-down list with this number: a native one, or one the page draws (a button that opens a list of options), which it opens and picks from.",
            parameters: Type.Object({ index, option: Type.String() }),
            execute: async (args, api, context) => act(api, context, (browser, session) => browser.select(session, args.index, args.option)),
        }),
        defineTool({
            name: "browser_hover",
            description: "Move the pointer over the control with this number without clicking (menus and tooltips that open on hover).",
            parameters: Type.Object({ index }),
            execute: async (args, api, context) => act(api, context, (browser, session) => browser.hover(session, args.index)),
        }),
        defineTool({
            name: "browser_upload",
            description:
                "Give files from where this session works to a file field, or to the button that opens one (a styled Upload button): the page gets them as if the person chose them. Then submit the form if it needs it.",
            parameters: Type.Object({
                index,
                paths: Type.Array(Type.String(), { minItems: 1, maxItems: 10, description: "The files, absolute or relative to this session's folder" }),
            }),
            execute: async (args, api, context) =>
                act(api, context, async (browser, session) => {
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
            parameters: Type.Object({ path: Type.String({ description: "Where to save it, ending in .pdf: absolute or relative to this session's folder" }) }),
            execute: async (args, api, context) =>
                act(api, context, async (browser, session) => {
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
            description: `Open a new tab in Pi's browser, in front (at an address, or blank), keeping the others. At most ${MAX_TABS} tabs.`,
            parameters: Type.Object({ url: Type.Optional(Type.String({ description: "An address like example.com, or words to search for" })) }),
            execute: async (args, api, context) => {
                let url: string | undefined;

                try {
                    url = args.url === undefined || args.url.trim() === "" ? undefined : addressOf(args.url);
                } catch (error) {
                    return reply(error instanceof Error ? error.message : String(error), true);
                }

                return act(api, context, (browser, session) => browser.newTab(session, url));
            },
        }),
        defineTool({
            name: "browser_tabs",
            description: "List Pi's browser tabs (numbered from 1, the one in front marked), or bring one to the front (switch_to), or close one (close). Switching answers with that tab's page.",
            parameters: Type.Object({
                switch_to: Type.Optional(Type.Integer({ minimum: 1, description: "The tab to bring to the front" })),
                close: Type.Optional(Type.Integer({ minimum: 1, description: "The tab to close" })),
            }),
            execute: async (args, api, context) =>
                act(api, context, (browser, session) =>
                    args.close !== undefined ? browser.closeTab(session, args.close) : args.switch_to !== undefined ? browser.switchTab(session, args.switch_to) : browser.tabs(session),
                ),
        }),
        defineTool({
            name: "browser_size",
            description: "Lay this session's pages in Pi's browser out as a phone's (412×860, touch: the default) or a desktop's (1280×800, a desktop Chrome): for a site whose phone page lacks what you need, or a desktop layout to check. Open pages load again at the new size; answers the page.",
            parameters: Type.Object({ size: Type.Union([Type.Literal("phone"), Type.Literal("desktop")]) }),
            execute: async (args, api, context) => act(api, context, (browser, session) => browser.resize(session, args.size)),
        }),
        defineTool({
            name: "browser_scroll",
            description: "Scroll the page up or down by screens; with index, what scrolls around that control instead (an open list or panel with its own scroll area), by its height. Clicking a control out of view scrolls it into view by itself.",
            parameters: Type.Object({
                direction: Type.Union([Type.Literal("up"), Type.Literal("down")]),
                screens: Type.Optional(Type.Number({ minimum: 0.25, maximum: 10, description: "How many screens (default 1)" })),
                index: Type.Optional(Type.Integer({ minimum: 1, description: "A control inside the area to scroll, like an option of an open list" })),
            }),
            execute: async (args, api, context) => act(api, context, (browser, session) => browser.scroll(session, args.direction, args.screens ?? 1, args.index)),
        }),
        defineTool({
            name: "browser_press",
            description: `Press a key on the focused control: ${PRESSABLE.join(", ")}, or one character (a list's type-ahead: "G" jumps to the first option starting with G). For text, use browser_type.`,
            parameters: Type.Object({ key: Type.String(), accept_dialog: acceptDialog }),
            execute: async (args, api, context) => act(api, context, (browser, session) => browser.press(session, args.key, args.accept_dialog ?? false)),
        }),
        defineTool({
            name: "browser_back",
            description: "Go back a page in Pi's browser.",
            parameters: Type.Object({}),
            execute: async (_args, api, context) => act(api, context, (browser, session) => browser.history(session, -1)),
        }),
        defineTool({
            name: "browser_forward",
            description: "Go forward a page in Pi's browser.",
            parameters: Type.Object({}),
            execute: async (_args, api, context) => act(api, context, (browser, session) => browser.history(session, 1)),
        }),
        defineTool({
            name: "browser_text",
            description: "Read all the text on the current page at once (an article, docs, a list, a table), without scrolling through it.",
            parameters: Type.Object({}),
            replay: "safe",
            execute: async (_args, api, context) =>
                act(api, context, async (browser, session) => {
                    const page = await browser.text(session, TEXT_MAX);

                    return `${page.title} — ${page.url}\n\n${page.text}${page.cut ? `\n\n(cut at ${TEXT_MAX} characters)` : ""}`;
                }),
        }),
        defineTool({
            name: "browser_screenshot",
            description:
                `See what is in view in Pi's browser as a picture (for models that take images). With path, also save it to a file where this session works (.png or .jpg), for documents (doc_image) or reports. With index, picture only the dialog, menu or list that control is in, or else the control. The picture is what is in view: scroll first for more. Pi's browser takes calls in the order they come: one made in the same batch as other browser calls (or a codemode script that uses the browser) may land between their steps, so take the picture after them. ${MARKS_NOTE} Each mark is on a control (index), on every place a text shows (text: for a secret that is not a control), or on an area of the view in CSS pixels; a control out of view or a text not shown is an error, never a picture with it left showing.`,
            parameters: Type.Object({
                path: Type.Optional(Type.String({ description: "Save it here too, ending in .png or .jpg: absolute or relative to this session's folder" })),
                index: Type.Optional(Type.Integer({ minimum: 1, description: "A control: the picture is of the dialog, menu or list it is in, or of the control" })),
                marks: Type.Optional(
                    Type.Array(
                        Type.Object({
                            index: Type.Optional(Type.Integer({ minimum: 1, description: "A control, by its number" })),
                            text: Type.Optional(Type.String({ minLength: 1, description: "A text on the page: every place it shows" })),
                            area: Type.Optional(AREA),
                            ...MARK_STYLE,
                        }),
                        { maxItems: 40, description: "Marks drawn on the picture" },
                    ),
                ),
            }),
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
                    const shot = await browser.screenshot(Number(api.conversationId), { png: kind === "png", index: args.index, marks: args.marks ?? [] });
                    const state = shot;
                    const what = shot.whole === undefined ? "" : shot.whole === "control" ? `, only [${args.index}]` : `, only the ${shot.whole} that [${args.index}] is in`;
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
                            { type: "text" as const, text: `${state.title || "(no title)"} — ${state.url}, as Pi's browser shows it (${state.viewport.width}×${state.viewport.height} CSS pixels${what}).${saved}` },
                            { type: "image" as const, data: shot.data, mimeType: kind === "png" ? "image/png" : "image/jpeg" },
                        ],
                    };
                } catch (error) {
                    return reply(error instanceof Error ? error.message : String(error), true);
                }
            },
        }),
        defineTool({
            name: "browser_wait",
            description: "Wait for the page, then read it again: until a text shows on it (up to 30 seconds), or for some seconds (up to 10).",
            parameters: Type.Object({
                text: Type.Optional(Type.String({ description: "Text to wait for, like a result's title or \"Saved\"" })),
                seconds: Type.Optional(Type.Number({ minimum: 0, maximum: 10 })),
            }),
            execute: async (args, api, context) =>
                act(api, context, (browser, session) => browser.wait(session, { ...(args.text === undefined ? {} : { text: args.text }), ...(args.seconds === undefined ? {} : { seconds: args.seconds }) })),
        }),
        defineTool({
            name: "browser_run",
            description:
                "Carry out one concrete goal in Pi's browser on its own, a step at a time, each step decided by the run model the owner picked (Settings › Browser: this session's model, or Jev). " +
                "Give every text it may type in values (a name for each: {\"from\": \"Zurich\"}); it never types anything else. Optionally a url to open first. " +
                "Answers how it ended (done, or why it stopped: needs_value, blocked, stuck_loop, unverified_done, budget, decision_error), its steps, time and cost, and the page as it is.",
            parameters: Type.Object({
                goal: Type.String({ description: "One concrete goal, with everything it requires (\"Search one-way flights Zurich to London on 3 November, and stop when results show\")" }),
                values: Type.Optional(
                    Type.Record(Type.String(), Type.Union([Type.String(), Type.Object({ secret: Type.String({ description: "A saved secret's name: typed into the page (a password field too), never shown to you or the run model" }) })]), {
                        description: "Texts it may type, by name: a text, or { secret: NAME } for one of the owner's saved secrets",
                    }),
                ),
                url: Type.Optional(Type.String({ description: "An address to open first; without it, the run starts on the page open now" })),
                max_steps: Type.Optional(Type.Integer({ minimum: 1, maximum: 60, description: "Steps at most (default 25)" })),
            }),
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

                    return reply(report(result, decider.label, page), result.status !== "done");
                } catch (error) {
                    return reply(error instanceof Error ? error.message : String(error), true);
                }
            },
        }),
        defineTool({
            name: "browser_sign_in",
            description:
                "Sign in on the page with the person's own username and password: they type them on a card (or use a sign-in kept in Secrets), and they go straight into the fields you name. You never see them. " +
                "Use this for every sign-in and never ask for a password in the chat; whenever a page asks to sign in, call it right away (the card is how you ask; they can say Not now). " +
                "Name the fields the page has now (a sign-in that asks for the username and the password on pages of their own: call it on each). Then submit the form yourself.",
            parameters: Type.Object({
                username: Type.Optional(Type.Integer({ minimum: 1, description: "The number of the username or email field, if the page has one" })),
                password: Type.Optional(Type.Integer({ minimum: 1, description: "The number of the password field, if the page has one" })),
            }),
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
            parameters: Type.Object({
                index,
                prompt: Type.Optional(Type.String({ description: "What to tell the person, like \"Enter the 6-digit code texted to your phone\"" })),
            }),
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
                    return reply(`[${args.index}] ${field.label} is not a field to type into.`, true);
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
            parameters: Type.Object({ instruction: Type.String({ description: "What they should do, in a sentence" }) }),
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
            name: "browser_close",
            description: "Close this session's tabs in Pi's browser; its sign-ins stay for next time. The next browser_open starts it again.",
            parameters: Type.Object({}),
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
