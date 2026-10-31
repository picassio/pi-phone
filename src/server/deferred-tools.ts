/**
 * Tools that load when Pi needs them (PP-276, the prompt's `tools` part): every tool's definition goes into each
 * request (109 tools, 84k characters on a new session), most of them rarely called. These are marked deferred (Pi Durable
 * leaves a deferred tool out of the request until `modelTools` loads it), and `tool_search` (Pi Durable's) finds and
 * loads them for the rest of the session. Other tools and codemode scripts can call them all the time.
 *
 * The wraps live in an extension of their own, so a session whose `tools` is `all` leaves it out of its selection
 * (`AgentDoc.extensions.remove`) and is offered every tool, as before.
 */
import { defineExtension, type Extension, type ToolRegistration, type Wrap } from "@earendil-works/pi-durable";
import { createToolSearchTool } from "@earendil-works/pi-durable/tool-search";

export const DEFERRED_EXTENSION = "deferred-tools";

/** The tools a computer control session works with: offered once one starts (`computer_control` start). */
export const COMPUTER_TOOLS = ["computer_screen", "computer_act", "computer_screenshot", "computer_sign_in"] as const;

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
    "browser_hover",
    "browser_forward",
    "browser_back",
    // The session list's upkeep.
    "session_fork",
    "session_compact",
    "session_new_context",
    "session_settle",
    "session_archive",
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
    "app_action",
    "secret_save",
    "image_markup",
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
    "Some tools are not offered until you need them: the rarer ones (people's documents, the session list's upkeep, Pi's terminal sessions on machines, the wiki's upkeep, devices, extension installs, image markup, a board's rarer work, some of Pi's browser) and the screen tools of phone and computer control, which come by themselves when a control session starts. When a tool you need, or one these instructions name, is not offered (a call to it says it is not available), load it with tool_search: words of what it does, or its name. It is offered from your next call on, for the rest of the session.";

const deferred = (name: string): Wrap => ({ tool: name, wrap: (tool: ToolRegistration): ToolRegistration => ({ ...tool, deferred: true as const }) });

export function deferredToolsExtension(): Extension {
    return defineExtension({
        name: DEFERRED_EXTENSION,
        tools: [createToolSearchTool() as unknown as ToolRegistration],
        wraps: DEFERRED_TOOLS.map(deferred),
        sections: [{ key: "tool_search", render: () => TOOL_SEARCH_NOTE }],
    });
}
