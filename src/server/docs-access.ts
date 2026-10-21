/**
 * Documents as a pi-phone reaches them (PP-46), for the Documents page (`extensions/docs.ts`) and Pi's document tools:
 *
 * - mine: this pi-phone's own store (`documents.sqlite` in its data folder), its person's alone;
 * - team, and project:<KEY> of a shared board: the team server's gateway (`/internal/docs`), by the person's rights there;
 * - project:<KEY> of one of the phone's own boards (no team server): this pi-phone's store, its owner's.
 *
 * Every call names its scope; search asks each place for its scopes and puts the answers together. Who acts is the
 * person this pi-phone is theirs (guests never reach documents), or Pi working for them (`pi`), named "Pi (person)".
 */
import { join } from "node:path";
import { HttpError } from "./errors.ts";
import { type Author, type DocHit, DocumentStore, indexer } from "./doc-store.ts";
import type { Embedder } from "./embeddings.ts";
import type { Projects } from "./projects.ts";

export type DocScope = { id: string; name: string; write: boolean };

const READS = new Set(["tree", "page", "byTitle", "deleted", "history", "version", "backlinks"]);
const WRITES = new Set(["write", "edit", "move", "remove", "restore", "makeFolder", "changeFolder", "removeFolder"]);

export type DocsOptions = {
    dataDir: string;
    /** This pi-phone's person: who writes, and whose "mine" it is. */
    me: () => Author;
    /** The team server's gateway, or undefined (the phone). */
    teamServer: { url: string; token: string } | undefined;
    /** The phone's own boards, for their documents (no team server). */
    projects?: Projects;
    fetch?: typeof fetch;
    /** Search by meaning here (PP-49): the person's OpenRouter key and embedding model, or undefined (keyword only). */
    embedder?: () => Promise<Embedder | undefined>;
    /** What embedding cost, for Spend. */
    spent?: (usage: { model: string; tokens: number; cost?: number }) => void;
    log?: (line: string) => void;
};

export class Docs {
    readonly #local: DocumentStore;
    readonly #options: DocsOptions;
    /** Embed what is pending here (after a save, and once at the start). */
    readonly #index: () => void;

    constructor(options: DocsOptions) {
        this.#options = options;
        this.#local = new DocumentStore(join(options.dataDir, "documents.sqlite"));
        this.#index = indexer(this.#local, options.embedder ?? (async () => undefined), options.spent ?? (() => {}), options.log ?? (() => {}));
        this.#index();
    }

    /** Whether search here, and at the team server, is by meaning too (else by keyword only). */
    async meaning(): Promise<{ mine: boolean; team: boolean | null }> {
        const mine = (await this.#options.embedder?.()) !== undefined;

        return { mine, team: this.#options.teamServer === undefined ? null : ((await this.#remote("meaning", [])) as boolean) };
    }

    close(): void {
        this.#local.close();
    }

    /** Where this person keeps documents: Mine, the team's, and each board's. */
    async scopes(): Promise<DocScope[]> {
        const mine: DocScope = { id: "mine", name: "Mine", write: true };

        if (this.#options.teamServer !== undefined) {
            return [mine, ...((await this.#remote("scopes", [])) as DocScope[])];
        }

        const owner = this.#owner();

        return [mine, ...(this.#options.projects?.list({ kind: "person", person: owner }) ?? []).map((project) => ({ id: `project:${project.key}`, name: `${project.key} · ${project.name}`, write: true }))];
    }

    /** One call on a scope: a read, or a write as this person (or Pi working for them). */
    async call(scope: string, method: string, args: unknown[], pi = false): Promise<unknown> {
        if (!READS.has(method) && !WRITES.has(method)) {
            throw new HttpError(400, `${method} is not something documents do.`);
        }

        const local = this.#localScope(scope);

        if (local === undefined) {
            return this.#remote(method, [scope, ...args], pi);
        }

        const me = this.#options.me();
        const by: Author = pi ? { id: me.id, name: `Pi (${me.name})` } : me;
        const docs = this.#local as unknown as Record<string, (...given: unknown[]) => unknown>;
        // Writes take who writes last, where the store wants one.
        const withBy = ["write", "edit", "restore"].includes(method) ? [...args, by] : args;
        const value = docs[method]!.call(this.#local, local, ...withBy);

        if (WRITES.has(method)) {
            this.#index();
        }

        return renamed(value, local, scope);
    }

    /** Pages matching words in the scopes asked for (all of this person's by default), best first. */
    async search(query: string, scopes?: string[]): Promise<DocHit[]> {
        const asked = scopes ?? (await this.scopes()).map((each) => each.id);
        const here = asked.filter((scope) => this.#localScope(scope) !== undefined);
        const there = asked.filter((scope) => this.#localScope(scope) === undefined);
        const embedder = here.length === 0 ? undefined : await this.#options.embedder?.();
        let vector: number[] | null = null;

        if (embedder !== undefined) {
            try {
                const embedded = await embedder.embed([query]);

                vector = embedded.vectors[0] ?? null;
                this.#options.spent?.({ model: embedder.model, tokens: embedded.tokens, ...(embedded.cost === undefined ? {} : { cost: embedded.cost }) });
            } catch (error) {
                this.#options.log?.(`documents: the search's embedding failed, so it is by keyword: ${error instanceof Error ? error.message : String(error)}`);
            }
        }

        const hits = this.#local.hybrid(
            here.map((scope) => this.#localScope(scope)!),
            query,
            vector,
            20,
        ).map((hit) => ({ ...hit, scope: here.find((scope) => this.#localScope(scope) === hit.scope) ?? hit.scope }));

        return [...hits, ...(there.length === 0 ? [] : ((await this.#remote("search", [there, query, 20])) as DocHit[]))];
    }

    /** Where a scope is kept here (its inside name), or undefined when the team server keeps it. */
    #localScope(scope: string): string | undefined {
        if (scope === "mine") {
            return "mine";
        }

        if (this.#options.teamServer !== undefined) {
            return undefined;
        }

        const key = /^project:([A-Za-z][A-Za-z0-9]{1,5})$/.exec(scope)?.[1];

        if (key === undefined || this.#options.projects === undefined) {
            throw new HttpError(400, `${scope} is not a place for documents here.`);
        }

        return `project:${this.#options.projects.project({ kind: "person", person: this.#owner() }, key).id}`;
    }

    #owner() {
        const me = this.#options.me();

        return { id: me.id, name: me.name, role: "owner" as const };
    }

    async #remote(method: string, args: unknown[], pi = false): Promise<unknown> {
        const server = this.#options.teamServer;

        if (server === undefined) {
            throw new HttpError(400, "Team documents are the team server's.");
        }

        const response = await (this.#options.fetch ?? fetch)(`${server.url}/internal/docs`, {
            method: "POST",
            headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
            body: JSON.stringify({ method, args, ...(pi ? { pi: { conversationId: "0" } } : {}) }),
            signal: AbortSignal.timeout(20_000),
        });
        const body = (await response.json()) as { value?: unknown; error?: string };

        if (!response.ok) {
            throw new HttpError(response.status, body.error ?? `The team server answered ${response.status}.`);
        }

        return body.value;
    }
}

/** Answers with the scope's outside name. */
function renamed(value: unknown, inside: string, outside: string): unknown {
    if (Array.isArray(value)) {
        return value.map((each) => renamed(each, inside, outside));
    }

    if (value !== null && typeof value === "object" && (value as { scope?: unknown }).scope === inside) {
        return { ...(value as object), scope: outside };
    }

    return value;
}
