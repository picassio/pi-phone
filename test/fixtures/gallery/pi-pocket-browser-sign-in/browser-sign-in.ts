/**
 * Browser sign-in: when Pi's browser is at a sign-in, the person types the username and password, or a one-time code,
 * on a card in the chat, and the values go straight into the page. Pi never sees them, and neither does the transcript.
 * For a CAPTCHA or a sign-in to approve on a phone, Pi asks the person to do it in the Browser panel and tap Done.
 *
 * A filled password, username, or code is hidden in the session from then on: if the page or a tool gives it back, it
 * shows as [password for <site>]. A value too short to hide (under 4 characters) leaves the page out of what Pi gets.
 * Pi's own browser tool may not type into a password field. This keeps sign-ins out of the chat by accident and by
 * default; it is not a boundary against a model that sets out to read a field.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, hook, section, ToolTask } from "@earendil-works/pi-durable";
// Types only: Node removes this import when the module runs. In the drop-in folder, Pi Pocket writes `_pocket.d.ts`.
import type { BrowserControl, BrowserPageHandle, BrowserTarget, Host, Web } from "./_pocket.d.ts";

export const pocketApi = 2;

const reply = (text: string, isError = false) => ({
    output: [{ type: "text" as const, text }],
    ...(isError ? { isError: true } : {}),
});

/** The arguments of Pi's `browser` tool that name a target. */
const TARGET = ["ref", "selector", "label", "x", "y"] as const;

const RULES = `Sign-ins in the browser: never type a password or a one-time code, and never ask for one in the chat. You cannot type into a password field.
- At a sign-in page, call browser_sign_in (with the refs of the username and password fields from your last snapshot, or none to let it find them): the person types them on a card, they go straight into the page, and you never see them. Then submit the form yourself.
- For a code from a text message, an email, or an authenticator app, call browser_ask_code with the field's ref.
- For a CAPTCHA, a sign-in to approve on a phone, or anything else only the person can do in the page, call browser_ask_person with what to do.`;

/** The site of an address, for the card and the hidden value's label: `example.com`, `127.0.0.1:8898`. */
function siteOf(url: string): string {
    try {
        const { host, protocol } = new URL(url);

        return host === "" ? protocol.replace(/:$/, "") : host;
    } catch {
        return "this page";
    }
}

/** A label `host.hide` takes: letters, digits, spaces, and `_ . : -`, up to 60. `password for example.com`. */
const labelFor = (what: string, site: string) =>
    `${what} for ${site}`
        .replace(/[^A-Za-z0-9 _.:-]/g, "-")
        .slice(0, 60)
        .trim();

/** A ref as Pi writes it: `e12`, or `[e12]`. */
const refOf = (value: string | undefined) => value?.replace(/^\[|\]$/g, "").trim() || undefined;

