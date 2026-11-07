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

/** Where a tag goes first in a page: just inside its head, else after its doctype (before it, a page is in quirks mode), else first of all. */
function headStart(html: string): number {
    const head = /<head(\s[^>]*)?>/i.exec(html) ?? /^\s*<!doctype[^>]*>/i.exec(html);

    return head === null ? 0 : head.index + head[0].length;
}

/** `<base href>` put in an HTML page, first in its head, unless it names a base of its own. */
export function withBase(html: string, href: string): string {
    if (/<base[\s>]/i.test(html)) {
        return html;
    }

    const at = headStart(html);

    return `${html.slice(0, at)}<base href="${href}">${html.slice(at)}`;
}

/**
 * What a file page runs before its own scripts (PP-440). The sandbox gives the page an origin of its own, where
 * `localStorage` and `sessionStorage` throw a SecurityError: an app that reads them outside a try (a single-file React
 * build) drew nothing, a blank screenshot. Here both are storage in memory, empty at each load, as on a first visit. The
 * page's uncaught errors are kept in `window.__piPageErrors`, which the layout check reports (`layout-check.ts`).
 */
export const PAGE_SHIM =
    "<script>(function(){var w=window,errors=w.__piPageErrors=[];" +
    'function say(x,m){if(errors.length<20)errors.push(x&&x.name?x.name+": "+x.message:String(m||x))}' +
    'w.addEventListener("error",function(e){if(e.target===w)say(e.error,e.message)});' +
    'w.addEventListener("unhandledrejection",function(e){say(e.reason,"Unhandled rejection")});' +
    "function store(){var d=new Map();return{get length(){return d.size},key:function(i){var k=Array.from(d.keys())[i];return k===undefined?null:k}," +
    "getItem:function(k){k=String(k);return d.has(k)?d.get(k):null},setItem:function(k,v){d.set(String(k),String(v))}," +
    "removeItem:function(k){d.delete(String(k))},clear:function(){d.clear()}}}" +
    'Object.defineProperty(w,"localStorage",{value:store(),configurable:true});' +
    'Object.defineProperty(w,"sessionStorage",{value:store(),configurable:true})})()</script>';

/** `PAGE_SHIM` put first in an HTML page, before any script of its own. */
export function withPageShim(html: string): string {
    const at = headStart(html);

    return `${html.slice(0, at)}${PAGE_SHIM}${html.slice(at)}`;
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
