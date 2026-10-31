/**
 * What of the wiki, the secrets, and the skills goes into a session's prompt (PP-276). Pi Durable keeps the prompt as
 * system messages in the transcript: a section whose text changes is sent again, and each copy stays in the context
 * until it is compacted. The wiki's index changed with every write in any session (21k characters each time, 12 times
 * in 3 days in one session), the secrets list with every new secret. These choices keep that text out, or fixed.
 *
 * - wiki: `relevant` (a short, fixed section; the pages that match each of the person's messages come with that message,
 *   with a line naming pages other sessions changed), `frozen` (the index as it was when the session first had it),
 *   `live` (the index, sent again whenever it changes), `off` (the rules only: Pi searches with wiki_query).
 * - secrets: `tool` (the rules, and secrets_list to find them) or `list` (every usable secret named in the prompt).
 * - skills: `frozen` (the list a session first had, until skills are added or taken away) or `live`.
 *
 * Each has a value for every session (Settings) and may have one for a single session.
 */

export const WIKI_MODES = ["relevant", "frozen", "live", "off"] as const;
export const SECRETS_MODES = ["tool", "list"] as const;
export const SKILLS_MODES = ["frozen", "live"] as const;

export type WikiMode = (typeof WIKI_MODES)[number];
export type SecretsMode = (typeof SECRETS_MODES)[number];
export type SkillsMode = (typeof SKILLS_MODES)[number];

export type ContextPolicy = { wiki: WikiMode; secrets: SecretsMode; skills: SkillsMode };
export type ContextPart = keyof ContextPolicy;

export const CONTEXT_PARTS: readonly ContextPart[] = ["wiki", "secrets", "skills"];

export const DEFAULT_CONTEXT_POLICY: ContextPolicy = { wiki: "relevant", secrets: "tool", skills: "frozen" };

/** The values one part takes. */
export function contextModes(part: ContextPart): readonly string[] {
    return part === "wiki" ? WIKI_MODES : part === "secrets" ? SECRETS_MODES : SKILLS_MODES;
}

/** `value` checked for `part`: the mode, or an Error saying which values it takes. */
export function contextMode(part: ContextPart, value: unknown): string {
    const modes = contextModes(part);

    if (typeof value !== "string" || !modes.includes(value)) {
        throw new Error(`The prompt's ${part} is ${modes.join(", ")}.`);
    }

    return value;
}

/** Every session's choices over the defaults, then one session's own over those. */
export function resolveContextPolicy(all: Partial<ContextPolicy> | undefined, own: Partial<ContextPolicy> | undefined): ContextPolicy {
    return { ...DEFAULT_CONTEXT_POLICY, ...all, ...own };
}

/**
 * A section's text as the session already has it (Pi Durable's `shown`, which keeps the `<key>` tags of a tagged
 * section), without the tags: what its render returns to keep it as it is.
 */
export function shownText(shown: Readonly<Record<string, string>>, key: string, tagged = true): string | undefined {
    const text = shown[key];

    if (text === undefined || !tagged) {
        return text;
    }

    const open = `<${key}>\n`;
    const close = `\n</${key}>`;

    return text.startsWith(open) && text.endsWith(close) ? text.slice(open.length, text.length - close.length) : undefined;
}

/** The skills a skills section names (`<name>…</name>`), in order. */
export function skillNames(text: string): string[] {
    return [...text.matchAll(/<name>([^<]*)<\/name>/g)].map((match) => match[1]!);
}

/**
 * The skills section to send, with skills `frozen`: the one the session has while it names the same skills (an update
 * that only rewords one is not worth sending again); the new one when skills were added or taken away.
 */
export function frozenSkills(shown: string | undefined, fresh: string | undefined): string | undefined {
    if (shown === undefined || fresh === undefined) {
        return fresh;
    }

    return skillNames(shown).join("\n") === skillNames(fresh).join("\n") ? shown : fresh;
}
