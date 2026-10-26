// Browser sign-in's browser module: how Pi's calls of its three tools show in transcripts and peek tiles. The cards
// themselves are Pi Pocket's own (`host.ask`).

/** The version of `pocket` this module was written for: an older app does not load it. */
export const pocketApi = 2;

/** A padlock, as a 24 × 24 stroked path like the app's own icons. */
const LOCK = "M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3";

export default function setup(pocket) {
    pocket.toolCall({
        tool: "browser_sign_in",
        iconPath: LOCK,
        label: () => "sign in",
        subject: () => "the person types it",
        summary: () => ({ verb: "asked to sign in" }),
    });
    pocket.toolCall({
        tool: "browser_ask_code",
        iconPath: LOCK,
        label: () => "ask for a code",
        subject: (args) => String(args.text ?? ""),
        summary: () => ({ verb: "asked for a code" }),
    });
    pocket.toolCall({
        tool: "browser_ask_person",
        iconPath: LOCK,
        label: () => "ask the person",
        subject: (args) => String(args.text ?? ""),
        summary: () => ({ verb: "asked the person" }),
    });
}
