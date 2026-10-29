/**
 * Design systems Pi designs with (PP-241): OpenDesign's 152, bundled in `third_party/open-design/design-systems/`
 * (`scripts/sync-open-design.ts` writes their `index.json`), and the person's own in `<data>/design-systems/<id>/`,
 * in the same shape: `DESIGN.md` (the prose: colours and their roles, type, spacing, components), `tokens.css` (the
 * same as CSS custom properties) and `manifest.json` (id, name, category, description). A person's system by a
 * bundled one's id comes first, as their skills do. (A brand-extract skill, PP-240, is to write them from a website.)
 *
 * All of it is the Design & video extension's (PP-247, `extensions/design.ts`): when it is on, its skills load
 * (`DESIGN_SKILLS`: the `design-system` skill, which lists and searches them with `src/design/skills/design-system/
 * systems.ts`, OpenDesign's deck templates and GSAP skills, Motion Video Kit's business-motion-film), and its Design
 * system setting (`design.default`, Menu › Design system) names the one Pi uses unless asked otherwise, in its prompt.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { APP_ROOT } from "./config.ts";

export const BUNDLED_DESIGN_SYSTEMS = join(APP_ROOT, "third_party", "open-design", "design-systems");

/** The Design & video extension's module (`extensions/design.ts`), and its name as it installs. */
export const DESIGN_MODULE = "design.ts";
export const DESIGN_EXTENSION = "pocket-design";

/** The skill folders the extension adds, while it is on. */
export const DESIGN_SKILLS = [
    join(APP_ROOT, "src", "design", "skills"),
    join(APP_ROOT, "third_party", "open-design", "skills"),
    join(APP_ROOT, "third_party", "motion-video-kit", "skills"),
];

/** The person's own design systems. */
export const ownDesignSystems = (dataDir: string): string => join(dataDir, "design-systems");

/** A design system's id: its folder's name. */
export const DESIGN_SYSTEM_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export type DesignSystem = {
    id: string;
    name: string;
    category: string;
    /** One line: what it looks like. */
    summary: string;
    /** The person's own (`<data>/design-systems/`), not bundled. */
    mine: boolean;
    /** DESIGN.md and tokens.css, absolute. */
    design: string;
    tokens: string;
};

export type DesignSystems = {
    systems: DesignSystem[];
    /** The person's folders that are not a design system, each with what it lacks. */
    problems: string[];
};

type Entry = { id: string; name: string; category: string; summary: string };

function bundled(): DesignSystem[] {
    const index = JSON.parse(readFileSync(join(BUNDLED_DESIGN_SYSTEMS, "index.json"), "utf8")) as Entry[];

    return index.map((entry) => ({
        ...entry,
        mine: false,
        design: join(BUNDLED_DESIGN_SYSTEMS, entry.id, "DESIGN.md"),
        tokens: join(BUNDLED_DESIGN_SYSTEMS, entry.id, "tokens.css"),
    }));
}

/** The person's own: each folder with all three files and a manifest naming it; the others are problems. */
function own(dataDir: string): DesignSystems {
    const folder = ownDesignSystems(dataDir);
    const systems: DesignSystem[] = [];
    const problems: string[] = [];

    if (!existsSync(folder)) {
        return { systems, problems };
    }

    for (const id of readdirSync(folder).sort()) {
        const dir = join(folder, id);

        if (!statSync(dir).isDirectory()) {
            continue;
        }

        if (!DESIGN_SYSTEM_ID.test(id)) {
            problems.push(`${dir}: a design system's folder name is lowercase letters, digits and hyphens`);
            continue;
        }

        const missing = ["DESIGN.md", "tokens.css", "manifest.json"].filter((file) => !existsSync(join(dir, file)));

        if (missing.length > 0) {
            problems.push(`${dir}: no ${missing.join(", ")}`);
            continue;
        }

        let manifest: { id?: unknown; name?: unknown; category?: unknown; description?: unknown };

        try {
            manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as typeof manifest;
        } catch (error) {
            problems.push(`${dir}/manifest.json: ${error instanceof Error ? error.message : String(error)}`);
            continue;
        }

        const { name, category, description } = manifest;

        if (manifest.id !== id || typeof name !== "string" || typeof category !== "string" || typeof description !== "string") {
            problems.push(`${dir}/manifest.json: needs "id": "${id}", and a "name", "category" and "description"`);
            continue;
        }

        systems.push({ id, name, category, summary: description, mine: true, design: join(dir, "DESIGN.md"), tokens: join(dir, "tokens.css") });
    }

    return { systems, problems };
}

