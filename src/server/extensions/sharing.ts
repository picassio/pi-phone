/**
 * Sharing chat sessions with teammates on the team server (PP-55). The sharer's pi-phone keeps a scoped account for each
 * teammate at each level: Can write is a `guest` limited to the sessions shared that way, Can watch a `viewer`. After
 * every change it sends the gateway that teammate's whole list at that level, with the account's token, so the gateway
 * can open `/space/<key>/<level>/` as them (PP-56) and list it under Shared with me. Unsharing removes the session from
 * the account, and the account when nothing is left: their open pages end at once.
 *
 * A session on a machine runs every command there, so it is shared only with "Pi may use my machines and secrets for
 * their messages" on for that share. Only on the team server, and only for this pi-phone's own person.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionWeb, PocketHost, WebRequest } from "../host.ts";
import { HttpError } from "../errors.ts";

export type Level = "write" | "watch";
type Account = { teammate: string; name: string; level: Level; userId: string; token: string };
type Share = { level: Level; machines: boolean };
/** What is shared: the accounts, and each session's teammates. */
type State = { accounts: Account[]; sessions: Record<string, Record<string, Share>>; budgets: Record<string, number> };

export function sharingState(host: PocketHost) {
    const file = join(host.dataDir, "shares.json");
    const load = (): State => (existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as State) : { accounts: [], sessions: {}, budgets: {} });
    const save = (state: State) => {
        writeFileSync(`${file}.new`, JSON.stringify(state, null, 2), { mode: 0o600 });
        renameSync(`${file}.new`, file);
    };

    return { load, save };
}

/**
 * Whether Pi may use this pi-phone's machines and secrets for what was asked last in session `id` (PP-57): always for
 * the owner; for a teammate's scoped account only where their share of that session says so.
 */
export function mayUseMachines(host: PocketHost, id: number): boolean {
    const requester = host.requesterOf(id as never);

    if (host.teamServer === undefined || requester === undefined) {
        return true;
    }

    const state = sharingState(host).load();
    const account = state.accounts.find((each) => each.userId === requester);

    return account === undefined || state.sessions[String(id)]?.[account.teammate]?.machines === true;
}

/** Why Pi doesn't use the owner's machines or secrets here. */
export const NOT_FOR_TEAMMATES = "Not for a teammate's message: in this shared session Pi doesn't use the owner's machines or secrets (the owner can allow it when sharing).";

/** The gateway's share routes, with this pi-phone's own token. */
async function gateway(host: PocketHost, body: Record<string, unknown>): Promise<unknown> {
    const server = host.teamServer;

    if (server === undefined) {
        throw new HttpError(400, "Sharing sessions is for the team server.");
    }

    const response = await fetch(`${server.url}/internal/shares`, {
        method: "POST",
        headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
    });
    const answer = (await response.json()) as { value?: unknown; error?: string };

    if (!response.ok) {
        throw new HttpError(response.status, answer.error ?? `The team server answered ${response.status}.`);
    }

    return answer.value;
}

/** Sharing, for this pi-phone's routes and Pi's tools (PP-60). */
export class Sharing {
    readonly #host: PocketHost;
    readonly #state: ReturnType<typeof sharingState>;

    constructor(host: PocketHost) {
        this.#host = host;
        this.#state = sharingState(host);
    }

