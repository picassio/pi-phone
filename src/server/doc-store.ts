/**
 * Documents (PP-46): people's documents, in nested folders, as markdown pages, by scope: `mine` (a person's own, in
 * their pi-phone), `team` (the team server's, in its gateway), and `project:<id>` (a board's: in the gateway for a
 * shared board, in the pi-phone for the phone's own). The same store in both places; who may read or write a scope is
 * its caller's to decide (`extensions/docs.ts`, `src/gateway/docs.ts`).
 *
 * Every save keeps a version (history, restore). A page's title is unique in its scope, so `[[Title]]` names one page;
 * backlinks are the pages whose text links to it. Deleting keeps the page and its versions, gone from the tree until
 * restored. Search is by keyword here (SQLite's full-text search); by meaning comes with embeddings (PP-49).
 */
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { HttpError } from "./errors.ts";

export type Author = { id: string; name: string };
export type DocFolder = { id: string; parentId: string | null; name: string; createdAt: number; updatedAt: number };
export type DocPageInfo = { id: string; folderId: string | null; title: string; updatedByName: string; updatedAt: number };
export type DocPage = DocPageInfo & { scope: string; body: string; updatedBy: string; createdAt: number; path: string[] };
export type DocVersion = { id: string; title: string; byName: string; at: number };
export type DocHit = { scope: string; pageId: string; title: string; path: string[]; snippet: string };

const MAX_NAME = 120;
const MAX_BODY = 500_000;
/** A scope's name: mine, team, or project:<board id>. */
const SCOPE = /^(mine|team|project:[A-Za-z0-9-]{1,64})$/;

type Row = Record<string, unknown>;

export class DocumentStore {
    readonly #db: DatabaseSync;
    readonly #now: () => number;

