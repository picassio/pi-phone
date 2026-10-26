// Browser runs' browser module: how Pi's browser_run calls show in transcripts and peek tiles.

/** The version of `pocket` this module was written for: an older app does not load it. */
export const pocketApi = 2;

/** A play mark in a window, as a 24 × 24 stroked path like the app's own icons. */
const RUN = "M3 5h18v14H3zM10 9.5v5l4.5-2.5z";

export default function setup(pocket) {
    pocket.toolCall({
        tool: "browser_run",
        iconPath: RUN,
        label: () => "browser_run",
        subject: (args) => String(args.goal ?? ""),
        summary: () => ({ verb: "ran", noun: "browser goal" }),
    });
}
