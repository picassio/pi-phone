/**
 * Documents (PP-46): people's documents in folders, as markdown pages: Mine (in this pi-phone), Team and each board's
 * (the team server's gateway; on the phone, its own boards' are kept here). The Documents page lists, reads, writes,
 * moves, deletes and restores them, and searches across them (`docs-access.ts`). Only this pi-phone's person: guests
 * never reach documents.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import type { ExtensionWeb, PocketHost, WebRequest } from "../host.ts";
import { HttpError } from "../errors.ts";
import { fencedDocuments } from "../fence.ts";
import { Docs } from "../docs-access.ts";
import { openRouterEmbedder } from "../embeddings.ts";
import { Projects } from "../projects.ts";

export default function createDocs(host: PocketHost, web: ExtensionWeb) {
    const owner = () => host.people().find((person) => person.role === "owner");
    // The phone's own boards, for their documents (the team server keeps its boards' documents itself); and, everywhere,
    // a session's board mode, whose board's documents Pi's tools use first.
    const projects = new Projects(host.dataDir, () => host.people());
    const docs = new Docs({
        dataDir: host.dataDir,
        me: () => {
            const person = owner();

            return { id: person?.id ?? "owner", name: person?.name ?? "Owner" };
        },
        teamServer: host.teamServer,
        ...(host.teamServer === undefined ? { projects } : {}),
        // Search by meaning (PP-49): the wiki's embedding model, with the person's OpenRouter sign-in; costs in Spend.
        embedder: async () => {
            const model = (await host.para.settings()).embeddingModel;
            const key = model === null ? undefined : await host.apiKey("openrouter");

            return model === null || key === undefined ? undefined : openRouterEmbedder(key, model);
        },
        spent: (usage) => void host.para.chargeEmbedding(usage).catch(() => {}),
        // Images described by the model the person chose for it (PP-49), if any.
        vision: async () => {
            const model = host.docsImages.model();

            return model === null ? undefined : { model, describe: async (mime, data, prompt) => (await host.docsImages.describe(mime, data, prompt))?.text ?? "" };
        },
        log: (line) => host.notice("warning", line),
    });

    // The Documents page (`docs-web/`): this pi-phone's person's.
    web.client("docs-web");
    web.onDispose(() => {
        docs.close();
        projects.close();
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
    web.route(
        "POST",
        "call",
        (request) =>
            (mine(request),
            answer(async () => ({ value: (await docs.call(String(request.body.scope ?? ""), String(request.body.method ?? ""), Array.isArray(request.body.args) ? request.body.args : [])) ?? null }))),
        // An image (10 MB) in base64.
        { maxBytes: 16 * 1024 * 1024 },
    );
    // The model that describes images in Mine (and the phone's boards'): the person's choice among models that read images.
    web.route("GET", "image-model", (request) => (mine(request), { model: host.docsImages.model(), models: host.docsImages.models(), team: host.teamServer !== undefined }));
    web.route("POST", "image-model", (request) =>
        (mine(request),
        answer(async () => {
            const model = request.body.model;

            await host.docsImages.choose(model === null || model === "" ? null : String(model));
            docs.describeImages();

            return { model: host.docsImages.model() };
        })),
    );
    web.route("GET", "meaning", (request) => (mine(request), answer(async () => docs.meaning())));
    web.route("GET", "search", (request) =>
        (mine(request),
        answer(async () => {
            const scopes = request.query.get("scopes");

            return { hits: await docs.search(request.query.get("q") ?? "", scopes === null || scopes === "" ? undefined : scopes.split(",")) };
        })),
    );

    // ---- Pi's document tools (PP-48) ----------------------------------------------------------------------------------

    const reply = (text: string, isError = false) => ({ output: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) });
    const PLACE = Type.Optional(Type.String({ description: "mine, team, or a board's key (PP); default: this session's board, else mine" }));
    const PAGE = Type.String({ description: "The page's title (or id)" });
    /** The place a tool means: as given (mine, team, a board's key), else this session's board, else mine. */
    const placeOf = (given: string | undefined, conversationId: unknown): string => {
        const said = given?.trim();

        if (said === undefined || said === "") {
            const mode = projects.boardMode(String(conversationId));

            return mode?.on === true && mode.project !== null ? `project:${mode.project.key}` : "mine";
        }

        return said === "mine" || said === "team" ? said : said.startsWith("project:") ? said : `project:${said.toUpperCase()}`;
    };
    /** A page by its title or id, in a place. */
    const pageOf = async (scope: string, which: string) =>
        ((await docs.call(scope, "byTitle", [which])) as { id: string; title: string } | null) ?? ((await docs.call(scope, "page", [which]).catch(() => null)) as { id: string; title: string } | null);
    const found = async (scope: string, which: string) => {
        const page = await pageOf(scope, which);

        if (page === null) {
            throw new HttpError(404, `There is no page ${which} in ${scope}: doc_list shows what is there.`);
        }

        return page;
    };
    const folderOf = async (scope: string, path: string | undefined): Promise<string | null> => {
        if (path === undefined || path.trim() === "" || path.trim() === "/") {
            return null;
        }

        const tree = (await docs.call(scope, "tree", [])) as { folders: { id: string; parentId: string | null; name: string }[] };
        let parent: string | null = null;

        for (const name of path.split("/").map((part) => part.trim()).filter((part) => part !== "")) {
            const next = tree.folders.find((folder) => folder.parentId === parent && folder.name.toLowerCase() === name.toLowerCase());

            parent = next?.id ?? ((await docs.call(scope, "makeFolder", [parent, name])) as { id: string }).id;
            tree.folders.push({ id: parent, parentId: next === undefined ? null : next.parentId, name });
        }

        return parent;
    };
    /** Only this pi-phone's own person: Pi working for a guest never reaches documents. */
    const ownersOnly = (conversationId: unknown) => {
        const id = host.requesterOf(Number(conversationId) as never);

        if (id === undefined || host.person(id).role !== "owner") {
            throw new HttpError(403, "Documents are this pi-phone's person's, not a guest's.");
        }
    };
    const ask = async (api: { conversationId: unknown; taskId: unknown; callId?: string }, context: unknown, tool: string, subject: string, reason: string) => {
        const answer = await host.approvals.request(
            { id: `${tool}-${String(api.conversationId)}-${String(api.callId)}`, conversationId: Number(api.conversationId) as never, taskId: api.taskId as never, ...(api.callId === undefined ? {} : { callId: api.callId }), tool, subject, reason, createdAt: Date.now() },
            context as never,
        );

        if (!answer.allow) {
            throw new HttpError(403, `${answer.by} said no: nothing was done.`);
        }
    };
    const tool = <P extends Parameters<typeof defineTool>[0]["parameters"]>(name: string, description: string, parameters: P, run: (args: never, api: { conversationId: unknown; taskId: unknown; callId?: string; agent(context: unknown): Promise<{ cwd?: string }> }, context: unknown) => Promise<string>) =>
        defineTool({
            name,
            description,
            parameters,
            execute: async (args, api, context) => {
                try {
                    ownersOnly(api.conversationId);

                    return reply(await run(args as never, api as never, context));
                } catch (error) {
                    return reply(error instanceof Error ? error.message : String(error), true);
                }
            },
        });
    const where = (scope: string, path: string[] = []) => [scope === "mine" ? "Mine" : scope === "team" ? "Team" : scope.slice("project:".length), ...path].join(" › ");

    const tools = [
        tool("doc_search", "Search people's documents (Mine, the team's, boards') by words: pages, best first, with where they are and where they match.", Type.Object({ query: Type.String(), place: PLACE }), async (args: { query: string; place?: string }) => {
            const hits = await docs.search(args.query, args.place === undefined ? undefined : [placeOf(args.place, undefined)]);

            return hits.length === 0 ? "No document matches." : fencedDocuments(hits.map((hit) => `- ${hit.title} (${where(hit.scope, hit.path)}): ${hit.snippet}`).join("\n"));
        }),
        tool("doc_list", "The folders and pages of a place's documents.", Type.Object({ place: PLACE }), async (args: { place?: string }, api) => {
            const scope = placeOf(args.place, api.conversationId);
            const tree = (await docs.call(scope, "tree", [])) as { folders: { id: string; parentId: string | null; name: string }[]; pages: { title: string; folderId: string | null; updatedByName: string }[] };
            const lines: string[] = [];
            const walk = (parent: string | null, depth: number) => {
                for (const folder of tree.folders.filter((each) => each.parentId === parent)) {
                    lines.push(`${"  ".repeat(depth)}${folder.name}/`);
                    walk(folder.id, depth + 1);
                }

                for (const page of tree.pages.filter((each) => each.folderId === parent)) {
                    lines.push(`${"  ".repeat(depth)}- ${page.title} (by ${page.updatedByName})`);
                }
            };

            walk(null, 0);

            return `${where(scope)}:\n${lines.length === 0 ? "(nothing yet)" : fencedDocuments(lines.join("\n"))}`;
        }),
        tool("doc_read", "Read a document page: its text (markdown), where it is, and who saved it last.", Type.Object({ page: PAGE, place: PLACE }), async (args: { page: string; place?: string }, api) => {
            const scope = placeOf(args.place, api.conversationId);
            const page = (await docs.call(scope, "page", [(await found(scope, args.page)).id])) as { title: string; body: string; path: string[]; updatedByName: string; updatedAt: number };

            // The title, the folders and the text are people's words (a teammate's too): fenced as data (PP-204).
            return fencedDocuments(`# ${page.title} (${where(scope, page.path)}; last saved by ${page.updatedByName}, ${new Date(page.updatedAt).toISOString().slice(0, 16).replace("T", " ")} UTC)\n\n${page.body}`);
        }),
        tool("doc_history", "A document page's saved versions, newest first.", Type.Object({ page: PAGE, place: PLACE }), async (args: { page: string; place?: string }, api) => {
            const scope = placeOf(args.place, api.conversationId);
            const versions = (await docs.call(scope, "history", [(await found(scope, args.page)).id])) as { id: string; byName: string; at: number }[];

            return versions.map((version, index) => `- ${version.id}: ${version.byName}, ${new Date(version.at).toISOString().slice(0, 16).replace("T", " ")} UTC${index === 0 ? " (now)" : ""}`).join("\n");
        }),
        tool(
            "doc_write",
            "Write a document page whole (a new one, or a new version of the page with that title), in a folder (a/b, made if missing). For people's documents; Pi's own knowledge goes in the wikis.",
            Type.Object({ title: Type.String(), body: Type.String({ description: "Markdown; [[Page]] links a page in the same place" }), folder: Type.Optional(Type.String({ description: "Folder path, like Guides/Deploy; default: where it is, else the top" })), place: PLACE }),
            async (args: { title: string; body: string; folder?: string; place?: string }, api) => {
                const scope = placeOf(args.place, api.conversationId);
                const existing = await pageOf(scope, args.title);
                const folderId = args.folder === undefined ? undefined : await folderOf(scope, args.folder);
                const page = (await docs.call(scope, "write", [{ ...(existing === null ? {} : { id: existing.id }), ...(folderId === undefined ? {} : { folderId }), title: args.title, body: args.body }], true)) as { title: string; path: string[] };

                return `Saved ${page.title} (${where(scope, page.path)}).`;
            },
        ),
        tool("doc_edit", "Change a document page with exact replacements: each oldText must be on it once.", Type.Object({ page: PAGE, edits: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() })), place: PLACE }), async (args: { page: string; edits: { oldText: string; newText: string }[]; place?: string }, api) => {
            const scope = placeOf(args.place, api.conversationId);

            await docs.call(scope, "edit", [(await found(scope, args.page)).id, args.edits], true);

            return `Edited ${args.page} (${where(scope)}).`;
        }),
        tool("doc_move", "Move a document page to a folder (a/b, made if missing; empty: the top).", Type.Object({ page: PAGE, folder: Type.String(), place: PLACE }), async (args: { page: string; folder: string; place?: string }, api) => {
            const scope = placeOf(args.place, api.conversationId);
            const moved = (await docs.call(scope, "move", [(await found(scope, args.page)).id, await folderOf(scope, args.folder)], true)) as { title: string; path: string[] };

            return `Moved ${moved.title} to ${where(scope, moved.path)}.`;
        }),
        tool("doc_delete", "Delete a document page (asks the person first). It can be brought back (doc_restore).", Type.Object({ page: PAGE, reason: Type.String(), place: PLACE }), async (args: { page: string; reason: string; place?: string }, api, context) => {
            const scope = placeOf(args.place, api.conversationId);
            const page = await found(scope, args.page);

            await ask(api, context, "doc_delete", `Delete the document ${page.title} (${where(scope)})`, args.reason);
            await docs.call(scope, "remove", [page.id], true);

            return `Deleted ${page.title}; it can be brought back.`;
        }),
        tool(
            "doc_restore",
            "Bring back a version of a document page, or a deleted page (asks the person first): saved as its newest version. doc_history lists versions; without one, its newest (a deleted page comes back as it was).",
            Type.Object({ page: PAGE, version: Type.Optional(Type.String()), reason: Type.String(), place: PLACE }),
            async (args: { page: string; version?: string; reason: string; place?: string }, api, context) => {
                const scope = placeOf(args.place, api.conversationId);
                const live = await pageOf(scope, args.page);
                const gone = live === null ? ((await docs.call(scope, "deleted", [])) as { id: string; title: string }[]).find((each) => each.title.toLowerCase() === args.page.trim().toLowerCase() || each.id === args.page) : undefined;
                const page = live ?? gone;

                if (page === undefined || page === null) {
                    throw new HttpError(404, `There is no page ${args.page} in ${where(scope)}, nor a deleted one.`);
                }

                const version = args.version ?? ((await docs.call(scope, "history", [page.id])) as { id: string }[])[0]!.id;

                await ask(api, context, "doc_restore", `Bring back ${page.title} (${where(scope)})${args.version === undefined ? "" : `, version ${args.version}`}`, args.reason);
                await docs.call(scope, "restore", [page.id, version], true);

                return `${page.title} is back.`;
            },
        ),
        tool(
            "doc_image",
            "Add an image file (PNG, JPEG, WebP or GIF, 10 MB at most) to a place's documents, without its location and camera data. Answers the markdown that shows it: put that in a page with doc_edit or doc_write. It is described for search when the place has an image model.",
            Type.Object({ path: Type.String({ description: "The image file, absolute or relative to this session's folder" }), name: Type.Optional(Type.String({ description: "What to call it; default: the file's name" })), place: PLACE }),
            async (args: { path: string; name?: string; place?: string }, api, context) => {
                const scope = placeOf(args.place, api.conversationId);
                const env = host.envOf((await api.agent(context)).cwd ?? "");
                const absolute = await env.absolutePath(args.path, context as never);
                const bytes = absolute.ok ? await env.readBinaryFile(absolute.value, context as never) : absolute;

                if (!absolute.ok || !bytes.ok) {
                    throw new HttpError(404, `Could not read ${args.path}: ${bytes.ok ? "" : bytes.error.message}`);
                }

                const name = args.name ?? args.path.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, "");
                const image = (await docs.call(scope, "addImage", [{ name, data: Buffer.from(bytes.value).toString("base64") }], true)) as { name: string; mime: string; size: number; markdown: string };

                return `Added ${image.name} to ${where(scope)} (${image.mime}, ${Math.ceil(image.size / 1024)} KB, location and camera data removed). Show it in a page with: ${image.markdown}`;
            },
        ),
    ];

    return defineExtension({
        name: "pocket-docs",
        tools,
        sections: [
            section(
                "docs",
                () =>
                    `Documents: the person's documents in folders, as markdown pages, in places: mine, ${host.teamServer === undefined ? "" : "team (the team's), "}and each board's (its key). Search, read and write them with the doc_* tools when the person asks about or for documents; in board mode the board's are the default. They are people's documents, apart from your wikis (your own knowledge).`,
            ),
        ],
    });
}
