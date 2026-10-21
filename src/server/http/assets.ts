/** The web app's own files and the modules it imports, its content security policy, and image files it shows. */
import { createHash } from "node:crypto";
import { closeSync, createReadStream, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join } from "node:path";
import { APP_ROOT } from "../config.ts";
import { HttpError } from "../errors.ts";
import { send } from "./io.ts";

export const WEB = join(APP_ROOT, "web");
const MODULES = join(APP_ROOT, "node_modules");

export const VENDOR: Record<string, string> = {
    "preact.mjs": join(MODULES, "preact", "dist", "preact.mjs"),
    "preact-hooks.mjs": join(MODULES, "preact", "hooks", "dist", "hooks.mjs"),
    "htm.mjs": join(MODULES, "htm", "dist", "htm.module.js"),
    "marked.mjs": join(MODULES, "marked", "lib", "marked.esm.js"),
    "purify.mjs": join(MODULES, "dompurify", "dist", "purify.es.mjs"),
    "xterm.mjs": join(MODULES, "@xterm", "xterm", "lib", "xterm.mjs"),
    "xterm-addon-fit.mjs": join(MODULES, "@xterm", "addon-fit", "lib", "addon-fit.mjs"),
    "xterm.css": join(MODULES, "@xterm", "xterm", "css", "xterm.css"),
    // Mermaid diagrams (`web/rich.js`): one file, loaded the first time one shows.
    "pele.mjs": join(MODULES, "pele", "dist", "pele.js"),
};

/**
 * KaTeX (`web/ui.js`, math in Markdown), served from its package as a folder: its module and stylesheet, and the fonts
 * the stylesheet loads by relative path (`fonts/…`). Browsers take the woff2 ones, so only those are served.
 */
export const KATEX = join(MODULES, "katex", "dist");

/**
 * The Intelligent UI frame's files (`scripts/intelligent-ui.ts`, built into `web/vendor/intelligent-ui/`): a path under
 * it, or undefined for one that leaves it or names nothing there. They are served with `Access-Control-Allow-Origin: *`,
 * as the frame loads them as modules from its opaque origin; they are public code, nothing of anyone's.
 */
export const INTELLIGENT_UI = join(WEB, "vendor", "intelligent-ui");

export function intelligentUiFile(parts: readonly string[]): string | undefined {
    if (parts.length === 0 || parts.length > 2 || parts.some((part) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part))) {
        return undefined;
    }

    const file = join(INTELLIGENT_UI, ...parts);

    return existsSync(file) && statSync(file).isFile() ? file : undefined;
}

/** A KaTeX file's path, or undefined for anything else. */
export function katexFile(parts: readonly string[]): string | undefined {
    const [first, second] = parts;

    if (parts.length === 1 && (first === "katex.mjs" || first === "katex.min.css")) {
        return join(KATEX, first);
    }

    if (parts.length === 2 && first === "fonts" && /^KaTeX_[A-Za-z0-9-]+\.woff2$/.test(second ?? "")) {
        return join(KATEX, "fonts", second!);
    }

    return undefined;
}

export const TYPES: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".json": "application/json",
    ".webmanifest": "application/manifest+json",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".woff2": "font/woff2",
    ".pdf": "application/pdf",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
};

/** File types the image route shows; the bytes must match too (see `sniffImage`). */
const IMAGE_EXTENSIONS = new Set([
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".avif",
    ".bmp",
    ".ico",
    ".svg",
]);
const MAX_IMAGE_FILE = 25 * 1024 * 1024;
/** Opened on its own, an SVG could run script: give it an opaque origin and nothing to load. */
const IMAGE_CSP =
    "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:";

/** The image type of a file's first bytes, or undefined when it is not an image this app shows. */
export function sniffImage(head: Buffer): string | undefined {
    const ascii = (start: number, text: string) =>
        head.subarray(start, start + text.length).toString("latin1") === text;

    if (head[0] === 0x89 && ascii(1, "PNG\r\n\x1a\n")) {
        return "image/png";
    }

    if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
        return "image/jpeg";
    }

    if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) {
        return "image/gif";
    }

    if (ascii(0, "RIFF") && ascii(8, "WEBP")) {
        return "image/webp";
    }

    if (ascii(4, "ftypavif") || ascii(4, "ftypavis")) {
        return "image/avif";
    }

    if (ascii(0, "BM")) {
        return "image/bmp";
    }

    if (head[0] === 0 && head[1] === 0 && head[2] === 1 && head[3] === 0) {
        return "image/x-icon";
    }

    const text = head
        .toString("utf8")
        .replace(/^\uFEFF/, "")
        .trimStart();

    if (text.startsWith("<") && /<svg[\s>]/i.test(text)) {
        return "image/svg+xml";
    }

    return undefined;
}

