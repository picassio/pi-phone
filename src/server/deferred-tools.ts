/**
 * Tools that load when Pi needs them (PP-276, the prompt's `tools` part): every tool's definition goes into each
 * request (109 tools, 84k characters on a new session), most of them rarely called. These are marked deferred (Pi Durable
 * leaves a deferred tool out of the request until `modelTools` loads it), and `tool_search` (Pi Durable's) finds and
 * loads them for the rest of the session. Other tools and codemode scripts can call them all the time.
 *
 * The wraps live in an extension of their own, so a session whose `tools` is `all` leaves it out of its selection
 * (`AgentDoc.extensions.remove`) and is offered every tool, as before.
 */
import type { Message } from "@earendil-works/pi-ai";
import { defineExtension, type Extension, GenerationTask, hook, type ToolRegistration, type Wrap } from "@earendil-works/pi-durable";
import { createToolSearchTool } from "@earendil-works/pi-durable/tool-search";

export const DEFERRED_EXTENSION = "deferred-tools";

/** The tools a computer control session works with: offered once one starts (`computer_control` start). */
export const COMPUTER_TOOLS = ["computer_screen", "computer_act", "computer_run", "computer_screenshot", "computer_sign_in"] as const;

/** The tools a phone control session works with: offered once one starts (`phone_control` start). */
export const PHONE_TOOLS = ["phone_screen", "phone_act", "phone_screenshot"] as const;

/** Rarely called, each by name; a name no extension provides (one that is off) is left alone. */
export const DEFERRED_TOOLS: readonly string[] = [
    ...COMPUTER_TOOLS,
    ...PHONE_TOOLS,
    // Pi's browser, beyond reading and acting on pages.
    "browser_attach",
    "browser_detach",
    "browser_upload",
    "browser_ask_code",
    "browser_size",
    "browser_save_pdf",
    "browser_layout_check",
    "browser_redline",
    "redline",
    "browser_hover",
    "browser_drag",
    "browser_focus",
    "browser_select_text",
    "browser_permission",
    "browser_forward",
    "browser_back",
    // The session list's upkeep, and every session's artifacts (PP-349).
    "artifacts_list",
    "session_fork",
    "session_compact",
    "session_new_context",
    "session_settle",
    "session_archive",
    "session_unsend",
    "session_groups",
    "session_group_create",
    "session_group_rename",
    "session_group_pin",
    "session_group_fold",
    "session_group_order",
    "session_group_move",
    "session_group_delete",
    // Pi in a machine's terminal.
    "pi_sessions",
    "pi_session_import",
    "continue_in_pi",
    "pi_bring_back",
    "machine_add",
    "machine_tools",
    // People's documents.
    "doc_search",
    "doc_list",
    "doc_read",
    "doc_history",
    "doc_write",
    "doc_edit",
    "doc_move",
    "doc_delete",
    "doc_restore",
    "doc_image",
    // The wiki's upkeep.
    "wiki_ingest",
    "wiki_summarize",
    "wiki_move",
    "wiki_lint",
    "wiki_migrate",
    // Devices and the app.
    "devices",
    "device_sign_out",
    "sign_out_everywhere",
    "extension_install",
    "extension_inspect",
    "extension_create",
    "extension_made",
    "app_action",
    "secret_save",
    "image_markup",
    "image_compare",
    // The owner's library of skills and slash commands (PP-468).
    "skill_save",
    "command_save",
    "library_pin",
    "library_list",
    "library_undo",
    "library_delete",
    // A board's rarer work.
    "project_create",
    "project_update",
    "project_team",
    "project_share",
    "project_delete",
    "task_delete",
    "task_cancel_run",
    "task_diff",
    "task_merge",
    "task_link_session",
];

/** In the prompt with the extension: fixed, so it is sent once. */
export const TOOL_SEARCH_NOTE =
    "Some tools are not offered until you need them: the rarer ones (people's documents, the session list's upkeep, Pi's terminal sessions on machines, machine tools, the wiki's upkeep, devices, making, installing and inspecting extensions, image markup and comparison, a board's rarer work, some of Pi's browser) and the screen tools of phone and computer control, which come by themselves when a control session starts. When a tool you need, or one these instructions name, is not offered (a call to it says it is not available), load it with tool_search: words of what it does, or its name. It is offered from your next call on, for the rest of the session.";

const deferred = (name: string): Wrap => ({ tool: name, wrap: (tool: ToolRegistration): ToolRegistration => ({ ...tool, deferred: true as const }) });

const DEFERRED = new Set(DEFERRED_TOOLS);

/** What a call to a deferred tool not loaded yet answers, after Pi Durable's "Tool <name> is not available". */
export const notLoaded = (name: string) =>
    ` ${name} is one of the rarer tools, offered once loaded: call tool_search with its name ("${name}") first, then call it again.`;

/**
 * Pi called a deferred tool it had not loaded (the owner saw "Tool session_archive is not available", and Pi did not
 * know why): such a result says how to load it, in every request (the same words each time, so the context's prefix
 * stays as it was). Another tool's "not available" is left as it is.
 */
export function explainNotLoaded(messages: readonly Message[]): readonly Message[] | undefined {
    let changed = false;
    const explained = messages.map((message) => {
        if (message.role !== "toolResult" || !message.isError || !DEFERRED.has(message.toolName)) {
            return message;
        }

        const plain = `Tool ${message.toolName} is not available`;
        const content = message.content.map((part) => (part.type === "text" && part.text.includes(plain) && !part.text.includes("tool_search") ? { ...part, text: part.text.replace(plain, `${plain}.${notLoaded(message.toolName)}`) } : part));

        if (content.every((part, index) => part === message.content[index])) {
            return message;
        }

        changed = true;

        return { ...message, content };
    });

    return changed ? explained : undefined;
}

export function deferredToolsExtension(): Extension {
    return defineExtension({
        name: DEFERRED_EXTENSION,
        tools: [createToolSearchTool() as unknown as ToolRegistration],
        wraps: DEFERRED_TOOLS.map(deferred),
        sections: [{ key: "tool_search", render: () => TOOL_SEARCH_NOTE }],
        hooks: [
            hook(GenerationTask, {
                beforeRequest: (request) => {
                    const messages = explainNotLoaded(request.messages);

                    return messages === undefined ? undefined : { messages };
                },
            }),
        ],
    });
}
