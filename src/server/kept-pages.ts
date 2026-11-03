/**
 * Pages kept from artifacts (PP-370): an artifact a person keeps shows as a page of their own, opened from the rail, in
 * the artifacts' sandbox, following its newest version. Each person's list is theirs, in their order, on all their
 * devices (`KeptPagesDoc`); a page whose artifact they cannot see (a session not shared with them, or one deleted) is
 * not shown to them. Settings › Pages orders and removes them; `artifacts.pages` (the owner's, on by default) turns
 * pages off for everyone, and their lists come back as they were when it is on again.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import { type ArtifactType, ArtifactsDoc, type KeptPage, KeptPagesDoc } from "./docs.ts";
import { HttpError } from "./errors.ts";

/** The most pages one person keeps: each is a button on their rail. */
export const MAX_KEPT_PAGES = 24;

/** A kept page as a person's devices get it: where its artifact is, and what it is now. */
export type KeptPageView = KeptPage & {
    title: string;
    type: ArtifactType;
    /** Its artifact's newest version: the page shows it, and loads again when a newer one comes. */
    version: number;
    /** The title of the session the artifact is in. */
    session: string;
};

export type KeptPagesView = { on: boolean; pages: KeptPageView[] };

const same = (a: KeptPage, b: KeptPage) => a.conversation === b.conversation && a.artifact === b.artifact;

export class KeptPages {
    readonly #app: PocketApp;

    constructor(app: PocketApp) {
        this.#app = app;
    }

    /** This person's pages they can see now, in their order; none while pages are off. */
    async list(user: User): Promise<KeptPagesView> {
        if (!this.#app.config.artifactPages) {
            return { on: false, pages: [] };
        }

        const doc = await this.#app.harness.snapshot(KeptPagesDoc, BACKGROUND_CONTEXT);
        const pages: KeptPageView[] = [];

        for (const page of doc?.users[user.id] ?? []) {
            const shown = await this.#view(user, page);

            if (shown !== undefined) {
                pages.push(shown);
            }
        }

        return { on: true, pages };
    }

    /** Keep an artifact as a page, at the end of the rail, or take one off it. Explicit, not a toggle. */
    async set(user: User, request: { conversation?: unknown; artifact?: unknown; kept?: unknown }): Promise<KeptPagesView> {
        const page = this.#page(request);

        if (typeof request.kept !== "boolean") {
            throw new HttpError(400, "Say whether the page is kept: kept is true or false.");
        }

        if (request.kept) {
            if (!this.#app.config.artifactPages) {
                throw new HttpError(409, "Pages are off: the owner turns them on in Settings › Pages.");
            }

            if ((await this.#view(user, page)) === undefined) {
                throw new HttpError(404, `There is no artifact ${page.artifact} in session ${page.conversation} that you can see.`);
            }
        }

        await this.#app.harness.commit(async (tx) => {
            const doc = await tx.doc(KeptPagesDoc);
            const pages = [...(doc.users[user.id] ?? [])];

            if (request.kept) {
                if (pages.some((each) => same(each, page))) {
                    return;
                }

                if (pages.length >= MAX_KEPT_PAGES) {
                    throw new HttpError(409, `You can keep up to ${MAX_KEPT_PAGES} pages: remove one in Settings › Pages first.`);
                }

                doc.users[user.id] = [...pages, page];
            } else if (pages.some((each) => same(each, page))) {
                doc.users[user.id] = pages.filter((each) => !same(each, page));
            }
        }, BACKGROUND_CONTEXT);

