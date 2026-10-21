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
import { type Author, DocumentStore } from "../server/doc-store.ts";
import type { BoardService } from "./boards.ts";
import type { GatewayStore, PersonBox } from "./store.ts";

export type DocCall = { method: string; args: unknown[]; pi?: { conversationId: string } };

const READS = new Set(["tree", "page", "byTitle", "deleted", "history", "version", "backlinks"]);
const WRITES = new Set(["write", "edit", "move", "remove", "restore", "makeFolder", "changeFolder", "removeFolder"]);

export class DocService {
    readonly #store: GatewayStore;
    readonly #boards: BoardService;
    readonly #docs: DocumentStore;

    constructor(store: GatewayStore, boards: BoardService, dir: string, now: () => number = Date.now) {
        this.#store = store;
        this.#boards = boards;
        this.#docs = new DocumentStore(join(dir, "documents.sqlite"), now);
        // A board deleted: its documents go with it.
        boards.onRemoved((projectId) => this.#docs.forgetScope(`project:${projectId}`));
    }

    close(): void {
        this.#docs.close();
    }

    call(box: PersonBox, call: DocCall): unknown {
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

        // Search: the scopes asked for that this person may read.
        if (call.method === "search") {
            const asked = (Array.isArray(args[0]) ? args[0] : []).map((name) => scope(name));
            const hits = this.#docs.search(
                asked.map((each) => each.inside),
                String(args[1] ?? ""),
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

        return out(value, where.inside, where.outside);
    }
}
