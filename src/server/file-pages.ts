/**
 * The files beside a session's HTML page, for that page (PP-113): `/a/file/<conversation>?path=` serves the page with a
 * `<base>` at `/a/file/g/<key>/`, and a key grants reading the page's folder (and under it) in that session as the
 * person who opened it, for a while. The page is in the artifacts' sandbox, with an origin of its own: its stylesheets,
 * scripts, and pictures go without the person's cookie, so the key in their address is what lets them in.
 */
import { randomBytes } from "node:crypto";
import type { ConversationId } from "@earendil-works/pi-durable";

/** How long a key lets a page's files in: a page loads them at once (a screenshot, the viewer's frame). */
export const FILE_PAGE_MS = 30 * 60_000;
/** Keys kept at most; the oldest go first. */
const KEPT = 500;

export type FilePage = { conversation: ConversationId; userId: string; folder: string; until: number };

export class FilePages {
    readonly #pages = new Map<string, FilePage>();
    readonly #now: () => number;

    constructor(now: () => number = Date.now) {
        this.#now = now;
    }

    /** A key to the files in `folder` ("" for the session's own) of a session, for a person. */
    grant(conversation: ConversationId, userId: string, folder: string): string {
        const now = this.#now();

        for (const [key, page] of this.#pages) {
            if (page.until <= now) {
                this.#pages.delete(key);
            }
        }

        while (this.#pages.size >= KEPT) {
            this.#pages.delete(this.#pages.keys().next().value!);
        }

        const key = randomBytes(18).toString("base64url");

        this.#pages.set(key, { conversation, userId, folder, until: now + FILE_PAGE_MS });

        return key;
    }

    /** What a key grants, while it does. */
    find(key: string): FilePage | undefined {
        const page = this.#pages.get(key);

        return page !== undefined && page.until > this.#now() ? page : undefined;
    }
}

/** The folder of a file's path as written ("" for none): POSIX or Windows. */
export function folderOf(path: string): string {
    const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));

    return cut < 0 ? "" : cut === 0 ? "/" : path.slice(0, cut);
}

/** `<base href>` put in an HTML page, first in its head (or first of all), unless it names a base of its own. */
export function withBase(html: string, href: string): string {
    if (/<base[\s>]/i.test(html)) {
        return html;
    }

    const tag = `<base href="${href}">`;
    const head = /<head(\s[^>]*)?>/i.exec(html);

    return head === null ? tag + html : html.slice(0, head.index + head[0].length) + tag + html.slice(head.index + head[0].length);
}

/** Content types of the files a page loads beside it, by extension. */
const TYPES: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/plain; charset=utf-8",
    ".csv": "text/plain; charset=utf-8",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mp3": "audio/mpeg",
    ".wasm": "application/wasm",
};

export function fileType(path: string): string {
    const dot = path.lastIndexOf(".");

    return (dot < 0 ? undefined : TYPES[path.slice(dot).toLowerCase()]) ?? "application/octet-stream";
}
