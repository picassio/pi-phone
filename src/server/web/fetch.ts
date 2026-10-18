/**
 * `fetch_content`'s reading of one address, where the session works (the phone, or a machine through its env):
 * - a web page: its main text by Mozilla Readability over linkedom's DOM, as Markdown by turndown, as pi-web-access does;
 * - a document (PDF, Word, PowerPoint, Excel, EPUB, Jupyter, CSV, RSS, …): markit (`markit-engine`, our fork with an
 *   Android build) turns it into Markdown;
 * - a GitHub repository: cloned shallowly into `~/.cache/pi-phone/github/<owner>/<repo>`, and Pi gets its path, its
 *   README, and its top folder; an issue or pull request: `gh issue view` or `gh pr view` with comments; a file on
 *   GitHub: its raw text;
 * - an image: the image itself, for models that see;
 * - text, JSON, XML: as it is.
 * Text longer than Pi should take at once is saved whole in `~/.cache/pi-phone/fetch/`, and Pi gets the start and the
 * path to read the rest with offsets.
 */
import type { Context } from "@earendil-works/chord";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { Readability } from "@mozilla/readability";
import { createHash } from "node:crypto";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { documentKind, toMarkdown } from "../documents.ts";

/**
 * What Pi gets of one call in one go, in characters and in lines, shared by its addresses; more is saved to a file. Under
 * the harness's own limits for a tool's output (2,000 lines, 50 KB), which would cut the end off.
 */
export const MAX_INLINE = 30_000;
export const MAX_INLINE_LINES = 1_200;
const MAX_DOWNLOAD = 25 * 1024 * 1024;
const MAX_IMAGE = 5 * 1024 * 1024;
const TIMEOUT_MS = 45_000;
const AGENT = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36 pi-phone";

const IMAGES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export type Fetched =
    | { kind: "text"; url: string; title: string; text: string; how: string }
    | { kind: "image"; url: string; mimeType: string; data: string };

export class FetchError extends Error {
    constructor(url: string, message: string) {
        super(`${url}: ${message}`);
        this.name = "FetchError";
    }
}

/** A page's main text as Markdown: Readability's article, or the whole body when it finds none. */
export function pageMarkdown(html: string, url: string): { title: string; markdown: string } {
    const { document } = parseHTML(html);
    const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });

    turndown.remove(["script", "style", "noscript", "iframe"]);

    let article: ReturnType<Readability<string>["parse"]> = null;

    try {
        // Readability changes the document it reads; it reads its own copy.
        article = new Readability(parseHTML(html).document as unknown as Document, { charThreshold: 200 }).parse();
    } catch {
        article = null;
    }

    const title = (article?.title ?? document.title ?? "").trim() || url;
    const body = article?.content ?? document.body?.innerHTML ?? html;

    return { title, markdown: turndown.turndown(body).replace(/\n{3,}/g, "\n\n").trim() };
}

/** The home folder where `env` runs, by asking its shell. */
async function homeOf(env: ExecutionEnv, context: Context): Promise<string> {
    let out = "";
    const result = await env.exec(["sh", "-c", 'printf %s "$HOME"'], { onOutput: (text) => (out += text) }, context);

    if (!result.ok || result.value.exitCode !== 0 || out === "") {
        throw new Error("Could not find the home folder where this session runs.");
    }

    return out;
}

/** Run a command where the session works, and answer its output; a failure says what it printed. */
async function run(env: ExecutionEnv, argv: string[], context: Context, timeout = 120): Promise<string> {
    let out = "";
    const result = await env.exec(argv, { timeout, onOutput: (text) => (out += text) }, context);

    if (!result.ok) {
        throw new Error(`${argv[0]} did not run: ${result.error.message}`);
    }

    if (result.value.exitCode !== 0) {
        throw new Error(`${argv.slice(0, 3).join(" ")} failed (exit ${result.value.exitCode}): ${out.trim().slice(-600)}`);
    }

    return out;
}

