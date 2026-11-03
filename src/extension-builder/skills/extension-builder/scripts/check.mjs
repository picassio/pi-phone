// Check a drop-in before extension_install (pi-phone's extension-builder skill):
//
//   node <skill>/scripts/check.mjs <folder>
//
// The folder holds one module <name>.ts at its top, and what belongs to it (<name>.js, a folder <name>/). It reads the
// files and never runs them: the .ts parses with Node's type stripping (erasable syntax only, as pi-phone runs it), every
// .js parses as a module, no tool takes a built-in tool's name, and the browser part keeps the app's UI rules (no
// emoji or dingbats, no system <select>, icons by the app's names, whole pixels, the theme's colours). Exit 1 with each
// problem on its own line; notes do not fail it.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Node calls type stripping experimental and says so on every run: not the drop-in's problem.
const emit = process.emitWarning.bind(process);

process.emitWarning = (warning, ...rest) => {
    if (!String(warning).includes("stripTypeScriptTypes")) {
        emit(warning, ...rest);
    }
};

/** The app this skill came with: its own lists are the authority. */
const APP = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const MODULE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const problems = [];
const notes = [];
const given = process.argv[2];

if (given === undefined) {
    console.error("Usage: node check.mjs <folder holding <name>.ts>");
    process.exit(2);
}

const folder = resolve(given);

if (!statSync(folder, { throwIfNoEntry: false })?.isDirectory()) {
    console.error(`${folder} is not a folder: give the folder that holds the drop-in's <name>.ts.`);
    process.exit(2);
}

/** Strings in a block of the app's own source, between `start` and the first `end` after it. */
function appList(file, start, end, item) {
    const source = readFileSync(join(APP, file), "utf8");
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);

    if (from < 0 || to < 0) {
        throw new Error(`cannot find ${start.trim()} in ${file}: this skill and the app are out of step`);
    }

    return new Set([...source.slice(from, to).matchAll(item)].map((match) => match[1]));
}

const builtInTools = appList("src/server/reload.ts", "BUILT_IN_TOOLS: ReadonlySet<string> = new Set([", "]);", /"([a-z0-9_]+)"/g);
const icons = appList("web/ui.js", "const ICONS = {", "\n};", /^ {4}([a-z0-9]+):/gm);

/** Whether `source` parses as an ES module, with Node's own parser; the error's first lines when it does not. */
function parses(source) {
    const result = spawnSync(process.execPath, ["--input-type=module", "--check"], { input: source, encoding: "utf8" });

    return result.status === 0 ? undefined : result.stderr.split("\n").filter((line) => line.trim() !== "").slice(0, 4).join(" | ");
}

const tops = readdirSync(folder);
const modules = tops.filter((file) => file.endsWith(".ts") && !file.endsWith(".d.ts") && !file.endsWith(".test.ts") && !file.startsWith("_"));

if (modules.length !== 1) {
    problems.push(`${folder}: a drop-in is one module <name>.ts at its top; found ${modules.length === 0 ? "none" : modules.join(", ")}`);
} else {
    const module = modules[0];
    const name = module.slice(0, -3);

    if (!MODULE_NAME.test(name)) {
        problems.push(`${module}: a module's name is letters, digits, _ and -, starting with a letter or digit, no dots`);
    }

    for (const top of tops) {
        if (top !== module && top !== name && !top.startsWith(`${name}.`)) {
            notes.push(`${top}: not ${name}.* or ${name}/, so extension_install leaves it out`);
        }
    }

    checkServer(join(folder, module));

    for (const file of browserFiles(name)) {
        checkBrowser(file);
    }
}

