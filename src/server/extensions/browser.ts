/**
 * Browser use: Pi opens pages in its own browser (`browser/pi-browser.ts`), reads them as numbered controls and visible
 * text, and clicks, types, chooses, scrolls, and presses keys there; people watch it live in the Browser panel and can
 * take it over. Every action answers with the page as it is after it. Ideas from Kuvo Code (design only), browser-use
 * and jev-ultrafast (MIT).
 */
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { addressOf, PRESSABLE, StalePage } from "../browser/page.ts";
import type { PocketHost } from "../host.ts";

const reply = (text: string, isError = false) => ({ output: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) });
/** How much of a whole page `browser_text` gives at once. */
const TEXT_MAX = 40_000;

/** In every prompt while the module is on. */
export const BROWSING = `Pi's browser: browser_open opens a page in a browser the person can watch (the Browser panel) and gives you the page as numbered controls ([3] button "Search") and its visible text. Act by number with browser_click, browser_type, browser_select, browser_scroll and browser_press; every action answers with the page as it is after it, so use the newest numbers. browser_text reads a whole article or table at once; browser_screenshot shows the page as a picture. Use web_search and fetch_content for plain reading; use the browser to do things on a site (search forms, filters, sign-in flows, pages that need clicks or scripts). Never type a password or a one-time code yourself, and ask the person before anything that pays, sends, books, or deletes on a site.`;

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
