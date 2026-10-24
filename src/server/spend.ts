/**
 * What Pi costs, and limits on it. A conversation's spend is its `pi.usage` total; a session's is its own and its
 * subagents'. Spend is also counted per person: work goes to whoever asked for it, the person Pi works for there when
 * the work's usage is committed. The owner can limit a session or a person. Past a limit, new messages are refused,
 * and a run that crosses it is stopped; the model request that crossed it still counts.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type ConversationId, UsageDoc, type UsageState } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import { SessionsDoc, SpendDoc, type WikiSpend } from "./docs.ts";
import { describe, HttpError } from "./errors.ts";
import { teamUsageCost, usageCost } from "./projection.ts";

const context = BACKGROUND_CONTEXT;

/** Spend stored for people a little after it happens: a run commits its usage with every response. */
const COUNT_AFTER_MS = 250;

export const dollars = (amount: number) => `$${amount.toFixed(2)}`;

/** Two counts of the wiki's embeddings as one: summed, and since the earlier. */
function addWiki(a: WikiSpend | undefined, b: WikiSpend | undefined): WikiSpend | undefined {
    if (a === undefined || b === undefined) {
        return a ?? b;
    }

    return { cost: a.cost + b.cost, tokens: a.tokens + b.tokens, requests: a.requests + b.requests, since: Math.min(a.since, b.since) };
}

export type SpendSummary = {
    /** Everything Pi spent on this server, the wiki's embeddings with it; only the owner sees it. */
    total?: number;
    /** The wiki's search by meaning (remote embeddings), counted since `since`; only the owner sees it. */
    wiki?: WikiSpend;
    sessions: { id: number; title: string; spent: number; budget?: number }[];
    /** Everyone for the owner; others see themselves. */
    people: { id: string; name: string; spent: number; budget?: number }[];
};

export class Spend {
    readonly #app: PocketApp;
    /** Each conversation's spend so far. */
    readonly #costs = new Map<ConversationId, number>();
    /** Spend added to people but not stored yet, per conversation and person. */
    readonly #owed = new Map<ConversationId, Map<string, number>>();
    /** What `SpendDoc` says each person spent, as of the last count. */
    #people: Record<string, number> = {};
    /** The same three for the part spent on the team server's accounts (PP-73). */
    readonly #teamCosts = new Map<ConversationId, number>();
    readonly #teamOwed = new Map<ConversationId, Map<string, number>>();
    #team: Record<string, number> = {};
    /** Runs being stopped for a limit, until they end: each is stopped, and announced, once. */
    readonly #stopping = new Set<ConversationId>();
    #timer: NodeJS.Timeout | undefined;
    /** Told when the owner changes a limit: work held back by one may go now. */
    readonly #limits = new Set<() => void>();
    /** The wiki's embeddings as stored at the last count, and what came since, to be added with the next. */
    #wiki: WikiSpend | undefined;
    #wikiAdded: WikiSpend | undefined;

    constructor(app: PocketApp) {
        this.#app = app;
    }

