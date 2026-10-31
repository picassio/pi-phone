// What the server tests share: an isolated Pi install and data folder, a scripted model, and small helpers. Import
// this before anything from src/: it points Pi's config at a temporary folder first.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { type ConversationId, UsageDoc } from "@earendil-works/pi-durable";
import type { Attachment } from "../src/server/commands.ts";
import type { User } from "../src/server/config.ts";
import type { Client } from "../src/server/room.ts";
import { newestBig, WHATS_NEW_DIR } from "../src/server/whats-new.ts";

export const context = BACKGROUND_CONTEXT;

export const root = mkdtempSync(join(tmpdir(), "pi-pocket-test-"));
// Isolate from the real Pi install: its auth, settings, skills, and Lancet Guard.
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.PI_POCKET_GUARD = "off";
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
/** The folder test sessions work in. */
export const work = join(root, "work");
mkdirSync(work);
/** The home folder the app finds `~/.agents/skills` in, for the same isolation. */
export const home = join(root, "home");
mkdirSync(home);

const { PocketApp } = await import("../src/server/app.ts");

export type App = Awaited<ReturnType<typeof PocketApp.open>>;

/** The text of the newest message a model request carries, and who sent it. */
export function lastText(context: { messages: readonly { role: string; content: unknown }[] }): {
    role: string;
    text: string;
} {
    const last = context.messages.findLast((message) => message.role !== "system")!;
    const content =
        typeof last.content === "string"
            ? [{ type: "text", text: last.content }]
            : (last.content as { type: string; text?: string }[]);

    return {
        role: last.role,
        // The wiki's pages that came with a person's message (PP-276) are the app's, not what they wrote.
        text: content.flatMap((part) => (part.type === "text" && !(part.text ?? "").startsWith('<wiki-pages paths="') ? [part.text ?? ""] : [])).join(""),
    };
}

/** Echoes the last message: enough for tests that do not care what Pi says. */
export const echo: FauxResponseStep = (context) =>
    fauxAssistantMessage([fauxText(`echo: ${lastText(context as never).text}`)]);

/** A scripted provider, "faux", that answers every request with `route`. */
export function scriptedModel(route: FauxResponseStep = echo) {
    const faux = fauxProvider({
        tokensPerSecond: 2000,
        models: [
            { id: "faux-1" },
            { id: "faux-2" },
            { id: "faux-vision", input: ["text", "image"] },
        ],
    });

    // Plenty: a test file of many subagents (each of whose turns takes one) used 200 up.
    faux.setResponses(Array.from({ length: 1000 }, () => route));

    return faux;
}

/** Open the app on `dataDir` with the scripted model. Opening the same folder again is a restart; `now` moves its clock. */
export function openApp(
    model: ReturnType<typeof scriptedModel>,
    dataDir = join(root, "data"),
    now?: () => number,
    /** More of the app's options a test stands in (computer control's machines and launch, PP-178). */
    extra: Partial<Parameters<typeof PocketApp.open>[0]> = {},
    /**
     * `welcome`: the owner still has the first-run welcome to see (PP-234); otherwise it is done, as for most tests.
     * `tools`: `all` (most tests: a scripted model calls the tool it tests at once) or `load`, the app's default, where
     * the rarer tools wait for tool_search (PP-276, test/deferred-tools.test.ts).
     */
    { welcome = false, tools = "all" }: { welcome?: boolean; tools?: "load" | "all" } = {},
): Promise<App> {
    return PocketApp.open({
        dataDir,
        defaultCwd: work,
        supervised: false,
        log: () => {},
        configureModels: (models) => models.registerNativeProvider(model.provider),
        // More accounts of the scripted provider (accounts.ts): each answers as it does.
        accountProviders: { faux: () => model.provider as never },
        home,
        // Off unless a test stands one in (test/officecli.test.ts): on the phone the bundled binary would run.
        officecli: { runs: false },
        ...(now === undefined ? {} : { now }),
        ...extra,
    }).then((app) => {
        if (!welcome) {
            pastWelcome(app);
        }

        app.config.setContextPart("tools", tools);

        return app;
    });
}

/** Wait until `check` holds, polling. */
export async function until(
    check: () => Promise<boolean> | boolean,
    what: string,
    timeoutMs = 10_000,
): Promise<void> {
    const started = Date.now();

    while (!(await check())) {
        if (Date.now() - started > timeoutMs) {
            throw new Error(`Timed out waiting for ${what}`);
        }

        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

/** Record `dollars` more of model usage in a conversation, the way a model response does: the scripted model costs nothing. */
export async function recordCost(app: App, id: ConversationId, dollars: number, model = "faux/faux-1"): Promise<void> {
    await app.harness.commit(async (tx) => {
        const usage = await tx.doc(UsageDoc, id);

        usage.models[model] ??= {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        };
        usage.models[model].cost.output += dollars;
        usage.models[model].cost.total += dollars;
    }, context);
}

export const owner = (app: App) => app.config.users.find((user) => user.role === "owner")!;

/**
 * The owner as someone who has used the app: past the first-run welcome (PP-234), and the newest release's What's new
 * card seen (PP-235). For tests that open the app themselves: the welcome would cover what they test.
 */
export function pastWelcome(app: App): void {
    app.config.updateUser(owner(app).id, { welcome: "done", whatsNewSeen: newestBig(WHATS_NEW_DIR)?.version });
}

/** A session in `cwd` with the scripted model, no thinking. */
export async function newSession(app: App, cwd = work): Promise<ConversationId> {
    // New sessions start with a model someone picked, and none when nobody did: as if the owner picked this one before.
    app.config.lastModel ??= { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
    const { id } = await app.commands.createSession(owner(app), { cwd });

    await app.commands.configure(id, owner(app), {
        model: { provider: "faux", modelId: "faux-1" },
        thinkingLevel: "off",
    });

    return id;
}

/** Send a message as the owner and wait for Pi's answer. */
export async function say(
    app: App,
    id: ConversationId,
    text: string,
    attachments?: Attachment[],
): Promise<void> {
    const { submissionId } = await app.commands.submit(id, owner(app), {
        text,
        requestId: crypto.randomUUID(),
        ...(attachments === undefined ? {} : { attachments }),
    });

    await (await app.harness.submission(submissionId, context))!.wait(context);
}

/** The texts of a conversation's entries as the model sees them, oldest first. */
export async function modelTexts(app: App, id: ConversationId): Promise<string[]> {
    const view = await (await app.harness.conversation(id, context))!.context(context);

    return view.messages.map((message) => JSON.stringify(message.content));
}

/** A browser tab as the app sees it, recording every event it is sent. Attach it with `app.attach(tab.client)`. */
export function fakeTab(id: ConversationId | undefined, user: User, protocol = 2) {
    const events: { event: string; data: Record<string, unknown> }[] = [];
    const client: Client = {
        id: `tab-${crypto.randomUUID()}`,
        connection: `connection-${crypto.randomUUID()}`,
        user,
        conversationId: id,
        protocol,
        sentEntries: new Set<number>(),
        orderKey: "",
        send: (event: string, data: unknown) =>
            events.push({ event, data: data as Record<string, unknown> }),
    };
    const last = (event: string) => events.findLast((each) => each.event === event)?.data;
    /** A view field as a browser has it: updates leave out the fields that did not change. */
    const field = (name: string) =>
        events.findLast((each) => each.event === "view" && name in each.data)?.data[name];

    return { client, events, last, field };
}

/** Remove the temporary folder: call from `after`, once the app is closed. */
export function cleanUp(): void {
    rmSync(root, { recursive: true, force: true });
}