export default function createBrowserSignIn(host: Host, web: Web) {
    // The points of 0.22.0. On an older server, or before a restart after an update, there is nothing to offer.
    if (
        typeof host.browser !== "function" ||
        typeof host.ask !== "function" ||
        typeof host.hide !== "function"
    ) {
        return undefined;
    }

    /** Stop hiding every value this version hid, when it goes. */
    const hidden: (() => void)[] = [];

    web.onDispose(() => {
        for (const stop of hidden.splice(0)) {
            stop();
        }
    });

    /** Hide a person's value in one session from now on: whether it is hidden (a value under 4 characters is not). */
    const hide = (value: string, label: string, conversationId: unknown): boolean => {
        if (value.length < 4) {
            return false;
        }

        try {
            hidden.push(host.hide({ value, label, conversationId: Number(conversationId) }));

            return true;
        } catch {
            return false;
        }
    };

    /** The session's page, or why there is none. */
    const pageOf = async (conversationId: unknown): Promise<BrowserPageHandle | string> => {
        const page = await host.browser(conversationId as never);

        return (
            page ??
            "No page is open in this session's browser: open the sign-in page with the browser tool first."
        );
    };

    /** What the person sees and what Pi gets afterwards: the page as it is now, its password values masked. */
    const after = async (page: BrowserPageHandle, said: string) => {
        const { text } = await page.snapshot();

        return reply(`${said}\n\nThe page now:\n${host.text.defang(text)}`);
    };

    const signIn = defineTool({
        name: "browser_sign_in",
        description:
            "At a sign-in page in the browser, ask the person for the username and password on a card: they go straight into the page, and you never see them. Give the refs of the fields from your last snapshot, or none to let the tool find them. Then submit the form yourself.",
        parameters: Type.Object({
            username: Type.Optional(
                Type.String({ description: "The ref of the username or email field, such as e3." }),
            ),
            password: Type.Optional(
                Type.String({ description: "The ref of the password field, such as e4." }),
            ),
        }),
        execute: async (args, api, context) => {
            const page = await pageOf(api.conversationId);

            if (typeof page === "string") {
                return reply(page, true);
            }

            let username: BrowserTarget | undefined = refOf(args.username)
                ? { ref: refOf(args.username)! }
                : undefined;
            let password: BrowserTarget | undefined = refOf(args.password)
                ? { ref: refOf(args.password)! }
                : undefined;

            // No refs: the page's first password field, and the field before it for the username.
            if (username === undefined && password === undefined) {
                const { controls } = await page.snapshot();
                const fields = controls.filter(
                    (control) => !control.disabled && control.role !== "button",
                );
                const at = fields.findIndex((control) => control.kind === "password");
                const before = fields
                    .slice(0, at < 0 ? fields.length : at)
                    .findLast((control: BrowserControl) =>
                        ["text", "email", "tel", "textbox", "search"].includes(control.kind),
                    );

                if (at < 0 && before === undefined) {
                    return reply(
                        "This page has no sign-in fields. Snapshot it, and give the fields' refs.",
                        true,
                    );
                }

                password = at < 0 ? undefined : { ref: fields[at]!.ref };
                username = before === undefined ? undefined : { ref: before.ref };
            }

            // The password field must be one: a value typed for it never lands in a field that shows it.
            if (password !== undefined && !(await page.inspect(password)).password) {
                return reply(
                    `${args.password ?? "That field"} is not a password field: snapshot the page again.`,
                    true,
                );
            }

            if (username !== undefined) {
                const what = await page.inspect(username);

                if (!what.editable || what.password) {
                    return reply(`${args.username ?? "That field"} is not a username field.`, true);
                }
            }

            const site = siteOf(page.url);
            const answer = await host.ask(
                {
                    conversationId: api.conversationId,
                    id: `sign-in:${String(api.taskId)}:${api.callId}`,
                    taskId: api.taskId,
                    callId: api.callId,
                    title: `Sign in to ${site}`.slice(0, 120),
                    // The card itself adds that what is typed goes to the page, and that Pi does not see it.
                    text: "Pi's browser is at the site's sign-in.",
                    fields: [
                        ...(username === undefined
                            ? []
                            : [
                                  {
                                      name: "username",
                                      // A fixed label: the page's own words never go on the card.
                                      label: "Username or email",
                                      autocomplete: "username",
                                  },
                              ]),
                        ...(password === undefined
                            ? []
                            : [
                                  {
                                      name: "password",
                                      label: "Password",
                                      secret: true,
                                      autocomplete: "current-password",
                                  },
                              ]),
                    ],
                    submit: "Fill in",
                },
                context,
            );

            if (!answer.answered) {
                return reply(`${answer.by} declined to sign in.`, true);
            }

            if (password !== undefined) {
                const value = answer.values.password ?? "";

                // Hide first: if hiding refuses the value (too short), nothing went into the page.
                if (!hide(value, labelFor("password", site), api.conversationId)) {
                    return reply(
                        "The password could not be kept out of the chat (it is shorter than 4 characters), so nothing was filled in. Ask the person to sign in in the Browser panel with browser_ask_person.",
                        true,
                    );
                }
            }

            // The username field shows what was typed, so hide it too. One too short to hide still goes in, and the
            // page is then left out of what Pi gets.
            const userHidden =
                username === undefined ||
                hide(answer.values.username ?? "", labelFor("username", site), api.conversationId);

            try {
                if (username !== undefined) {
                    await page.fill(username, answer.values.username ?? "");
                }

                if (password !== undefined) {
                    await page.fill(password, answer.values.password ?? "");
                }
            } catch (error) {
                return reply(`The page did not take the values: ${(error as Error).message}`, true);
            }

            return userHidden
                ? after(page, `${answer.by} filled in the sign-in. Submit the form now.`)
                : reply(
                      `${answer.by} filled in the sign-in. Submit the form now. The page is not shown here, since its username field shows the username; take a snapshot after you submit.`,
                  );
        },
    });

    const askCode = defineTool({
        name: "browser_ask_code",
        description:
            "Ask the person for a one-time code (from a text message, an email, or an authenticator app) on a card: it goes straight into the field, and you never see it. Then submit the form yourself.",
        parameters: Type.Object({
            field: Type.String({ description: "The ref of the code field, such as e5." }),
            text: Type.Optional(
                Type.String({
                    description: "What to tell the person, such as: the 6-digit code texted to you",
                }),
            ),
        }),
        execute: async (args, api, context) => {
            const page = await pageOf(api.conversationId);

            if (typeof page === "string") {
                return reply(page, true);
            }

            const field = { ref: refOf(args.field) ?? "" };
            const what = await page.inspect(field).catch(() => undefined);

            if (what === undefined || !what.editable) {
                return reply(`${args.field} is not a field: snapshot the page again.`, true);
            }

            const site = siteOf(page.url);
            const answer = await host.ask(
                {
                    conversationId: api.conversationId,
                    id: `code:${String(api.taskId)}:${api.callId}`,
                    taskId: api.taskId,
                    callId: api.callId,
                    title: `A code for ${site}`.slice(0, 120),
                    text: (args.text ?? "The one-time code that the site sent you.").slice(0, 1500),
                    fields: [
                        {
                            name: "code",
                            label: "Code",
                            secret: true,
                            autocomplete: "one-time-code",
                        },
                    ],
                    submit: "Fill in",
                },
                context,
            );

            if (!answer.answered) {
                return reply(`${answer.by} declined to give the code.`, true);
            }

            const code = (answer.values.code ?? "").trim();
            // The field shows the code, so a snapshot would give it to Pi: hide it in this session for as long as the
            // module runs. A code too short to hide still goes in, and the page is then left out of what Pi gets.
            const codeHidden = hide(code, labelFor("code", siteOf(page.url)), api.conversationId);

            try {
                await page.fill(field, code);
            } catch (error) {
                return reply(`The page did not take the code: ${(error as Error).message}`, true);
            }

            return codeHidden
                ? after(page, `${answer.by} filled in the code. Submit the form now.`)
                : reply(
                      `${answer.by} filled in the code. Submit the form now. The page is not shown here, since its code field shows the code; take a snapshot after you submit.`,
                  );
        },
    });

    const askPerson = defineTool({
        name: "browser_ask_person",
        description:
            "Ask the person to do something in the browser page that only they can do (a CAPTCHA, approving a sign-in on their phone), then tap Done. You get the page as it is afterwards.",
        parameters: Type.Object({
            text: Type.String({ description: "What they should do, in a sentence" }),
        }),
        execute: async (args, api, context) => {
            const page = await pageOf(api.conversationId);

            if (typeof page === "string") {
                return reply(page, true);
            }

            const answer = await host.ask(
                {
                    conversationId: api.conversationId,
                    id: `person:${String(api.taskId)}:${api.callId}`,
                    taskId: api.taskId,
                    callId: api.callId,
                    title: `Pi's browser needs you on ${siteOf(page.url)}`.slice(0, 120),
                    text: `${args.text.slice(0, 1500)} Do it in the Browser panel, then tap Done.`,
                    submit: "Done",
                },
                context,
            );

            if (!answer.answered) {
                return reply(`${answer.by} declined.`, true);
            }

            return after(page, `${answer.by} said it is done.`);
        },
    });

    // Pi's own browser tool never types into a password field: the card fills it.
    const noTypedPasswords = hook(ToolTask, {
        beforeTool: async (call, api) => {
            const args = call.arguments as Record<string, unknown>;

            if (call.name !== "browser" || args.action !== "type") {
                return undefined;
            }

            const at = Object.fromEntries(
                TARGET.filter((key) => key in args).map((key) => [key, args[key]]),
            );

            // Without a target, Pi types where the focus is, which `inspect` cannot see.
            if (Object.keys(at).length === 0) {
                return undefined;
            }

            // A hook that throws blocks Pi's call: a page that cannot be read leaves the call to the browser tool.
            const found = await host
                .browser(api.conversationId)
                .then((page) => page?.inspect(at as BrowserTarget))
                .catch(() => undefined);

            return found?.password
                ? {
                      block: "That is a password field: Pi never types a password. Use browser_sign_in.",
                  }
                : undefined;
        },
    });

    web.client("browser-sign-in.js");

    return defineExtension({
        name: "browser-sign-in",
        tools: [signIn, askCode, askPerson],
        hooks: [noTypedPasswords],
        sections: [
            section("browser_sign_in", (input) =>
                input.agent.tools.some((tool) => tool.name === "browser") ? RULES : undefined,
            ),
        ],
    });
}