/** Every design system: the person's first, then the bundled ones whose id is not theirs. */
export function listDesignSystems(dataDir: string): DesignSystems {
    const mine = own(dataDir);
    const taken = new Set(mine.systems.map((system) => system.id));

    return { systems: [...mine.systems, ...bundled().filter((system) => !taken.has(system.id))], problems: mine.problems };
}

/** The design system `id`, or undefined when there is none by it. */
export function findDesignSystem(dataDir: string, id: string): DesignSystem | undefined {
    return listDesignSystems(dataDir).systems.find((system) => system.id === id);
}

/**
 * The systems with every word of `query` in their id, name, category or summary, best first: words in the name or id
 * count most, then the category, then the summary.
 */
export function searchDesignSystems(systems: DesignSystem[], query: string): DesignSystem[] {
    const words = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word !== "");

    if (words.length === 0) {
        return systems;
    }

    const scored = systems.flatMap((system) => {
        const title = `${system.id} ${system.name}`.toLowerCase();
        const category = system.category.toLowerCase();
        const summary = system.summary.toLowerCase();
        let score = 0;

        for (const word of words) {
            const points = title.includes(word) ? 3 : category.includes(word) ? 2 : summary.includes(word) ? 1 : 0;

            if (points === 0) {
                return [];
            }

            score += points;
        }

        return [{ system, score }];
    });

    return scored.sort((a, b) => b.score - a.score || Number(b.system.mine) - Number(a.system.mine) || a.system.id.localeCompare(b.system.id)).map((each) => each.system);
}

/**
 * The tokens every design system's tokens.css binds (OpenDesign's token schema, which all bundled ones follow): colour
 * roles, the three font stacks, the type scale, spacing and radii. A person's own binds them all too.
 */
export const REQUIRED_TOKENS = [
    "--bg",
    "--surface",
    "--fg",
    "--fg-2",
    "--muted",
    "--border",
    "--accent",
    "--accent-on",
    "--accent-hover",
    "--success",
    "--warn",
    "--danger",
    "--font-display",
    "--font-body",
    "--font-mono",
    "--text-sm",
    "--text-base",
    "--text-lg",
    "--text-2xl",
    "--text-4xl",
    "--space-2",
    "--space-4",
    "--space-8",
    "--radius-sm",
    "--radius-md",
    "--radius-lg",
] as const;

/**
 * The custom properties of a tokens.css's first `:root { … }` block, in order, each `var(--other)` replaced by the
 * other's value (for Office files, which take plain values).
 */
export function readTokens(css: string): Map<string, string> {
    const root = /:root\s*\{([^}]*)\}/.exec(css.replace(/\/\*[^]*?\*\//g, ""));

    if (root === null) {
        throw new Error("tokens.css has no :root { … } block");
    }

    const raw = new Map<string, string>();

    for (const match of root[1]!.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
        raw.set(match[1]!, match[2]!.trim().replace(/\s+/g, " "));
    }

    const resolve = (value: string, seen: Set<string>): string =>
        value.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/g, (whole, name: string) => {
            const next = raw.get(name);

            return next === undefined || seen.has(name) ? whole : resolve(next, new Set([...seen, name]));
        });

    return new Map([...raw].map(([name, value]) => [name, resolve(value, new Set([name]))]));
}

/** What a design system lacks to be used: required tokens its tokens.css does not bind. */
export function missingTokens(system: DesignSystem): string[] {
    const tokens = readTokens(readFileSync(system.tokens, "utf8"));

    return REQUIRED_TOKENS.filter((name) => !tokens.has(name));
}

/** What Pi's prompt says of the default design system (`design.default`), or undefined when there is none. */
export function designSystemPrompt(dataDir: string, id: string | undefined): string | undefined {
    if (id === undefined) {
        return undefined;
    }

    const system = findDesignSystem(dataDir, id);

    if (system === undefined) {
        return `The person's default design system is "${id}" (Menu › Design system), but there is no design system by that id any more: say so before you design anything, and ask whether to pick another (design.default) or none.`;
    }

    return [
        `The person's default design system (Menu › Design system): ${system.name} (${system.id}, ${system.mine ? "their own" : system.category}): ${system.summary}`,
        `Use it for HTML pages, artifacts, and Office files (decks, documents, sheets) unless the person asks for another look or for none; the design-system skill says how. Its DESIGN.md: ${system.design}; its tokens.css: ${system.tokens}.`,
    ].join("\n");
}