/** A GitHub repository, issue, pull request, or file, if `url` is one. */
function githubTarget(url: URL):
    | { type: "repo"; owner: string; repo: string; ref?: string; path?: string }
    | { type: "issue" | "pr"; owner: string; repo: string; number: number }
    | { type: "file"; raw: string }
    | undefined {
    if (url.hostname !== "github.com" && url.hostname !== "www.github.com") {
        return undefined;
    }

    const [owner, rawRepo, kind, ...rest] = url.pathname.split("/").filter((part) => part !== "");

    if (owner === undefined || rawRepo === undefined) {
        return undefined;
    }

    const repo = rawRepo.replace(/\.git$/, "");

    if ((kind === "issues" || kind === "pull") && /^\d+$/.test(rest[0] ?? "")) {
        return { type: kind === "pull" ? "pr" : "issue", owner, repo, number: Number(rest[0]) };
    }

    if (kind === "blob" && rest.length >= 2) {
        return { type: "file", raw: `https://raw.githubusercontent.com/${owner}/${repo}/${rest.join("/")}` };
    }

    if (kind === undefined || kind === "tree") {
        return { type: "repo", owner, repo, ...(rest[0] === undefined ? {} : { ref: rest[0] }), ...(rest.length > 1 ? { path: rest.slice(1).join("/") } : {}) };
    }

    return undefined;
}

async function fetchGithub(
    target: Exclude<ReturnType<typeof githubTarget>, undefined | { type: "file" }>,
    env: ExecutionEnv,
    context: Context,
): Promise<Fetched> {
    const name = `${target.owner}/${target.repo}`;

    if (target.type !== "repo") {
        const text = await run(env, ["gh", target.type, "view", String(target.number), "-R", name, "--comments"], context);

        return { kind: "text", url: `https://github.com/${name}/${target.type === "pr" ? "pull" : "issues"}/${target.number}`, title: `${name}#${target.number}`, text, how: `gh ${target.type} view` };
    }

    const home = await homeOf(env, context);
    const folder = `${home}/.cache/pi-phone/github/${target.owner}/${target.repo}${target.ref === undefined ? "" : `@${target.ref}`}`;
    const present = await env.exists(`${folder}/.git`, context);

    if (present.ok && present.value) {
        await run(env, ["git", "-C", folder, "fetch", "--depth", "1", "origin", ...(target.ref === undefined ? [] : [target.ref])], context);
        await run(env, ["git", "-C", folder, "reset", "--hard", "FETCH_HEAD"], context);
    } else {
        await env.createDir(folder.slice(0, folder.lastIndexOf("/")), { recursive: true }, context);
        await run(env, ["git", "clone", "--depth", "1", ...(target.ref === undefined ? [] : ["--branch", target.ref]), `https://github.com/${name}.git`, folder], context, 300);
    }

    const at = target.path === undefined ? folder : `${folder}/${target.path}`;
    const listing = await env.listDir(at, context);
    const entries = listing.ok ? listing.value.map((entry) => `${entry.name}${entry.kind === "directory" ? "/" : ""}`).sort() : [];
    const readme = entries.find((entry) => /^readme(\.(md|markdown|rst|txt))?$/i.test(entry));
    const readmeText = readme === undefined ? undefined : await env.readTextFile(`${at}/${readme}`, context);

    return {
        kind: "text",
        url: `https://github.com/${name}`,
        title: name,
        how: "git clone --depth 1",
        text: [
            `Cloned to ${folder}${target.path === undefined ? "" : ` (this is ${target.path} in it)`}: read and search its files there.`,
            "",
            `${at}:`,
            ...entries.filter((entry) => entry !== ".git/").map((entry) => `  ${entry}`),
            ...(readmeText?.ok ? ["", `${readme}:`, "", readmeText.value] : []),
        ].join("\n"),
    };
}