    /**
     * Start from what is stored: every conversation's spend, then count what a crash left uncounted. That goes to whoever
     * Pi works for there now, as whom it was for is not stored.
     */
    async load(ids: readonly ConversationId[]): Promise<void> {
        const harness = this.#app.harness;

        for (const id of ids) {
            const usage = await harness.snapshot(UsageDoc, id, context);

            this.#costs.set(id, usageCost(usage));
            this.#teamCosts.set(id, teamUsageCost(usage));
        }

        if ((await harness.snapshot(SpendDoc, context)) === undefined) {
            // The first start that counts spend per person: what was spent before is nobody's, rather than all of it
            // going to whoever wrote last in each conversation.
            await harness.commit(async (tx) => {
                const doc = await tx.doc(SpendDoc);

                for (const [id, cost] of this.#costs) {
                    doc.counted[String(id)] = cost;
                }
            }, context);
        }

        const stored = await harness.snapshot(SpendDoc, context);

        this.#people = { ...stored?.people };
        this.#team = { ...stored?.team };
        this.#wiki = stored?.wiki;

        for (const id of ids) {
            const added = (this.#costs.get(id) ?? 0) - (stored?.counted[String(id)] ?? 0);
            const team = (this.#teamCosts.get(id) ?? 0) - (stored?.teamCounted?.[String(id)] ?? 0);

            if (added > 0) {
                this.#owe(id, this.#payer(id), added);
            }

            if (team > 0) {
                this.#owe(id, this.#payer(id), team, this.#teamOwed);
            }
        }

        await this.#count();
    }

    /** Add spend in a conversation to a person, to be stored with the next count. */
    #owe(id: ConversationId, payer: string, added: number, to = this.#owed): void {
        const owed = to.get(id) ?? new Map<string, number>();

        owed.set(payer, (owed.get(payer) ?? 0) + added);
        to.set(id, owed);
    }

    /**
     * A conversation's usage changed: called from the commit listener, when whom Pi works for is who asked for this
     * work. Storing it waits for a moment.
     */
    usageChanged(id: ConversationId, usage: UsageState | null): void {
        const cost = usageCost(usage ?? undefined);
        const added = cost - (this.#costs.get(id) ?? 0);
        const team = teamUsageCost(usage ?? undefined);
        const teamAdded = team - (this.#teamCosts.get(id) ?? 0);

        this.#costs.set(id, cost);
        this.#teamCosts.set(id, team);

        if (added > 0) {
            this.#owe(id, this.#payer(id), added);
        }

        if (teamAdded > 0) {
            this.#owe(id, this.#payer(id), teamAdded, this.#teamOwed);
        }

        this.#later();
    }

    /** A remote embedding request for the wiki: added to the wiki's spend, nobody's budget. */
    wikiUsed(usage: { model: string; tokens: number; cost: number }): void {
        this.#wikiAdded = addWiki(this.#wikiAdded, { cost: usage.cost, tokens: usage.tokens, requests: 1, since: Date.now() });
        this.#later();
    }

    /** Store what was added, in a moment. */
    #later(): void {
        this.#timer ??= setTimeout(() => {
            this.#timer = undefined;
            void this.#count().catch((error: unknown) =>
                this.#app.log(`spend not counted: ${describe(error)}`),
            );
        }, COUNT_AFTER_MS);
    }

    /** Who pays for a conversation's work: whoever asked for it, else whoever started the session, else the owner. */
    #payer(id: ConversationId): string {
        const app = this.#app;

        return (
            app.attribution.requesterOf(id) ??
            app.sessionMeta(app.rootOf(id))?.createdBy ??
            app.config.users.find((user) => user.role === "owner")!.id
        );
    }

    /** Store the spend added to people, then stop work that went past a limit. */
    async #count(): Promise<void> {
        const owed = [...this.#owed];
        const teamOwed = [...this.#teamOwed];
        const wiki = this.#wikiAdded;

        this.#owed.clear();
        this.#teamOwed.clear();
        this.#wikiAdded = undefined;

        if (owed.length === 0 && teamOwed.length === 0 && wiki === undefined) {
            return;
        }

        try {
            [this.#people, this.#team] = await this.#app.harness.commit(async (tx) => {
                const doc = await tx.doc(SpendDoc);

                if (wiki !== undefined) {
                    const counted = addWiki(doc.wiki, wiki);

                    doc.wiki = counted;
                    // The plain value, never `doc.wiki`: that is the transaction's view, which throws "Cannot use a
                    // settled overlay" once it ends (Pi Durable 1.4 hands back a view of what was just set).
                    this.#wiki = counted === undefined ? undefined : { ...counted };
                }

                for (const [id, payers] of owed) {
                    for (const [payer, added] of payers) {
                        doc.counted[String(id)] = (doc.counted[String(id)] ?? 0) + added;
                        doc.people[payer] = (doc.people[payer] ?? 0) + added;
                    }
                }

                for (const [id, payers] of teamOwed) {
                    for (const [payer, added] of payers) {
                        doc.teamCounted = { ...doc.teamCounted, [String(id)]: (doc.teamCounted?.[String(id)] ?? 0) + added };
                        doc.team = { ...doc.team, [payer]: (doc.team?.[payer] ?? 0) + added };
                    }
                }

                return [{ ...doc.people }, { ...doc.team }] as const;
            }, context);
        } catch (error) {
            // Still owed: the next count stores it.
            this.#wikiAdded = wiki === undefined ? this.#wikiAdded : addWiki(wiki, this.#wikiAdded);

            for (const [id, payers] of owed) {
                for (const [payer, added] of payers) {
                    this.#owe(id, payer, added);
                }
            }

            for (const [id, payers] of teamOwed) {
                for (const [payer, added] of payers) {
                    this.#owe(id, payer, added, this.#teamOwed);
                }
            }

            throw error;
        }

        this.#stopOverLimit();
    }

    /** What a session spent: itself and its subagents. */
    sessionSpent(root: ConversationId): number {
        let spent = 0;

        for (const [id, cost] of this.#costs) {
            if (this.#app.rootOf(id) === root) {
                spent += cost;
            }
        }

        return spent;
    }

    /**
     * The session at the top of a linked family (`linked-sessions.ts`): the one that started this one, and so on up. A
     * session no link started is its own.
     */
    teamRoot(root: ConversationId): ConversationId {
        const seen = new Set<ConversationId>([root]);
        let at = root;

        for (;;) {
            const from = this.#app.sessionMeta(at)?.linkedFrom?.id as ConversationId | undefined;

            if (from === undefined || seen.has(from)) {
                return at;
            }

            seen.add(from);
            at = from;
        }
    }

    /** What a linked family spent: its top session and every session linked under it, subagents included. */
    #teamSpent(top: ConversationId): number {
        let spent = 0;

        for (const [id, cost] of this.#costs) {
            if (this.teamRoot(this.#app.rootOf(id)) === top) {
                spent += cost;
            }
        }

        return spent;
    }

    /**
     * What counts against a session's own limit, to show beside it: itself and its subagents, and, for a session that
     * started linked sessions, theirs too, as `#reached` counts it.
     */
    budgetSpent(root: ConversationId): number {
        return this.teamRoot(root) === root ? this.#teamSpent(root) : this.sessionSpent(root);
    }

    personSpent(userId: string): number {
        return this.#people[userId] ?? 0;
    }

    /** The limit work in a conversation reached when `userId` pays for it: the session's, or theirs. */
    #reached(
        id: ConversationId,
        userId: string,
    ): { budget: number; person?: User; team?: true; monthly?: true } | undefined {
        const app = this.#app;
        const root = app.rootOf(id);
        const budget = app.sessionMeta(root)?.budget;

        if (budget !== undefined && this.sessionSpent(root) >= budget) {
            return { budget };
        }

        // The budget of the session that started a team covers it all: what its linked sessions spend counts too.
        const top = this.teamRoot(root);
        const team = app.sessionMeta(top)?.budget;

        if (team !== undefined && this.#teamSpent(top) >= team) {
            return top === root ? { budget: team } : { budget: team, team: true };
        }

        const person = app.config.userById(userId);
        const limit = person === undefined || person.role === "owner" ? undefined : person.budget;

        if (limit !== undefined && this.personSpent(userId) >= limit) {
            return { budget: limit, person };
        }

        // The owner of a pi-phone behind the server edition's gateway: their role's monthly cap (PP-22).
        // Not what went to the team's accounts: the team server holds that to the role's team spend limit (PP-73).
        const month = person?.role === "owner" ? app.policy.month(this.personSpent(userId) - (this.#team[userId] ?? 0)) : undefined;

        if (month !== undefined && month.spent >= month.cap) {
            return { budget: month.cap, monthly: true };
        }

        return undefined;
    }

    /** Throw unless this person may start more work in this session. */
    check(user: User, id: ConversationId): void {
        const reached = this.#reached(id, user.id);

        if (reached === undefined) {
            return;
        }

        if (reached.monthly) {
            throw new HttpError(409, `Your role's ${dollars(reached.budget)} monthly spend limit is reached: your team's owner can raise it.`);
        }

        const whose =
            reached.person !== undefined
                ? "You reached your"
                : reached.team
                  ? "The session that started this one reached its"
                  : "This session reached its";

        throw new HttpError(
            409,
            `${whose} ${dollars(reached.budget)} spend limit. The owner can raise it.`,
        );
    }

    /**
     * Why work Pi starts with nobody asking (a scheduled message, the next round toward a goal) may not start: a limit
     * the session or its payer reached. `userId` pays when given, else whoever asked last.
     */
    heldBack(id: ConversationId, userId = this.#payer(id)): string | undefined {
        const reached = this.#reached(id, userId);

        if (reached === undefined) {
            return undefined;
        }

        return reached.monthly
            ? `the role's ${dollars(reached.budget)} monthly spend limit is reached`
            : reached.person !== undefined
            ? `${reached.person.name} reached their ${dollars(reached.budget)} spend limit`
            : reached.team
              ? `the session that started this one reached its ${dollars(reached.budget)} spend limit`
              : `this session reached its ${dollars(reached.budget)} spend limit`;
    }

    /** Call `listener` whenever the owner changes a session's or a person's limit; returns how to stop. */
    onLimitsChanged(listener: () => void): () => void {
        this.#limits.add(listener);

        return () => this.#limits.delete(listener);
    }

    #limitsChanged(): void {
        for (const listener of this.#limits) {
            listener();
        }
    }

    /** A conversation's run ended: a new one there is stopped again if it goes past a limit. */
    runEnded(id: ConversationId): void {
        this.#stopping.delete(id);
    }

    /** Stop every run that goes on past its session's limit or its payer's. */
    #stopOverLimit(): void {
        const app = this.#app;

        for (const id of app.busyConversations()) {
            if (this.#stopping.has(id)) {
                continue;
            }

            const why = this.heldBack(id);

            if (why === undefined) {
                continue;
            }

            this.#stopping.add(id);
            app.notice("warning", `Pi stopped: ${why}.`, id);
            void app
                .conversation(id)
                .then((conversation) => conversation.abort(context))
                .catch((error: unknown) => {
                    // The next count tries again.
                    this.#stopping.delete(id);
                    app.log(`could not stop ${String(id)}: ${describe(error)}`);
                });
        }
    }

    /** The owner limits what Pi may spend in a session (`null`: no limit). */
    async setSessionBudget(user: User, id: ConversationId, budget: unknown): Promise<void> {
        requireOwner(user);
        const amount = budgetOf(budget);

        await this.#app.harness.commit(async (tx) => {
            const meta = (await tx.doc(SessionsDoc)).items[String(id)];

            if (meta === undefined) {
                throw new HttpError(404, "Not a session");
            }

            if (amount === undefined) {
                delete meta.budget;
            } else {
                meta.budget = amount;
            }
        }, context);
        this.#limitsChanged();
        await this.#app.collab.activity(
            id,
            user,
            amount === undefined
                ? "removed the spend limit"
                : `set a spend limit of ${dollars(amount)}`,
        );
    }

    /** The owner limits what Pi may spend for a person (`null`: no limit). */
    setPersonBudget(user: User, userId: string, budget: unknown): void {
        requireOwner(user);
        const person = this.#app.config.userById(userId);

        if (person === undefined) {
            throw new HttpError(404, "No such person");
        }

        if (person.role === "owner") {
            throw new HttpError(400, "The owner has no spend limit");
        }

        const amount = budgetOf(budget);

        this.#app.config.updateUser(userId, { budget: amount });
        this.#limitsChanged();
    }

    /** Spend as this person may see it: the owner sees everything, others their own sessions and themselves. */
    summary(user: User): SpendSummary {
        const app = this.#app;
        const owner = user.role === "owner";
        // Each session's spend, its subagents' with it, in one pass over every conversation.
        const byRoot = new Map<ConversationId, number>();

        for (const [id, cost] of this.#costs) {
            const root = app.rootOf(id);

            byRoot.set(root, (byRoot.get(root) ?? 0) + cost);
        }

        const sessions = app.sessions(user).map((session) => {
            const id = session.id as unknown as ConversationId;
            const budget = app.sessionMeta(id)?.budget;

            return {
                id: session.id,
                title: session.title ?? "New session",
                spent: budget === undefined ? (byRoot.get(id) ?? 0) : this.budgetSpent(id),
                ...(budget === undefined ? {} : { budget }),
            };
        });
        const people = app.config.users
            .filter((person) => owner || person.id === user.id)
            .map((person) => ({
                id: person.id,
                name: person.name,
                spent: this.personSpent(person.id),
                ...(person.budget === undefined ? {} : { budget: person.budget }),
            }));
        const wiki = addWiki(this.#wiki, this.#wikiAdded);
        const total = [...this.#costs.values()].reduce((sum, cost) => sum + cost, 0) + (wiki?.cost ?? 0);

        return {
            ...(owner ? { total } : {}),
            ...(owner && wiki !== undefined ? { wiki } : {}),
            sessions: sessions.sort((a, b) => b.spent - a.spent),
            people: people.sort((a, b) => b.spent - a.spent),
        };
    }

    close(): void {
        clearTimeout(this.#timer);
        this.#limits.clear();
    }
}

function requireOwner(user: User): void {
    if (user.role !== "owner") {
        throw new HttpError(403, "Only the owner can do that");
    }
}

/** A limit from a request: dollars, or null for none. */
function budgetOf(value: unknown): number | undefined {
    if (value === null) {
        return undefined;
    }

    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1_000_000) {
        throw new HttpError(400, "budget must be an amount in dollars, or null for none");
    }

    return Math.round(value * 100) / 100;
}
