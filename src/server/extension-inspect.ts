/**
 * What `extension_inspect` tells Pi (PP-368; the Extension builder extension, `extensions/extension-builder.ts`). It
 * only reads, and never a file's contents or a secret.
 *
 * Without a name: what a drop-in can use (the kinds a browser part adds and `pocket`'s members, read from
 * `web/extension-ui.js`; the icons, from `web/ui.js`'s `ICONS`; the theme's CSS variables, from `web/style.css`'s
 * `:root`), the names it may not take (tools, module files, extension names), and how each drop-in stands. With a
 * module's name: its files (names and sizes), on or off, loaded, failed or refused and why, what it added (tools,
 * sections, hooks, routes, its browser part, commands), and what tabs reported of its browser part: what it added
 * there once it loaded (its rail, menu, launcher, page and sheet ids), and its newest failure.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { APP_ROOT } from "./config.ts";
import type { BrowserReport } from "./extension-web.ts";
import { BUILT_IN_MODULES, type ExtensionInfo } from "./reload.ts";

/** The names of the drop-in API, as the app's own files have them. */
export type DropInApi = { kinds: string[]; members: string[]; icons: string[]; variables: string[] };

/** The part of `file` (under `web/`) from `start` to the first `end` after it. */
function part(file: string, start: string, end: string): string {
    const source = readFileSync(join(APP_ROOT, "web", file), "utf8");
    const from = source.indexOf(start);
    const to = from < 0 ? -1 : source.indexOf(end, from + start.length);

    if (to < 0) {
        throw new Error(`extension_inspect cannot find ${JSON.stringify(start.trim().split("\n")[0])} in web/${file}: it and the app are out of step`);
    }

    return source.slice(from, to);
}

const names = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].map((match) => match[1]!);

let api: DropInApi | undefined;

