/**
 * The app's words and their translations (PP-81):
 * - people-facing text in the web app's `html` templates not yet in `t()`, by file (a report: it never fails a build);
 * - the sentences in `t()` / `tn()` calls, and for each catalog (web/i18n/<locale>.json) the ones it lacks or no longer
 *   uses (a report too);
 * - a catalog sentence whose placeholders are not the English one's: that fails, as the app would show it wrong.
 *
 *   node scripts/i18n-check.ts            the summary
 *   node scripts/i18n-check.ts web/x.js   what is left in one file, with lines
 *   node scripts/i18n-check.ts --missing zh-CN   the sentences a catalog lacks
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { scan } from "./i18n-scan.ts";

const ROOT = resolve(import.meta.dirname, "..");
const WEB = join(ROOT, "web");
/** Where web code lives: the app, and the extensions' and the gateway's own pages. */
const SOURCES = [WEB, join(ROOT, "src/server/extensions"), join(ROOT, "src/gateway/web")];

function* files(dir: string): Generator<string> {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);

        if (entry.isDirectory() && (path === join(WEB, "vendor") || path === join(WEB, "i18n"))) {
            continue;
        }

        if (entry.isDirectory()) {
            yield* files(path);
        } else if (entry.name.endsWith(".js")) {
            yield path;
        }
    }
}

/** A JS string literal's value: "…", '…' or a template without `${`. */
function literal(source: string): string | undefined {
    const quote = source[0];

    if (quote === "`") {
        return source.includes("${") ? undefined : source.slice(1, -1);
    }

    try {
        return JSON.parse(quote === "'" ? `"${source.slice(1, -1).replace(/\\'/g, "'").replace(/"/g, '\\"')}"` : source) as string;
    } catch {
        return undefined;
    }
}

const STRING = String.raw`("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\`[^\`$]*\`)`;

/** The sentences a file asks for: `t("…")`, `tx("…")`, `tn(n, "…", "…")`, `pocket.t("…")`. */
export function sentences(source: string): string[] {
    const found: string[] = [];

    for (const match of source.matchAll(new RegExp(String.raw`\b(?:t|tx)\(\s*` + STRING, "g"))) {
        const value = literal(match[1]!);

        if (value !== undefined) {
            found.push(value);
        }
    }

    for (const match of source.matchAll(new RegExp(String.raw`\btn\([^,]+,\s*` + STRING + String.raw`\s*,\s*` + STRING, "g"))) {
        for (const each of [match[1]!, match[2]!]) {
            const value = literal(each);

            if (value !== undefined) {
                found.push(value);
            }
        }
    }

    // A sheet's row: `item("Label", run, "hint")` shows both in the person's language (web/ui.js).
    for (const match of source.matchAll(/\bitem\(/g)) {
        const args = callArgs(source, match.index! + match[0].length);

        for (const arg of [args[0], args[2]]) {
            for (const each of arg?.matchAll(new RegExp(STRING, "g")) ?? []) {
                const value = literal(each[1]!);

                // Words, not markup or a class name passed along.
                if (value !== undefined && /[A-Za-z]{2,}/.test(value) && !value.includes("<") && !/^[a-z]+(-[a-z]+)+$/.test(value)) {
                    found.push(value);
                }
            }
        }
    }

    return found;
}

/** A call's arguments as source text, from just after its `(`: split at its own commas, not nested ones. */
function callArgs(source: string, start: number): string[] {
    const args: string[] = [];
    let depth = 0;
    let from = start;

    for (let i = start; i < source.length; i++) {
        const c = source[i]!;

        if (c === '"' || c === "'" || c === "`") {
            const end = new RegExp(STRING, "y");

            end.lastIndex = i;
            const hit = end.exec(source);

            // A template with `${…}`: skip to its end by quote count.
            i = hit === null ? source.indexOf(c, i + 1) : i + hit[0].length - 1;
        } else if (c === "(" || c === "[" || c === "{") {
            depth++;
        } else if (c === ")" || c === "]" || c === "}") {
            if (depth === 0) {
                args.push(source.slice(from, i));

                return args;
            }

            depth--;
        } else if (c === "," && depth === 0) {
            args.push(source.slice(from, i));
            from = i + 1;
        }
    }

    return args;
}

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort().join(",");

function main(): number {
    const args = process.argv.slice(2);
    const used = new Set<string>();
    const left: { file: string; count: number }[] = [];

    for (const dir of SOURCES) {
        if (!existsSync(dir)) {
            continue;
        }

        for (const file of files(dir)) {
            const source = readFileSync(file, "utf8");

            for (const each of sentences(source)) {
                used.add(each);
            }

            const open = scan(source);
            const name = relative(ROOT, file);

            if (open.length > 0) {
                left.push({ file: name, count: open.length });
            }

            if (args[0] !== undefined && resolve(args[0]) === file) {
                for (const each of open) {
                    console.log(`${name}:${each.line} ${each.kind}${each.attr ? ` ${each.attr}` : ""} ${JSON.stringify(each.text)}`);
                }
            }
        }
    }

    let failed = 0;
    const catalogs = readdirSync(join(WEB, "i18n")).filter((name) => name.endsWith(".json"));

    for (const name of catalogs) {
        const locale = name.replace(/\.json$/, "");
        const catalog = JSON.parse(readFileSync(join(WEB, "i18n", name), "utf8")) as Record<string, string>;
        const missing = [...used].filter((each) => typeof catalog[each] !== "string" || catalog[each] === "");
        const unused = Object.keys(catalog).filter((each) => !each.startsWith("//") && !used.has(each));

        for (const [english, translated] of Object.entries(catalog)) {
            if (!english.startsWith("//") && translated !== "" && placeholders(english) !== placeholders(translated)) {
                console.error(`✗ ${name}: the placeholders of ${JSON.stringify(translated)} are not those of ${JSON.stringify(english)}`);
                failed++;
            }
        }

        if (args[0] === "--missing" && args[1] === locale) {
            console.log(JSON.stringify(Object.fromEntries(missing.map((each) => [each, ""])), null, 4));

            return failed > 0 ? 1 : 0;
        }

        console.log(`${locale}: ${used.size - missing.length} of ${used.size} sentences translated${unused.length > 0 ? `; ${unused.length} no longer used` : ""}`);
    }

    if (args.length === 0) {
        const total = left.reduce((sum, each) => sum + each.count, 0);

        console.log(`Text not yet in t(): ${total} in ${left.length} files${total > 0 ? ` (most: ${left.sort((a, b) => b.count - a.count).slice(0, 5).map((each) => `${each.file} ${each.count}`).join(", ")})` : ""}`);
    }

    return failed > 0 ? 1 : 0;
}

if (import.meta.main) {
    process.exitCode = main();
}
