/**
 * The PARA wiki for Pi: pi-para's tools (wiki_query, wiki_read, wiki_edit, wiki_write, wiki_move, wiki_ingest,
 * wiki_lint, wiki_summarize, wiki_migrate) and its context, scoped to the session's project, in every session's prompt.
 * The wiki is pi-para's, at ~/.pi/wiki, shared with pi-para in pi on other computers (`para.ts`).
 */
import type { Static, TSchema } from "@earendil-works/pi-ai";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import {
    defineExtension,
    defineTool,
    hook,
    section,
    type ToolExecutionApi,
    type ToolExecutionResult,
    ToolTask,
} from "@earendil-works/pi-durable";
import { documentKind, toMarkdown } from "../documents.ts";
import { readOnlyCommand } from "./plan.ts";
import { CAPTURE_SYSTEM_PROMPT } from "pi-para/templates/prompts";
import { CAPTURE_EXTENSION } from "../para-capture.ts";
import type { JsonValue } from "@earendil-works/chord";
import { buildWikiToolGuidanceSection, WIKI_TOOL_DESCRIPTIONS, type WikiToolName } from "pi-para/wiki-tool-guidance";
import { createEditExecute, createReadExecute } from "pi-para/tools/edit-read";
import { createIngestExecute } from "pi-para/tools/ingest";
import { createLintExecute } from "pi-para/tools/lint";
import { createMigrateExecute } from "pi-para/tools/migrate";
import { createMoveExecute } from "pi-para/tools/move";
import { createQueryExecute } from "pi-para/tools/query";
import {
    WikiEditParams,
    WikiIngestParams,
    WikiLintParams,
    WikiMigrateParams,
    WikiMoveParams,
    WikiQueryParams,
    WikiReadParams,
    WikiSummarizeParams,
    WikiWriteParams,
} from "pi-para/tools/schemas";
import { createSummarizeExecute } from "pi-para/tools/summarize";
import { createWriteExecute } from "pi-para/tools/write";
import type { ExtensionWeb, PocketHost } from "../host.ts";
import type { Para } from "../para.ts";

/**
 * pi-para's own skill for working with the wiki (`skills/para/SKILL.md` in its package): consult it before planning,
 * search it before debugging, write decisions as they happen. First in the prompt's wiki section, before the schema and
 * the index, where it is read; it takes the place of pi-para's short guidance list. Read from the package, so it follows
 * pi-para's releases; a package without it fails the module's load, saying so.
 */
const PARA_SKILL = readFileSync(fileURLToPath(new URL("../skills/para/SKILL.md", import.meta.resolve("pi-para/config"))), "utf8")
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .trim();

/** In every session's prompt: the wiki's files are the tools' alone, so the index, search, and context stay current. */
const TOOLS_ONLY =
    "Change the wiki only with the wiki tools (wiki_write, wiki_edit, wiki_move, wiki_ingest, wiki_lint), and read it with wiki_read and wiki_query: never write, edit, move, or delete files under ~/.pi/wiki with write, edit, or bash. Only the tools keep its index, search, links, and log current; changing its files directly is refused.";
const REFUSED =
    "The wiki changes only through its tools: wiki_edit for exact changes to a page, wiki_write to create, append to, or replace pages, wiki_move to move one between categories. Writing its files directly would leave its index and search behind.";

/** What pi-para's tools return: pi's tool result. */
type ParaResult = { content: ToolExecutionResult["output"]; details?: unknown; isError?: boolean };
/** What a tool's implementation is made from: the open wiki, and the calling session's scope. */
type Wiki = Awaited<ReturnType<Para["open"]>> & { scope: Awaited<ReturnType<Para["scope"]>>; markDirty: () => void };

