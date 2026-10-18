/**
 * The PARA wiki for Pi: pi-para's tools (wiki_query, wiki_read, wiki_edit, wiki_write, wiki_move, wiki_ingest,
 * wiki_lint, wiki_summarize, wiki_migrate) and its context, scoped to the session's project, in every session's prompt.
 * The wiki is pi-para's, at ~/.pi/wiki, shared with pi-para in pi on other computers (`para.ts`).
 */
import type { Static, TSchema } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type ToolExecutionResult } from "@earendil-works/pi-durable";
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
import type { PocketHost } from "../host.ts";
import type { Para } from "../para.ts";

/** What pi-para's tools return: pi's tool result. */
type ParaResult = { content: ToolExecutionResult["output"]; details?: unknown; isError?: boolean };
/** What a tool's implementation is made from: the open wiki, and the calling session's scope. */
type Wiki = Awaited<ReturnType<Para["open"]>> & { scope: Awaited<ReturnType<Para["scope"]>>; markDirty: () => void };

export default function createPara(host: PocketHost) {
    const para = host.para;

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
        tool("wiki_ingest", WikiIngestParams, (wiki, args) =>
            createIngestExecute(wiki.wikiDir, wiki.store, scoped(wiki))(args as never),
        ),
        tool("wiki_lint", WikiLintParams, (wiki, args) =>
            createLintExecute(wiki.wikiDir, wiki.store, wiki.markDirty, () => wiki.config.lint)(args as never),
        ),
        tool("wiki_summarize", WikiSummarizeParams, (wiki, args) =>
            createSummarizeExecute(wiki.wikiDir, scoped(wiki))(args as never),
        ),
        tool("wiki_migrate", WikiMigrateParams, (wiki) => createMigrateExecute(wiki.wikiDir)()),
    ];

    return defineExtension({
        name: "pocket-para",
        tools,
        sections: [
            {
                key: "wiki",
                // pi-para's guidance, then what the wiki knows of this session's project (its context, cached until the wiki
                // changes). A wiki that cannot open says so here, once per prompt, rather than leaving Pi unaware.
                render: async (input) => {
                    const guidance = buildWikiToolGuidanceSection();

                    try {
                        const context = await para.context(input.agent.cwd ?? "");

                        return context === "" ? guidance : `${guidance}\n\n${context}`;
                    } catch (error) {
                        return `${guidance}\n\nThe wiki could not open: ${String(error)}. The wiki tools fail until it does.`;
                    }
                },
            },
        ],
    });
}