/** Read one address. `env` is where the session works: clones and `gh` run there. */
export async function fetchContent(address: string, env: ExecutionEnv, signal: AbortSignal, context: Context): Promise<Fetched> {
    let url: URL;

    try {
        url = new URL(address);
    } catch {
        throw new FetchError(address, "not an address (http:// or https://)");
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new FetchError(address, "only http:// and https:// addresses");
    }

    const github = githubTarget(url);

    if (github !== undefined && github.type !== "file") {
        try {
            return await fetchGithub(github, env, context);
        } catch (error) {
            throw new FetchError(address, error instanceof Error ? error.message : String(error));
        }
    }

    const target = github?.type === "file" ? github.raw : url.href;
    let response: Response;

    try {
        response = await fetch(target, {
            headers: { "user-agent": AGENT, accept: "text/html,application/xhtml+xml,text/markdown;q=0.9,*/*;q=0.8" },
            redirect: "follow",
            signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
        });
    } catch (error) {
        if (signal.aborted) {
            throw error;
        }

        throw new FetchError(address, `could not load it: ${error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error)}`);
    }

    if (!response.ok) {
        throw new FetchError(address, `HTTP ${response.status} ${response.statusText}`.trim());
    }

    if (Number(response.headers.get("content-length") ?? 0) > MAX_DOWNLOAD) {
        throw new FetchError(address, `larger than ${MAX_DOWNLOAD / 1024 / 1024} MB`);
    }

    const type = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    const bytes = Buffer.from(await response.arrayBuffer());
    const final = response.url || target;

    if (IMAGES.has(type)) {
        if (bytes.length > MAX_IMAGE) {
            throw new FetchError(address, `an image larger than ${MAX_IMAGE / 1024 / 1024} MB`);
        }

        return { kind: "image", url: final, mimeType: type, data: bytes.toString("base64") };
    }

    const document = documentKind(new URL(final).pathname, type);

    if (document !== undefined) {
        const converted = await toMarkdown(bytes, document);

        return { kind: "text", url: final, title: converted.title ?? decodeURIComponent(final.split("/").pop() ?? final), text: converted.markdown, how: `markit (${document.slice(1)})` };
    }

    const text = bytes.toString("utf8");

    if (type === "text/html" || type === "application/xhtml+xml" || (type === "" && /^\s*<(!doctype html|html)/i.test(text))) {
        const page = pageMarkdown(text, final);

        return { kind: "text", url: final, title: page.title, text: page.markdown, how: "Readability" };
    }

    if (type.startsWith("text/") || /json|xml|javascript|yaml|toml/.test(type)) {
        return { kind: "text", url: final, title: decodeURIComponent(final.split("/").pop() || final), text, how: type || "text" };
    }

    throw new FetchError(address, `${type || "this kind of file"} is not something fetch_content reads`);
}

/**
 * Text to give Pi: all of it when short, else its start and where the whole is saved, where the session works, to read
 * with offsets.
 */
export async function inline(
    fetched: Extract<Fetched, { kind: "text" }>,
    env: ExecutionEnv,
    context: Context,
    share = 1,
    /** Where the whole text already is (`file_to_markdown`'s `.md`): pointed to, not saved again. */
    whole?: string,
): Promise<string> {
    const head = `# ${fetched.title}\nSource: ${fetched.url} (${fetched.how})\n\n`;
    const chars = Math.floor(MAX_INLINE / share);
    const lines = Math.floor(MAX_INLINE_LINES / share);
    const kept = fetched.text.slice(0, chars).split("\n").slice(0, lines).join("\n");

    if (kept.length === fetched.text.length) {
        return head + fetched.text;
    }

    const shown = kept.split("\n").length;
    let file = whole;
    // In `whole`, the text starts on its first line; in a file saved here, after the head's four.
    let from = shown + 1;

    if (file === undefined) {
        const folder = `${await homeOf(env, context)}/.cache/pi-phone/fetch`;

        file = `${folder}/${createHash("sha256").update(fetched.url).digest("hex").slice(0, 16)}.md`;
        from = shown + 4;
        await env.createDir(folder, { recursive: true }, context);
        const written = await env.writeFile(file, head + fetched.text, context);

        if (!written.ok) {
            throw new Error(`Could not save the whole text to ${file}: ${written.error.message}`);
        }
    }

    // The note first: what follows may be cut short again on the way to the model.
    return `${head}[The first ${shown.toLocaleString("en")} lines (${kept.length.toLocaleString("en")} of ${fetched.text.length.toLocaleString("en")} characters). The whole text is in ${file}: read it from line ${from} on.]\n\n${kept}`;
}
