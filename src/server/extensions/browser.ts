/**
 * Browser use: Pi opens pages in its own browser (`browser/pi-browser.ts`), reads them as numbered controls and visible
 * text, and clicks, types, chooses, scrolls, and presses keys there; people watch it live in the Browser panel and can
 * take it over. Every action answers with the page as it is after it. Ideas from Kuvo Code (design only), browser-use
 * and jev-ultrafast (MIT).
 */
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { addressOf, PRESSABLE, StalePage } from "../browser/page.ts";
import { type Decider, JevDecider, report, SessionDecider } from "../browser/run.ts";
import type { ApprovalRequest, PocketHost } from "../host.ts";

const reply = (text: string, isError = false) => ({ output: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) });
/** How much of a whole page `browser_text` gives at once. */
const TEXT_MAX = 40_000;

/** In every prompt while the module is on. */
export const BROWSING = `Pi's browser: browser_open opens a page in a browser the person can watch (the Browser panel) and gives you the page as numbered controls ([3] button "Search") and its visible text. Act by number with browser_click, browser_type, browser_select, browser_scroll and browser_press; every action answers with the page as it is after it, so use the newest numbers. browser_text reads a whole article or table at once; browser_screenshot shows the page as a picture. browser_run carries out one concrete goal on its own, a step at a time (a goal, every text to type in values, optionally a url to start from): faster and cheaper than driving each step yourself, it answers how it ended and the page; when it stops (needs_value, blocked, stuck_loop, unverified_done), read why and go on yourself or run again. Use web_search and fetch_content for plain reading; use the browser to do things on a site (search forms, filters, sign-in flows, pages that need clicks or scripts). Never type a password or a one-time code yourself: when a page asks to sign in, call browser_sign_in (the person types it on a card; you never see it); for a one-time code, browser_ask_code; for a CAPTCHA or anything only they can do, browser_ask_user. Pi's browser cannot use passkeys or security keys (Android allows them only in allowlisted browsers): when a site asks for one, choose its other way (\"Try another way\", a password, a code) if it offers one, and otherwise tell the person with browser_ask_user. Ask the person before anything that pays, sends, books, or deletes on a site.`;

