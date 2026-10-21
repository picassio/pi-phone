/**
 * Project wikis (PP-42): Pi's knowledge about a shared board's project, kept in the team server's gateway next to the
 * board, so every member's Pi reads what the others' learned. Pages are markdown, named by a slug, searchable by keyword
 * (SQLite's full-text search). Who may read or write is the board service's to decide (its members; viewers read);
 * this store only keeps the pages, and who wrote each last.
 */
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HttpError } from "../server/errors.ts";

export type WikiPage = { slug: string; title: string; body: string; updatedBy: string; updatedByName: string; updatedAt: number; createdAt: number };
export type WikiEntry = Pick<WikiPage, "slug" | "title" | "updatedByName" | "updatedAt">;
export type WikiHit = { slug: string; title: string; snippet: string };

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_TITLE = 120;
const MAX_BODY = 200_000;

/** A page's slug from its title: lowercase words joined by hyphens. */
export function slugOf(title: string): string {
    return title
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80);
}

export class ProjectWiki {
    readonly #db: DatabaseSync;
    readonly #now: () => number;

    constructor(dir: string, now: () => number = Date.now) {
        this.#now = now;
        this.#db = new DatabaseSync(join(dir, "wiki.sqlite"), { timeout: 5000 });
        this.#db.exec(`
            CREATE TABLE IF NOT EXISTS pp_wiki_pages (
                project_id TEXT NOT NULL, slug TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
                updated_by TEXT NOT NULL, updated_by_name TEXT NOT NULL, updated_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
                PRIMARY KEY (project_id, slug)
            ) STRICT;
            CREATE VIRTUAL TABLE IF NOT EXISTS pp_wiki_search USING fts5(project_id UNINDEXED, slug UNINDEXED, title, body);
        `);
    }

    /** A consistent copy of the project wikis' database in `file` (`VACUUM INTO`), for the team server's backup (PP-26). */
    snapshot(file: string): void {
        this.#db.prepare("VACUUM INTO ?").run(file);
    }

    close(): void {
        this.#db.close();
    }

    /** A board's pages, by title. */
    list(projectId: string): WikiEntry[] {
        return (this.#db.prepare("SELECT slug, title, updated_by_name, updated_at FROM pp_wiki_pages WHERE project_id = ? ORDER BY title COLLATE NOCASE").all(projectId) as Record<string, unknown>[]).map((row) => ({
            slug: String(row.slug),
            title: String(row.title),
            updatedByName: String(row.updated_by_name),
            updatedAt: Number(row.updated_at),
        }));
    }

    read(projectId: string, slug: string): WikiPage {
        const row = this.#db.prepare("SELECT * FROM pp_wiki_pages WHERE project_id = ? AND slug = ?").get(projectId, String(slug)) as Record<string, unknown> | undefined;

        if (row === undefined) {
            throw new HttpError(404, `There is no page ${slug} in this project's wiki.`);
        }

        return {
            slug: String(row.slug),
            title: String(row.title),
            body: String(row.body),
            updatedBy: String(row.updated_by),
            updatedByName: String(row.updated_by_name),
            updatedAt: Number(row.updated_at),
            createdAt: Number(row.created_at),
        };
    }

    /** Write a page whole: made new, or replaced (by its slug, from its title unless given). */
    write(projectId: string, page: { slug?: string; title: string; body: string }, by: { id: string; name: string }): WikiPage {
        const title = String(page.title ?? "").trim();
        const body = String(page.body ?? "");
        const slug = page.slug === undefined || page.slug === "" ? slugOf(title) : String(page.slug);

        if (title === "" || title.length > MAX_TITLE) {
            throw new HttpError(400, `A page's title is 1 to ${MAX_TITLE} characters.`);
        }

        if (!SLUG.test(slug)) {
            throw new HttpError(400, "A page's name is lowercase letters, digits and hyphens (deploy-notes).");
        }

        if (body.length > MAX_BODY) {
            throw new HttpError(400, `A page is at most ${MAX_BODY / 1000} KB.`);
        }

        const now = this.#now();

        this.#db.exec("BEGIN");

        try {
            this.#db
                .prepare(
                    `INSERT INTO pp_wiki_pages (project_id, slug, title, body, updated_by, updated_by_name, updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                     ON CONFLICT(project_id, slug) DO UPDATE SET title = excluded.title, body = excluded.body, updated_by = excluded.updated_by,
                     updated_by_name = excluded.updated_by_name, updated_at = excluded.updated_at`,
                )
                .run(projectId, slug, title, body, by.id, by.name, now, now);
            this.#db.prepare("DELETE FROM pp_wiki_search WHERE project_id = ? AND slug = ?").run(projectId, slug);
            this.#db.prepare("INSERT INTO pp_wiki_search (project_id, slug, title, body) VALUES (?, ?, ?, ?)").run(projectId, slug, title, body);
            this.#db.exec("COMMIT");
        } catch (error) {
            this.#db.exec("ROLLBACK");
            throw error;
        }

        return this.read(projectId, slug);
    }

    /** Exact replacements in a page: each old text must be there once. */
    edit(projectId: string, slug: string, edits: { oldText: string; newText: string }[], by: { id: string; name: string }): WikiPage {
        const page = this.read(projectId, slug);
        let body = page.body;

        if (!Array.isArray(edits) || edits.length === 0) {
            throw new HttpError(400, "Give one or more edits: { oldText, newText }.");
        }

        for (const edit of edits) {
            const old = String(edit.oldText ?? "");
            const count = old === "" ? 0 : body.split(old).length - 1;

            if (count !== 1) {
                throw new HttpError(409, count === 0 ? `This text is not on ${slug}: ${old.slice(0, 80)}` : `This text is on ${slug} ${count} times: give more of it so it is once.`);
            }

            body = body.replace(old, () => String(edit.newText ?? ""));
        }

        return this.write(projectId, { slug, title: page.title, body }, by);
    }

    /** Pages matching words, best first, with where they match. */
    search(projectId: string, query: string, limit = 10): WikiHit[] {
        // Words only, each a prefix: full-text search's own syntax never comes from the person or Pi.
        const words = String(query ?? "")
            .toLowerCase()
            .match(/[\p{L}\p{N}]+/gu);

        if (words === null) {
            return [];
        }

        const match = words.map((word) => `"${word}"*`).join(" ");

        return (
            this.#db
                .prepare(`SELECT slug, title, snippet(pp_wiki_search, 3, '**', '**', '…', 12) AS snippet FROM pp_wiki_search WHERE project_id = ? AND pp_wiki_search MATCH ? ORDER BY bm25(pp_wiki_search) LIMIT ?`)
                .all(projectId, match, Math.max(1, Math.min(50, limit))) as Record<string, unknown>[]
        ).map((row) => ({ slug: String(row.slug), title: String(row.title), snippet: String(row.snippet) }));
    }

    /** A board deleted: its wiki too. */
    forget(projectId: string): void {
        this.#db.prepare("DELETE FROM pp_wiki_pages WHERE project_id = ?").run(projectId);
        this.#db.prepare("DELETE FROM pp_wiki_search WHERE project_id = ?").run(projectId);
    }
}
