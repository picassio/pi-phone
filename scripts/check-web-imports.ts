/**
 * The web app has no build step and no type check: a removed module or export only shows as a broken page. This checks
 * every relative import in web/ (static `import ... from`, `export ... from`, and string `import("...")`): the file
 * exists, and each named import is exported by it.
 *
 *   node scripts/check-web-imports.ts
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const WEB = resolve(import.meta.dirname, "..", "web");

function* files(dir: string): Generator<string> {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);

        // web/vendor holds built bundles (the Intelligent UI frame), not the app's own modules.
        if (entry.isDirectory() && path === join(WEB, "vendor")) {
            continue;
        }

        if (entry.isDirectory()) {
            yield* files(path);
        } else if (entry.name.endsWith(".js")) {
            yield path;
        }
    }
}

const exportsCache = new Map<string, Set<string>>();

function exportsOf(file: string): Set<string> {
    const cached = exportsCache.get(file);

    if (cached !== undefined) {
        return cached;
    }

    const text = readFileSync(file, "utf8");
    const names = new Set<string>();

    for (const match of text.matchAll(
        /^export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|var|class)\s+([\w$]+)/gm,
    )) {
        names.add(match[1]!);
    }

    for (const match of text.matchAll(/^export\s+default\b/gm)) {
        names.add("default");
        void match;
    }

    for (const match of text.matchAll(/^export\s*\{([^}]*)\}/gm)) {
        for (const part of match[1]!.split(",")) {
            const name = part.trim().split(/\s+as\s+/).pop();

            if (name) {
                names.add(name);
            }
        }
    }

    // `export * from "./x.js"` re-exports everything: accept any name.
    if (/^export\s+\*\s+from/m.test(text)) {
        names.add("*");
    }

    exportsCache.set(file, names);

    return names;
}

const problems: string[] = [];

for (const file of files(WEB)) {
    const text = readFileSync(file, "utf8");
    const where = relative(WEB, file);

    for (const match of text.matchAll(
        /^(?:import|export)\s+([^;"']*?)\s+from\s+["'](\.{1,2}\/[^"']+)["']/gm,
    )) {
        const target = resolve(dirname(file), match[2]!.split("?")[0]!);

        if (!existsSync(target)) {
            problems.push(`${where}: missing module ${match[2]}`);
            continue;
        }

        const clause = match[1]!;
        const named = /\{([\s\S]*)\}/.exec(clause);

        if (named === null) {
            continue;
        }

        const exported = exportsOf(target);

        if (exported.has("*")) {
            continue;
        }

        for (const part of named[1]!.split(",")) {
            const name = part.trim().split(/\s+as\s+/)[0]!.trim();

            if (name !== "" && !exported.has(name)) {
                problems.push(`${where}: ${match[2]} does not export ${name}`);
            }
        }
    }

    for (const match of text.matchAll(/import\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g)) {
        if (!existsSync(resolve(dirname(file), match[1]!.split("?")[0]!))) {
            problems.push(`${where}: missing module ${match[1]} (dynamic)`);
        }
    }
}

// Components a file renders (`<${Name}`) must be defined or imported there: a removed one is only a blank screen.
for (const file of files(WEB)) {
    const text = readFileSync(file, "utf8");
    const where = relative(WEB, file);
    const known = new Set<string>();

    for (const match of text.matchAll(/(?:function\*?|class|const|let|var)\s+([A-Z][\w$]*)/g)) {
        known.add(match[1]!);
    }

    for (const match of text.matchAll(/^import\s+([^;"']*?)\s+from\s+["'][^"']+["']/gm)) {
        for (const name of match[1]!.replace(/[{}]/g, ",").split(",")) {
            const local = name.trim().split(/\s+as\s+/).pop()?.trim();

            if (local) {
                known.add(local);
            }
        }
    }

    for (const match of text.matchAll(/<\$\{([A-Z][\w$]*)\}/g)) {
        if (!known.has(match[1]!)) {
            problems.push(`${where}: renders ${match[1]}, which is neither defined nor imported`);
        }
    }
}

// The shared helpers (store.js, ui.js, place.js) a file calls must be defined or imported there: a call to one it
// forgot to import is a ReferenceError only when that code runs.
const shared = new Set(["store.js", "ui.js", "place.js"].flatMap((name) => [...exportsOf(join(WEB, name))]));

for (const file of files(WEB)) {
    const text = readFileSync(file, "utf8");
    const where = relative(WEB, file);
    const known = new Set<string>();

    for (const match of text.matchAll(/(?:function\*?|class|const|let|var)\s+([\w$]+)/g)) {
        known.add(match[1]!);
    }

    // Destructured and parameter names: `const { a, b } =`, `({ a }) =>`, `function f(a, b)`.
    for (const match of text.matchAll(/(?:const|let|var)\s*\{([^}]*)\}/g)) {
        for (const name of match[1]!.split(",")) {
            known.add(name.trim().split(/\s*[:=]\s*/).pop()!.trim());
        }
    }

    for (const match of text.matchAll(/^import\s+([^;"']*?)\s+from\s+["'][^"']+["']/gm)) {
        for (const name of match[1]!.replace(/[{}]/g, ",").split(",")) {
            const local = name.trim().split(/\s+as\s+/).pop()?.trim();

            if (local) {
                known.add(local);
            }
        }
    }

    for (const name of shared) {
        if (known.has(name) || where === name) {
            continue;
        }

        // A class or object method of that name (`start() {`) is defined there, not called.
        if (new RegExp(`(?<![\\w$.])${name.replace(/\$/g, "\\$")}\\(`).test(text.replace(/^\s+(?:async\s+)?[\w$#]+\([^)]*\)\s*\{/gm, ""))) {
            problems.push(`${where}: calls ${name}, which is neither defined nor imported`);
        }
    }
}

if (problems.length > 0) {
    console.error(problems.join("\n"));
    process.exit(1);
}

console.log("web imports ok");
