/**
 * The PARA wiki (DESIGN.md section 4): pi-para's own code (https://github.com/picassio/pi-para) on pi-phone's runtime.
 * The wiki is pi-para's, as it is: its folder (`~/.pi/wiki` by default), its config (`~/.pi/para/config.jsonc`), its
 * qmd index and scheduler; pi on a computer with pi-para reads and writes the same files. What differs is the host:
 * here the tools are Pi Durable's (`extensions/para.ts`), the context goes in each session's prompt as a section, and
 * a session's scope comes from its folder, here or on its machine.
 *
 * Started on first use (the module's load), in the background: until the store is open, the tools wait for it. A store
 * that fails to open fails the tools, with why; nothing is silently skipped.
 *
 * pi-para and qmd-engine are imported when the wiki opens, not with the app: they load their SQLite driver with a
 * top-level await, which in the app's module graph (whose modules import each other) would let `app.ts` be read before
 * it finished loading.
 */
import "./para-env.ts";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { LoadedParaConfig } from "pi-para/config";
import type { WikiScheduler } from "pi-para/scheduler";
import type { ProjectScope } from "pi-para/scope";
import type { QMDStore } from "pi-para/store";

/** pi-para's modules, loaded when the wiki opens. */
const load = async () => {
    const [config, context, scheduler, scope, store, wiki, frontmatter, links, query, write, questions] = await Promise.all([
        import("pi-para/config"),
        import("pi-para/context"),
        import("pi-para/scheduler"),
        import("pi-para/scope"),
        import("pi-para/store"),
        import("pi-para/wiki"),
        import("pi-para/frontmatter"),
        import("pi-para/link-utils"),
        import("pi-para/query"),
        import("pi-para/tools/write"),
        import("pi-para/questions"),
    ]);

    return { ...config, ...context, ...scheduler, ...scope, ...store, ...wiki, ...frontmatter, ...links, ...query, ...write, ...questions };
};

/** The wiki's settings as the Wiki settings sheet shows and changes them: pi-para's config, which people never edit. */
export type WikiSettings = {
    wikiDir: string;
    /** "auto" (the app's default model) or provider/modelId. */
    captureModel: string;
    contextTokens: number;
    contextSchema: boolean;
    /** The OpenRouter embedding model qmd's vector search uses, or null: keyword search only. */
    embeddingModel: string | null;
    lintAutoFix: boolean;
    lintStaleDays: number;
    /** Days an open question may stay open before wiki_lint warns about it. */
    lintQuestionDays: number;
};

/** OpenRouter's embedding models, as its API lists them. */
export type EmbeddingModel = { id: string; name: string; pricePerMillion: number; context: number };

const EMBEDDING_MODELS_URL = "https://openrouter.ai/api/v1/embeddings/models";
/** How long OpenRouter's list is kept before it is asked again. */
const EMBEDDING_MODELS_MS = 60 * 60_000;

/** A page as the Wiki page lists it. */
export type PageSummary = { path: string; category: string; slug: string; title: string; updated: string; scope: string[]; tags: string[] };

const PATH = /^(projects|areas|resources|archives)\/([a-z0-9][a-z0-9-]*)$/;

type ParaModules = Awaited<ReturnType<typeof load>>;

/** How long a session's scope is taken as known before its folder is looked at again. */
const SCOPE_MS = 5 * 60_000;
/**
 * The least search score of a page that comes with a person's message (`relevant`). pi-para's scores are BM25 mapped to
 * 0..1 (lexical ×0.85) or cosine similarity: on the owner's wiki, pages about a query scored 0.6–0.85 and unrelated
 * ones 0.24–0.46 (wiki_query, 2026-10-31).
 */
const WIKI_MATCH = 0.5;

