/**
 * Documents (PP-46): people's documents in folders, as markdown pages: Mine (in this pi-phone), Team and each board's
 * (the team server's gateway; on the phone, its own boards' are kept here). The Documents page lists, reads, writes,
 * moves, deletes and restores them, and searches across them (`docs-access.ts`). Only this pi-phone's person: guests
 * never reach documents.
 */
import { defineExtension } from "@earendil-works/pi-durable";
import type { ExtensionWeb, PocketHost, WebRequest } from "../host.ts";
import { HttpError } from "../errors.ts";
import { Docs } from "../docs-access.ts";
import { Projects } from "../projects.ts";

export default function createDocs(host: PocketHost, web: ExtensionWeb) {
    const owner = () => host.people().find((person) => person.role === "owner");
    // The phone's own boards, for their documents (the team server keeps its boards' documents itself).
    const projects = host.teamServer === undefined ? new Projects(host.dataDir, () => host.people()) : undefined;
    const docs = new Docs({
        dataDir: host.dataDir,
        me: () => {
            const person = owner();

            return { id: person?.id ?? "owner", name: person?.name ?? "Owner" };
        },
        teamServer: host.teamServer,
        ...(projects === undefined ? {} : { projects }),
    });

    // The Documents page (`docs-web/`): this pi-phone's person's.
    web.client("docs-web");
    web.onDispose(() => {
        docs.close();
        projects?.close();
    });

    /** Only this pi-phone's own person. */
    const mine = (request: WebRequest) => {
        if (request.user.role !== "owner") {
            throw web.error(403, "Documents are this pi-phone's person's.");
        }
    };
    const answer = async <T>(work: () => Promise<T>): Promise<T> => {
        try {
            return await work();
        } catch (error) {
            throw error instanceof HttpError ? web.error(error.status, error.message) : error;
        }
    };

    web.route("GET", "scopes", (request) => (mine(request), answer(async () => ({ scopes: await docs.scopes() }))));
    web.route("POST", "call", (request) =>
        (mine(request),
        answer(async () => ({ value: (await docs.call(String(request.body.scope ?? ""), String(request.body.method ?? ""), Array.isArray(request.body.args) ? request.body.args : [])) ?? null }))),
    );
    web.route("GET", "search", (request) =>
        (mine(request),
        answer(async () => {
            const scopes = request.query.get("scopes");

            return { hits: await docs.search(request.query.get("q") ?? "", scopes === null || scopes === "" ? undefined : scopes.split(",")) };
        })),
    );

    return defineExtension({ name: "pocket-docs", tools: [] });
}