        return this.list(user);
    }

    /**
     * Put this person's pages in a new order: `pages` names every page they keep, each once. Pages they cannot see now
     * keep their places after the ones named.
     */
    async order(user: User, request: { pages?: unknown }): Promise<KeptPagesView> {
        if (!Array.isArray(request.pages) || request.pages.length > MAX_KEPT_PAGES) {
            throw new HttpError(400, "Give the pages in their new order: a list of each one's session and artifact.");
        }

        const wanted = request.pages.map((each) => this.#page((each ?? {}) as Record<string, unknown>));

        await this.#app.harness.commit(async (tx) => {
            const doc = await tx.doc(KeptPagesDoc);
            const pages = doc.users[user.id] ?? [];

            if (wanted.some((page, index) => !pages.some((each) => same(each, page)) || wanted.findIndex((each) => same(each, page)) !== index)) {
                throw new HttpError(409, "Name each page you keep once, and only those: the list changed, so open it again.");
            }

            doc.users[user.id] = [...wanted, ...pages.filter((each) => !wanted.some((page) => same(page, each)))];
        }, BACKGROUND_CONTEXT);

        return this.list(user);
    }

    /** Pages on or off for everyone (`artifacts.pages`, Settings › Pages). The owner's. */
    setOn(user: User, on: unknown): void {
        if (user.role !== "owner") {
            throw new HttpError(403, "Only the owner can do that");
        }

        if (typeof on !== "boolean") {
            throw new HttpError(400, "Pages are on (true) or off (false).");
        }

        this.#app.config.artifactPages = on;
        this.#sendAll();
    }

    /** Only committed lists reach browsers, and only each person's own. */
    committed(): void {
        this.#sendAll();
    }

    /** A conversation's artifacts changed (a new one, a new version, a new title): those who keep one of them hear. */
    async artifactsChanged(conversation: ConversationId): Promise<void> {
        const doc = await this.#app.harness.snapshot(KeptPagesDoc, BACKGROUND_CONTEXT);
        const keeping = new Set(
            Object.entries(doc?.users ?? {})
                .filter(([, pages]) => pages.some((page) => page.conversation === Number(conversation)))
                .map(([id]) => id),
        );

        if (keeping.size > 0) {
            this.#send((user) => keeping.has(user.id));
        }
    }

    #sendAll(): void {
        this.#send(() => true);
    }

    /** Each person's list, worked out once, to each of their tabs `to` picks. */
    #send(to: (user: User) => boolean): void {
        const lists = new Map<string, Promise<KeptPagesView>>();

        for (const client of this.#app.clients) {
            if (!to(client.user)) {
                continue;
            }

            let list = lists.get(client.user.id);

            if (list === undefined) {
                list = this.list(client.user);
                lists.set(client.user.id, list);
            }

            list.then(
                (view) => client.send("kept-pages", view),
                (error: unknown) => this.#app.log(`kept pages not sent: ${error instanceof Error ? error.message : String(error)}`),
            );
        }
    }

    /** A page as a request names it. */
    #page(request: { conversation?: unknown; artifact?: unknown }): KeptPage {
        const conversation = Number(request.conversation);

        if (!Number.isInteger(conversation) || conversation <= 0 || typeof request.artifact !== "string" || !/^[a-z0-9-]{1,64}$/.test(request.artifact)) {
            throw new HttpError(400, "A page is an artifact: its session's number (conversation) and its id (artifact).");
        }

        return { conversation, artifact: request.artifact };
    }

    /** The page as this person sees it, or undefined when its session is gone, not theirs to see, or has no such artifact. */
    async #view(user: User, page: KeptPage): Promise<KeptPageView | undefined> {
        const app = this.#app;
        const id = page.conversation as unknown as ConversationId;
        const session = app.sessionMeta(app.rootOf(id));

        if (session === undefined || !app.canSee(user, id)) {
            return undefined;
        }

        const index = await app.harness.snapshot(ArtifactsDoc, id, BACKGROUND_CONTEXT);
        const meta = index !== undefined && Object.hasOwn(index.items, page.artifact) ? index.items[page.artifact] : undefined;
        const version = meta?.versions.at(-1)?.version;

        if (meta === undefined || version === undefined) {
            return undefined;
        }

        return { ...page, title: meta.title, type: meta.type, version, session: session.title ?? "New session" };
    }
}
