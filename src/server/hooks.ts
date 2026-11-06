/**
 * Hooks (PP-418, PP-419): checks pi-phone runs around Pi's work by itself, so a step the prompt only asks for cannot be
 * skipped. Each has an id, what it does and when, and a default; the owner turns each on or off in Settings › Hooks, and
 * Pi does through setting_change (`hooks.<id>`, `settings-registry.ts`). The config keeps only what differs from the
 * defaults (`config.ts`).
 *
 * - `artifactCheck` (PP-421): the artifact tool renders an HTML, SVG or openui artifact it published at the screenshot
 *   widths and puts the layout check's counts in its own result (`extensions/artifacts.ts`).
 * - `uiReminder` (PP-422): a turn that ends with UI files changed after its last look at them gets one follow-up that
 *   asks Pi to check them (`ui-reminder.ts`, the generation's `onYield` in `extensions/screenshot.ts`).
 *
 * Behaviours that act as hooks but keep settings of their own (the wiki's capture after idle, auto-compact) are listed
 * beside them on the sheet (`BuiltInBehaviour`), with their own setting's value; their settings stay where they are.
 */

export const HOOK_IDS = ["artifactCheck", "uiReminder"] as const;

export type HookId = (typeof HOOK_IDS)[number];

export type HookInfo = {
    id: HookId;
    /** Sentence case, as the sheet and the settings tool show it. */
    title: string;
    /** What it does, in a sentence. */
    does: string;
    /** When it runs, in a sentence. */
    when: string;
    /** On or off when the owner never changed it. */
    default: boolean;
    /** Only the owner changes it (every hook so far). */
    owner: true;
};

export const HOOKS: readonly HookInfo[] = [
    {
        id: "artifactCheck",
        title: "Check artifacts on publish",
        does: "Renders the artifact at 390, 1280 and 1920 px and adds the layout check's counts to the artifact tool's result, so Pi sees cut text, overlaps, small tap targets and low contrast in the same call.",
        when: "Each time Pi publishes an HTML, SVG or interactive artifact.",
        default: true,
        owner: true,
    },
    {
        id: "uiReminder",
        title: "Remind to check UI before finishing",
        does: "Sends Pi one follow-up naming the UI files it changed after its last screenshot, asking it to check them at 390, 1280 and 1920 px or say why not.",
        when: "When Pi ends a turn with UI files edited after its last check; once a turn, subagents too.",
        default: true,
        owner: true,
    },
];

export const isHookId = (id: string): id is HookId => (HOOK_IDS as readonly string[]).includes(id);

export const hookInfo = (id: HookId): HookInfo => HOOKS.find((hook) => hook.id === id)!;

/** Automatic behaviours with settings of their own: listed on the sheet with their value, never moved there. */
export type BuiltInBehaviour =
    | { id: "wikiCapture"; setting: "wiki.captureMinutes"; minutes: number | null }
    | { id: "autoCompact"; setting: "sessions.compactAt"; at: number | "full" };

/** What Settings › Hooks shows (`GET /api/hooks`). */
export type HooksView = {
    hooks: (Omit<HookInfo, "owner"> & { on: boolean })[];
    builtIn: BuiltInBehaviour[];
};
