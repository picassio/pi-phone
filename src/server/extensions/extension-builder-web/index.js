// The Extension builder's browser part (PP-369): how the Creator flow's calls show in the transcript. Its progress card,
// under an extension_create call, is the app's own (web/made-card.js); this module's events (`made`) keep it current.
export default function extensionBuilder(pocket) {
    const { t } = pocket;
    const ACTIONS = {
        install: t("Install"),
        checked: t("Checked in the app"),
        keep: t("Keep"),
        undo: t("Undo"),
        restore: t("Restore"),
        list: t("Drop-ins Pi made"),
    };

    pocket.toolCall({
        tool: "extension_create",
        label: () => t("Make a drop-in"),
        subject: (args) => (typeof args.title === "string" ? args.title : ""),
        icon: "plus",
    });
    pocket.toolCall({
        tool: "extension_made",
        label: (args) => ACTIONS[args.action] ?? t("Drop-ins Pi made"),
        subject: (args) => (typeof args.name === "string" ? `made-${args.name.replace(/^made-/, "")}` : ""),
        icon: "grid",
    });
}