/** Read once: the app's files change only with an update, which restarts the server. */
export function dropInApi(): DropInApi {
    api ??= {
        kinds: names(part("extension-ui.js", "const KINDS = [", "];"), /"([a-z]+)"/g),
        members: names(part("extension-ui.js", "\n    return Object.freeze({\n        version: POCKET_API,", "\n    });\n}"), /^ {8}([A-Za-z]\w*)\s*[,:(]/gm),
        icons: names(part("ui.js", "const ICONS = {", "\n};"), /^ {4}([a-z0-9]+):/gm),
        variables: names(part("style.css", ":root {", "\n}"), /^ {4}(--[a-z0-9-]+):/gm),
    };

    return api;
}

/** What `extension_inspect` reads of the app (`PocketHost.extensionModules`). */
export type Modules = {
    list(): ExtensionInfo[];
    nameClashes(): { file: string; path: string }[];
    builtInToolNames(): Set<string>;
    dropInFolder(): string | undefined;
    browserReports(file: string): { ready?: BrowserReport; failed?: BrowserReport };
};

/** A module's state in a few words, and why when it is not loaded. */
function state(module: ExtensionInfo, why: boolean): string {
    if (!module.enabled) {
        return "off";
    }

    if (module.error === undefined) {
        return "on, loaded";
    }

    const how = module.refused === undefined ? "on, failed to load" : "on, refused";

    return why ? `${how}: ${module.error}` : how;
}

/** Without a name: the API's names, the names a drop-in may not take, and the drop-ins (with their state, for the owner). */
export function overview(modules: Modules, owner: boolean): string {
    const { kinds, members, icons, variables } = dropInApi();
    const list = modules.list();
    const builtIn = modules.builtInToolNames();
    const dropIns = list.filter((module) => module.source === "drop-in");
    const theirs = dropIns.flatMap((module) => module.extensions.flatMap((each) => each.tools.filter((tool) => !builtIn.has(tool)).map((tool) => `${tool} (${module.file})`)));

    return [
        "The drop-in API (pocketApi 2; the extension-builder skill's references say how to use it):",
        `- A browser part adds, each with pocket.<kind>(spec): ${kinds.join(", ")}.`,
        `- pocket's members: ${members.join(", ")}.`,
        `- Icons (pocket.Icon's name, a spec's icon): ${icons.join(", ")}.`,
        `- The theme's CSS variables (web/style.css :root; use these, never colours of its own): ${variables.join(", ")}.`,
        "",
        "Names a drop-in may not take:",
        `- Tools (built-in; a drop-in with one is refused whole): ${[...builtIn].sort().join(", ")}.`,
        `- Module files (a drop-in named like one is never loaded): ${[...BUILT_IN_MODULES].sort().map((name) => `${name}.ts`).join(", ")}.`,
        "- Extension names: pocket-… and coding-tools.",
        ...(theirs.length === 0 ? [] : [`- Tools other drop-ins have now: ${theirs.join(", ")}.`]),
        ...(owner
            ? [
                  "",
                  `Drop-ins (${modules.dropInFolder() ?? "no drop-in folder"}):`,
                  ...(dropIns.length === 0 ? ["- none yet"] : dropIns.map((module) => `- ${module.file}: ${state(module, false)}`)),
                  ...modules.nameClashes().map((clash) => `- ${clash.file}: never loaded: a built-in module has its file name; rename it`),
                  "",
                  "For one, with why it failed and what it added: extension_inspect with its name.",
              ]
            : []),
    ].join("\n");
}

/** A size, in bytes or KB. */
const size = (bytes: number) => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`);

/** A drop-in's files: its module, `<name>.*` beside it, and everything in `<name>/`, by name and size (at most 100). */
function files(folder: string, name: string): string[] {
    const found: string[] = [];
    const tops = readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const path = join(dir, entry.name);

            if (found.length >= 100) {
                return;
            }

            if (entry.isDirectory() && entry.name !== "node_modules") {
                walk(path);
            } else if (entry.isFile()) {
                found.push(`${relative(folder, path)} (${size(statSync(path).size)})`);
            }
        }
    };

    const module = tops.filter((entry) => entry.isFile() && entry.name === `${name}.ts`);
    const beside = tops.filter((entry) => entry.isFile() && entry.name !== `${name}.ts` && entry.name.startsWith(`${name}.`));

    for (const entry of [...module, ...beside]) {
        found.push(`${entry.name} (${size(statSync(join(folder, entry.name)).size)})`);
    }

    if (tops.some((entry) => entry.isDirectory() && entry.name === name)) {
        walk(join(folder, name));
    }

    return found;
}

const when = (at: number) => new Date(at).toISOString().replace(/\.\d+Z$/, "Z");

/** One module, by its name or file: everything but its files' contents. Throws for a module there is not. */
export function inspect(modules: Modules, given: string): string {
    const file = given.trim().endsWith(".ts") ? given.trim() : `${given.trim()}.ts`;
    const name = file.slice(0, -".ts".length);
    const module = modules.list().find((each) => each.file === file);

    if (module === undefined) {
        const clash = modules.nameClashes().find((each) => each.file === file);

        if (clash !== undefined) {
            return `${file}: a drop-in at ${clash.path}, never loaded: a built-in module has its file name. Rename it (a new name in its files too), and install it again.`;
        }

        const dropIns = modules.list().filter((each) => each.source === "drop-in").map((each) => each.file);

        throw new Error(`There is no extension module ${file}. Drop-ins: ${dropIns.length === 0 ? "none yet" : dropIns.join(", ")}.`);
    }

    const folder = modules.dropInFolder();
    const added = module.extensions.map((extension) => {
        const parts = [
            extension.tools.length === 0 ? "" : `tools ${extension.tools.map((tool) => (extension.readOnlyTools.includes(tool) ? `${tool} (read-only)` : tool)).join(", ")}`,
            extension.sections.length === 0 ? "" : `prompt sections ${extension.sections.join(", ")}`,
            extension.hooks.length === 0 ? "" : `hooks ${extension.hooks.join(", ")}`,
            extension.wraps.length === 0 ? "" : `wraps ${extension.wraps.join(", ")}`,
        ].filter((each) => each !== "");

        return `- extension ${extension.name}: ${parts.length === 0 ? "nothing yet" : parts.join("; ")}`;
    });
    const web = module.web;
    const reports = module.enabled ? modules.browserReports(file) : {};
    const ready = reports.ready?.state === "ready" ? reports.ready : undefined;
    const failed = reports.failed?.state === "failed" ? reports.failed : undefined;
    const shown =
        ready === undefined
            ? []
            : Object.entries(ready.adds)
                  .filter(([, ids]) => ids.length > 0)
                  .map(([kind, ids]) => `${kind} ${ids.join(", ")}`);
    const pages = (ready?.adds.page ?? []).map((id) => `http://127.0.0.1:8787/?page=${name}:${id}`);
    const sheets = (ready?.adds.sheet ?? []).map((id) => `http://127.0.0.1:8787/?sheet=${name}:${id}`);

    return [
        `${file}: ${module.source === "drop-in" ? `a drop-in at ${module.path}` : `built-in (${module.title})`}`,
        ...(module.summary === "" ? [] : [`What it says it does: ${module.summary}`]),
        `State: ${state(module, true)}${module.enabled ? "" : ` (turn it on: Settings › Extensions, or setting_change extensions.${file} on)`}`,
        ...(module.source === "drop-in" && folder !== undefined ? [`Files (names only): ${files(folder, name).join(", ") || "none"}`] : []),
        ...(module.extensions.length === 0 && web === undefined
            ? [module.enabled && module.error === undefined ? "Added: nothing on the server" : "Added: nothing (not loaded)"]
            : [
                  "Added on the server:",
                  ...added,
                  ...(web === undefined
                      ? []
                      : [
                            ...(web.routes.length === 0 ? [] : [`- routes (under /api/x/${name}/): ${web.routes.join(", ")}`]),
                            ...(web.client === undefined ? [] : [`- a browser part, for ${web.client === "owner" ? "the owner" : `whoever may ${web.client}`}`]),
                            ...((web.commands ?? []).length === 0 ? [] : [`- commands: ${(web.commands ?? []).join(", ")}`]),
                        ]),
              ]),
        ...(web?.client === undefined || !module.enabled
            ? []
            : [
                  "Its browser part in the app (as tabs reported this version):",
                  ...(ready === undefined
                      ? [module.source === "drop-in" ? "- no tab has loaded this version yet: open the app (or a screenshot of it), then ask again" : "- built-in: tabs report only its failures"]
                      : [`- loaded in ${ready.by}'s tab at ${when(ready.at)}: ${shown.length === 0 ? "it added nothing" : `added ${shown.join("; ")}`}`]),
                  ...(failed === undefined ? ["- no failure reported"] : [`- ${failed.how} in ${failed.by}'s tab at ${when(failed.at)}: ${failed.error}`]),
                  ...(pages.length + sheets.length === 0 ? [] : [`- to look at: ${[...pages, ...sheets].join(", ")}`]),
              ]),
    ].join("\n");
}