    constructor(file: string, now: () => number = Date.now) {
        this.#now = now;
        this.#db = new DatabaseSync(file, { timeout: 5000 });
        this.#db.exec(`
            CREATE TABLE IF NOT EXISTS doc_folders (
                id TEXT PRIMARY KEY, scope TEXT NOT NULL, parent_id TEXT, name TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
            ) STRICT;
            CREATE TABLE IF NOT EXISTS doc_pages (
                id TEXT PRIMARY KEY, scope TEXT NOT NULL, folder_id TEXT, title TEXT NOT NULL, body TEXT NOT NULL,
                updated_by TEXT NOT NULL, updated_by_name TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
            ) STRICT;
            CREATE INDEX IF NOT EXISTS doc_pages_scope ON doc_pages (scope, folder_id);
            CREATE TABLE IF NOT EXISTS doc_versions (
                id TEXT PRIMARY KEY, page_id TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, by TEXT NOT NULL, by_name TEXT NOT NULL, at INTEGER NOT NULL
            ) STRICT;
            CREATE INDEX IF NOT EXISTS doc_versions_page ON doc_versions (page_id, at);
            CREATE VIRTUAL TABLE IF NOT EXISTS doc_search USING fts5(page_id UNINDEXED, scope UNINDEXED, title, body);
        `);
    }

    close(): void {
        this.#db.close();
    }

    // ---- Folders --------------------------------------------------------------------------------------------------

    /** A scope's folders and pages (without their text), for the tree. */
    tree(scope: string): { folders: DocFolder[]; pages: DocPageInfo[] } {
        check(scope);

        return {
            folders: (this.#db.prepare("SELECT * FROM doc_folders WHERE scope = ? ORDER BY name COLLATE NOCASE").all(scope) as Row[]).map(folderOf),
            pages: (this.#db.prepare("SELECT id, folder_id, title, updated_by_name, updated_at FROM doc_pages WHERE scope = ? AND deleted_at IS NULL ORDER BY title COLLATE NOCASE").all(scope) as Row[]).map(infoOf),
        };
    }

    makeFolder(scope: string, parentId: string | null, name: string): DocFolder {
        check(scope);
        const clean = nameOf(name, "folder");

        if (parentId !== null) {
            this.#folder(scope, parentId);
        }

        if (this.#siblingFolder(scope, parentId, clean) !== undefined) {
            throw new HttpError(409, `There is already a folder ${clean} there.`);
        }

        const id = randomUUID();
        const now = this.#now();

        this.#db.prepare("INSERT INTO doc_folders (id, scope, parent_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, scope, parentId, clean, now, now);

        return this.#folder(scope, id);
    }

    /** Rename a folder, or move it under another (never under itself or one of its own). */
    changeFolder(scope: string, id: string, change: { name?: string; parentId?: string | null }): DocFolder {
        const folder = this.#folder(scope, id);
        const name = change.name === undefined ? folder.name : nameOf(change.name, "folder");
        const parentId = change.parentId === undefined ? folder.parentId : change.parentId;

        if (parentId !== null) {
            this.#folder(scope, parentId);

            for (let at: string | null = parentId; at !== null; at = this.#folder(scope, at).parentId) {
                if (at === id) {
                    throw new HttpError(409, "A folder can't go inside itself.");
                }
            }
        }

        const sibling = this.#siblingFolder(scope, parentId, name);

        if (sibling !== undefined && sibling.id !== id) {
            throw new HttpError(409, `There is already a folder ${name} there.`);
        }

        this.#db.prepare("UPDATE doc_folders SET name = ?, parent_id = ?, updated_at = ? WHERE id = ?").run(name, parentId, this.#now(), id);

        return this.#folder(scope, id);
    }

    /** A folder and all in it: its folders gone, its pages deleted (kept, to restore). How many pages it held. */
    removeFolder(scope: string, id: string): number {
        this.#folder(scope, id);
        const folders = [id];

        for (let at = 0; at < folders.length; at++) {
            for (const child of this.#db.prepare("SELECT id FROM doc_folders WHERE scope = ? AND parent_id = ?").all(scope, folders[at]!) as Row[]) {
                folders.push(String(child.id));
            }
        }

        let pages = 0;

        this.#transaction(() => {
            for (const folder of folders) {
                pages += Number(this.#db.prepare("UPDATE doc_pages SET deleted_at = ?, folder_id = NULL WHERE scope = ? AND folder_id = ? AND deleted_at IS NULL").run(this.#now(), scope, folder).changes);
                this.#db.prepare("DELETE FROM doc_folders WHERE id = ?").run(folder);
            }

            this.#db.prepare("DELETE FROM doc_search WHERE scope = ? AND page_id IN (SELECT id FROM doc_pages WHERE scope = ? AND deleted_at IS NOT NULL)").run(scope, scope);
        });

        return pages;
    }

    // ---- Pages ----------------------------------------------------------------------------------------------------

    page(scope: string, id: string): DocPage {
        check(scope);
        const row = this.#db.prepare("SELECT * FROM doc_pages WHERE scope = ? AND id = ? AND deleted_at IS NULL").get(scope, String(id)) as Row | undefined;

        if (row === undefined) {
            throw new HttpError(404, "There is no such page here.");
        }

        return this.#pageOf(row);
    }

    /** A page by its title (what `[[Title]]` names), or undefined. */
    byTitle(scope: string, title: string): DocPage | undefined {
        check(scope);
        const row = this.#db.prepare("SELECT * FROM doc_pages WHERE scope = ? AND title = ? COLLATE NOCASE AND deleted_at IS NULL").get(scope, String(title).trim()) as Row | undefined;

        return row === undefined ? undefined : this.#pageOf(row);
    }

    /** Save a page whole: a new one (no id), or a new version of one. Its title is unique in its scope. */
    write(scope: string, input: { id?: string; folderId?: string | null; title: string; body: string }, by: Author): DocPage {
        check(scope);
        const title = nameOf(input.title, "page");
        const body = String(input.body ?? "");

        if (body.length > MAX_BODY) {
            throw new HttpError(400, `A page is at most ${MAX_BODY / 1000} KB.`);
        }

        const existing = input.id === undefined ? undefined : this.page(scope, input.id);
        const folderId = input.folderId === undefined ? (existing?.folderId ?? null) : input.folderId;

        if (folderId !== null) {
            this.#folder(scope, folderId);
        }

        const same = this.byTitle(scope, title);

        if (same !== undefined && same.id !== existing?.id) {
            throw new HttpError(409, `There is already a page called ${same.title} here: pages are named once a scope, so [[${same.title}]] finds one.`);
        }

        const id = existing?.id ?? randomUUID();
        const now = this.#now();

        this.#transaction(() => {
            if (existing === undefined) {
                this.#db
                    .prepare("INSERT INTO doc_pages (id, scope, folder_id, title, body, updated_by, updated_by_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
                    .run(id, scope, folderId, title, body, by.id, by.name, now, now);
            } else {
                this.#db.prepare("UPDATE doc_pages SET folder_id = ?, title = ?, body = ?, updated_by = ?, updated_by_name = ?, updated_at = ? WHERE id = ?").run(folderId, title, body, by.id, by.name, now, id);
            }

            this.#db.prepare("INSERT INTO doc_versions (id, page_id, title, body, by, by_name, at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(randomUUID(), id, title, body, by.id, by.name, now);
            this.#index(scope, id, title, body);
        });

        return this.page(scope, id);
    }

    /** Exact replacements in a page: each old text must be on it once. */
    edit(scope: string, id: string, edits: { oldText: string; newText: string }[], by: Author): DocPage {
        const page = this.page(scope, id);
        let body = page.body;

        if (!Array.isArray(edits) || edits.length === 0) {
            throw new HttpError(400, "Give one or more edits: { oldText, newText }.");
        }

        for (const edit of edits) {
            const old = String(edit.oldText ?? "");
            const count = old === "" ? 0 : body.split(old).length - 1;

            if (count !== 1) {
                throw new HttpError(409, count === 0 ? `This text is not on ${page.title}: ${old.slice(0, 80)}` : `This text is on ${page.title} ${count} times: give more of it so it is once.`);
            }

            body = body.replace(old, () => String(edit.newText ?? ""));
        }

        return this.write(scope, { id, title: page.title, body }, by);
    }

    /** Move a page to a folder (null: the top). */
    move(scope: string, id: string, folderId: string | null): DocPage {
        this.page(scope, id);

        if (folderId !== null) {
            this.#folder(scope, folderId);
        }

        this.#db.prepare("UPDATE doc_pages SET folder_id = ? WHERE id = ?").run(folderId, id);

        return this.page(scope, id);
    }

    /** Delete a page: gone from the tree and search, kept with its versions to restore. */
    remove(scope: string, id: string): void {
        this.page(scope, id);
        this.#transaction(() => {
            this.#db.prepare("UPDATE doc_pages SET deleted_at = ? WHERE id = ?").run(this.#now(), id);
            this.#db.prepare("DELETE FROM doc_search WHERE page_id = ?").run(id);
        });
    }

    /** Pages deleted in a scope, newest first, to restore. */
    deleted(scope: string): DocPageInfo[] {
        check(scope);

        return (this.#db.prepare("SELECT id, folder_id, title, updated_by_name, updated_at FROM doc_pages WHERE scope = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC").all(scope) as Row[]).map(infoOf);
    }

    /** A page's versions, newest first (without their text). Deleted pages' too. */
    history(scope: string, id: string): DocVersion[] {
        this.#anyPage(scope, id);

        return (this.#db.prepare("SELECT id, title, by_name, at FROM doc_versions WHERE page_id = ? ORDER BY at DESC, rowid DESC").all(id) as Row[]).map((row) => ({ id: String(row.id), title: String(row.title), byName: String(row.by_name), at: Number(row.at) }));
    }

    version(scope: string, id: string, versionId: string): DocVersion & { body: string } {
        this.#anyPage(scope, id);
        const row = this.#db.prepare("SELECT * FROM doc_versions WHERE page_id = ? AND id = ?").get(id, String(versionId)) as Row | undefined;

        if (row === undefined) {
            throw new HttpError(404, "There is no such version of this page.");
        }

        return { id: String(row.id), title: String(row.title), byName: String(row.by_name), at: Number(row.at), body: String(row.body) };
    }

    /** Bring back a version (a deleted page too): saved as the newest, so nothing is lost. */
    restore(scope: string, id: string, versionId: string, by: Author): DocPage {
        const page = this.#anyPage(scope, id);
        const version = this.version(scope, id, versionId);

        if (page.deletedAt !== null) {
            const taken = this.byTitle(scope, version.title);

            if (taken !== undefined) {
                throw new HttpError(409, `There is a page called ${taken.title} again: rename it first.`);
            }

            this.#db.prepare("UPDATE doc_pages SET deleted_at = NULL WHERE id = ?").run(id);
        }

        return this.write(scope, { id, title: version.title, body: version.body }, by);
    }

    /** Pages in the scope whose text links to this one (`[[Title]]` or `[[Title|words]]`). */
    backlinks(scope: string, id: string): DocPageInfo[] {
        const page = this.page(scope, id);
        const pattern = new RegExp(`\\[\\[(?:[a-z]+:)?${escape(page.title)}(?:\\|[^\\]]*)?\\]\\]`, "i");

        return (this.#db.prepare("SELECT * FROM doc_pages WHERE scope = ? AND id != ? AND deleted_at IS NULL AND body LIKE ? ORDER BY title COLLATE NOCASE").all(scope, id, `%[[%${page.title}%]]%`) as Row[])
            .filter((row) => pattern.test(String(row.body)))
            .map(infoOf);
    }

    /** Pages matching words in the given scopes, best first, with where they are and where they match. */
    search(scopes: string[], query: string, limit = 20): DocHit[] {
        scopes.forEach(check);
        // Words only, each a prefix: full-text search's own syntax never comes from outside.
        const words = String(query ?? "")
            .toLowerCase()
            .match(/[\p{L}\p{N}]+/gu);

        if (words === null || scopes.length === 0) {
            return [];
        }

        const rows = this.#db
            .prepare(
                `SELECT page_id, scope, title, snippet(doc_search, 3, '**', '**', '…', 12) AS snippet FROM doc_search
                 WHERE doc_search MATCH ? AND scope IN (${scopes.map(() => "?").join(", ")}) ORDER BY bm25(doc_search) LIMIT ?`,
            )
            .all(words.map((word) => `"${word}"*`).join(" "), ...scopes, Math.max(1, Math.min(100, limit))) as Row[];

        return rows.map((row) => {
            const page = this.page(String(row.scope), String(row.page_id));

            return { scope: page.scope, pageId: page.id, title: page.title, path: page.path, snippet: String(row.snippet) };
        });
    }

    /** A scope gone (its board deleted): its folders, pages and their versions. */
    forgetScope(scope: string): void {
        check(scope);
        this.#transaction(() => {
            this.#db.prepare("DELETE FROM doc_versions WHERE page_id IN (SELECT id FROM doc_pages WHERE scope = ?)").run(scope);
            this.#db.prepare("DELETE FROM doc_pages WHERE scope = ?").run(scope);
            this.#db.prepare("DELETE FROM doc_folders WHERE scope = ?").run(scope);
            this.#db.prepare("DELETE FROM doc_search WHERE scope = ?").run(scope);
        });
    }

    // ---- Inside ---------------------------------------------------------------------------------------------------

    #folder(scope: string, id: string): DocFolder {
        check(scope);
        const row = this.#db.prepare("SELECT * FROM doc_folders WHERE scope = ? AND id = ?").get(scope, String(id)) as Row | undefined;

        if (row === undefined) {
            throw new HttpError(404, "There is no such folder here.");
        }

        return folderOf(row);
    }

    #siblingFolder(scope: string, parentId: string | null, name: string): DocFolder | undefined {
        const row = this.#db.prepare("SELECT * FROM doc_folders WHERE scope = ? AND parent_id IS ? AND name = ? COLLATE NOCASE").get(scope, parentId, name) as Row | undefined;

        return row === undefined ? undefined : folderOf(row);
    }

    /** A page, deleted or not. */
    #anyPage(scope: string, id: string): { id: string; deletedAt: number | null } {
        check(scope);
        const row = this.#db.prepare("SELECT id, deleted_at FROM doc_pages WHERE scope = ? AND id = ?").get(scope, String(id)) as Row | undefined;

        if (row === undefined) {
            throw new HttpError(404, "There is no such page here.");
        }

        return { id: String(row.id), deletedAt: row.deleted_at === null ? null : Number(row.deleted_at) };
    }

    #pageOf(row: Row): DocPage {
        const path: string[] = [];

        for (let at = row.folder_id === null ? null : String(row.folder_id); at !== null; ) {
            const folder = this.#db.prepare("SELECT name, parent_id FROM doc_folders WHERE id = ?").get(at) as Row | undefined;

            if (folder === undefined) {
                break;
            }

            path.unshift(String(folder.name));
            at = folder.parent_id === null ? null : String(folder.parent_id);
        }

        return { ...infoOf(row), scope: String(row.scope), body: String(row.body), updatedBy: String(row.updated_by), createdAt: Number(row.created_at), path };
    }

    #index(scope: string, id: string, title: string, body: string): void {
        this.#db.prepare("DELETE FROM doc_search WHERE page_id = ?").run(id);
        this.#db.prepare("INSERT INTO doc_search (page_id, scope, title, body) VALUES (?, ?, ?, ?)").run(id, scope, title, body);
    }

    #transaction(work: () => void): void {
        this.#db.exec("BEGIN");

        try {
            work();
            this.#db.exec("COMMIT");
        } catch (error) {
            this.#db.exec("ROLLBACK");
            throw error;
        }
    }
}

/** Whether a scope's name is one of ours. */
export function isScope(scope: string): boolean {
    return SCOPE.test(scope);
}

function check(scope: string): void {
    if (!SCOPE.test(String(scope))) {
        throw new HttpError(400, `${scope} is not a place documents are kept (mine, team, or a project).`);
    }
}

function nameOf(name: string, what: "page" | "folder"): string {
    const clean = String(name ?? "").trim();

    if (clean === "" || clean.length > MAX_NAME || /[\]\[|\n\r]/.test(clean)) {
        throw new HttpError(400, `A ${what}'s name is 1 to ${MAX_NAME} characters, without [ ] | or line breaks.`);
    }

    return clean;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const folderOf = (row: Row): DocFolder => ({ id: String(row.id), parentId: row.parent_id === null ? null : String(row.parent_id), name: String(row.name), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) });
const infoOf = (row: Row): DocPageInfo => ({ id: String(row.id), folderId: row.folder_id === null ? null : String(row.folder_id), title: String(row.title), updatedByName: String(row.updated_by_name), updatedAt: Number(row.updated_at) });
