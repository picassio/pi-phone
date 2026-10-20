// A tool call in one line, as transcripts and peek tiles show it.

const short = (text, max = 90) => {
    const flat = String(text ?? "")
        .replace(/\s+/g, " ")
        .trim();

    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/**
 * How extensions' browser modules show their own tools' calls (`pocket.toolCall`): `extension-ui.js` sets it, and it
 * gives `{ label, subject, iconPath? }` in text, or undefined for the default display.
 */
let ownDescription = () => undefined;
/** Goes up when what extensions describe changes, so that calls drawn before draw again. */
let ownRevision = 0;

export function setCallDescriber(describe) {
    ownDescription = describe;
}

export function describersChanged() {
    ownRevision++;
}

export const describersRevision = () => ownRevision;

/**
 * A tool call in one line: an icon, a label, and what it acts on. Peek tiles describe calls this way too. `own` marks a
 * call an extension described.
 */
export function describeCall(call) {
    const args = call.args ?? {};

    switch (call.name) {
        case "read": {
            const range = args.offset ? `:${args.offset}${args.limit ? `+${args.limit}` : ""}` : "";

            return { icon: "▤", label: "Read", subject: `${args.path ?? ""}${range}`, mono: true };
        }

        case "write":
            return { icon: "✎", label: "Write", subject: args.path ?? "", mono: true };
        case "edit":
            return { icon: "✎", label: "Edit", subject: args.path ?? "", mono: true };
        case "bash":
            return { icon: ">_", label: "", subject: short(args.command, 140), mono: true };
        case "artifact":
            return {
                icon: "✦",
                label: "Artifact",
                subject: args.title ?? args.id ?? "",
                mono: false,
            };

        case "codemode": {
            // The first line that does something: not the options line, a comment, or blank.
            const line = String(args.code ?? "")
                .split("\n")
                .map((each) => each.trim())
                .find((each) => each !== "" && !each.startsWith("//"));

            return { icon: "{}", label: "Codemode", subject: short(line ?? "", 140), mono: true };
        }

        case "interview": {
            let title = "";

            try {
                title = JSON.parse(args.questions ?? "").title ?? "";
            } catch {
                title = String(args.questions ?? "").startsWith("{") ? "" : String(args.questions ?? "");
            }

            return { icon: "?", label: args.async === true ? "Interview, answered later" : "Interview", subject: title };
        }
        case "screenshot": {
            const what = args.artifact ? `artifact ${args.artifact}` : String(args.path ?? args.url ?? "").replace(/^https?:\/\//, "").replace(/^.*\//, (m) => (args.path ? "" : m));

            return { icon: "▣", label: "Looks at", subject: `${what}${args.widths ? ` at ${args.widths.join(", ")} px` : ""}`, mono: true };
        }
        // Pi's browser (extensions/browser.ts): what it did, and to what.
        case "browser_open":
            return { icon: "◍", label: "Opens", subject: String(args.url ?? "").replace(/^https?:\/\//, ""), mono: true };
        case "browser_new_tab":
            return { icon: "◍", label: "New tab", subject: String(args.url ?? "blank").replace(/^https?:\/\//, ""), mono: true };
        case "browser_snapshot":
            return { icon: "◍", label: "Reads", subject: "the page" };
        case "browser_text":
            return { icon: "◍", label: "Reads", subject: "the whole page" };
        case "browser_screenshot":
            return { icon: "◍", label: "Looks at", subject: "the page" };
        case "browser_click":
            return { icon: "◍", label: "Clicks", subject: `[${args.index ?? ""}]` };
        case "browser_hover":
            return { icon: "◍", label: "Points at", subject: `[${args.index ?? ""}]` };
        case "browser_type":
            return { icon: "◍", label: "Types", subject: `“${short(args.text ?? "", 60)}” into [${args.index ?? ""}]` };
        case "browser_select":
            return { icon: "◍", label: "Chooses", subject: `“${args.option ?? ""}” in [${args.index ?? ""}]` };
        case "browser_scroll":
            return { icon: "◍", label: "Scrolls", subject: args.direction ?? "down" };
        case "browser_press":
            return { icon: "◍", label: "Presses", subject: args.key ?? "" };
        case "browser_back":
            return { icon: "◍", label: "Goes back", subject: "" };
        case "browser_forward":
            return { icon: "◍", label: "Goes forward", subject: "" };
        case "browser_wait":
            return { icon: "◍", label: "Waits", subject: args.text ? `for “${args.text}”` : `${args.seconds ?? 1} s` };
        case "browser_upload":
            return { icon: "◍", label: "Uploads", subject: (args.paths ?? []).join(", "), mono: true };
        case "browser_save_pdf":
            return { icon: "◍", label: "Saves PDF", subject: args.path ?? "", mono: true };
        case "browser_tabs":
            return { icon: "◍", label: "Tabs", subject: args.close ? `closes ${args.close}` : args.switch_to ? `to ${args.switch_to}` : "lists them" };
        case "browser_close":
            return { icon: "◍", label: "Closes", subject: "Pi's browser" };
        case "browser_run":
            return { icon: "◍", label: "Browser run", subject: short(args.goal ?? "", 100) };
        case "browser_sign_in":
            return { icon: "◍", label: "Asks you", subject: "to sign in" };
        case "browser_ask_code":
            return { icon: "◍", label: "Asks you", subject: "for a code" };
        case "browser_ask_user":
            return { icon: "◍", label: "Asks you", subject: short(args.instruction ?? "", 100) };
        case "web_search": {
            const queries = [...(args.query ? [args.query] : []), ...(args.queries ?? [])];

            return { icon: "⌕", label: "Web search", subject: queries.join(" · ") };
        }
        case "fetch_content": {
            const urls = [...(args.url ? [args.url] : []), ...(args.urls ?? [])];

            return { icon: "↓", label: "Read", subject: urls.map((url) => url.replace(/^https?:\/\//, "")).join(" · "), mono: true };
        }
        case "file_to_markdown":
            return { icon: "▤", label: "As Markdown", subject: args.path ?? "", mono: true };
        case "board_mode":
            return { icon: "▦", label: "Asks to use the board", subject: `${args.project ?? ""}`, mono: true };
        case "project_list":
            return { icon: "▦", label: "Projects", subject: "the boards Pi may use" };
        case "project_create":
            return { icon: "▦", label: "Makes project", subject: `${args.key ?? ""} · ${args.name ?? ""}` };
        case "project_update":
            return { icon: "▦", label: "Changes project", subject: `${args.project ?? ""}` };
        case "project_team":
            return { icon: "▦", label: "Starts the main session of", subject: `${args.project ?? ""}` };
        case "task_link_session":
            return { icon: "▦", label: "Links a session to", subject: `${args.task ?? ""}`, mono: true };
        case "project_share":
            return { icon: "▦", label: "Shares project", subject: `${args.project ?? ""} with ${(args.people ?? []).join(", ")}` };
        case "project_delete":
            return { icon: "▦", label: "Deletes project", subject: `${args.project ?? ""}`, mono: true };
        case "task_delete":
            return { icon: "▦", label: "Deletes task", subject: `${args.task ?? ""}`, mono: true };
        case "task_cancel_run":
            return { icon: "▦", label: "Withdraws the run of", subject: `${args.task ?? ""}`, mono: true };
        case "task_diff":
            return { icon: "▦", label: "Diff of", subject: `${args.task ?? ""}`, mono: true };
        case "task_merge":
            return { icon: "▦", label: "Merges", subject: `${args.task ?? ""}`, mono: true };
        case "task_run":
            return { icon: "▦", label: "Runs", subject: `${args.task ?? ""}`, mono: true };
        case "task_list":
            return { icon: "▦", label: "Tasks", subject: [args.project, args.state, args.text].filter(Boolean).join(" · ") || "on the board" };
        case "task_get":
            return { icon: "▦", label: "Reads task", subject: `${args.task ?? ""}`, mono: true };
        case "task_create":
            return { icon: "▦", label: "Adds task", subject: `${args.title ?? ""}` };
        case "task_update":
            return { icon: "▦", label: "Updates task", subject: `${args.task ?? ""}${args.state ? ` → ${args.state}` : ""}`, mono: true };
        case "task_comment":
            return { icon: "▦", label: "Comments on", subject: `${args.task ?? ""}`, mono: true };
        case "secrets_list":
            return { icon: "⚿", label: "Secrets", subject: "the names Pi may use here" };
        case "secret_request":
            return { icon: "⚿", label: "Asks for secret", subject: `${args.name ?? ""}`, mono: true };
        case "secret_save":
            return { icon: "⚿", label: "Saves secret", subject: `${args.name ?? ""} from ${short(args.command ?? "", 100)}`, mono: true };

        case "browser": {
            const firstLine = String(args.script ?? "")
                .split("\n")
                .find((each) => each.trim() !== "");
            const what =
                args.url ??
                (args.ref ? `[${String(args.ref).replace(/^\[|\]$/g, "")}]` : undefined) ??
                args.selector ??
                (args.label ? `“${args.label}”` : undefined) ??
                args.key ??
                args.viewport ??
                firstLine ??
                (args.text !== undefined ? `“${args.text}”` : "");
            const typed =
                args.action === "type" && args.text !== undefined && what !== `“${args.text}”`
                    ? ` ← “${args.text}”`
                    : "";

            return {
                icon: "◎",
                label: `Browser ${args.action ?? ""}`,
                subject: short(`${what}${typed}`, 120),
                mono: true,
            };
        }

        case "subagent":
            return {
                icon: "⧉",
                label: `Subagent ${args.action ?? ""}`,
                subject: [args.name, args.message && short(args.message, 60)]
                    .filter(Boolean)
                    .join(" · "),
                mono: true,
            };

        default: {
            const own = ownDescription(call.name, args);

            if (own !== undefined) {
                return { icon: "⚙", mono: false, own: true, ...own };
            }

            return {
                icon: "⚙",
                label: call.name,
                subject: short(JSON.stringify(args), 100),
                mono: true,
            };
        }
    }
}