function checkServer(path) {
    const source = readFileSync(path, "utf8");
    let js;

    try {
        js = stripTypeScriptTypes(source);
    } catch (error) {
        problems.push(`${relative(folder, path)}: ${String(error.message).split("\n")[0]} (pi-phone runs TypeScript with erasable syntax only: no enum, namespace or parameter properties)`);

        return;
    }

    const parse = parses(js);

    if (parse !== undefined) {
        problems.push(`${relative(folder, path)}: does not parse: ${parse}`);
    }

    if (/(:\s*any\b|\bas\s+any\b|<any>)/.test(source)) {
        problems.push(`${relative(folder, path)}: uses the type any: name the type`);
    }

    if (!/export\s+const\s+pocketApi\s*=\s*2\b/.test(source)) {
        notes.push(`${relative(folder, path)}: no "export const pocketApi = 2": say which extension API it is written for`);
    }

    for (const match of source.matchAll(/defineTool\(\s*\{[^]*?\bname:\s*["'`]([^"'`]+)["'`]/g)) {
        if (builtInTools.has(match[1])) {
            problems.push(`${relative(folder, path)}: the tool ${match[1]} has a built-in tool's name: the drop-in would be refused; rename it`);
        }
    }

    for (const match of source.matchAll(/web\.client\(\s*["'`]([^"'`]+)["'`]/g)) {
        // The app's own rule (src/server/extension-web.ts, ENTRY): a file or folder right beside the module, no path.
        if (!/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(match[1]) || match[1] === "node_modules") {
            problems.push(`${relative(folder, path)}: web.client("${match[1]}"): name a file or folder right beside the module, such as "${basename(match[1]) || "index.js"}" or the folder's own name, with letters, digits and . _ - only (no path): the app refuses it on load`);
        } else if (!statSync(join(folder, match[1]), { throwIfNoEntry: false })) {
            problems.push(`${relative(folder, path)}: web.client("${match[1]}"), but there is no ${match[1]} beside it`);
        }
    }
}

/** The browser part's files: <name>.js or .mjs, and every .js, .mjs and .css under <name>/. */
function browserFiles(name) {
    const found = tops.filter((file) => file === `${name}.js` || file === `${name}.mjs`).map((file) => join(folder, file));
    const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const path = join(dir, entry.name);

            if (entry.isDirectory() && entry.name !== "node_modules") {
                walk(path);
            } else if (/\.(m?js|css)$/.test(entry.name)) {
                found.push(path);
            }
        }
    };

    if (statSync(join(folder, name), { throwIfNoEntry: false })?.isDirectory()) {
        walk(join(folder, name));
    }

    return found;
}

function checkBrowser(path) {
    const file = relative(folder, path);
    const source = readFileSync(path, "utf8");

    if (!path.endsWith(".css")) {
        const parse = parses(source);

        if (parse !== undefined) {
            problems.push(`${file}: does not parse: ${parse}`);
        }

        if (/<select\b|<option\b/.test(source)) {
            problems.push(`${file}: a system <select>: use pocket.Choice (or pocket.MultiChoice)`);
        }

        for (const match of source.matchAll(/(?:\bname=|\bicon:\s*)["'`]([a-z0-9]+)["'`]/g)) {
            if (!icons.has(match[1])) {
                problems.push(`${file}: the icon ${match[1]} is not one of the app's (extension_inspect lists them)`);
            }
        }
    }

    if (/\p{Extended_Pictographic}|[\u2713\u2714\u2717\u2718\u26a0]/u.test(source)) {
        problems.push(`${file}: an emoji or dingbat: use the app's line icons (pocket.Icon) and pocket.StateTag for states`);
    }

    if (/\b\d+\.\d+px\b/.test(source)) {
        problems.push(`${file}: a size in part pixels: whole pixels, on the 4 px grid`);
    }

    if (/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/.test(source)) {
        notes.push(`${file}: a colour of its own: use the theme's variables (var(--text), var(--accent), …)`);
    }
}

for (const note of notes) {
    console.log(`note: ${note}`);
}

for (const problem of problems) {
    console.log(`problem: ${problem}`);
}

console.log(problems.length === 0 ? `ok: ${folder}` : `${problems.length} problem(s): fix them, then check again`);
process.exit(problems.length === 0 ? 0 : 1);
