/**
 * Pi's browser per session (PP-13; the owner, 2026-10-20: "pi browser session are not stick with chat session"). Each
 * place (the phone, or a machine) has one browser engine, with one profile, so a sign-in there serves every session on
 * it. Each session sees only its own tabs there, through a `SessionEngine`: a view of the place's engine that lists,
 * makes, and closes the tabs it owns. Who owns which tab is kept in a file (`TabOwners`), so tabs keep their session
 * across a server restart. A tab nobody owns (one a page opened, or one from before) goes to the first session that
 * looks: that is the session whose page just opened it, since Pi reads the page right after each action.
 */
import { readFileSync, writeFileSync } from "node:fs";
import type { Cdp } from "./cdp.ts";
import type { BrowserPage } from "./page.ts";
import type { BrowserEngine, BrowserSize } from "./pi-browser.ts";

/** Which session owns each tab, by place and tab id, kept in a JSON file. */
export class TabOwners {
    readonly #file: string | undefined;
    #owners: Record<string, Record<string, number>>;

    /** `file`: where to keep them, or undefined to keep them in memory only (tests). */
    constructor(file: string | undefined) {
        this.#file = file;
        this.#owners = {};

        if (file !== undefined) {
            try {
                const kept = JSON.parse(readFileSync(file, "utf8")) as unknown;

                if (kept !== null && typeof kept === "object") {
                    this.#owners = kept as Record<string, Record<string, number>>;
                }
            } catch {
                // None kept yet.
            }
        }
    }

    owner(place: string, tab: string): number | undefined {
        return this.#owners[place]?.[tab];
    }

    set(place: string, tab: string, session: number | undefined): void {
        const owners = { ...this.#owners[place] };

        if (session === undefined) {
            delete owners[tab];
        } else {
            owners[tab] = session;
        }

        this.#owners = { ...this.#owners, [place]: owners };
        this.#save();
    }

    /** Forget tabs the engine no longer has. */
    keepOnly(place: string, tabs: readonly string[]): void {
        const owners = this.#owners[place] ?? {};
        const gone = Object.keys(owners).filter((tab) => !tabs.includes(tab));

        if (gone.length > 0) {
            this.#owners = { ...this.#owners, [place]: Object.fromEntries(Object.entries(owners).filter(([tab]) => tabs.includes(tab))) };
            this.#save();
        }
    }

    #save(): void {
        if (this.#file !== undefined) {
            writeFileSync(this.#file, JSON.stringify(this.#owners));
        }
    }
}

/** The size each session's browser lays pages out at (PP-18), by `<place>#<session>`, kept in a JSON file. */
export class BrowserSizes {
    readonly #file: string | undefined;
    #sizes: Record<string, BrowserSize>;

    /** `file`: where to keep them, or undefined to keep them in memory only (tests). */
    constructor(file: string | undefined) {
        this.#file = file;
        this.#sizes = {};

        if (file !== undefined) {
            try {
                const kept = JSON.parse(readFileSync(file, "utf8")) as unknown;

                if (kept !== null && typeof kept === "object") {
                    this.#sizes = Object.fromEntries(Object.entries(kept).filter(([, size]) => size === "phone" || size === "desktop")) as Record<string, BrowserSize>;
                }
            } catch {
                // None kept yet.
            }
        }
    }

    /** A session's size at a place: Phone unless it picked Desktop. */
    of(key: string): BrowserSize {
        return this.#sizes[key] ?? "phone";
    }

    /** Keep a size (Phone, the default, is not written down), or forget a session's (`undefined`). */
    set(key: string, size: BrowserSize | undefined): void {
        const sizes = { ...this.#sizes };

        if (size === undefined || size === "phone") {
            delete sizes[key];
        } else {
            sizes[key] = size;
        }

        if (JSON.stringify(sizes) !== JSON.stringify(this.#sizes)) {
            this.#sizes = sizes;

            if (this.#file !== undefined) {
                writeFileSync(this.#file, JSON.stringify(sizes));
            }
        }
    }
}

/** One session's view of a place's engine: its own tabs only. Closing it closes those, never the engine. */
export class SessionEngine implements BrowserEngine {
    readonly #engine: BrowserEngine;
    readonly #place: string;
    readonly #session: number;
    readonly #owners: TabOwners;

    constructor(engine: BrowserEngine, place: string, session: number, owners: TabOwners) {
        this.#engine = engine;
        this.#place = place;
        this.#session = session;
        this.#owners = owners;
    }

    get label(): string {
        return this.#engine.label;
    }

    get popups(): boolean {
        return this.#engine.popups;
    }

    get local(): boolean {
        return this.#engine.local;
    }

    get actAsPhone(): boolean {
        return this.#engine.actAsPhone;
    }

    get reopensToResize(): boolean {
        return this.#engine.reopensToResize;
    }

    /** This session's tabs, oldest first: its own, and any nobody owns (taken now). */
    async tabs(): Promise<string[]> {
        const all = await this.#engine.tabs();

        this.#owners.keepOnly(this.#place, all);

        return all.filter((tab) => {
            const owner = this.#owners.owner(this.#place, tab);

            if (owner === undefined) {
                this.#owners.set(this.#place, tab, this.#session);

                return true;
            }

            return owner === this.#session;
        });
    }

    async newTab(size?: { width: number; height: number }): Promise<string> {
        const tab = await this.#engine.newTab(size);

        this.#owners.set(this.#place, tab, this.#session);

        return tab;
    }

    connect(id: string): Promise<Cdp> {
        return this.#engine.connect(id);
    }

    async closeTab(id: string): Promise<void> {
        await this.#engine.closeTab(id);
        this.#owners.set(this.#place, id, undefined);
    }

    /** Close this session's tabs; the engine, and other sessions' tabs, stay. */
    async close(): Promise<void> {
        for (const tab of await this.tabs()) {
            await this.closeTab(tab);
        }
    }

    pdf(id: string, page: BrowserPage): Promise<Buffer> {
        return this.#engine.pdf(id, page);
    }

    picture(id: string, page: BrowserPage, quality: number, timeoutMs?: number): Promise<string> {
        return this.#engine.picture(id, page, quality, timeoutMs);
    }

    stage(name: string, bytes: Uint8Array): Promise<string> {
        return this.#engine.stage(name, bytes);
    }
}
