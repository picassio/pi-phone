/**
 * The design-system skill's command (`SKILL.md`): lists, searches and shows the design systems Pi may design with,
 * the person's own and OpenDesign's (`src/server/design-systems.ts`). The person's are in the app's data folder
 * (PI_POCKET_DIR, which the app sets for Pi's bash).
 *
 *   node systems.ts list [category words]
 *   node systems.ts search <words>
 *   node systems.ts show <id>
 *   node systems.ts tokens <id>    its tokens.css's values, each var() resolved (for Office files)
 *   node systems.ts check <id>     whether a system of the person's is complete (after brand-extract writes one)
 */
import { readFileSync } from "node:fs";
import { dataDir } from "../../server/config.ts";
import {
    type DesignSystem,
    findDesignSystem,
    listDesignSystems,
    missingTokens,
    ownDesignSystems,
    readTokens,
    searchDesignSystems,
} from "../../server/design-systems.ts";

const line = (system: DesignSystem) => `${system.id}: ${system.name} · ${system.mine ? "yours" : system.category} · ${system.summary}`;

function main(args: string[]): string {
    const [command, ...rest] = args;
    const data = dataDir();
    const { systems, problems } = listDesignSystems(data);
    const notes = problems.map((problem) => `Not a design system: ${problem}`);

    if (command === "list") {
        const words = rest.join(" ").toLowerCase();
        const shown = words === "" ? systems : systems.filter((system) => system.category.toLowerCase().includes(words) || (system.mine && "yours".includes(words)));
        const categories = [...new Set(shown.map((system) => (system.mine ? "Yours" : system.category)))];

        return [
            `${shown.length} design systems${words === "" ? "" : ` in "${words}"`} (yours in ${ownDesignSystems(data)}).`,
            ...categories.flatMap((category) => ["", `## ${category}`, ...shown.filter((system) => (system.mine ? "Yours" : system.category) === category).map(line)]),
            ...notes,
        ].join("\n");
    }

    if (command === "search") {
        if (rest.length === 0) {
            throw new Error("Say what to search for: node systems.ts search <words>");
        }

        const found = searchDesignSystems(systems, rest.join(" "));

        return [found.length === 0 ? `No design system matches "${rest.join(" ")}".` : `${found.length} match "${rest.join(" ")}", best first:`, ...found.slice(0, 20).map(line), ...notes].join("\n");
    }

    if (command === "show" || command === "tokens" || command === "check") {
        const id = rest[0];

        if (id === undefined) {
            throw new Error(`Name the design system: node systems.ts ${command} <id>`);
        }

        const system = findDesignSystem(data, id);

        if (system === undefined) {
            const dir = `${ownDesignSystems(data)}/${id}`;
            const problem = problems.find((each) => each.startsWith(`${dir}:`) || each.startsWith(`${dir}/`));

            throw new Error(problem === undefined ? `There is no design system "${id}": node systems.ts search <words> finds one.` : `"${id}" is not a design system yet: ${problem}`);
        }

        if (command === "tokens") {
            return [...readTokens(readFileSync(system.tokens, "utf8"))].map(([name, value]) => `${name}: ${value}`).join("\n");
        }

        if (command === "check") {
            const missing = missingTokens(system);

            if (missing.length > 0) {
                throw new Error(`${system.tokens} does not bind ${missing.join(", ")}`);
            }

            return `${line(system)}\nComplete: DESIGN.md, tokens.css (every required token) and manifest.json.`;
        }

        return [line(system), `DESIGN.md: ${system.design}`, `tokens.css: ${system.tokens}`].join("\n");
    }

    throw new Error("Use: node systems.ts list [category] | search <words> | show <id> | tokens <id> | check <id>");
}

try {
    console.log(main(process.argv.slice(2)));
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
}