    /** Who this person may share with. */
    async teammates(): Promise<{ id: string; name: string }[]> {
        return (await gateway(this.#host, { method: "teammates" })) as { id: string; name: string }[];
    }

    /** A session's shares, and the machine it works on (if any). */
    of(session: string): { machine: string | null; shares: ({ teammate: string; name: string } & Share)[] } {
        const state = this.#state.load();
        const names = new Map(state.accounts.map((each) => [each.teammate, each.name]));

        return {
            machine: this.#host.sessionMachine(Number(session)) ?? null,
            shares: Object.entries(state.sessions[session] ?? {}).map(([teammate, share]) => ({ teammate, name: names.get(teammate) ?? "Someone", ...share })),
        };
    }

    /**
     * Share `session` with `teammate` (a person on the team server), or change how: write or watch, and whether Pi may
     * use the sharer's machines and secrets for their messages. `budget` is their spend limit in dollars a month for
     * what they write (null: none; undefined: as it was).
     */
    async share(session: string, teammate: string, level: Level, machines: boolean, budget?: number | null, pi = false): Promise<void> {
        if (this.#host.sessionTitle(Number(session)) === undefined) {
            throw new HttpError(404, `There is no session #${session}.`);
        }

        const machine = this.#host.sessionMachine(Number(session));

        if (machine !== undefined && !machines) {
            throw new HttpError(400, `Session #${session} works on ${machine}, where every command runs: share it only with "Pi may use my machines and secrets for their messages" on.`);
        }

        const person = (await this.teammates()).find((each) => each.id === teammate);

        if (person === undefined) {
            throw new HttpError(404, "No such teammate on this server.");
        }

        const state = this.#state.load();

        state.sessions[session] = { ...state.sessions[session], [teammate]: { level, machines } };

        if (budget === null) {
            delete state.budgets[teammate];
        } else if (budget !== undefined) {
            if (!Number.isFinite(budget) || budget < 0) {
                throw new HttpError(400, "A spend limit is a number of dollars a month, or none.");
            }

            state.budgets[teammate] = budget;
        }

        await this.#sync(state, teammate, person.name, pi);
    }

    /** Stop sharing `session` with `teammate` (both levels): their pages of it end at once. */
    async unshare(session: string, teammate: string, pi = false): Promise<void> {
        const state = this.#state.load();
        const name = state.accounts.find((each) => each.teammate === teammate)?.name ?? "Someone";

        if (state.sessions[session]?.[teammate] === undefined) {
            return;
        }

        delete state.sessions[session]![teammate];

        if (Object.keys(state.sessions[session]!).length === 0) {
            delete state.sessions[session];
        }

        await this.#sync(state, teammate, name, pi);
    }

    /** A shared session as a Pi session file (PP-59), for the gateway to give a teammate; only one that is shared. */
    async exportShared(session: string): Promise<{ title: string; text: string }> {
        if (this.#state.load().sessions[session] === undefined) {
            throw new HttpError(404, "That session is not shared.");
        }

        return this.#host.sharedCopy.export(Number(session));
    }

    /**
     * Continue in my space (PP-59): a session a teammate shares with this person (its /space/ address), copied from their
     * pi-phone through the gateway, as a new session here on this person's own providers.
     */
    async continueShared(url: string): Promise<{ id: number; title: string }> {
        const match = /^\/space\/([A-Za-z0-9_-]{6,64})\/(write|watch)\/s\/(\d+)$/.exec(url);

        if (match === null) {
            throw new HttpError(400, "A shared session's address: /space/<key>/<write|watch>/s/<id>.");
        }

        const [, key, level, session] = match;
        const copy = (await gateway(this.#host, { method: "copy", key, level, session })) as { title: string; text: string };
        const { id } = await this.#host.sharedCopy.import(`shared-${key}-${session}-${Date.now()}.jsonl`, copy.text);

        return { id, title: copy.title };
    }

    /** What is shared with this person, from the gateway. */
    async mine(): Promise<unknown> {
        return gateway(this.#host, { method: "mine" });
    }

    /** One teammate's accounts brought in line with what is shared, at both levels, and sent to the gateway. */
    async #sync(state: State, teammate: string, name: string, pi: boolean): Promise<void> {
        for (const level of ["write", "watch"] as const) {
            const ids = Object.entries(state.sessions)
                .filter(([, shares]) => shares[teammate]?.level === level)
                .map(([id]) => id);
            let account = state.accounts.find((each) => each.teammate === teammate && each.level === level);

            if (ids.length === 0) {
                if (account !== undefined) {
                    this.#host.teammates.remove(account.userId);
                    state.accounts = state.accounts.filter((each) => each !== account);
                    this.#state.save(state);
                    await gateway(this.#host, { method: "put", teammate, level, token: account.token, sessions: [], pi });
                }

                continue;
            }

            const role = level === "write" ? "guest" : "viewer";
            const budget = level === "write" ? (state.budgets[teammate] ?? null) : null;
            const label = `${name} (team${level === "watch" ? ", watching" : ""})`;

            if (account !== undefined && this.#host.teammates.exists(account.userId)) {
                this.#host.teammates.save({ id: account.userId, name: label, role, sessions: ids, budget });
            } else {
                const made = this.#host.teammates.save({ name: label, role, sessions: ids, budget });

                state.accounts = state.accounts.filter((each) => each !== account);
                account = { teammate, name, level, userId: made.id, token: made.token! };
                state.accounts.push(account);
            }

            this.#state.save(state);
            await gateway(this.#host, {
                method: "put",
                teammate,
                level,
                token: account.token,
                sessions: ids.map((id) => ({ id, title: this.#host.sessionTitle(Number(id)) ?? `#${id}`, machines: state.sessions[id]![teammate]!.machines })),
                pi,
            });
        }
    }
}

export default function createSharing(host: PocketHost, web: ExtensionWeb) {
    if (host.teamServer === undefined) {
        return;
    }

    const sharing = new Sharing(host);

    // The Share sheet and Shared with me (`sharing-web/`): this pi-phone's person's.
    web.client("sharing-web");
    /** Only this pi-phone's own person. */
    const mine = (request: WebRequest) => {
        if (request.user.role !== "owner") {
            throw web.error(403, "Sharing is this pi-phone's person's.");
        }
    };
    const answer = async <T>(work: () => Promise<T>): Promise<T> => {
        try {
            return await work();
        } catch (error) {
            throw error instanceof HttpError ? web.error(error.status, error.message) : error;
        }
    };

    web.route("GET", "teammates", (request) => (mine(request), answer(async () => ({ teammates: await sharing.teammates() }))));
    web.route("GET", "session/:id", (request) => (mine(request), sharing.of(request.params.id!)));
    web.route("POST", "share", (request) =>
        (mine(request),
        answer(async () => {
            const body = request.body;
            const level = body.level === "watch" ? "watch" : body.level === "write" ? "write" : undefined;

            if (level === undefined) {
                throw new HttpError(400, "Can write or Can watch.");
            }

            await sharing.share(String(body.session ?? ""), String(body.teammate ?? ""), level, body.machines === true, body.budget === undefined ? undefined : body.budget === null ? null : Number(body.budget));

            return sharing.of(String(body.session));
        })),
    );
    web.route("POST", "unshare", (request) =>
        (mine(request),
        answer(async () => {
            await sharing.unshare(String(request.body.session ?? ""), String(request.body.teammate ?? ""));

            return sharing.of(String(request.body.session));
        })),
    );
    web.route("GET", "mine", (request) => (mine(request), answer(async () => ({ shared: await sharing.mine() }))));
    // For the gateway, with this pi-phone's own token: a shared session for a teammate's Continue in my space.
    web.route("GET", "export/:id", (request) => (mine(request), answer(async () => sharing.exportShared(request.params.id!))));
    web.route("POST", "continue", (request) => (mine(request), answer(async () => sharing.continueShared(String(request.body.url ?? "")))));
}
