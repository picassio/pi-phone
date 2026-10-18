/**
 * The PARA wiki (DESIGN.md section 4): pi-para's own code (https://github.com/picassio/pi-para) on pi-phone's runtime.
 * The wiki is pi-para's, as it is: its folder (`~/.pi/wiki` by default), its config (`~/.pi/para/config.jsonc`), its
 * qmd index and scheduler; pi on a computer with pi-para reads and writes the same files. What differs is the host:
 * here the tools are Pi Durable's (`extensions/para.ts`), the context goes in each session's prompt as a section, and
 * a session's scope comes from its folder, here or on its machine.
 *
 * Started on first use (the module's load), in the background: until the store is open, the tools wait for it. A store
 * that fails to open fails the tools, with why; nothing is silently skipped.
 */
import "./para-env.ts";
import { basename } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { type LoadedParaConfig, loadParaConfig } from "pi-para/config";
import { buildContext } from "pi-para/context";
import { startWikiScheduler, stopWikiScheduler, type WikiScheduler } from "pi-para/scheduler";
import { detectScope, extractRepoName, type ProjectScope } from "pi-para/scope";
import { closeStore, openStore, type QMDStore } from "pi-para/store";
import { initWiki } from "pi-para/wiki";

/** How long a session's scope is taken as known before its folder is looked at again. */
const SCOPE_MS = 5 * 60_000;

/** What the wiki needs of the app. */
export interface ParaHost {
    readonly home: string;
    /** A provider's API key from the app's sign-ins, for `pi-auth:<provider>` credential references. */
    apiKey(provider: string): Promise<string | undefined>;
    /** A session folder on a machine: its path there and its environment; undefined for one on the phone. */
    remote(cwd: string): { path: string; env: ExecutionEnv } | undefined;
    log(message: string): void;
}

export class Para {
    readonly #host: ParaHost;
    #ready: Promise<void> | undefined;
    #config: LoadedParaConfig | undefined;
    #store: QMDStore | undefined;
    #scheduler: WikiScheduler | undefined;
    readonly #scopes = new Map<string, { scope: Promise<ProjectScope>; at: number }>();
    /** The prompt context of each scope, until the wiki changes. */
    readonly #contexts = new Map<string, Promise<string>>();

    constructor(host: ParaHost) {
        this.#host = host;
    }

    /** Open the wiki (once): its config, its folder, its index, and its scheduler. */
    ready(): Promise<void> {
        this.#ready ??= this.#open();

        return this.#ready;
    }

    async #open(): Promise<void> {
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

    /** The wiki changed: every scope's context is built again on its next use. */
    markDirty(): void {
        this.#contexts.clear();
    }

    /**
     * A session's project: as pi-para finds it in a folder here (`.pi/wiki-scope.json`, the git remote, the git root,
     * or the folder's name), and on a machine the same, asked there.
     */
    scope(cwd: string): Promise<ProjectScope> {
        const known = this.#scopes.get(cwd);

        if (known !== undefined && Date.now() - known.at < SCOPE_MS) {
            return known.scope;
        }

        const remote = this.#host.remote(cwd);
        const scope = remote === undefined ? detectScope(cwd) : remoteScope(remote.path, remote.env);

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
            built = buildContext(wikiDir, store, scope, {
                maxTokens: config.context.maxTokens,
                includeSchema: config.context.includeSchema,
                includeIndex: config.context.includeIndex,
            });
            this.#contexts.set(key, built);
            built.catch(() => this.#contexts.get(key) === built && this.#contexts.delete(key));
        }

        return built;
    }

    async close(): Promise<void> {
        if (this.#ready === undefined) {
            return;
        }

        await this.#ready.catch(() => {});

        if (this.#scheduler !== undefined) {
            await stopWikiScheduler(this.#config!.paths.wikiDir);
        }

        if (this.#store !== undefined) {
            await closeStore(this.#store);
        }
    }
}

/** pi-para's scope detection, with each look made on the machine. */
async function remoteScope(path: string, env: ExecutionEnv): Promise<ProjectScope> {
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