/**
 * The app page's policy. Replies show markdown that Pi wrote, and what Pi writes can be steered by any file or page it
 * reads: nothing on the page may load from, send to, or post to another site. The inline import map is allowed by hash.
 */
function appPolicy(html: string): string {
    // Browsers hash script text after turning CRLF and CR into LF, as their HTML parser does.
    const hashes = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(
        (match) =>
            `'sha256-${createHash("sha256").update(match[1]!.replace(/\r\n?/g, "\n")).digest("base64")}'`,
    );

    return [
        "default-src 'self'",
        ["script-src 'self'", ...hashes].join(" "),
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "media-src 'self' data: blob:",
        "connect-src 'self'",
        "frame-src 'self'",
        "worker-src 'self'",
        "object-src 'none'",
        // The page's own <base href> (PP-54), never another site's.
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'self'",
    ].join("; ");
}

/** A shared space's address (PP-54), as the team server's gateway sends it: `/space/<key>/`. */
const SPACE_BASE = /^\/space\/[A-Za-z0-9_-]{6,64}\/(write|watch)\/$/;

/**
 * The app page, with its content security policy. Under `base` (a teammate opening a session shared with them, through
 * the gateway: `/space/<key>/`) its relative URLs resolve there, and it offers no install (that is the sharer's app).
 */
export function serveApp(response: ServerResponse, base?: string): void {
    let body: string;

    try {
        body = readFileSync(join(WEB, "index.html"), "utf8");
    } catch {
        send(response, 404, "Not found");

        return;
    }

    if (base !== undefined && SPACE_BASE.test(base)) {
        body = body.replace('<base href="/" />', `<base href="${base}" />`).replace(/\s*<link rel="manifest"[^>]*>/, "");
    }

    send(response, 200, body, "text/html; charset=utf-8", {
        "cache-control": "no-cache",
        "content-security-policy": appPolicy(body),
    });
}

export function serveFile(response: ServerResponse, file: string, fallbackType?: string): void {
    let body: Buffer;

    try {
        body = readFileSync(file);
    } catch {
        send(response, 404, "Not found");

        return;
    }

    // No caching: the app is edited live, and a reload should always get the newest files.
    send(
        response,
        200,
        body,
        fallbackType ?? TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
        {
            "cache-control": "no-cache",
        },
    );
}

/** An image file from this machine, for `![alt](path)` in replies and for uploaded attachments. */
export function serveImage(request: IncomingMessage, response: ServerResponse, file: string): void {
    if (!IMAGE_EXTENSIONS.has(extname(file).toLowerCase())) {
        throw new HttpError(415, "Only image files can be shown");
    }

    let size: number;
    let mtime: number;
    let type: string | undefined;

    try {
        const stats = statSync(file);

        if (!stats.isFile()) {
            throw new Error("not a file");
        }

        size = stats.size;
        mtime = stats.mtimeMs;
        const head = Buffer.alloc(1024);
        const fd = openSync(file, "r");

        try {
            type = sniffImage(head.subarray(0, readSync(fd, head, 0, head.length, 0)));
        } finally {
            closeSync(fd);
        }
    } catch {
        throw new HttpError(404, "Image not found");
    }

    if (type === undefined) {
        throw new HttpError(415, "That file is not an image");
    }

    if (size > MAX_IMAGE_FILE) {
        throw new HttpError(413, "Image too large to show");
    }

    const etag = `"${size.toString(36)}-${Math.floor(mtime).toString(36)}"`;
    const headers = {
        etag,
        "cache-control": "private, no-cache",
        "content-security-policy": IMAGE_CSP,
    };

    if (request.headers["if-none-match"] === etag) {
        response.writeHead(304, headers);
        response.end();

        return;
    }

    response.writeHead(200, {
        ...headers,
        "content-type": type,
        "content-length": String(size),
    });
    createReadStream(file)
        .on("error", () => response.destroy())
        .pipe(response);
}
