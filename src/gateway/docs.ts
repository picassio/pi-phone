/**
 * The team server's documents (PP-46): team documents, and each shared board's project documents, kept in the gateway
 * (`DocumentStore`, on `/data/boards/documents.sqlite`). Pi-phones call it on the gateway's internal port with their own
 * token, as their person or their Pi, as with the boards. Who may:
 *
 * - team: everyone with a pi-phone reads; roles with "Edit team documents" (`docs.team`) write.
 * - project:<KEY>: those who see the board read; its leads and members write (the board service's rules).
 *
 * Scopes come and go by their outside names (`team`, `project:<KEY>`); inside they are `team` and `project:<board id>`,
 * so a renamed board keeps its documents. Deletes are audited; Pi's writes are named "Pi (person)".
 */
import { join } from "node:path";
import { HttpError } from "../server/errors.ts";
import { type Author, DESCRIBE_IMAGE, describer, DocumentStore, indexer } from "../server/doc-store.ts";
import { type Embedder, openRouterEmbedder, openRouterVision } from "../server/embeddings.ts";
import type { BoardService } from "./boards.ts";
import type { GatewayStore, PersonBox } from "./store.ts";

export type DocCall = { method: string; args: unknown[]; pi?: { conversationId: string } };

const READS = new Set(["tree", "page", "byTitle", "deleted", "history", "version", "backlinks", "image"]);
const WRITES = new Set(["write", "edit", "move", "remove", "restore", "makeFolder", "changeFolder", "removeFolder", "addImage"]);

export class DocService {
    readonly #store: GatewayStore;
    readonly #boards: BoardService;
    readonly #docs: DocumentStore;
    /** Embed what is pending, with the server's key (PP-49). */
    readonly #index: () => void;
    /** Describe images waiting for it, with the server's key and vision model (PP-49). */
    readonly #describe: () => void;
    readonly #now: () => number;

    constructor(store: GatewayStore, boards: BoardService, dir: string, now: () => number = Date.now, log: (line: string) => void = () => {}) {
        this.#store = store;
        this.#boards = boards;
        this.#now = now;
        this.#docs = new DocumentStore(join(dir, "documents.sqlite"), now);
        this.#index = indexer(this.#docs, async () => this.embedder(), (usage) => this.#spent(usage), log);
        this.#index();
        this.#describe = describer(
            this.#docs,
            async () => {
                const { key, vision } = this.#store.docsSearch();

                if (key === null || vision === null) {
                    return undefined;
                }

                const client = openRouterVision(key, vision);

                return {
                    model: vision,
                    describe: async (mime, data) => {
                        const said = await client.describe(mime, data, DESCRIBE_IMAGE);

                        this.#spent(said);

                        return said.text;
                    },
                };
            },
            this.#index,
            log,
        );
        this.#describe();
        // A board deleted: its documents go with it.
        boards.onRemoved((projectId) => this.#docs.forgetScope(`project:${projectId}`));
    }

    close(): void {
        this.#docs.close();
    }

    /** The server's embedder for search by meaning, or undefined (keyword only) without a key and a model. */
    embedder(): Embedder | undefined {
        const { key, model } = this.#store.docsSearch();

        return key === null || model === null ? undefined : openRouterEmbedder(key, model);
    }

    /** Search by meaning's state, for the Server page: the model, whether there is a key, this month's spend, how much is indexed. */
    searchState(): { model: string | null; vision: string | null; keySet: boolean; month: { tokens: number; cost: number }; indexed: { passages: number; embedded: number } } {
        const { key, model, vision } = this.#store.docsSearch();

        return { model, vision, keySet: key !== null, month: this.#store.docsSpend(new Date(this.#now()).toISOString().slice(0, 7)), indexed: this.#docs.indexed() };
    }

    /** The search settings changed: index again with them. */
    reindex(): void {
        this.#index();
        this.#describe();
    }

    #spent(usage: { tokens: number; cost?: number }): void {
        this.#store.addDocsSpend(new Date(this.#now()).toISOString().slice(0, 7), usage.tokens, usage.cost ?? 0);
    }

