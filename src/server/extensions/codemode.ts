/**
 * Codemode: Pi Durable's own (1.2.0 and later). The agent writes short JavaScript that calls its tools as nested calls
 * (`tools.<name>(args)`), batching, chaining, and filtering before output reaches the model. Scripts run in a QuickJS
 * sandbox without Node, files, network, or timers; every call they make goes through the same checks and hooks as a
 * direct call. A script survives a restart: it is replayed from a journal of the results it got. `store()` and `load()`
 * keep values per conversation.
 *
 * Its mode is the owner's, for every session (PP-379, from pi-pocket 0.28.0; setting `codemode.mode`):
 * - `on`: Pi calls its tools directly, or from a script. The `codemode` section is one line: the model sees the tools
 *   it may call already (Pi Durable's own section listed them all again, about 11,700 characters in each new session).
 * - `only`: Pi calls them only from scripts. Every tool but `DECLARED` is wrapped to `callers: ["tools"]` (not offered
 *   to the model, callable by scripts), tool_search with them; the section lists them for scripts, smallest first within
 *   Pi's default inline budget, then the names of the rest. The names come at each resolve (`wraps` is a getter), so a
 *   module turned on later is covered too, and no session keeps any state of it.
 */
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { defineExtension, type PromptSection, section, type ToolRegistration, type Wrap } from "@earendil-works/pi-durable";
import { CODEMODE_TOOL_NAME, createCodemodeTool, DEFAULT_CODEMODE_INLINE_BUDGET } from "@earendil-works/pi-durable/codemode";
import { TOOL_SEARCH_TOOL_NAME } from "@earendil-works/pi-durable/tool-search";
import type { PocketHost } from "../host.ts";

export const CODEMODE_TOOL = CODEMODE_TOOL_NAME;

/**
 * Declared to the model in Only mode too: codemode, and the tools whose card in the transcript reads their call's details
 * (a script's nested call keeps its details to itself): the artifact viewer, a subagent's Open, the pictures, video and
 * audio a tool made, a browser run's and a screen's card, and the Creator's progress card.
 */
export const DECLARED: ReadonlySet<string> = new Set([
    CODEMODE_TOOL,
    "artifact",
    "subagent",
    "image_generate",
    "video_generate",
    "audio_speak",
    "audio_transcribe",
    "browser_run",
    "show_screen",
    "extension_create",
]);

/** How much of the request the Only listing may take: Pi's default inline budget, at 4 characters a token. */
const INLINE_CHARS = DEFAULT_CODEMODE_INLINE_BUDGET * 4;

export const ONLY_GUIDE =
    "Your other tools are not declared: call them only from a codemode script, `await tools.<name>({ ...args })`. Where this prompt says to use one of them (read, bash, edit, write, the rest), call it from a script. One script batches independent calls (Promise.allSettled), chains them, or filters large output. The rarer tools are callable too: find them with `searchTools(query)` and read one's parameters with `describeTool(name)`.";

/** The section in On mode: the model sees its tools already. */
export const ON_GUIDE = "Use codemode to batch independent tool calls (Promise.allSettled), chain them, or filter large output.";

/** The Only section: each tool for scripts with its parameters, smallest first within the budget, then the names. */
export function onlyListing(tools: readonly ToolRegistration[]): string {
    const entries = tools.map((tool) => `## ${tool.name}\n${tool.description}\nParameters (JSON Schema): ${JSON.stringify(tool.parameters)}`);
    const shown = new Set<string>();
    let left = INLINE_CHARS;

    for (const entry of [...entries].sort((a, b) => a.length - b.length)) {
        if (entry.length > left) {
            break;
        }

        left -= entry.length;
        shown.add(entry);
    }

    const rest = tools.filter((_, at) => !shown.has(entries[at]!)).map((tool) => tool.name);

    return [ONLY_GUIDE, ...entries.filter((entry) => shown.has(entry)), ...(rest.length === 0 ? [] : [`Also callable, not listed (describeTool for their parameters): ${rest.join(", ")}`])].join("\n\n");
}

export default function createCodemode(host: PocketHost) {
    /** Only mode's wraps: every installed tool but `DECLARED` for scripts alone; the declared ones never wait. */
    const hide = (): Wrap[] => [
        ...host
            .toolNames()
            .filter((name) => !DECLARED.has(name))
            .map(
                (name): Wrap => ({
                    tool: name,
                    // Not the model's: scripts keep what they could call (a tool for the model alone, tool_search, for nobody).
                    wrap: (tool: ToolRegistration): ToolRegistration => ({ ...tool, callers: (tool.callers ?? ["model", "tools"]).filter((caller) => caller !== "model") }),
                }),
            ),
        // A declared tool that would wait for tool_search (extension_create) is offered: tool_search is for scripts too.
        ...[...DECLARED].map(
            (name): Wrap => ({
                tool: name,
                wrap: (tool: ToolRegistration) => {
                    const { deferred: _waits, ...offered } = tool;

                    return offered as ToolRegistration;
                },
            }),
        ),
        // tool_search's note says to load tools with it: in Only mode scripts call every tool, and searchTools() finds them.
        { section: TOOL_SEARCH_TOOL_NAME, wrap: (shown: PromptSection): PromptSection => ({ ...shown, render: () => undefined }) },
    ];

    return defineExtension({
        name: "codemode",
        // No models.* for scripts: a script that generates images or classifies text spends the owner's money unasked.
        tools: [createCodemodeTool({ sandbox: new CodemodeSandbox(), models: false })],
        get wraps(): Wrap[] {
            return host.codemodeOnly() ? hide() : [];
        },
        sections: [
            section("codemode", ({ agent }) => {
                if (!agent.tools.some((tool) => tool.name === CODEMODE_TOOL)) {
                    return undefined;
                }

                if (!host.codemodeOnly()) {
                    return ON_GUIDE;
                }

                return onlyListing(agent.callable.filter((tool) => tool.name !== CODEMODE_TOOL && tool.callers?.includes("model") === false && tool.deferred !== true));
            }),
        ],
    });
}