/** What the wiki needs of the app. */
export interface ParaHost {
    readonly home: string;
    /** A provider's API key from the app's sign-ins, for `pi-auth:<provider>` credential references. */
    apiKey(provider: string): Promise<string | undefined>;
    /** The models signed in now, for the capture model's picker. */
    models(): { provider: string; id: string; name: string }[];
    /** A session folder on a machine: its path there and its environment; undefined for one on the phone. */
    remote(cwd: string): { path: string; env: ExecutionEnv } | undefined;
    /** A remote embedding request for the wiki's search (indexing, or a query): its model, tokens, and cost in dollars. */
    spent(usage: { model: string; tokens: number; cost: number }): void;
    log(message: string): void;
}

export class Para {
    readonly #host: ParaHost;
    #ready: Promise<void> | undefined;
    #pi: ParaModules | undefined;
    #config: LoadedParaConfig | undefined;
    #store: QMDStore | undefined;
    #scheduler: WikiScheduler | undefined;
    readonly #scopes = new Map<string, { scope: Promise<ProjectScope>; at: number }>();
    /** The prompt context of each scope, until the wiki changes. */
    readonly #contexts = new Map<string, Promise<string>>();
    #embeddingModels: { at: number; list: Promise<EmbeddingModel[]> } | undefined;
    /** Stops hearing what embedding requests cost; set once, the first time the wiki opens. */
    #stopUsage: (() => void) | undefined;
    /** The wiki's tool calls and page saves, one at a time (`exclusive`). */
    #turn: Promise<unknown> = Promise.resolve();

    constructor(host: ParaHost) {
        this.#host = host;
    }

    /**
     * Run `work` when no other wiki tool call or page save runs, in the order asked. pi-para writes a page in place
     * (`writeFile`, not a rename), and its tools read a page before they write it: a wiki_write next to a wiki_edit of
     * the same page read it while the edit had emptied it, took it for a new page, and wrote the new section alone over
     * the whole page, "Untitled" (2026-10-25, a capture of #71257). Every session's Pi and the Wiki page share this.
     */
    exclusive<T>(work: () => Promise<T>): Promise<T> {
        const next = this.#turn.then(work, work);

        this.#turn = next.catch(() => undefined);

        return next;
    }

    /** Open the wiki (once): its config, its folder, its index, and its scheduler. */
    ready(): Promise<void> {
        this.#ready ??= this.#open();

        return this.#ready;
    }

    async #open(): Promise<void> {
        const pi = await load();
        const { loadParaConfig, initWiki, openStore, startWikiScheduler } = pi;