export default function createPara(host: PocketHost, web: ExtensionWeb) {
    const para = host.para;

    // The Wiki page (`para-web/`): the owner's, as the wiki is their own knowledge.
    const owner = { access: "owner" as const };
    const failed = (error: unknown) => web.error(400, error instanceof Error ? error.message : String(error));

    web.client("para-web", owner);
    web.route("GET", "tree", () => para.tree(), owner);
    web.route("GET", "status", () => para.status(), owner);
    // `mode=keywords`: at once, by keyword alone; without it, keywords and meaning (a remote embedding of the query).
    web.route(
        "GET",
        "search",
        async (request) => {
            const query = request.query.get("q") ?? "";

            return { results: request.query.get("mode") === "keywords" ? await para.searchKeywords(query) : await para.search(query) };
        },
        owner,
    );
    web.route(
        "GET",
        "page",
        async (request) => {
            const page = await para.page(request.query.get("path") ?? "").catch((error: unknown) => {
                throw failed(error);
            });

            if (page === null) {
                throw web.error(404, `There is no page ${request.query.get("path")}.`);
            }

            return page;
        },
        owner,
    );
    web.route(
        "POST",
        "page",
        async (request) => {
            const { path, raw, create } = request.body;

            if (typeof path !== "string" || typeof raw !== "string") {
                throw web.error(400, "Send the page's path and its text.");
            }

            return { said: await para.save(path, raw, create === true).catch((error: unknown) => {
                throw failed(error);
            }) };
        },
        owner,
    );

    // Open the wiki as the module loads: the first tool call or prompt need not wait for its index.
    para.ready().catch((error: unknown) => host.notice("warning", `The wiki could not open: ${String(error)}`));

    const tool = <P extends TSchema>(
        name: WikiToolName,
        parameters: P,
        run: (wiki: Wiki, args: Static<P>) => Promise<ParaResult>,
    ) =>
        defineTool({
            name,
            description: WIKI_TOOL_DESCRIPTIONS[name],
            parameters: parameters as never,
            execute: async (args, api, context) => {
                const cwd = (await api.agent(context)).cwd!;
                const wiki: Wiki = { ...(await para.open()), scope: await para.scope(cwd), markDirty: () => para.markDirty() };
                const result = await run(wiki, args as Static<P>);

                return {
                    output: result.content,
                    ...(result.details === undefined ? {} : { details: JSON.parse(JSON.stringify(result.details)) as JsonValue }),
                    ...(result.isError === true ? { isError: true } : {}),
                };
            },
        });

    const scoped = (wiki: Wiki) => () => wiki.scope;
    const tools = [
        tool("wiki_query", WikiQueryParams, (wiki, args) =>
            createQueryExecute(wiki.wikiDir, wiki.store, scoped(wiki), () => wiki.config.context.searchGraphBoost)(args as never),
        ),
        tool("wiki_read", WikiReadParams, (wiki, args) => createReadExecute(wiki.wikiDir)(args as never)),
        tool("wiki_edit", WikiEditParams, (wiki, args) =>
            createEditExecute(wiki.wikiDir, wiki.store, wiki.markDirty)(args as never),
        ),
        tool("wiki_write", WikiWriteParams, (wiki, args) =>
            createWriteExecute(wiki.wikiDir, wiki.store, scoped(wiki), wiki.markDirty)(args as never),
        ),
        tool("wiki_move", WikiMoveParams, (wiki, args) =>
            createMoveExecute(wiki.wikiDir, wiki.store, wiki.markDirty)(args as never),
        ),
        // A document (PDF, Word, …) on the phone is ingested as its Markdown, by markit, saved beside it: pi-para reads files
        // as text.
        tool("wiki_ingest", WikiIngestParams, async (wiki, args) => {
            const source = (args as { source?: unknown }).source;
            const path = typeof source === "string" && !/^https?:\/\//i.test(source) ? resolve(source.startsWith("~/") ? join(homedir(), source.slice(2)) : source) : undefined;
            const kind = path === undefined ? undefined : documentKind(path);

            if (path === undefined || kind === undefined || !existsSync(path)) {
                return createIngestExecute(wiki.wikiDir, wiki.store, scoped(wiki))(args as never);
            }

            const { markdown } = await toMarkdown(readFileSync(path), kind);

            writeFileSync(`${path}.md`, markdown);

            return createIngestExecute(wiki.wikiDir, wiki.store, scoped(wiki))({ ...(args as object), source: `${path}.md`, sourceType: "file" } as never);
        }),
        tool("wiki_lint", WikiLintParams, (wiki, args) =>
            createLintExecute(wiki.wikiDir, wiki.store, wiki.markDirty, () => wiki.config.lint)(args as never),
        ),
        tool("wiki_summarize", WikiSummarizeParams, (wiki, args) =>
            createSummarizeExecute(wiki.wikiDir, scoped(wiki))(args as never),
        ),
        tool("wiki_migrate", WikiMigrateParams, (wiki) => createMigrateExecute(wiki.wikiDir)()),
    ];

    // The capture session's own extension (`para-capture.ts`), selected there alone: the wiki tools, and pi-para's capture
    // instructions as its whole prompt.
    const capture = defineExtension({
        name: CAPTURE_EXTENSION,
        tools,
        sections: [section("capture", () => CAPTURE_SYSTEM_PROMPT, { tag: false })],
    });

    web.route(
        "POST",
        "capture",
        async (request) => {
            const session = request.body.session;

            if (typeof session !== "number") {
                throw web.error(400, "Name the session to capture.");
            }

            return host.wikiCapture.capture(session as never).catch((error: unknown) => {
                throw failed(error);
            });
        },
        owner,
    );
    web.route("GET", "capture", () => host.wikiCapture.status(), owner);

    // Wiki settings: pi-para's config, written by the app, and when idle sessions are captured.
    web.route(
        "GET",
        "settings",
        async () => ({ ...(await para.settings()), captureMinutes: (await host.wikiCapture.status()).minutes, models: para.models() }),
        owner,
    );
    web.route(
        "POST",
        "settings",
        async (request) => {
            const { captureMinutes, ...patch } = request.body as Record<string, unknown>;

            try {
                if (captureMinutes !== undefined) {
                    host.wikiCapture.setMinutes(captureMinutes);
                }

                await para.updateSettings(patch as never);
            } catch (error) {
                throw failed(error);
            }

            return { ...(await para.settings()), captureMinutes: (await host.wikiCapture.status()).minutes, models: para.models() };
        },
        owner,
    );
    web.route(
        "GET",
        "embedding-models",
        async () => ({
            signedIn: await para.hasKey("openrouter"),
            models: await para.embeddingModels().catch((error: unknown) => {
                throw web.error(502, error instanceof Error ? error.message : String(error));
            }),
        }),
        owner,
    );

    const main = defineExtension({
        name: "pocket-para",
        tools,
        sections: [
            {
                key: "wiki",
                // What the wiki knows of this session's project, with pi-para's guidance in it (its context, cached until the
                // wiki changes); the guidance alone when the wiki has nothing for it. A wiki that cannot open says so here,
                // rather than leaving Pi unaware.
                render: async (input) => {
                    try {
                        const context = (await para.context(input.agent.cwd ?? "")).replace(buildWikiToolGuidanceSection(), "").trim();

                        return [PARA_SKILL, TOOLS_ONLY, context].filter((part) => part !== "").join("\n\n");
                    } catch (error) {
                        return `${PARA_SKILL}\n\nThe wiki could not open: ${String(error)}. The wiki tools fail until it does.`;
                    }
                },
            },
        ],
        hooks: [
            // The wiki changes only through its tools (TOOLS_ONLY): a write, edit, or changing command on its files is
            // refused, naming the tool to use. Reading its files is left alone.
            hook(ToolTask, {
                beforeTool: async (call, api, context) => {
                    if (call.name !== "write" && call.name !== "edit" && call.name !== "bash") {
                        return undefined;
                    }

                    const runtime = api as typeof api & Partial<Pick<ToolExecutionApi, "agent">>;
                    const cwd = (await runtime.agent?.(context))?.cwd ?? "";

                    // A session on a machine works on that machine's files; the wiki is on the phone.
                    if (cwd.startsWith("machine:")) {
                        return undefined;
                    }

                    // A wiki that could not open has no index or context to keep current: nothing to refuse for it.
                    const opened = await para.open().catch(() => undefined);

                    if (opened === undefined) {
                        return undefined;
                    }

                    const { wikiDir } = opened;
                    const args = call.arguments as { path?: unknown; command?: unknown };

                    if (call.name === "bash") {
                        const command = typeof args.command === "string" ? args.command : "";
                        const names = command.includes(wikiDir) || /(^|[\s'"=])~?\/?\.pi\/wiki(\/|\s|$|['"])/.test(command);

                        return names && !readOnlyCommand(command) ? { block: REFUSED } : undefined;
                    }

                    const path = typeof args.path === "string" ? args.path : "";
                    const absolute = resolve(cwd, path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);

                    return absolute === wikiDir || absolute.startsWith(`${wikiDir}/`) ? { block: REFUSED } : undefined;
                },
            }),
        ],
    });

    return [main, capture];
}