    async call(box: PersonBox, call: DocCall): Promise<unknown> {
        const user = this.#store.users().find((each) => each.id === box.userId);

        if (user === undefined || user.banned) {
            throw new HttpError(403, "This pi-phone's person has no account here anymore.");
        }

        const permissions = this.#store.roleOf(user.id, user.role).permissions as readonly string[];
        const by: Author = { id: user.id, name: call.pi === undefined ? user.name : `Pi (${user.name})` };
        const args = Array.isArray(call.args) ? call.args : [];
        /** A scope by its outside name: where it is inside, its outside name, and whether this person may write it. */
        const scope = (name: unknown): { inside: string; outside: string; write: boolean } => {
            const given = String(name ?? "");

            if (given === "team") {
                if (!permissions.includes("pi.use")) {
                    throw new HttpError(403, "Team documents are for people with a pi-phone.");
                }

                return { inside: "team", outside: "team", write: permissions.includes("docs.team") };
            }

            const key = /^project:([A-Za-z][A-Za-z0-9]{1,5})$/.exec(given)?.[1];

            if (key === undefined) {
                throw new HttpError(400, `${given} is not a place for documents here (team, or project:<KEY>).`);
            }

            const board = this.#boards.standing(user.id, key);

            return { inside: `project:${board.id}`, outside: `project:${board.key}`, write: board.role !== "viewer" };
        };
        /** Answers with outside scope names. */
        const out = (value: unknown, inside: string, outside: string): unknown => {
            if (Array.isArray(value)) {
                return value.map((each) => out(each, inside, outside));
            }

            if (value !== null && typeof value === "object") {
                const object = value as Record<string, unknown>;

                return object.scope === inside ? { ...object, scope: outside } : object;
            }

            return value;
        };

        // The places this person has documents: the team's, and each board they see.
        if (call.method === "scopes") {
            return [
                ...(permissions.includes("pi.use") ? [{ id: "team", name: "Team", write: permissions.includes("docs.team") }] : []),
                ...this.#boards.seen(user.id).map((board) => ({ id: `project:${board.key}`, name: `${board.key} · ${board.name}`, write: board.role !== "viewer" })),
            ];
        }

        // Whether search here is by meaning too.
        if (call.method === "meaning") {
            return this.embedder() !== undefined;
        }

        // Search: the scopes asked for that this person may read; by meaning too, with the server's key.
        if (call.method === "search") {
            const asked = (Array.isArray(args[0]) ? args[0] : []).map((name) => scope(name));
            const query = String(args[1] ?? "");
            const embedder = this.embedder();
            let vector: number[] | null = null;

            // Vectors of another model (it was just changed) compare to nothing: by keyword until they are embedded again.
            if (embedder !== undefined && this.#docs.embeddedWith() !== embedder.model) {
                this.#index();
            } else if (embedder !== undefined && query.trim() !== "") {
                try {
                    const embedded = await embedder.embed([query]);

                    vector = embedded.vectors[0] ?? null;
                    this.#spent(embedded);
                } catch {
                    // By keyword, then.
                }
            }

            const hits = this.#docs.hybrid(
                asked.map((each) => each.inside),
                query,
                vector,
                Number(args[2] ?? 20),
            );

            return hits.map((hit) => ({ ...hit, scope: asked.find((each) => each.inside === hit.scope)?.outside ?? hit.scope }));
        }

        const where = scope(args[0]);
        const rest = args.slice(1);

        if (READS.has(call.method)) {
            const docs = this.#docs as unknown as Record<string, (...given: unknown[]) => unknown>;

            return out(docs[call.method]!.call(this.#docs, where.inside, ...rest), where.inside, where.outside);
        }

        if (!WRITES.has(call.method)) {
            throw new HttpError(400, `${call.method} is not something documents do.`);
        }

        if (!where.write) {
            throw new HttpError(403, where.outside === "team" ? "Editing team documents is not part of your role." : `You are a viewer on ${where.outside.slice("project:".length)}: its documents are its members' to write.`);
        }

        const docs = this.#docs;
        const audit = (action: string, what: string) => this.#store.audit(call.pi === undefined ? user.id : `pi:${user.id}`, action, undefined, { scope: where.outside, what });
        let value: unknown;

        switch (call.method) {
            case "write":
                value = docs.write(where.inside, rest[0] as never, by);
                break;
            case "edit":
                value = docs.edit(where.inside, String(rest[0]), rest[1] as never, by);
                break;
            case "move":
                value = docs.move(where.inside, String(rest[0]), (rest[1] ?? null) as string | null);
                break;
            case "remove":
                audit("document deleted", docs.page(where.inside, String(rest[0])).title);
                value = docs.remove(where.inside, String(rest[0]));
                break;
            case "restore":
                value = docs.restore(where.inside, String(rest[0]), String(rest[1]), by);
                audit("document restored", (value as { title: string }).title);
                break;
            case "addImage":
                value = docs.addImage(where.inside, rest[0] as never, by);
                this.#describe();
                break;
            case "makeFolder":
                value = docs.makeFolder(where.inside, (rest[0] ?? null) as string | null, String(rest[1] ?? ""));
                break;
            case "changeFolder":
                value = docs.changeFolder(where.inside, String(rest[0]), (rest[1] ?? {}) as never);
                break;
            default:
                audit("folder deleted", String(rest[0]));
                value = docs.removeFolder(where.inside, String(rest[0]));
        }

        this.#index();

        return out(value, where.inside, where.outside);
    }
}