export default function createBrowser(host: PocketHost) {
    const browser = host.browser;
    /** Pi's browser is the owner's (it may be signed in to their accounts): only for work the owner asked for. */
    const mayBrowse = (conversationId: unknown): true | string => {
        const requester = host.requesterOf(Number(conversationId) as never);
        const person = host.people().find((each) => each.id === requester);

        return person?.role === "owner" ? true : "Pi's browser is the owner's: it works only for what the owner asks.";
    };
    /** Run a browser action for a session: its answer, or the error in words (a stale page reads the page again). */
    const act = async (conversationId: unknown, work: (session: number) => Promise<string>) => {
        const session = Number(conversationId);
        const owner = mayBrowse(conversationId);

        if (owner !== true) {
            return reply(owner, true);
        }

        try {
            return reply(await work(session));
        } catch (error) {
            if (error instanceof StalePage) {
                try {
                    return reply(`${error.message}\nThe page now:\n${await browser.snapshot(session)}`, true);
                } catch {
                    // The page is gone too: say the first problem.
                }
            }

            return reply(error instanceof Error ? error.message : String(error), true);
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
        api: { conversationId: unknown; taskId: unknown; callId?: string },
        context: unknown,
        session: number,
        tool: string,
        subject: string,
        reason: string,
        form: NonNullable<ApprovalRequest["form"]>,
        done: string,
    ) => {
        const answer = await host.approvals.request(
            {
                id: `browser-${String(api.taskId)}-${api.callId}`,
                conversationId: api.conversationId as never,
                taskId: api.taskId as never,
                ...(api.callId === undefined ? {} : { callId: api.callId }),
                tool,
                subject,
                reason,
                form,
                createdAt: Date.now(),
            },
            context as never,
        );

        if (!answer.allow) {
            return reply(`${answer.by === "superseded" ? "The request was replaced" : `${answer.by} said not now`}: nothing was filled in or done.`, true);
        }

        try {
            return reply(`${done}\nThe page now:\n${await browser.snapshot(session)}`);
        } catch (error) {
            return reply(`${done} The page could not be read again: ${error instanceof Error ? error.message : String(error)}`);
        }
    };
    const acceptDialog = Type.Optional(Type.Boolean({ description: "Accept a confirmation or prompt the page shows on the way (they are declined otherwise)" }));

    const tools = [
        defineTool({
            name: "browser_open",
            description: "Open a web address (or search for words) in Pi's browser, which the person can watch. Answers with the page as numbered controls and its visible text.",
            parameters: Type.Object({ url: Type.String({ description: "An address like example.com, or words to search for" }) }),
            execute: async (args, api) => {
                let url: string;

                try {
                    url = addressOf(args.url);
                } catch (error) {
                    return reply(error instanceof Error ? error.message : String(error), true);
                }

                return act(api.conversationId, (session) => browser.open(session, url));
            },
        }),
        defineTool({
            name: "browser_snapshot",
            description: "Read the page in Pi's browser again: its title, address, scroll position, numbered controls, and visible text.",
            parameters: Type.Object({}),
            replay: "safe",
            execute: async (_args, api) => act(api.conversationId, (session) => browser.snapshot(session)),
        }),
        defineTool({
            name: "browser_click",
            description: "Click the control with this number from the newest read of the page.",
            parameters: Type.Object({ index, accept_dialog: acceptDialog }),
            execute: async (args, api) => act(api.conversationId, (session) => browser.click(session, args.index, args.accept_dialog ?? false)),
        }),
        defineTool({
            name: "browser_type",
            description: "Type text into the field with this number. Replaces what is there unless clear is false. Never a password or a one-time code.",
            parameters: Type.Object({
                index,
                text: Type.String(),
                submit: Type.Optional(Type.Boolean({ description: "Press Enter afterwards (submits search boxes and forms)" })),
                clear: Type.Optional(Type.Boolean({ description: "Clear the field first (default true)" })),
            }),
            execute: async (args, api) =>
                act(api.conversationId, (session) => browser.type(session, args.index, args.text, { clear: args.clear ?? true, submit: args.submit ?? false })),
        }),
        defineTool({
            name: "browser_select",
            description: "Choose an option, by its text or value, in the drop-down list with this number.",
            parameters: Type.Object({ index, option: Type.String() }),
            execute: async (args, api) => act(api.conversationId, (session) => browser.select(session, args.index, args.option)),
        }),
        defineTool({
            name: "browser_scroll",
            description: "Scroll the page up or down by screens.",
            parameters: Type.Object({
                direction: Type.Union([Type.Literal("up"), Type.Literal("down")]),
                screens: Type.Optional(Type.Number({ minimum: 0.25, maximum: 10, description: "How many screens (default 1)" })),
            }),
            execute: async (args, api) => act(api.conversationId, (session) => browser.scroll(session, args.direction, args.screens ?? 1)),
        }),
        defineTool({
            name: "browser_press",
            description: `Press a key on the focused control: ${PRESSABLE.join(", ")}. For text, use browser_type.`,
            parameters: Type.Object({ key: Type.String(), accept_dialog: acceptDialog }),
            execute: async (args, api) => act(api.conversationId, (session) => browser.press(session, args.key, args.accept_dialog ?? false)),
        }),
        defineTool({
            name: "browser_back",
            description: "Go back a page in Pi's browser.",
            parameters: Type.Object({}),
            execute: async (_args, api) => act(api.conversationId, (session) => browser.history(session, -1)),
        }),
        defineTool({
            name: "browser_forward",
            description: "Go forward a page in Pi's browser.",
            parameters: Type.Object({}),
            execute: async (_args, api) => act(api.conversationId, (session) => browser.history(session, 1)),
        }),
        defineTool({
            name: "browser_text",
            description: "Read all the text on the current page at once (an article, docs, a list, a table), without scrolling through it.",
            parameters: Type.Object({}),
            replay: "safe",
            execute: async (_args, api) =>
                act(api.conversationId, async (session) => {
                    const page = await browser.text(session, TEXT_MAX);

                    return `${page.title} — ${page.url}\n\n${page.text}${page.cut ? `\n\n(cut at ${TEXT_MAX} characters)` : ""}`;
                }),
        }),
        defineTool({
            name: "browser_screenshot",
            description: "See what is in view in Pi's browser as a picture (for models that take images).",
            parameters: Type.Object({}),
            replay: "safe",
            execute: async (_args, api) => {
                const owner = mayBrowse(api.conversationId);

                if (owner !== true) {
                    return reply(owner, true);
                }

                try {
                    const jpeg = await browser.screenshot(Number(api.conversationId));
                    const state = browser.state();

                    return {
                        output: [
                            { type: "text" as const, text: `${state.title || "(no title)"} — ${state.url}, as Pi's browser shows it (${state.viewport.width}×${state.viewport.height} CSS pixels).` },
                            { type: "image" as const, data: jpeg, mimeType: "image/jpeg" },
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
            execute: async (args, api) =>
                act(api.conversationId, (session) => browser.wait(session, { ...(args.text === undefined ? {} : { text: args.text }), ...(args.seconds === undefined ? {} : { seconds: args.seconds }) })),
        }),
        defineTool({
            name: "browser_run",
            description:
                "Carry out one concrete goal in Pi's browser on its own, a step at a time, each step decided by the run model the owner picked (Settings › Browser: this session's model, or Jev). " +
                "Give every text it may type in values (a name for each: {\"from\": \"Zurich\"}); it never types anything else. Optionally a url to open first. " +
                "Answers how it ended (done, or why it stopped: needs_value, blocked, stuck_loop, unverified_done, budget, decision_error), its steps, time and cost, and the page as it is.",
            parameters: Type.Object({
                goal: Type.String({ description: "One concrete goal, with everything it requires (\"Search one-way flights Zurich to London on 3 November, and stop when results show\")" }),
                values: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Texts it may type, by name" })),
                url: Type.Optional(Type.String({ description: "An address to open first; without it, the run starts on the page open now" })),
                max_steps: Type.Optional(Type.Integer({ minimum: 1, maximum: 60, description: "Steps at most (default 25)" })),
            }),
            execute: async (args, api) => {
                const session = Number(api.conversationId);
                const owner = mayBrowse(api.conversationId);

                if (owner !== true) {
                    return reply(owner, true);
                }

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

                    const { result, page } = await browser.run(session, { goal: args.goal, values: args.values ?? {}, maxSteps: args.max_steps ?? 25, decider });

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

                if (args.username === undefined && args.password === undefined) {
                    return reply("Name the username field, the password field, or both, by their numbers.", true);
                }

                let fields: { name: "username" | "password"; index: number; label: string }[];

                try {
                    fields = [
                        ...(args.username === undefined ? [] : [{ name: "username" as const, index: args.username, field: browser.field(args.username) }]),
                        ...(args.password === undefined ? [] : [{ name: "password" as const, index: args.password, field: browser.field(args.password) }]),
                    ].map((each) => {
                        if (!each.field.fill) {
                            throw new Error(`[${each.index}] ${each.field.label} is not a field to type into.`);
                        }

                        if (each.name === "username" && each.field.role === "password") {
                            throw new Error(`[${each.index}] is a password field: name it as password.`);
                        }

                        return { name: each.name, index: each.index, label: each.field.label };
                    });
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
                    fields: [{ name: "code", index: args.index, label: field.label }],
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
            description: "Close Pi's browser (its page and what it was signed in to for now). The next browser_open starts it again.",
            parameters: Type.Object({}),
            execute: async (_args, api) => {
                const owner = mayBrowse(api.conversationId);

                if (owner !== true) {
                    return reply(owner, true);
                }

                await browser.close();

                return reply("Pi's browser is closed.");
            },
        }),
    ];

    return defineExtension({
        name: "pocket-browser",
        tools,
        sections: [section("browsing", () => BROWSING)],
    });
}