        this.#pi = pi;
        // What search by meaning costs: every embedding request qmd sends, indexing and queries, goes to Spend.
        this.#stopUsage ??= pi.onApiUsage((usage) => {
            void this.#spent(usage).catch((error: unknown) => this.#host.log(`wiki embedding not counted: ${error instanceof Error ? error.message : String(error)}`));
        });
        const config = await loadParaConfig({ homeDir: this.#host.home, migrate: true });

        this.#config = config;
        await initWiki(config.paths.wikiDir);
        this.#store = await openStore(config.paths.wikiDir, {
            paraConfig: config.config,
            secretsPath: config.paths.secretsPath,
            authStorage: { getApiKey: (provider) => this.#host.apiKey(provider) },
            backgroundEmbed: false,
        });

        if (config.config.scheduler.enabled) {
            this.#scheduler = startWikiScheduler({
                wikiDir: config.paths.wikiDir,
                enabled: true,
                intervalMs: config.config.scheduler.intervalMinutes * 60_000,
                storeProvider: () => this.#store ?? null,
                markDirty: () => this.markDirty(),
                handlers: {},
                embedEnabled: config.config.qmd.embedEnabled && config.config.qmd.embedding !== undefined,
            });
        }
    }

    /** The open wiki, for the tools: its folder, config, and store. Rejects with why it could not open. */
    async open(): Promise<{ wikiDir: string; config: LoadedParaConfig["config"]; store: QMDStore }> {
        await this.ready();

        return { wikiDir: this.#config!.paths.wikiDir, config: this.#config!.config, store: this.#store! };
    }

    /** The wiki's folder, once it is open. */
    wikiDirNow(): string {
        if (this.#config === undefined) {
            throw new Error("The wiki is not open yet.");
        }

        return this.#config.paths.wikiDir;
    }

    /** The wiki changed: every scope's context is built again on its next use. */
    markDirty(): void {
        this.#contexts.clear();
    }

    /**
     * A session's project: as pi-para finds it in a folder here (`.pi/wiki-scope.json`, the git remote, the git root,
     * or the folder's name), and on a machine the same, asked there.
     */
    async scope(cwd: string): Promise<ProjectScope> {
        await this.ready();
        const { detectScope, extractRepoName } = this.#pi!;
        const known = this.#scopes.get(cwd);

        if (known !== undefined && Date.now() - known.at < SCOPE_MS) {
            return known.scope;
        }

        const remote = this.#host.remote(cwd);
        const scope = remote === undefined ? detectScope(cwd) : remoteScope(remote.path, remote.env, extractRepoName);

        this.#scopes.set(cwd, { scope, at: Date.now() });
        scope.catch(() => this.#scopes.delete(cwd));

        return scope;
    }

    /** The wiki's context for a session's prompt: pi-para's, for its scope, within the config's budget. */
    async context(cwd: string): Promise<string> {
        const { wikiDir, config, store } = await this.open();
        const scope = await this.scope(cwd);
        const key = JSON.stringify([scope.name, scope.include, scope.exclude]);
        let built = this.#contexts.get(key);

        if (built === undefined) {
            built = this.#pi!.buildContext(wikiDir, store, scope, {
                maxTokens: config.context.maxTokens,
                includeSchema: config.context.includeSchema,
                includeIndex: config.context.includeIndex,
            });
            this.#contexts.set(key, built);
            built.catch(() => this.#contexts.get(key) === built && this.#contexts.delete(key));
        }

        return built;
    }

    // ─── For the Wiki page (`extensions/para.ts`'s routes) ───────────────────────

    /** Every page, by category, newest first, with what the list shows of it. */
    async tree(): Promise<{ wikiDir: string; categories: Record<string, PageSummary[]> }> {
        const { wikiDir } = await this.open();
        const { PARA_CATEGORIES, listPages, readPage } = this.#pi!;
        const categories: Record<string, PageSummary[]> = {};

        for (const category of PARA_CATEGORIES) {
            const pages: PageSummary[] = [];

            for (const ref of await listPages(wikiDir, category)) {
                const page = await readPage(wikiDir, ref.category, ref.slug);

                if (page !== null) {
                    pages.push(summaryOf(page));
                }
            }

            categories[category] = pages.sort((a, b) => b.updated.localeCompare(a.updated));
        }

        return { wikiDir, categories };
    }

    /** One page: its frontmatter, body, the file as it is, how fresh it is, and the pages that link to it. */
    async page(path: string) {
        const { wikiDir } = await this.open();
        const { readPage, listPages, extractWikilinks, serializeFrontmatter, formatFreshness } = this.#pi!;
        const [, category, slug] = PATH.exec(path) ?? [];

        if (category === undefined || slug === undefined) {
            throw new Error(`${path} is not a wiki page's path (category/slug).`);
        }

        const page = await readPage(wikiDir, category as never, slug);

        if (page === null) {
            return null;
        }

        const backlinks: PageSummary[] = [];

        for (const ref of await listPages(wikiDir)) {
            if (ref.slug === slug) {
                continue;
            }

            const other = await readPage(wikiDir, ref.category, ref.slug);

            if (other !== null && (extractWikilinks(other.body).includes(slug) || other.frontmatter.links.includes(slug))) {
                backlinks.push(summaryOf(other));
            }
        }

        return {
            ...summaryOf(page),
            body: page.body,
            raw: serializeFrontmatter(page.frontmatter, page.body),
            freshness: formatFreshness(page.frontmatter.updated, Date.now()),
            backlinks,
        };
    }

    /**
     * Pages for words by keyword alone (qmd's BM25, on the phone, in milliseconds): what the Wiki page shows at once,
     * before `search` adds what only meaning finds, which waits for the remote embedding of the query.
     */
    async searchKeywords(query: string): Promise<{ path: string; title: string; snippet: string; score: number }[]> {
        const { store } = await this.open();
        const { parseFrontmatter } = this.#pi!;
        const found = await store.searchLex(query, { limit: 30, collection: "wiki", graphBoost: true });

        return found.flatMap((each) => {
            const page = /(projects|areas|resources|archives)\/([^/]+)\.md$/.exec(each.displayPath);

            if (page === null) {
                return [];
            }

            const { frontmatter, body } = parseFrontmatter(each.body ?? "");
            const words = query.toLowerCase().split(/\s+/).filter((word) => word.length > 1);
            const lines = body.split("\n").filter((line) => line.trim() !== "" && !line.startsWith("#"));
            const hit = lines.find((line) => words.some((word) => line.toLowerCase().includes(word))) ?? lines[0] ?? "";

            return [{ path: `${page[1]}/${page[2]}`, title: frontmatter.title || page[2]!, snippet: hit.trim().slice(0, 240), score: each.score }];
        });
    }

    /** Pages for words: qmd's search across every scope, archives too. */
    async search(query: string): Promise<{ path: string; title: string; snippet: string; score: number }[]> {
        const { store } = await this.open();
        const found = await this.#pi!.searchWiki(store, query, { limit: 30, includeArchives: true, graphBoost: true });

        return found.map((each) => ({
            path: each.page.path.replace(/\.md$/, ""),
            title: each.frontmatter.title || each.page.title,
            snippet: each.snippet,
            score: each.score,
        }));
    }

    /**
     * The pages that match a person's message (PP-276, the wiki `relevant`): pi-para's search (keywords, and meaning when
     * the wiki has embeddings) in the session's scope, only matches scoring at least `WIKI_MATCH` and near the best one,
     * at most four; each with a line of it, how fresh it is, and its open questions.
     */
    async relevant(
        message: string,
        cwd: string,
    ): Promise<{ path: string; title: string; line: string; freshness: string; questions: string[] }[]> {
        const { store, wikiDir } = await this.open();
        const { readPage, formatFreshness } = this.#pi!;
        const scope = await this.scope(cwd);
        // The whole message: by meaning when the wiki has embeddings, and by keyword when every word is on a page.
        const found = await this.#pi!.searchWiki(store, message.replace(/\s+/g, " ").slice(0, 400), { limit: 8, graphBoost: true, scope });
        const best = found[0]?.score ?? 0;
        const chosen = new Map<string, string>(
            found.filter((each) => each.score >= WIKI_MATCH && each.score >= best * 0.7).map((each) => [`${each.page.category}/${each.page.slug}`, each.snippet]),
        );
        // A message's words are rarely all on one page (qmd's keyword search wants every word): its telling words
        // each, and the pages that have at least two of them (or the one, when it has one).
        const words = tellingWords(message);
        const hits = new Map<string, { count: number; score: number; snippet: string }>();

        for (const word of words) {
            // Pages that have the word, without the pages they link to (graphBoost): those have not.
            for (const hit of await store.searchLex(word, { limit: 10, collection: "wiki", graphBoost: false })) {
                const page = /(projects|areas|resources)\/([^/]+)\.md$/.exec(hit.displayPath);

                if (page === null) {
                    continue;
                }

                const path = `${page[1]}/${page[2]}`;
                const known = hits.get(path) ?? { count: 0, score: 0, snippet: "" };

                hits.set(path, { count: known.count + 1, score: known.score + hit.score, snippet: known.snippet });
            }
        }

        for (const [path, hit] of [...hits].sort((a, b) => b[1].count - a[1].count || b[1].score - a[1].score)) {
            if (hit.count >= Math.min(2, words.length) && !chosen.has(path)) {
                chosen.set(path, hit.snippet);
            }
        }

        const pages = [];

        for (const [path, snippet] of [...chosen].slice(0, 4)) {
            const [category, slug] = path.split("/") as [string, string];
            const each = { page: { category, slug, title: slug }, snippet };
            const page = await readPage(wikiDir, each.page.category as never, each.page.slug);

            if (page === null) {
                continue;
            }

            const open = /## Open Questions\n([\s\S]*?)(?:\n## |$)/.exec(page.body)?.[1] ?? "";
            const first = page.body.split("\n").find((line) => line.trim() !== "" && !line.startsWith("#")) ?? each.snippet;

            pages.push({
                path: `${each.page.category}/${each.page.slug}`,
                title: page.frontmatter.title || each.page.title,
                line: first.replace(/\s+/g, " ").trim().slice(0, 200),
                freshness: formatFreshness(page.frontmatter.updated, Date.now()),
                questions: open.split("\n").filter((line) => line.startsWith("- [ ]")).slice(0, 3),
            });
        }

        return pages;
    }

    /** How many changes the wiki's log (log.md) holds: a mark for `changedSince`. */
    async logMark(): Promise<number> {
        return (await this.#logEntries()).length;
    }

    /** The pages the log names in its changes after `mark` (`logMark`), most recent first, each once. */
    async changedSince(mark: number): Promise<string[]> {
        const entries = (await this.#logEntries()).slice(mark);
        const pages = entries.flatMap((entry) => /^Pages: (.*)$/m.exec(entry)?.[1]?.split(/,\s*/) ?? []);

        return [...new Set(pages.map((page) => page.trim()).filter((page) => page !== "").reverse())];
    }

    async #logEntries(): Promise<string[]> {
        const { wikiDir } = await this.open();
        const log = await readFile(`${wikiDir}/log.md`, "utf8").catch(() => "");

        return log.split(/^## /m).slice(1);
    }

    /**
     * A page written from the Wiki page's editor: its whole file (frontmatter and body), through pi-para's own
     * wiki_write, so it gets the same checks, links, index, log, and search update as Pi's writes. `create` refuses a
     * page that is there; otherwise it replaces it.
     */
    save(path: string, raw: string, create: boolean): Promise<string> {
        return this.exclusive(() => this.#save(path, raw, create));
    }

    async #save(path: string, raw: string, create: boolean): Promise<string> {
        const { wikiDir, store } = await this.open();
        const { parseFrontmatter, validateFrontmatter, createWriteExecute } = this.#pi!;
        const [, category, slug] = PATH.exec(path) ?? [];

        if (category === undefined || slug === undefined) {
            throw new Error(`${path} is not a wiki page's path (category/slug: lowercase letters, digits, and dashes).`);
        }

        const parsed = parseFrontmatter(raw);
        const frontmatter = validateFrontmatter({ ...parsed.frontmatter, para: category });
        const scope = { name: frontmatter.scope[0] ?? "global", include: frontmatter.scope, exclude: [], source: "config" as const };
        const result = await createWriteExecute(wikiDir, store, () => scope, () => this.markDirty())({
            pages: [
                {
                    category: category as never,
                    slug,
                    title: frontmatter.title,
                    scope: frontmatter.scope,
                    tags: frontmatter.tags,
                    body: parsed.body,
                    mode: create ? "create" : "replace",
                },
            ],
            logSummary: `${create ? "created" : "edited"} ${path} in pi-phone`,
        } as never);
        const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");

        if ((result.details as { pagesSkipped?: unknown[] } | undefined)?.pagesSkipped?.length) {
            throw new Error(text);
        }

        return text;
    }

    /** What the Wiki page says of the wiki: where it is, its pages, the end of its log, and its search. */
    async status() {
        const { wikiDir, config, store } = await this.open();
        const { listPages } = this.#pi!;
        const log = await readFile(`${wikiDir}/log.md`, "utf8").catch(() => "");
        const qmd = await store.getStatus();

        return {
            wikiDir,
            pages: (await listPages(wikiDir)).length,
            log: log.split("\n").filter((line) => line.startsWith("## ")).slice(-8).reverse().map((line) => line.slice(3)),
            search: { documents: qmd.totalDocuments, vectors: qmd.hasVectorIndex, needsEmbedding: qmd.needsEmbedding },
            embedding: config.qmd.embedEnabled && config.qmd.embedding !== undefined ? `${config.qmd.embedding.provider}/${config.qmd.embedding.model ?? ""}` : null,
        };
    }

    // ─── Settings (the Wiki settings sheet) ─────────────────────────────────────

    async settings(): Promise<WikiSettings> {
        const { wikiDir, config } = await this.open();
        const capture = config.models.capture;
        const embedding = config.qmd.embedding;

        return {
            wikiDir,
            captureModel: capture === "auto" ? "auto" : `${capture.provider}/${capture.model ?? ""}`,
            contextTokens: config.context.maxTokens,
            contextSchema: config.context.includeSchema,
            embeddingModel:
                config.qmd.embedEnabled && embedding?.provider === "openrouter" && embedding.model ? embedding.model : null,
            lintAutoFix: config.lint.autoFix,
            lintStaleDays: config.lint.staleDays,
            lintQuestionDays: config.lint.questionDays,
        };
    }

    /**
     * The wiki's open questions (pi-para's `questions.ts`), oldest first, as Markdown lines: for a capture, which may
     * answer any of them. Empty when there are none.
     */
    async openQuestionsText(max: number): Promise<string> {
        const { wikiDir } = await this.open();
        const { collectOpenQuestions, formatOpenQuestions } = this.#pi!;
        const open = await collectOpenQuestions(wikiDir);

        return open.length === 0 ? "" : formatOpenQuestions(open, { max });
    }

    /**
     * Change settings: pi-para's config file, written by the app (`saveParaConfig`), the rest of it as it was. A change
     * of embedding model reopens the wiki's search, so qmd embeds with the new one.
     */
    async updateSettings(patch: Partial<Omit<WikiSettings, "wikiDir">>): Promise<WikiSettings> {
        await this.ready();
        const { loadParaConfig, saveParaConfig } = this.#pi!;
        const loaded = await loadParaConfig({ homeDir: this.#host.home, migrate: true });
        const config = loaded.config;

        for (const [key, type] of [["captureModel", "string"], ["contextTokens", "number"], ["contextSchema", "boolean"], ["lintAutoFix", "boolean"], ["lintStaleDays", "number"], ["lintQuestionDays", "number"]] as const) {
            if (patch[key] !== undefined && typeof patch[key] !== type) {
                throw new Error(`${key} is a ${type}.`);
            }
        }

        if (patch.embeddingModel !== undefined && patch.embeddingModel !== null && typeof patch.embeddingModel !== "string") {
            throw new Error("embeddingModel is an OpenRouter model's id, or null.");
        }

        if (patch.captureModel !== undefined) {
            if (patch.captureModel === "auto") {
                config.models.capture = "auto";
            } else {
                const slash = patch.captureModel.indexOf("/");
                const provider = patch.captureModel.slice(0, slash);
                const model = patch.captureModel.slice(slash + 1);

                if (slash < 1 || model === "" || !this.#host.models().some((each) => each.provider === provider && each.id === model)) {
                    throw new Error(`${patch.captureModel} is not a signed-in model.`);
                }

                config.models.capture = { provider, model, credentialRef: `pi-auth:${provider}` };
            }
        }

        if (patch.contextTokens !== undefined) {
            if (!Number.isInteger(patch.contextTokens) || patch.contextTokens < 500 || patch.contextTokens > 32_000) {
                throw new Error("The context budget is a whole number of tokens from 500 to 32000.");
            }

            config.context.maxTokens = patch.contextTokens;
        }

        if (patch.contextSchema !== undefined) {
            config.context.includeSchema = patch.contextSchema === true;
        }

        if (patch.lintAutoFix !== undefined) {
            config.lint.autoFix = patch.lintAutoFix === true;
        }

        if (patch.lintStaleDays !== undefined) {
            if (!Number.isInteger(patch.lintStaleDays) || patch.lintStaleDays < 1 || patch.lintStaleDays > 3650) {
                throw new Error("A page is stale after a whole number of days from 1 to 3650.");
            }

            config.lint.staleDays = patch.lintStaleDays;
        }

        if (patch.lintQuestionDays !== undefined) {
            if (!Number.isInteger(patch.lintQuestionDays) || patch.lintQuestionDays < 1 || patch.lintQuestionDays > 365) {
                throw new Error("An open question is stale after a whole number of days from 1 to 365.");
            }

            config.lint.questionDays = patch.lintQuestionDays;
        }

        const searchChanged = patch.embeddingModel !== undefined;

        if (patch.embeddingModel === null) {
            config.qmd.embedEnabled = false;
        } else if (patch.embeddingModel !== undefined) {
            if ((await this.#host.apiKey("openrouter")) === undefined) {
                throw new Error("Sign in to OpenRouter first (Settings > Providers): its embedding models need its key.");
            }

            if (!(await this.embeddingModels()).some((each) => each.id === patch.embeddingModel)) {
                throw new Error(`${patch.embeddingModel} is not one of OpenRouter's embedding models.`);
            }

            config.qmd.embedEnabled = true;
            config.qmd.providerConfig = "pi-para-profiles";
            config.qmd.embedding = { provider: "openrouter", model: patch.embeddingModel, credentialRef: "pi-auth:openrouter" };
        }

        await saveParaConfig(config, { homeDir: this.#host.home });

        if (searchChanged) {
            await this.reopen();
        } else {
            this.#config = { ...this.#config!, config };
        }

        this.markDirty();

        return this.settings();
    }

    /** The models signed in now (the capture model's picker). */
    models(): { provider: string; id: string; name: string }[] {
        return this.#host.models();
    }

    /** Whether a provider's key is signed in here. */
    async hasKey(provider: string): Promise<boolean> {
        return (await this.#host.apiKey(provider)) !== undefined;
    }

    /** Open the wiki again: its config read anew, its search reopened (a new embedding model, a test's provider). */
    async reopen(): Promise<void> {
        await this.close();
        this.#ready = undefined;
        this.markDirty();
    }

    /** Embed what qmd has not embedded yet, now (the scheduler does it in the background after changes). */
    async embed(): Promise<void> {
        const { store } = await this.open();

        await store.embed();
    }

    /** OpenRouter's embedding models, cheapest first; asked again after an hour. A failed ask is not kept. */
    embeddingModels(): Promise<EmbeddingModel[]> {
        if (this.#embeddingModels !== undefined && Date.now() - this.#embeddingModels.at < EMBEDDING_MODELS_MS) {
            return this.#embeddingModels.list;
        }

        const list = (async () => {
            const response = await fetch(EMBEDDING_MODELS_URL, { signal: AbortSignal.timeout(20_000) });

            if (!response.ok) {
                throw new Error(`OpenRouter's list of embedding models answered ${response.status}.`);
            }

            const data = (await response.json()) as {
                data: { id: string; name: string; context_length?: number; pricing?: { prompt?: string } }[];
            };

            return data.data
                .map((each) => ({
                    id: each.id,
                    name: each.name,
                    pricePerMillion: Number(each.pricing?.prompt ?? 0) * 1_000_000,
                    context: each.context_length ?? 0,
                }))
                .sort((a, b) => a.pricePerMillion - b.pricePerMillion || a.name.localeCompare(b.name));
        })();
        const entry = { at: Date.now(), list };

        this.#embeddingModels = entry;
        list.catch(() => this.#embeddingModels === entry && (this.#embeddingModels = undefined));

        return list;
    }

    /** An embedding request's cost: what the provider said, else its tokens at the model's price on OpenRouter's list. */
    /** What search by meaning in documents cost (PP-49): counted as the wiki's embeddings are, in Spend. */
    async chargeEmbedding(usage: { model: string; tokens: number; cost?: number }): Promise<void> {
        await this.#spent({ model: usage.model, promptTokens: usage.tokens, ...(usage.cost === undefined ? {} : { cost: usage.cost }) });
    }

    async #spent(usage: { model: string; promptTokens: number; cost?: number }): Promise<void> {
        const price = usage.cost === undefined ? (await this.embeddingModels()).find((each) => each.id === usage.model)?.pricePerMillion : undefined;

        if (usage.cost === undefined && price === undefined) {
            this.#host.log(`wiki embedding: no price for ${usage.model}; its ${usage.promptTokens} tokens are counted at nothing`);
        }

        this.#host.spent({ model: usage.model, tokens: usage.promptTokens, cost: usage.cost ?? ((price ?? 0) * usage.promptTokens) / 1_000_000 });
    }

    async close(): Promise<void> {
        if (this.#ready === undefined) {
            return;
        }

        await this.#ready.catch(() => {});

        if (this.#scheduler !== undefined) {
            await this.#pi!.stopWikiScheduler(this.#config!.paths.wikiDir);
        }

        if (this.#store !== undefined) {
            await this.#pi!.closeStore(this.#store);
        }
    }
}

function summaryOf(page: { category: string; slug: string; frontmatter: { title: string; updated: string; scope: string[]; tags: string[] } }): PageSummary {
    return {
        path: `${page.category}/${page.slug}`,
        category: page.category,
        slug: page.slug,
        title: page.frontmatter.title || page.slug,
        updated: page.frontmatter.updated,
        scope: page.frontmatter.scope,
        tags: page.frontmatter.tags,
    };
}

/** Words that say nothing of a subject, in English and Vietnamese: left out of `tellingWords`. */
const PLAIN_WORDS = new Set(
    (
        "about after again also anything because been before being both could does doing done each every from have here " +
        "into just like make more most much need next only other over please same should some such than that their them " +
        "then there these they this those through very want what when where which while will with would your yours " +
        "không được những nhưng trong cũng thêm nữa này đang chưa"
    ).split(" "),
);

/**
 * A message's telling words for the wiki's keyword search (`relevant`): longer words and names (a task's key such as
 * PP-276 too), each once, at most six, the longest first.
 */
export function tellingWords(message: string): string[] {
    const words = message
        .toLowerCase()
        .match(/[\p{L}\p{N}][\p{L}\p{N}_-]*[\p{L}\p{N}]/gu) ?? [];

    return [...new Set(words.filter((word) => (word.length >= 4 || /\d/.test(word)) && !PLAIN_WORDS.has(word)))]
        .sort((a, b) => b.length - a.length)
        .slice(0, 6);
}

/** pi-para's scope detection, with each look made on the machine. */
async function remoteScope(
    path: string,
    env: ExecutionEnv,
    extractRepoName: ParaModules["extractRepoName"],
): Promise<ProjectScope> {
    const run = async (args: string[]): Promise<string | undefined> => {
        let output = "";
        const ran = await env.exec(args, {
            cwd: path,
            timeout: 15,
            onOutput: (text, _context, info) => {
                if (info.stream === "stdout") {
                    output += text;
                }
            },
        }, BACKGROUND_CONTEXT);

        return ran.ok && ran.value.exitCode === 0 && output.trim() !== "" ? output.trim() : undefined;
    };
    const configured = await env.readTextFile(`${path}/.pi/wiki-scope.json`, BACKGROUND_CONTEXT);

    if (configured.ok) {
        const parsed = JSON.parse(configured.value) as { name: string; include?: string[]; exclude?: string[] };

        return {
            name: parsed.name,
            include: [...new Set([parsed.name, ...(parsed.include ?? [])])],
            exclude: parsed.exclude ?? [],
            source: "config",
        };
    }

    const remoteUrl = await run(["git", "remote", "get-url", "origin"]);
    const repo = remoteUrl === undefined ? null : extractRepoName(remoteUrl);

    if (repo) {
        return { name: repo, include: [repo], exclude: [], source: "git-remote" };
    }

    const root = await run(["git", "rev-parse", "--show-toplevel"]);
    const name = basename(root ?? path);

    return { name, include: [name], exclude: [], source: root === undefined ? "dirname" : "git-root" };
}
