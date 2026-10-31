/**
 * The model and thinking level Pi starts subagents on (PP-281): one choice for every session (`config.subagentDefaults`)
 * and a session's own (`SessionMeta.subagentDefaults`), each part on its own. Pi passes another model or level on a spawn
 * only when the person asks in the chat; without either, the session's own model and level, as before.
 *
 * - model: `provider/modelId`, or `session` (stored only as a session's own, over every session's) or absent for the
 *   session's own model.
 * - thinking: a thinking level, or `session` (likewise) or absent for the session's own level (never above it, as before).
 */
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

/** The session's own model or level, chosen by a session over every session's choice. */
export const SESSION = "session";

export type SubagentDefaults = { model?: string; thinking?: ModelThinkingLevel | typeof SESSION };
export type SubagentPart = keyof SubagentDefaults;

export const SUBAGENT_PARTS: readonly SubagentPart[] = ["model", "thinking"];

/** Where a resolved part comes from: this session's own choice, every session's, or the session itself (none set). */
export type SubagentSource = "own" | "all" | "session";

export type ResolvedSubagentDefaults = {
    model?: string;
    thinking?: ModelThinkingLevel;
    from: Record<SubagentPart, SubagentSource>;
};

/** A session's own choices over every session's; a part neither sets is the session's own. */
export function resolveSubagentDefaults(all: SubagentDefaults | undefined, own: SubagentDefaults | undefined): ResolvedSubagentDefaults {
    const pick = <K extends SubagentPart>(part: K): [SubagentDefaults[K], SubagentSource] =>
        own?.[part] !== undefined ? [own[part], "own"] : all?.[part] !== undefined ? [all[part], "all"] : [undefined, "session"];
    const [model, modelFrom] = pick("model");
    const [thinking, thinkingFrom] = pick("thinking");

    return {
        ...(model === undefined || model === SESSION ? {} : { model }),
        ...(thinking === undefined || thinking === SESSION ? {} : { thinking }),
        from: { model: modelFrom, thinking: thinkingFrom },
    };
}

/** How long until a time, in words: "2h 10m", "45m", "3d". */
export function untilText(ms: number): string {
    const minutes = Math.max(0, Math.round(ms / 60_000));

    if (minutes < 60) {
        return `${String(minutes)}m`;
    }

    if (minutes < 48 * 60) {
        return `${String(Math.floor(minutes / 60))}h ${String(minutes % 60)}m`;
    }

    return `${String(Math.round(minutes / (24 * 60)))}d`;
}

/** `defaults` with `part` set to `value`, or without it (undefined); undefined when nothing is left. */
export function withPart(defaults: SubagentDefaults | undefined, part: SubagentPart, value: string | undefined): SubagentDefaults | undefined {
    const next: Record<string, string> = { ...defaults };

    if (value === undefined) {
        delete next[part];
    } else {
        next[part] = value;
    }

    return Object.keys(next).length === 0 ? undefined : (next as SubagentDefaults);
}
