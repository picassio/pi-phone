// A tool call in one line, as transcripts and peek tiles show it.
import { t } from "./i18n.js";

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
 * call an extension described. Labels and the words in subjects are in the person's language (`i18n.js`); paths,
 * commands and what Pi typed stay as they are.
 */
export function describeCall(call) {
    const args = call.args ?? {};

    switch (call.name) {
        case "read": {
            const range = args.offset ? `:${args.offset}${args.limit ? `+${args.limit}` : ""}` : "";

            return { icon: "▤", label: t("Read"), subject: `${args.path ?? ""}${range}`, mono: true };
        }

        case "write":
            return { icon: "✎", label: t("Write"), subject: args.path ?? "", mono: true };
        case "edit":
            return { icon: "✎", label: t("Edit"), subject: args.path ?? "", mono: true };
        case "bash":
            return { icon: ">_", label: "", subject: short(args.command, 140), mono: true };
        case "artifact":
            return {
                icon: "✦",
                label: t("Artifact"),
                subject: args.title ?? args.id ?? "",
                mono: false,
            };

        case "codemode": {
            // The first line that does something: not the options line, a comment, or blank.
            const line = String(args.code ?? "")
                .split("\n")
                .map((each) => each.trim())
                .find((each) => each !== "" && !each.startsWith("//"));

            return { icon: "{}", label: t("Codemode"), subject: short(line ?? "", 140), mono: true };
        }

        case "interview": {
            let title = "";

            try {
                title = JSON.parse(args.questions ?? "").title ?? "";
            } catch {
                title = String(args.questions ?? "").startsWith("{") ? "" : String(args.questions ?? "");
            }

            return { icon: "?", label: args.async === true ? t("Interview, answered later") : t("Interview"), subject: title };
        }
        // The app's settings (extensions/settings.ts), devices, and board settings: what they read or change.
        case "settings":
            return { icon: "⚙", label: t("Reads settings"), subject: args.id ? `${args.id}${args.target ? ` (${args.target})` : ""}` : (args.area ?? t("all")), mono: Boolean(args.id) };
        case "setting_change":
            return { icon: "⚙", label: t("Changes"), subject: `${args.id ?? ""}${args.target ? ` (${args.target})` : ""} → ${short(args.value ?? "", 60)}`, mono: true };
        case "app_action":
            return { icon: "⚙", label: t("Action"), subject: `${args.id ?? ""}${args.args && Object.keys(args.args).length > 0 ? ` ${Object.values(args.args).join(", ")}` : ""}`, mono: true };
        case "devices":
            return { icon: "⚙", label: t("Devices"), subject: t("signed in") };
        case "device_sign_out":
            return { icon: "⚙", label: t("Signs out"), subject: t("device {id}", { id: String(args.id ?? "").slice(0, 8) }), mono: true };
        case "sign_out_everywhere":
            return { icon: "⚙", label: t("Signs out"), subject: t("every device") };
        case "board_settings":
            return {
                icon: "▦",
                label: t("Board settings"),
                subject:
                    [args.closer && t("closer {closer}", { closer: args.closer }), args.rules && t("rules {rules}", { rules: args.rules })].filter(Boolean).join(", ") ||
                    t("reads them"),
            };
        case "screenshot": {
            const what = args.artifact ? t("artifact {id}", { id: args.artifact }) : String(args.path ?? args.url ?? "").replace(/^https?:\/\//, "").replace(/^.*\//, (m) => (args.path ? "" : m));

            return { icon: "▣", label: t("Looks at"), subject: args.widths ? t("{what} at {widths} px", { what, widths: args.widths.join(", ") }) : what, mono: true };
        }
        // Pi's browser (extensions/browser.ts): what it did, and to what.
        case "browser_open":
            return { icon: "◍", label: t("Opens"), subject: String(args.url ?? "").replace(/^https?:\/\//, ""), mono: true };
        case "browser_new_tab":
            return { icon: "◍", label: t("New tab"), subject: args.url === undefined ? t("blank") : String(args.url).replace(/^https?:\/\//, ""), mono: true };
        case "browser_snapshot":
            return { icon: "◍", label: t("Reads"), subject: t("the page") };
        case "browser_text":
            return { icon: "◍", label: t("Reads"), subject: t("the whole page") };
        case "browser_screenshot":
            return { icon: "◍", label: t("Looks at"), subject: t("the page") };
        case "browser_click":
            return { icon: "◍", label: t("Clicks"), subject: `[${args.index ?? ""}]` };
        case "browser_hover":
            return { icon: "◍", label: t("Points at"), subject: `[${args.index ?? ""}]` };
        case "browser_type":
            // A saved secret by its name only (PP-32): its value never reaches the call.
            return {
                icon: "◍",
                label: t("Types"),
                subject: args.secret
                    ? t("[secret {name}] into [{index}]", { name: args.secret, index: args.index ?? "" })
                    : t("“{text}” into [{index}]", { text: short(args.text ?? "", 60), index: args.index ?? "" }),
            };
        case "browser_select":
            return { icon: "◍", label: t("Chooses"), subject: t("“{option}” in [{index}]", { option: args.option ?? "", index: args.index ?? "" }) };
        case "browser_scroll":
            return { icon: "◍", label: t("Scrolls"), subject: args.direction === "up" ? t("up") : t("down") };
        case "browser_press":
            return { icon: "◍", label: t("Presses"), subject: args.key ?? "" };
        case "browser_back":
            return { icon: "◍", label: t("Goes back"), subject: "" };
        case "browser_forward":
            return { icon: "◍", label: t("Goes forward"), subject: "" };
        case "browser_wait":
            return { icon: "◍", label: t("Waits"), subject: args.text ? t("for “{text}”", { text: args.text }) : t("{n} s", { n: args.seconds ?? 1 }) };
        case "browser_upload":
            return { icon: "◍", label: t("Uploads"), subject: (args.paths ?? []).join(", "), mono: true };
        case "browser_save_pdf":
            return { icon: "◍", label: t("Saves PDF"), subject: args.path ?? "", mono: true };
        case "browser_tabs":
            return {
                icon: "◍",
                label: t("Tabs"),
                subject: args.close ? t("closes {n}", { n: args.close }) : args.switch_to ? t("to {n}", { n: args.switch_to }) : t("lists them"),
            };
        case "browser_size":
            return { icon: "◍", label: t("Size"), subject: args.size === "desktop" ? t("desktop, 1280 px") : t("phone, 412 px") };
        case "browser_close":
            return { icon: "◍", label: t("Closes"), subject: t("this session's tabs") };
        case "browser_run":
            return { icon: "◍", label: t("Browser run"), subject: short(args.goal ?? "", 100) };
        case "browser_sign_in":
            return { icon: "◍", label: t("Asks you"), subject: t("to sign in") };
        case "browser_ask_code":
            return { icon: "◍", label: t("Asks you"), subject: t("for a code") };
        case "browser_ask_user":
            return { icon: "◍", label: t("Asks you"), subject: short(args.instruction ?? "", 100) };
        case "web_search": {
            const queries = [...(args.query ? [args.query] : []), ...(args.queries ?? [])];

            return { icon: "⌕", label: t("Web search"), subject: queries.join(" · ") };
        }
        case "fetch_content": {
            const urls = [...(args.url ? [args.url] : []), ...(args.urls ?? [])];

            return { icon: "↓", label: t("Read"), subject: urls.map((url) => url.replace(/^https?:\/\//, "")).join(" · "), mono: true };
        }
        case "file_to_markdown":
            return { icon: "▤", label: t("As Markdown"), subject: args.path ?? "", mono: true };
        case "board_mode":
            return { icon: "▦", label: t("Asks to use the board"), subject: `${args.project ?? ""}`, mono: true };
        case "project_list":
            return { icon: "▦", label: t("Projects"), subject: t("the boards Pi may use") };
        case "project_create":
            return { icon: "▦", label: t("Makes project"), subject: `${args.key ?? ""} · ${args.name ?? ""}` };
        case "project_update":
            return { icon: "▦", label: t("Changes project"), subject: `${args.project ?? ""}` };
        case "project_team":
            return { icon: "▦", label: t("Starts the main session of"), subject: `${args.project ?? ""}` };
        case "task_link_session":
            return { icon: "▦", label: t("Links a session to"), subject: `${args.task ?? ""}`, mono: true };
        case "project_share":
            return { icon: "▦", label: t("Shares project"), subject: t("{project} with {people}", { project: args.project ?? "", people: (args.people ?? []).join(", ") }) };
        case "project_delete":
            return { icon: "▦", label: t("Deletes project"), subject: `${args.project ?? ""}`, mono: true };
        case "task_delete":
            return { icon: "▦", label: t("Deletes task"), subject: `${args.task ?? ""}`, mono: true };
        case "task_cancel_run":
            return { icon: "▦", label: t("Withdraws the run of"), subject: `${args.task ?? ""}`, mono: true };
        case "task_diff":
            return { icon: "▦", label: t("Diff of"), subject: `${args.task ?? ""}`, mono: true };
        case "task_merge":
            return { icon: "▦", label: t("Merges"), subject: `${args.task ?? ""}`, mono: true };
        case "task_run":
            return { icon: "▦", label: t("Runs"), subject: `${args.task ?? ""}`, mono: true };
        case "task_list":
            return { icon: "▦", label: t("Tasks"), subject: [args.project, args.state, args.text].filter(Boolean).join(" · ") || t("on the board") };
        case "task_get":
            return { icon: "▦", label: t("Reads task"), subject: `${args.task ?? ""}`, mono: true };
        case "task_create":
            return { icon: "▦", label: t("Adds task"), subject: `${args.title ?? ""}` };
        case "task_update":
            return { icon: "▦", label: t("Updates task"), subject: `${args.task ?? ""}${args.state ? ` → ${args.state}` : ""}`, mono: true };
        case "task_comment":
            return { icon: "▦", label: t("Comments on"), subject: `${args.task ?? ""}`, mono: true };
        case "secrets_list":
            return { icon: "⚿", label: t("Secrets"), subject: t("the names Pi may use here") };
        case "secret_request":
            return { icon: "⚿", label: t("Asks for secret"), subject: `${args.name ?? ""}`, mono: true };
        case "secret_save":
            return { icon: "⚿", label: t("Saves secret"), subject: t("{name} from {command}", { name: args.name ?? "", command: short(args.command ?? "", 100) }), mono: true };

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
                label: t("Browser {action}", { action: args.action ?? "" }),
                subject: short(`${what}${typed}`, 120),
                mono: true,
            };
        }

        case "subagent":
            return {
                icon: "⧉",
                label: t("Subagent {action}", { action: args.action ?? "" }),
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
