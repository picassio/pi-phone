/**
 * Pi's run model on a real site (PP-456, a follow-up to PP-451): browser_run and computer_run may take a `model` other
 * than the setting's, and each step then sends the page (or the window) to that model's provider. On a test site
 * (`test-sites.ts`) that is Pi's choice; on a real or production site the owner approves it on a card first: Approve
 * once (this run) or Deny, which runs with the setting's model, said in the answer. Nobody answering within
 * `RISKY_WAIT_MS` (a schedule) is a Deny too.
 *
 * Every step's page is judged, not only the first: a run that moves from a test site to a real one asks at its first
 * real-site step, before that page goes to Pi's model. A computer app is never a test site.
 */
import { type Decider, DecisionError, type DecisionState, type Question, type RunModelChoice, type RunResult, runDecider } from "./browser/run.ts";
import type { PocketHost } from "./host.ts";
import { type CardCall, ownerCard, RISKY_WAIT_MS } from "./risky.ts";
import { isTestSite } from "./test-sites.ts";

/** A run model as `runDecider` makes it: the decider, its model (a Jev id, or "session"), and its words for the report. */
export type RunModel = { decider: Decider; model: string; label: string };

export type SiteGuardOptions = {
    /** The model Pi asked for, which differs from the setting's. */
    asked: RunModel;
    /** The setting's model, made when the owner says no (an error that says what is missing, when it cannot be). */
    setting(): Promise<RunModel | { error: string }>;
    /** Whether a step's page is a test site. */
    isTest(url: string): boolean;
    /** The owner's card for the site of `url`: true to run with Pi's model; else why not. */
    ask(url: string): Promise<true | string>;
    /** The site of `url`, as the answer names it. */
    site(url: string): string;
};

/**
 * Pi's model until a step's page is a real site; there, the owner's card. Approved: Pi's model for the rest of the run.
 * Denied: the setting's model for the rest of it. `label` and `usage` say which models decided and what each cost.
 */
export class SiteGuardDecider implements Decider {
    readonly #options: SiteGuardOptions;
    #current: RunModel;
    #approved = false;
    #switched: { why: string; site: string } | undefined;
    /** What each Jev model's decisions cost, by its id: for Spend. */
    readonly usage = new Map<string, { input: number; output: number; cost: number }>();

    constructor(options: SiteGuardOptions) {
        this.#options = options;
        this.#current = options.asked;
    }

    /** The decider that decides the next step: Pi's, or the setting's after a Deny. */
    get inner(): Decider {
        return this.#current.decider;
    }

    get label(): string {
        return this.#switched === undefined
            ? this.#current.label
            : `${this.#current.label}, after the owner's card for ${this.#options.asked.label.replace(/ as Pi asked$/, "")} on ${this.#switched.site} (${this.#switched.why.replace(/:$/, "")})`;
    }

    async decide(state: DecisionState, questions: Record<string, Question>) {
        const url = state.page.url;

        if (this.#current === this.#options.asked && !this.#approved && !this.#options.isTest(url)) {
            const answer = await this.#options.ask(url);

            if (answer === true) {
                this.#approved = true;
            } else {
                const setting = await this.#options.setting();

                if ("error" in setting) {
                    throw new DecisionError(`${answer} the setting's model, then: ${setting.error}`);
                }

                this.#current = setting;
                this.#switched = { why: answer, site: this.#options.site(url) };
            }
        }

        const model = this.#current.model;
        const decided = await this.#current.decider.decide(state, questions);

        if (model !== "session") {
            const before = this.usage.get(model) ?? { input: 0, output: 0, cost: 0 };

            this.usage.set(model, { input: before.input + decided.tokens.input, output: before.output + decided.tokens.output, cost: before.cost + decided.cost });
        }

        return decided;
    }
}

/** A run model's name on the card: this session's model, or a Jev model's id. */
const modelName = (model: string) => (model === "session" ? "this session's model" : model);

/**
 * The run model of one browser_run or computer_run (PP-451, PP-456), from `chosen` (`runDecider`'s): the decider, its
 * words for the report once the run ended (`label`), and its cost charged to Spend (`charge`). With Pi's `model` other
 * than the setting's, a `SiteGuardDecider` asks the owner on a card (`run-model-<task>-<call>`) at the run's first
 * real-site step; `site` names a step's page on it (a computer app: never a test site).
 */
export function runModelFor(
    host: Pick<PocketHost, "approvals" | "requesterOf" | "people" | "browserTestSites" | "apiKey" | "askSessionModel" | "chargeSession">,
    call: CardCall,
    context: unknown,
    run: { tool: string; place: "browser" | "computer"; setting: string; asked: RunModelChoice | undefined; chosen: RunModel; site(url: string): string },
): { decider: Decider; label(): string; charge(result: Pick<RunResult, "decisions" | "tokens" | "cost">): Promise<void> } {
    const { chosen, setting } = run;
    const conversation = call.conversationId as never;

    if (run.asked === undefined || chosen.model === setting) {
        return {
            decider: chosen.decider,
            label: () => chosen.label,
            charge: async (result) => {
                if (chosen.model !== "session" && result.decisions > 0) {
                    await host.chargeSession(conversation, `openrouter/${chosen.model}`, { ...result.tokens, cost: result.cost });
                }
            },
        };
    }

    const provider = chosen.model === "session" ? ("session" as const) : ("openrouter" as const);
    const guard = new SiteGuardDecider({
        asked: chosen,
        setting: () => runDecider(setting, undefined, () => host.apiKey("openrouter"), (prompt) => host.askSessionModel(conversation, prompt, 600)),
        isTest: (url) => run.place === "browser" && isTestSite(url, host.browserTestSites()),
        site: run.site,
        ask: (url) =>
            ownerCard(
                host,
                call,
                context,
                {
                    id: `run-model-${String(call.taskId)}-${String(call.callId)}`,
                    tool: run.tool,
                    subject: run.site(url),
                    reason: `${run.tool} would send ${run.place === "browser" ? "this site's pages" : "this app's window"} to ${modelName(chosen.model)}${provider === "openrouter" ? " through OpenRouter (openrouter.ai)" : ", through its provider"}, not the setting's ${modelName(setting)}. Approve once is for this run; Deny runs with the setting's model.`,
                    form: { type: "run-model", site: run.site(url), setting, asked: chosen.model, provider, place: run.place },
                },
                "Only the owner approves another run model on a real site, and this session does not work for the owner: denied.",
                RISKY_WAIT_MS,
            ),
    });

    return {
        decider: guard,
        label: () => guard.label,
        charge: async () => {
            for (const [model, usage] of guard.usage) {
                await host.chargeSession(conversation, `openrouter/${model}`, { input: usage.input, output: usage.output, cost: usage.cost });
            }
        },
    };
}
