/**
 * The Pi Pocket server core: one durable Harness over one SQLite file, shared by every session, every subagent, and
 * every connected browser. Browsers attach to a conversation's committed view; nothing a browser sees exists only in
 * memory, except who is connected, who is typing, and which tool calls wait for approval.
 *
 * What people ask of Pi lives in `commands.ts`, the people's side of a session in `collab.ts`, push notifications in
 * `alerts.ts`, provider sign-ins in `providers.ts`, and each conversation's shared live view in `room.ts`.
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { sshArguments } from "@earendil-works/pi-env";
import { Accounts, baseProvider, isTeamAccount } from "./accounts.ts";
import { TeamAccountsClient } from "./team-accounts.ts";
import { TeamMachinesClient } from "./team-machines.ts";
import { machinePaths } from "./machine-paths.ts";
import { PhoneSettingsFile } from "./phone-settings.ts";
import { UsageLimits, type UsageWindow } from "./usage-limits.ts";
import { LimitGate, type LimitTuning, noWait, type WaitView, type Waiting } from "./limit-gate.ts";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { clampThinkingLevel, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
    formatSkillsForPrompt,
    getAgentDir,
    ModelRuntime,
    resolveModelScopeWithDiagnostics,
    SettingsManager,
    type Skill,
} from "@earendil-works/pi-coding-agent";
import {
    AgentDoc,
    type AgentState,
    type CommitPublication,
    type Conversation,
    type ConversationId,
    type Cursor,
    createRegistry,
    defineExtension,
    type DocumentCommitChange,
    Harness,
    type HarnessSettings,
    LiveDoc,
    type LiveState,
    ProviderDoc,
    type Registry,
    type Storage,
    UsageDoc,
    type UsageState,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import {
    createBashTool,
    createEditTool,
    createReadTool,
    createWriteTool,
} from "@earendil-works/pi-durable/tools";
import { Attribution, type Missing } from "./attribution.ts";
import { inBatchOrder } from "./batch-order.ts";
import { Collab, REACTIONS } from "./collab.ts";
import { Commands } from "./commands.ts";
import { APP_ROOT, ConfigStore, type User, type WelcomeState } from "./config.ts";
import {
    ArtifactBodyDoc,
    type ArtifactMeta,
    ArtifactsDoc,
    AuthorsDoc,
    ChatDoc,
    type ChatMessage,
    DecisionsDoc,
    FolderFavoritesDoc,
    SessionGroupsDoc,
    type SessionGroupsOf,
    type SessionMeta,
    SessionsDoc,
    type SubagentRecord,
    SubagentsDoc,
    TurnsDoc,
} from "./docs.ts";
import { describe, HttpError } from "./errors.ts";
import { ExtensionCommands } from "./extension-commands.ts";
import { ExtensionWebs, mayUse } from "./extension-web.ts";
import { defang, quoted } from "./fence.ts";
import { cardFills, savedSignIn } from "./extensions/browser.ts";
import { FolderFavorites } from "./folder-favorites.ts";
import { SessionGroups } from "./session-groups.ts";
import { AutoCompact, checkCompactAt } from "./auto-compact.ts";
import { withAssistant } from "./assistant.ts";
import { type CallPlan, type CallStart, chatgptAccount, type VoiceEndpoints, type VoiceMode, VOICES, VoiceService, isVoiceMode, voiceInstructions, withVoice } from "./voice.ts";
import { GitHubLogin } from "./github-login.ts";
import { PiHandoff } from "./pi-handoff.ts";
import { clockText, inLanguage, inZone, type PhoneEvent, PhoneEvents, type Said, said } from "./phone-events.ts";
import { resolveLanguage, translator } from "./i18n.ts";
import { newestBig, WHATS_NEW_DIR, type WhatsNew } from "./whats-new.ts";
import { WebPush } from "./web-push.ts";
import { Forwards } from "./forwards.ts";
import { SessionControl } from "./session-control.ts";
import { Para } from "./para.ts";
import { CAPTURE_EXTENSION, ParaCapture } from "./para-capture.ts";
import { PiSessions } from "./pi-sessions.ts";
import { Machines } from "./machines.ts";
import { MachineTools, machineSkillsDir, TOOLS_BIN } from "./machine-tools.ts";
import { Screenshots } from "./screenshots.ts";
import { FilePages } from "./file-pages.ts";
import { MachineEngine } from "./browser/machine-engine.ts";
import { BrowserSizes, SessionEngine, TabOwners } from "./browser/session-engine.ts";
import { checkPolicy, EXTENSIONS as POLICY_EXTENSIONS, PolicyStore } from "./policy.ts";
import { installImageGuard } from "./image-guard.ts";
import { appSettings } from "./settings-registry.ts";
import { type BrowserEngine, type BrowserFrame, type FrameSize, PhoneEngine, PiBrowser } from "./browser/pi-browser.ts";
import { PhoneRequests } from "./phone-requests.ts";
import { PhoneControl } from "./phone-control.ts";
import { ComputerControl, type ComputerControlOptions, shellWord } from "./computer-control.ts";
import { askSessionModel, chargeSession } from "./side-model.ts";
import { OfficeCli, type OfficeCliOptions } from "./officecli.ts";
import { isRemote, parsePlace, Places } from "./places.ts";
import { SshKeys } from "./ssh-keys.ts";
import { SshAgent } from "./ssh-agent.ts";
import { namesIn, Secrets } from "./secrets.ts";
import { CommandEnvs, HiddenValues } from "./hidden.ts";
import { ask, checkValues } from "./extension-points.ts";
import type { Tailnet } from "./tailnet.ts";
import { WebSearch } from "./web/access.ts";
import { InterviewHelpers } from "./interview-helpers.ts";
import { checkDraft, type Interview, InterviewsDoc } from "./interviews.ts";
import type { JsonValue } from "@earendil-works/chord";
import { ANSWER_KEY, MAX_ANSWER_STATE_BYTES, MAX_ANSWER_STATES, OpenUiStateDoc } from "./openui.ts";
import { type ApprovalRequest, Approvals, type PocketHost, type WebAccess } from "./host.ts";
import { waitForLock } from "./lock.ts";
import { SAFETY_COPY_DAYS, safetyCopyBeforeUpgrade } from "./storage-upgrade.ts";
import { isThinkingLevel, modelList, resolveModel, THINKING_LEVELS } from "./models.ts";
import { configureHttp } from "./net.ts";
import { type ClientEntry, type LimitOffer, projectEntry, snippet } from "./projection.ts";
import { VOICE_PREFIX } from "./entry-format.ts";
import { VOICE_TOOLS, VoiceBridge } from "./voice-bridge.ts";
import { loadPromptTemplates, type PromptTemplate, type SkillCommand } from "./prompts.ts";
import { BASE_THEME, Themes } from "./themes.ts";
import { THEME_ID } from "./themes/format.ts";
import { measureModelStreams } from "./timing.ts";
import { Providers } from "./providers.ts";
import { type ExtensionInfo, ExtensionLoader, prepareDropInFolder, Refused } from "./reload.ts";
import { type DropInPackage, replacedBy, writePackage } from "./drop-in-install.ts";
import { ResendTask } from "./resend.ts";
import { type Client, reportingOf, Room, ROOM_DOCS, subagentView } from "./room.ts";
import { Schedules } from "./schedules.ts";
import { Goals } from "./goals.ts";
import { Shell } from "./shell.ts";
import {
    loadSessionSkills,
    machineToolSkills,
    projectDistrusted,
    type ProjectTrust,
    readProjectTrust,
    saveProjectTrust,
    type SkillSources,
    type TrustChoice,
} from "./skills.ts";
import { Spend } from "./spend.ts";
import { Transcripts } from "./transcripts.ts";
import { Workspace } from "./workspace.ts";

const context = BACKGROUND_CONTEXT;

/** How other devices reach this server, as reported by the launcher (`bin/pi-pocket.js`). */
export type AccessInfo = {
    mode: string;
    label: string;
    /** The address other devices should use, such as a tunnel's public https URL. */
    url?: string;
};

/** How long the server waits, when it stops, for extension modules' cleanups that wait. */
const CLEANUP_LIMIT_MS = 3000;
/** A session's tabs in Pi's browser close after this long unused (PP-13): each costs memory on the phone or a machine. */
export const BROWSER_IDLE_MS = 30 * 60_000;
/** How often idle tabs are looked for. */
const BROWSER_SWEEP_MS = 60_000;
/** The extension module with the subagent tool, rebuilt when the models subagents may use change. */
const SUBAGENTS_FILE = "subagents.ts";
/** The most models the owner may allow subagents besides their session's own. */
const MAX_SUBAGENT_MODELS = 50;
/** The hours a run may wait for a provider's limit, as the owner may choose them (0: not at all). */
const LIMIT_WAIT_CHOICES = [0, 1, 6, 12, 24];

/**
 * The most conversations a tab gets live peeks for at once: the sessions on its screen, and the subagents working
 * there, each row asking for its own as the tiles do.
 */
export const MAX_PEEKS = 20;
/**
 * How a run that failed leaves its messages: the model or its provider answered with an error, no model was there to
 * ask, or the run broke. Stopped (`aborted`), cleared (`reset`), and replaced (`stale`) runs did not fail.
 */
const FAILED_RUN = new Set(["model_error", "no_model", "faulted"]);

/** A conversation's subagents document, as far as the app reads it. */
type SubagentsValue = {
    agents?: Record<string, SubagentRecord>;
    outbox?: readonly { name: string }[];
    sending?: { reports: readonly { name: string }[] };
};

type SubagentsOf = { agents: Record<string, SubagentRecord>; reporting: Set<string> };

/** One subagent on the subagents board: the subagents bar's view, the session it works in, and the call it waits on. */
export type SubagentEntry = ReturnType<typeof subagentView> & {
    id: number;
    waiting?: true;
    approval?: { tool: string; subject: string };
};

/** Where a subagent is. Waiting for an approval comes before working: it is working, held up. */
export type SubagentState = "waiting" | "working" | "failed" | "stopped" | "done";

export function subagentState(entry: SubagentEntry): SubagentState {
    if (entry.waiting === true) {
        return "waiting";
    }

    if (entry.busy) {
        return "working";
    }

    return entry.stopped === true ? "stopped" : entry.failed === true ? "failed" : "done";
}

/**
 * On the subagents board, a session's finished subagents (done, stopped, or failed and dealt with) past this many, the
 * oldest, are left out: the session list counts them, and the board says how many more there are. Those that work,
 * wait, failed with nobody dealing with it yet, or have a report on its way always show.
 */
const BOARD_FINISHED = 24;

/** How long a read of Pi's settings serves skills and trust before it is read again. */
const SETTINGS_STALE_MS = 30_000;

/** A session's subagents as the board gets them: all but its oldest finished ones past `BOARD_FINISHED`. */
function forBoard(entries: readonly SubagentEntry[]): SubagentEntry[] {
    const finished = (entry: SubagentEntry) =>
        entry.reporting !== true &&
        (["done", "stopped"].includes(subagentState(entry)) ||
            (subagentState(entry) === "failed" && entry.dealt === true));
    const done = entries.filter(finished);

    if (done.length <= BOARD_FINISHED) {
        return [...entries];
    }

    const when = (entry: SubagentEntry) => entry.answeredAt ?? entry.askedAt ?? 0;
    const kept = new Set(done.sort((a, b) => when(b) - when(a)).slice(0, BOARD_FINISHED));

    return entries.filter((entry) => !finished(entry) || kept.has(entry));
}

/**
 * How many of a session's subagents are in each state, without the empty ones, and how many of those that failed a
 * person dealt with (`dealt`): the rest need someone. Undefined for none at all.
 */
function countSubagents(
    entries: readonly SubagentEntry[],
): (Partial<Record<SubagentState, number>> & { dealt?: number }) | undefined {
    if (entries.length === 0) {
        return undefined;
    }

    const counts: Partial<Record<SubagentState, number>> & { dealt?: number } = {};

    for (const entry of entries) {
        const state = subagentState(entry);

        counts[state] = (counts[state] ?? 0) + 1;

        if (state === "failed" && entry.dealt === true) {
            counts.dealt = (counts.dealt ?? 0) + 1;
        }
    }

    return counts;
}

export interface OpenOptions {
    dataDir: string;
    defaultCwd: string;
    supervised: boolean;
    log?: (line: string) => void;
    /** How long opening waits for a live holder of the data directory's lock to let go (`waitForLock`); default 10 s. */
    lockWaitMs?: number;
    /** Tests register scripted providers here. */
    configureModels?: (models: ModelRuntime) => void;
    /** Tests shorten the limit gate's waits (`limit-gate.ts`). */
    limits?: Partial<LimitTuning>;
    /** How plan limits are asked (`usage-limits.ts`); tests answer for the providers. */
    usageFetch?: typeof fetch;
    /** The providers that may have more accounts, and how to make each (`accounts.ts`); tests use their scripted one. */
    accountProviders?: ConstructorParameters<typeof Accounts>[2];
    /** The clock durable work runs by, such as scheduled messages. Tests move it ahead. */
    now?: () => number;
    /** The home folder, whose `.agents/skills/` every session has. Undefined is Pi's: `$HOME`. Tests use their own. */
    home?: string;
    /** OfficeCLI as tests stand it in (a binary of their own); default the bundled one, on Android. */
    officecli?: Omit<OfficeCliOptions, "dataDir">;
    /** Where Pi's browser comes from: the phone's WebView unless a test or a computer gives another (a Chrome). */
    browserEngine?: BrowserEngine;
    /** Where the release notes are (`whatsnew/<version>.md`, PP-235); tests give their own. Default: the app's. */
    whatsNewDir?: string;
    /** Computer control's machines and how it runs a script on one (PP-178): the app's machines and ssh, unless a test gives its own. */
    computer?: Pick<ComputerControlOptions, "machines" | "launch" | "idleEndMs" | "refreshMs">;
    /** The owner token to have (`ConfigStore`): the server edition's gateway gives each person's container its own. */
    ownerToken?: string;
    /**
     * Behind the server edition's gateway (PP-21): accounts, sign-out, people and devices are the gateway's, so the page
     * offers the gateway's account page for them.
     */
    gateway?: boolean;
    /**
     * The gateway's internal address (PP-40), for the services pi-phones share there (the team's boards). Given with
     * `ownerToken`, which is how the gateway knows this pi-phone.
     */
    gatewayUrl?: string;
    /** Where OpenAI is and whose sign-in voice uses (`voice.ts`): tests stand in a fake OpenAI and a token. */
    voice?: { endpoints?: VoiceEndpoints; auth?: () => Promise<{ token: string; account?: string } | undefined>; fetch?: typeof fetch };
}

/** A Codex token's ChatGPT account, as voice sends it. */
function withAccount(token: string): { account?: string } {
    const account = chatgptAccount(token);

    return account === undefined ? {} : { account };
}

/** A send limit as given: a whole number of 1 to 10000 an hour, or null for none. */
function checkSendLimit(limit: unknown): number | null {
    if (limit === null) {
        return null;
    }

    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 10_000) {
        throw new HttpError(400, "The limit is a whole number from 1 to 10000 an hour, or null for none.");
    }

    return limit;
}

export class PocketApp {
    readonly config: ConfigStore;
    readonly approvals = new Approvals((id) => this.attribution.requesterOf(id));
    /** What the app's background service notifies the owner of (`phone-events.ts`). */
    readonly phoneEvents = new PhoneEvents();
    /** The same, as push notifications to the browsers that turned them on (`web-push.ts`, PP-127). */
    readonly webPush: WebPush;
    /** Pictures of pages, rendered by the app's service on the phone (`screenshots.ts`). */
    readonly screenshots = new Screenshots();
    /** Keys to the files beside a session's HTML page, for the page (`file-pages.ts`). */
    readonly filePages = new FilePages();
    /** What the app's service does for Pi's browser: make and remove its WebView (`PiBrowser.java`). */
    readonly browserRequests = new PhoneRequests("Pi's browser");
    /** Pi's browser on the phone (`browser/pi-browser.ts`): the pages Pi uses, that the owner watches and can take over. */
    /** The phone's browser engine (`PiBrowser.java`'s WebViews), shared by every session's browser on the phone. */
    readonly #phoneEngine: BrowserEngine;
    readonly #whatsNewDir: string;
    /** pi-phone's own settings (`phone.json`): the Claude Code billing patch. */
    readonly phoneSettings: PhoneSettingsFile;
    /** Start the server again (the HTTP layer's, under the pi-phone app): Pi's server.restart action. */
    restart: (() => void) | undefined;
    /** Pi's browsers on machines, by machine id: a Chrome there for sessions working there, made on first use. */
    /** Each machine's browser engine (a Chrome there, one profile), made on first use. */
    readonly #machineEngines = new Map<string, BrowserEngine>();
    /** Pi's browsers, one per place and session (`<place>#<session>`), each with its own tabs there (PP-13). */
    readonly #browsers = new Map<string, PiBrowser>();
    /** Which session owns each tab of each place's engine. */
    readonly #tabOwners: TabOwners;
    /** The size each session's browser lays pages out at (PP-18). */
    readonly #browserSizes: BrowserSizes;
    /** The sweep that closes idle sessions' tabs, and those of sessions archived or deleted. */
    #browserSweep: NodeJS.Timeout | undefined;
    /** Approvals the phone was told of already. */
    readonly #toldApprovals = new Set<string>();
    readonly dataDir: string;
    readonly defaultCwd: string;
    readonly supervised: boolean;
    /** Behind the server edition's gateway (`OpenOptions.gateway`). */
    readonly gateway: boolean;
    /** The team server's gateway, for the services pi-phones share (PP-40); undefined elsewhere. */
    readonly #teamServer: { url: string; token: string } | undefined;
    /** The person's role's policy, from the gateway (`policy.ts`, PP-22). */
    readonly policy: PolicyStore;
    readonly startedAt = Date.now();
    /** How other devices reach this server: the Tailscale address while it listens there (`setReach`). */
    access: AccessInfo | undefined;
    /** The Tailscale listener (`tailnet.ts`), set by `main.ts` once it serves; undefined in tests that serve nothing. */
    tailnet: Tailnet | undefined;
    /** The port the server listens on (`main.ts`), for the phone's own WebView; undefined in tests that serve nothing. */
    serverPort: number | undefined;
    harness!: Harness;
    models!: ModelRuntime;
    settings!: SettingsManager;
    loader!: ExtensionLoader;
    readonly commands = new Commands(this);
    readonly extensionCommands = new ExtensionCommands(this);
    readonly collab = new Collab(this);
    readonly interviewHelpers = new InterviewHelpers(this);
    readonly providers = new Providers(this);
    /** Model requests that hit a limit wait for it to clear, then go on (`limit-gate.ts`, PP-135). */
    readonly limits: LimitGate;
    readonly schedules = new Schedules(this);
    readonly goals = new Goals(this);
    readonly shell = new Shell(this);
    readonly spend = new Spend(this);
    /** Who Pi works for in each conversation, and who wrote and queued each message. */
    readonly attribution = new Attribution(this);
    /** The conversation's folder: files, the viewer, changes, and uploads. */
    readonly workspace = new Workspace(this);
    /** The conversation's stored history, as people read it. */
    readonly transcripts = new Transcripts(this);
    /** Pi's sessions, from this phone's Pi folder or imported from elsewhere, which the owner can continue here. */
    readonly piSessions = new PiSessions(this);
    readonly piHandoff = new PiHandoff(this);
    /** Each person's favorite working folders, shared by their devices. */
    readonly folderFavorites = new FolderFavorites(this);
    readonly sessionGroups = new SessionGroups(this);
    readonly autoCompact = new AutoCompact(this);
    /** The app's `gh` and `git` signed in to GitHub (`github-login.ts`). */
    readonly github = new GitHubLogin();
    /** The app's SSH keys, for machines (`ssh-keys.ts`). */
    readonly sshKeys: SshKeys;
    /** The app's ssh-agent: it holds the SSH keys, and signs the app's own ssh with them (`ssh-agent.ts`). */
    readonly sshAgent: SshAgent;
    /** The owner's secrets: values for commands that name them, never for the model (`secrets.ts`). */
    readonly secrets: Secrets;
    /**
     * Values extensions hide from what commands and tools give back and people send (`hidden.ts`, `host.hide`): redacted
     * with the secrets, in the session they are hidden in (and its subagents).
     */
    readonly hidden = new HiddenValues((id) => Number(this.rootOf(id as unknown as ConversationId)));
    /** What extensions add to the environment of each command (`hidden.ts`, `host.commandEnv`). */
    readonly commandEnvs = new CommandEnvs((line) => this.log(line));
    /** Web search's provider, its key from Pi's sign-ins or the secrets, and self-hosted addresses (`web/access.ts`). */
    readonly web: WebSearch;
    /** Other computers sessions can work on, over ssh (`machines.ts`). */
    readonly machines: Machines;
    /** More accounts of a subscription provider, each a provider of its own (`accounts.ts`). */
    readonly accounts: Accounts;
    /** The team's provider accounts on the team server (`team-accounts.ts`, PP-69). */
    readonly teamAccounts: TeamAccountsClient;
    readonly teamMachines: TeamMachinesClient;
    /** The subscription accounts' plan limits (`usage-limits.ts`). */
    readonly usageLimits: UsageLimits;
    /** Voice with the ChatGPT sign-in (PP-185): calls and Codex dictation (`voice.ts`). */
    readonly voice: VoiceService;
    /** The server's side of a call once it is set up: Pi's work in, Pi's words out (`voice-bridge.ts`). */
    readonly voiceBridge: VoiceBridge;
    /** Word, Excel, and PowerPoint files for Pi's bash and the Files viewer (`officecli.ts`). */
    readonly officecli: OfficeCli;
    /** Tools pi-phone installs on machines: OfficeCLI, rg, fd (`machine-tools.ts`). */
    readonly machineTools: MachineTools;
    /** Where sessions work, here or on a machine, and each place's execution environment (`places.ts`). */
    readonly places: Places;
    /** Ports of machines opened here (`forwards.ts`). */
    readonly forwards: Forwards;
    /** Pi controls phones (`phone-control.ts`, PP-141): control sessions, the Never list, the phone's service channel. */
    readonly phoneControl: PhoneControl;
    readonly computerControl: ComputerControl;
    /** The PARA wiki (`para.ts`). */
    readonly para: Para;
    readonly paraCapture: ParaCapture = new ParaCapture(this);
    /** Sessions acting on other sessions (`session-control.ts`). */
    readonly sessionControl = new SessionControl(this);
    /** Theme folders: the app's look and layout, built in and the owner's (`themes.ts`). */
    readonly themes: Themes;
    /** What extension modules add to the app: their routes, browser modules, and events (`extension-web.ts`). */
    readonly webs: ExtensionWebs;
    #websTimer: NodeJS.Timeout | undefined;
    /** Whose tabs the next `hello` for browser modules goes to: those who may use any of these. */
    readonly #websFor = new Set<WebAccess>();
    /** Whether everyone's tabs must hear `hello` again, for a change to the modules' commands. */
    #websAll = false;
    readonly #clients = new Set<Client>();
    readonly #rooms = new Map<ConversationId, Promise<Room>>();
    readonly #busy = new Set<ConversationId>();
    /** Conversations with a compaction going: its request may wait for a limit too. */
    readonly #compacting = new Set<ConversationId>();
    /** Conversations that were in a wait for a limit, or are now: their views and the session list show the change. */
    #limitWaiting = new Set<number>();
    /** The account card of each waiting conversation (`limitOffer`), by the wait it was made for. */
    readonly #limitOffers = new Map<number, { key: string; offer?: LimitOffer }>();
    /** When each busy session's run began: the list says how long it has been working. */
    readonly #busySince = new Map<ConversationId, number>();
    /** When each conversation's last run ended, since this server started: peek tiles show sessions done since a look. */
    readonly #endedAt = new Map<ConversationId, number>();
    /**
     * Conversations whose last run ended because the model or provider failed (not stopped by someone), since this
     * server started: the session list marks them until their next run starts.
     */
    readonly #failed = new Set<ConversationId>();
    readonly #agents = new Map<ConversationId, AgentState>();

    /** The newest chat message (not activity) of each conversation, for unread dots in the session list. */
    readonly #lastChat = new Map<string, { at: number; userId: string }>();
    /** Subagent conversation → the conversation that spawned it. */
    readonly #parents = new Map<ConversationId, ConversationId>();
    /** Each conversation's subagents, and those with a report on its way to it: for the board and the session list. */
    readonly #subagents = new Map<ConversationId, SubagentsOf>();
    #sessions: Record<string, SessionMeta> = {};
    #sessionsTimer: NodeJS.Timeout | undefined;
    /** The extensions installed now: every conversation runs with them, except PiP's own, which PiP alone selects. */
    #registry: Registry | undefined;
    #unsubscribeCommits: (() => void) | undefined;
    #unsubscribeApprovals: (() => void) | undefined;
    #lockFile: string;
    readonly #lockWaitMs: number | undefined;
    #closing: Promise<void> | undefined;
    /** This process's data lock, once taken: released last, when the storage is closed (`lock.ts`). */
    #releaseLock: (() => void) | undefined;
    /** The storage between opening it and the harness taking it: closed by `close` if the harness never opened. */
    #openingStorage: Awaited<ReturnType<typeof openNodeSqliteStorage>> | undefined;
    readonly #log: (line: string) => void;
    readonly #configureModels: ((models: ModelRuntime) => void) | undefined;
    readonly #home: string;
    /** The clock durable work runs by. */
    readonly now: () => number;

    private constructor(options: OpenOptions) {
        this.#configureModels = options.configureModels;
        this.#home = options.home ?? (process.env.HOME || homedir());
        this.now = options.now ?? Date.now;
        this.dataDir = options.dataDir;
        this.defaultCwd = options.defaultCwd;
        this.supervised = options.supervised;
        this.gateway = options.gateway === true;
        this.#teamServer = options.gatewayUrl !== undefined && options.ownerToken !== undefined ? { url: options.gatewayUrl.replace(/\/+$/, ""), token: options.ownerToken } : undefined;
        this.config = new ConfigStore(options.dataDir, options.ownerToken === undefined ? {} : { ownerToken: options.ownerToken });
        this.webPush = new WebPush({ file: join(options.dataDir, "web-push.json"), log: (line) => this.log(line) });
        this.phoneEvents.onPosted((event) => void this.#pushEvent(event));
        // The app's own ssh (`ssh/` in the data folder): its agent holds the keys, which the database keeps.
        const sshDir = join(options.dataDir, "ssh");

        this.sshAgent = new SshAgent(sshDir, (line) => this.log(line));
        this.sshKeys = new SshKeys(options.dataDir, this.sshAgent, sshDir, this.#home);
        this.secrets = new Secrets(options.dataDir, Date.now, (line) => this.log(line), this.hidden);
        this.policy = new PolicyStore(options.dataDir);
        this.web = new WebSearch(this.config, this.secrets, async (provider) => (await this.models.getAuth(provider))?.auth.apiKey);
        // Every tab's machines (the folder picker, Ports, Pi sessions on a machine) come with `hello`: a machine connected,
        // renamed, or removed reaches them at once, not at their next connection. A changed machine's connection and
        // environments go too: sessions there reconnect with its new address, key or host key (PP-87).
        this.machines = new Machines(options.dataDir, this.sshKeys, sshDir, this.sshAgent, this.#home, (id) => {
            if (id !== undefined) {
                this.places.forget(id);
            }

            void this.#refreshClients().catch((error: unknown) => this.log(`machines not sent to the tabs: ${describe(error)}`));
        });
        this.places = new Places(this.machines, () => this.#toolPath());
        // The team server's machines this person may use (PP-82): into Machines, reached through its relay and agent.
        this.teamMachines = new TeamMachinesClient(this.#teamServer, sshDir, (line) => this.log(line), (entries, manage) => this.machines.setTeam(entries, manage));
        this.accounts = new Accounts(options.dataDir, () => this.models, options.accountProviders);
        // A team account's sign-in steps go to this pi-phone's person, as their own sign-ins' do (not to teammates).
        const phoneSettings = new PhoneSettingsFile(options.dataDir);

        this.phoneSettings = phoneSettings;
        this.teamAccounts = new TeamAccountsClient(
            this.#teamServer,
            (data) => {
                for (const client of this.clients) {
                    if (client.user.role === "owner") {
                        client.send("auth", data);
                    }
                }
            },
            // The billing patch is made on the team server for its Claude subscriptions, with this person's setting (PP-74).
            () => phoneSettings.current().claudeCodeBilling,
        );

        this.usageLimits = new UsageLimits({
            models: () => this.models,
            claudeVersion: () => phoneSettings.current().claudeCodeBilling.version,
            publish: (usage) => {
                for (const client of this.#clients) {
                    client.send("usage", usage);
                }
            },
            ...(options.usageFetch === undefined ? {} : { fetch: options.usageFetch }),
        });
        this.voice = new VoiceService({
            auth:
                options.voice?.auth ??
                (async () => {
                    const token = (await this.models.getAuth("openai-codex"))?.auth.apiKey;

                    return token === undefined || token === "" ? undefined : { token, ...withAccount(token) };
                }),
            settings: () => this.config.voice,
            check: () => this.config.voiceCheck,
            saveCheck: (check) => {
                this.config.voiceCheck = check;
            },
            usedToday: () => this.spend.voiceToday(),
            used: (kind, seconds) => this.spend.voiceUsed(kind, seconds),
            joined: (call) => void this.voiceBridge.join(call),
            ended: (call) => void this.voiceBridge.leave(call.id),
            ...(options.voice?.endpoints === undefined ? {} : { endpoints: options.voice.endpoints }),
            ...(options.voice?.fetch === undefined ? {} : { fetch: options.voice.fetch }),
            now: () => this.now(),
        });
        this.voiceBridge = new VoiceBridge({
            service: this.voice,
            settings: () => this.config.voice,
            plan: (session) => this.voicePlan(session as unknown as ConversationId),
            watch: (session, listener) => this.#watchVoice(session as unknown as ConversationId, listener),
            submit: async (call, text) => {
                const id = call.session as unknown as ConversationId;

                await this.commands.submit(id, this.#voiceUser(call.userId), {
                    text: `${VOICE_PREFIX}${text}`,
                    mode: this.isBusy(id) ? "steer" : "followUp",
                    requestId: randomUUID(),
                });
            },
            stop: (call) => this.commands.abort(call.session as unknown as ConversationId, this.#voiceUser(call.userId)),
            said: (call, turns) => this.commands.voiceTurns(call.session as unknown as ConversationId, this.#voiceUser(call.userId), turns, call.mode === "chat", call.model),
            toPage: (call, events) => {
                for (const client of this.#clients) {
                    if (client.user.id === call.userId) {
                        client.send("voice", { call: call.id, events });
                    }
                }
            },
            say: (call, text) => {
                for (const client of this.#clients) {
                    if (client.user.id === call.userId) {
                        client.send("voice", { call: call.id, say: text });
                    }
                }
            },
            log: (line) => this.log(line),
            now: () => this.now(),
        });
        this.officecli = new OfficeCli({ dataDir: options.dataDir, ...options.officecli });
        this.machineTools = new MachineTools(this.places, (id) => this.machines.get(id), (id, tools) => this.machines.setTools(id, tools));
        this.officecli.install();
        // The owner's tabs get the open ports again on every change, and hear why one closed by itself (PP-108).
        this.forwards = new Forwards(this.machines, (ended) => {
            if (ended !== undefined) {
                this.ownerNotice("warning", `Port ${ended.forward.remotePort} of ${ended.forward.machine} closed: ${ended.reason}`);
            }

            for (const client of this.#clients) {
                if (client.user.role === "owner") {
                    client.send("forwards", { forwards: this.forwards.list() });
                }
            }
        });
        this.#phoneEngine = options.browserEngine ?? new PhoneEngine(this.browserRequests);
        this.#whatsNewDir = options.whatsNewDir ?? WHATS_NEW_DIR;
        this.phoneControl = new PhoneControl({ dataDir: options.dataDir, gateway: this.gateway, now: this.now, log: (line) => this.log(line) });
        // The owner's tabs show a session's live line while Pi uses the phone, and its Stop.
        this.phoneControl.onChange(() => {
            for (const client of this.#clients) {
                if (client.user.role === "owner") {
                    client.send("phone-control", { sessions: this.phoneControl.view() });
                }
            }
        });
        // Pi controls computers (PP-178): one `ocu mcp`, and the window that says so, per session, through the app's ssh.
        this.computerControl = new ComputerControl({
            dataDir: options.dataDir,
            gateway: this.gateway,
            now: this.now,
            log: (line) => this.log(line),
            machines: () =>
                this.machines.list().map((machine) => ({
                    id: machine.id,
                    name: machine.name,
                    ...(machine.remote === undefined ? {} : { platform: machine.remote.platform }),
                    connected: machine.remote !== undefined,
                    ...(machine.tools === undefined ? {} : { tools: machine.tools }),
                })),
            launch: (id, script) =>
                spawn("ssh", [...sshArguments(this.machines.target(this.machines.ready(id))), `sh -c ${shellWord(script)}`], { stdio: ["pipe", "pipe", "pipe"] }),
            refreshTools: async (id) => {
                await this.machineTools.status(id);
            },
            ...options.computer,
        });
        this.computerControl.onChange(() => {
            for (const client of this.#clients) {
                if (client.user.role === "owner") {
                    client.send("computer-control", { sessions: this.computerControl.view() });
                }
            }
        });
        // The panel: what a session's computer shows and does (the owner's tabs), and its pictures (the tabs that watch).
        this.computerControl.onPanel((panel) => {
            for (const client of this.#clients) {
                if (client.user.role === "owner") {
                    client.send("computer", panel);
                }
            }
        });
        this.computerControl.onFrame((frame) => {
            for (const client of this.#clients) {
                if (client.computerWatch === frame.session) {
                    client.send("computer-frame", frame);
                }
            }
        });
        this.#tabOwners = new TabOwners(join(options.dataDir, "browser-tabs.json"));
        this.#browserSizes = new BrowserSizes(join(options.dataDir, "browser-sizes.json"));
        this.para = new Para({
            home: this.#home,
            apiKey: async (provider) => (await this.models.getAuth(provider))?.auth.apiKey,
            models: () =>
                this.models.getAvailableSnapshot().map((model) => ({ provider: model.provider, id: model.id, name: model.name })),
            remote: (cwd) => {
                if (!isRemote(cwd)) {
                    return undefined;
                }

                return { path: parsePlace(cwd).path, env: this.places.env(cwd) };
            },
            spent: (usage) => this.spend.wikiUsed(usage),
            log: (message) => this.#log(message),
        });
        this.#lockFile = join(options.dataDir, "harness.lock");
        this.#lockWaitMs = options.lockWaitMs;
        this.#log = options.log ?? ((line) => console.log(line));
        // After the log: reading the gates kept by the last run may say why it ignored them.
        this.limits = new LimitGate({
            hours: () => this.config.limitWaitHours,
            epoch: (provider) => this.providers.signInEpoch(provider),
            conversationOf: (sessionId) => this.#conversationOfSession(sessionId),
            usage: (provider) => this.#usageWindows(provider),
            modelOf: (provider, modelId) => this.models.getModel(provider, modelId),
            changed: () => this.#limitsChanged(),
            started: (conversationId, view) => this.#limitNotice(conversationId, view),
            log: (line) => this.#log(line),
            file: join(options.dataDir, "provider-limits.json"),
            ...(options.limits === undefined ? {} : { tuning: options.limits }),
        });
        this.themes = new Themes({
            builtIn: join(APP_ROOT, "web", "themes"),
            dataDir: options.dataDir,
            notify: (message) => this.ownerNotice("warning", message),
            // Everyone's tabs: a theme anyone may have chosen changed, or one came or went.
            changed: () => {
                const lists = { owner: this.themes.list(true), others: this.themes.list(false) };

                for (const client of this.#clients) {
                    client.send(
                        "themes",
                        client.user.role === "owner" ? lists.owner : lists.others,
                    );
                }

                void this.#themeDefaultStillHere();
            },
            log: (line) => this.#log(line),
        });
        this.webs = new ExtensionWebs({
            changed: (access) => this.#websChanged(access),
            deliver: (part, access, event, data, to) => {
                for (const client of this.#clients) {
                    if (
                        (to === undefined || client.user.id === to) &&
                        mayUse(client.user, access)
                    ) {
                        client.send("ext", { module: part.module, event, data });
                    }
                }
            },
            // Everyone's tabs hear the new list in `hello`: commands are for guests too, not by a browser module's access.
            commandsChanged: () => this.#websChanged("all"),
            log: (line) => this.#log(line),
            // Something about a module only the owner can mend: their tabs, as what it says can name the server's folders.
            warn: (message) => this.ownerNotice("warning", message),
        });
    }

    /**
     * Browser modules came, went, or changed: the tabs of the people they are for hear which to load, once for changes
     * that come together.
     */
    #websChanged(access: readonly WebAccess[] | "all"): void {
        if (this.#closing !== undefined) {
            return;
        }

        if (access === "all") {
            this.#websAll = true;
        } else {
            for (const each of access) {
                this.#websFor.add(each);
            }
        }

        if (this.#websTimer !== undefined) {
            return;
        }

        this.#websTimer = setTimeout(() => {
            const changed = [...this.#websFor];
            const all = this.#websAll;

            this.#websTimer = undefined;
            this.#websFor.clear();
            this.#websAll = false;
            void this.#refreshClients((user) => all || changed.some((each) => mayUse(user, each)));
        }, 50);
    }

    /** Write a line to the server log. */
    log(line: string): void {
        this.#log(line);
    }

    static async open(options: OpenOptions): Promise<PocketApp> {
        const app = new PocketApp(options);

        try {
            await app.#open();
        } catch (error) {
            // What it opened (the keys, the storage, modules) closes before the lock goes, so the next start finds
            // nothing of this one held.
            if (app.#releaseLock !== undefined) {
                await app.close();
            }

            throw error;
        }

        app.#markReady();

        return app;
    }

    /** Opened: sessions read back and the harness up. Extensions load before this, so they wait for it (`host.ready`). */
    #markReady: () => void = () => {};
    readonly #ready = new Promise<void>((resolve) => {
        this.#markReady = resolve;
    });

    async #open(): Promise<void> {
        // A server before this one may still be stopping (the phone's service started this one as it closed): wait for it.
        this.#releaseLock = await waitForLock(this.#lockFile, {
            log: (line) => this.#log(line),
            ...(this.#lockWaitMs === undefined ? {} : { waitMs: this.#lockWaitMs }),
        });
        // The keys into the agent (moved into the database first, from files, once): before anything connects.
        await this.sshKeys.open();

        this.settings = SettingsManager.create(this.defaultCwd);

        try {
            configureHttp(
                this.settings.getHttpIdleTimeoutMs() || 2_147_483_647,
                this.settings.getGlobalSettings().httpProxy,
            );
        } catch (error) {
            this.#log(`HTTP setup failed, using Node defaults: ${describe(error)}`);
        }

        this.models = await ModelRuntime.create();
        this.providers.modelRefresh.watch(this.models);
        this.#configureModels?.(this.models);
        // Before anything reads the models: sessions on an account's models resume with it there.
        this.accounts.registerAll();
        // And the team's accounts this person may use, on the team server (PP-69): before sessions on them resume too.
        await this.syncTeamAccounts(false);
        // The team's machines (PP-82): their relay and agent, then the list, before sessions on them resume.
        await this.teamMachines.start();
        await this.syncTeamMachines();
        measureModelStreams(this.models);
        // Outside the timing wrapper, so each attempt is timed on its own, not the wait before it; inside the image guard,
        // so a request's images are shrunk once, not at every try.
        this.limits.install(this.models);
        await this.models.getAvailable().catch(() => []);

        const registry = createRegistry();

        // Pi Durable's coding tools, as `createCodingTools()` makes them, but for two things. `read` returns images as
        // images, oriented and shrunk to the model's limits by Photon (WebAssembly), in a worker. And `bash` runs a command
        // that names a secret (`$NPM_TOKEN`) with its value in the environment, where the session may use it: the command
        // keeps the name, so the value is in no transcript (`secrets.ts`). `edit`, `write` and `bash` run in their batch's
        // order with each other (`batch-order.ts`): a bash after an edit sees the edit.
        const images = await createNodePhotonImages();

        // No image over 2000 px a side reaches a model: one would fail every request after it (`image-guard.ts`).
        installImageGuard(this.models, images, (line) => this.#log(line));

        registry.install(
            defineExtension({
                name: "coding-tools",
                tools: [
                    createReadTool({ images }),
                    inBatchOrder(createWriteTool()),
                    inBatchOrder(createEditTool()),
                    inBatchOrder(createBashTool({
                        prepare: async (execution, api, context) => {
                            const cwd = (await api.agent(context)).cwd ?? this.defaultCwd;

                            // On the phone, `pi-ssh` (the app's machines, through its agent) and `officecli` are on the PATH.
                            if (!isRemote(cwd)) {
                                execution.env.PATH = this.#toolPath();
                            } else {
                                // On a machine, the tools pi-phone installed there come first (`machine-tools.ts`).
                                execution.command = `PATH="$HOME/${TOOLS_BIN}:$PATH"; export PATH\n${execution.command}`;
                            }

                            const named = namesIn(execution.command);

                            if (named.length === 0) {
                                return;
                            }

                            const env = this.secrets.environment(named, cwd);

                            Object.assign(execution.env, env);
                            this.secrets.used(Object.keys(env));
                        },
                    })),
                ],
            }),
        );
        // Durable work of the app itself, whatever extension modules are on.
        registry.install(
            defineExtension({
                name: "pocket-core",
                tasks: [
                    ResendTask,
                    this.shell.task,
                    this.commands.followTask,
                    this.extensionCommands.task,
                ],
            }),
        );
        const host: PocketHost = {
            approvals: this.approvals,
            agentDir: getAgentDir(),
            dataDir: this.dataDir,
            skillPaths: () => {
                try {
                    return this.settings.getSkillPaths();
                } catch {
                    return [];
                }
            },
            skills: (cwd) => this.skills(cwd),
            machineOf: (cwd) => {
                const machine = this.places.machineOf(cwd);

                return machine === undefined
                    ? undefined
                    : {
                          name: machine.name,
                          address: `${machine.user}@${machine.host}${machine.port === undefined ? "" : `:${machine.port}`}`,
                          path: parsePlace(cwd).path,
                          platform: machine.remote === undefined ? "unknown" : `${machine.remote.platform} ${machine.remote.arch}`,
                          tools: machine.tools ?? {},
                      };
            },
            serverBase: () => (this.serverPort === undefined ? undefined : `http://127.0.0.1:${this.serverPort}`),
            render: (url, options) => this.screenshots.render(url, options),
            browserFor: (cwd, session) => this.browserFor(cwd, session),
            browserRunModel: (id) => this.sessionMeta(this.rootOf(id))?.browserRunModel ?? this.config.browserRunModel,
            apiKey: async (provider) => (await this.models.getAuth(provider))?.auth.apiKey,
            askSessionModel: async (id, prompt, maxTokens) => (await askSessionModel(this, id, prompt, { maxTokens })).text,
            chargeSession: (id, key, usage) => chargeSession(this, id, key, usage),
            machineSkills: (cwd) => {
                const machine = this.places.machineOf(cwd);

                if (machine?.remote === undefined) {
                    return undefined;
                }

                const skills = this.machineTools.catalog.flatMap((tool) => {
                    const version = machine.tools?.[tool.id];

                    return tool.skills === undefined || version === undefined
                        ? []
                        : machineToolSkills(resolve(APP_ROOT, tool.skills), machineSkillsDir(machine.remote!.home, tool, version), getAgentDir());
                });
                const text = formatSkillsForPrompt(skills, "read").trim();

                return text === "" ? undefined : text;
            },
            machines: () =>
                this.machines
                    .sshHosts()
                    .filter(({ machine }) => machine.remote !== undefined)
                    .map(({ machine, alias }) => ({
                        id: machine.id,
                        name: machine.name,
                        alias,
                        address: `${machine.user}@${machine.host}${machine.port === undefined ? "" : `:${machine.port}`}`,
                        home: machine.remote!.home,
                        windows: machine.remote!.platform === "windows",
                        askRun: machine.askRun === true,
                    })),
            home: this.#home,
            resolveModel: (spec) => resolveModel(this.models, spec, this.signInNeeded),
            subagentModels: () => this.config.subagentModels,
            docsImages: {
                model: () => this.config.docsImageModel,
                models: () => this.imageModels(),
                choose: (model) => this.setDocsImageModel(this.#person(this.config.users.find((user) => user.role === "owner")!.id), model),
                describe: (mime, data, prompt) => this.describeImage(mime, data, prompt),
            },
            modelProblem: (ref, fresh) => this.providers.problem(ref, fresh),
            requesterOf: (conversationId) => this.attribution.requesterOf(conversationId),
            ready: () => this.#ready,
            people: () => this.config.users.map((user) => ({ id: user.id, name: user.name, role: user.role })),
            devices: (userId) => this.devices(this.#person(userId)),
            signOutDevice: (userId, id) => this.signOutDevice(this.#person(userId), id),
            appSettings: () => appSettings(this),
            person: (userId) => this.#person(userId),
            // From Pi no device is "this one": the owner's phone app signs in again by itself.
            signOutEverywhere: (userId) => this.signOutEverywhere(this.#person(userId)),
            startSession: async ({ userId, cwd, title, message, via }) => {
                const user = this.config.userById(userId);

                if (user === undefined) {
                    throw new HttpError(404, "That person is not in the app.");
                }

                const { id } = await this.commands.createSession(user, { cwd, title });

                await this.commands.submit(id, user, { text: message, requestId: randomUUID() }, via);

                return Number(id);
            },
            sendToSession: async ({ userId, session, message, via }) => {
                const user = this.config.userById(userId);

                if (user === undefined) {
                    throw new HttpError(404, "That person is not in the app.");
                }

                await this.commands.submit(
                    session as unknown as ConversationId,
                    user,
                    { text: message, requestId: randomUUID(), mode: "followUp" },
                    via,
                );
            },
            onSessionEvent: (listener) =>
                this.phoneEvents.subscribe((event) => listener({ kind: event.kind, session: event.session, text: event.text })),
            quietSessions: (test) => this.phoneEvents.quiet(test),
            run: async (cwd, command, timeoutSeconds = 120) => {
                const folder = await this.workspace.checkPlace(cwd);
                let stdout = "";
                let stderr = "";
                const result = await this.places.env(folder).exec(
                    command,
                    {
                        timeout: timeoutSeconds,
                        onOutput: (text, _context, info) => {
                            if (info.stream === "stdout") {
                                stdout += text;
                            } else {
                                stderr += text;
                            }
                        },
                    },
                    context,
                );

                if (!result.ok) {
                    return { code: -1, stdout, stderr: `${stderr}${result.error.message}` };
                }

                return { code: result.value.exitCode ?? -1, stdout, stderr };
            },
            sessionTitle: (session) => this.sessionMeta(session as unknown as ConversationId)?.title,
            sessionMachine: (session) => (this.sessionMeta(session as unknown as ConversationId) === undefined ? undefined : this.places.machineOf(this.cwdOf(session as unknown as ConversationId))?.name),
            cwdOf: (id) => this.cwdOf(id),
            sharedCopy: {
                export: (session) => this.piHandoff.sessionFile(session as unknown as ConversationId),
                import: async (name, text) => {
                    const owner = this.config.users.find((user) => user.role === "owner")!;
                    const { path } = await this.piSessions.import(owner, name, Buffer.from(text));
                    const { id } = await this.commands.continuePiSession(owner, path, this.defaultCwd);

                    return { id: Number(id) };
                },
            },
            teammates: {
                save: (account) => this.#saveTeammate(account),
                remove: (id) => {
                    if (this.config.userById(id)?.role !== "owner") {
                        this.#forget(id);
                        this.#peopleChanged();
                    }
                },
                exists: (id) => this.config.userById(id) !== undefined,
            },
            sessionState: (session) => this.sessionState(session as unknown as ConversationId),
            lastAnswer: (session) => this.lastAnswer(session as unknown as ConversationId),
            settleSession: async (session, reason, ifUnset = false) => {
                if (this.sessionMeta(session as unknown as ConversationId) === undefined) {
                    return;
                }

                await this.harness.commit(async (tx) => {
                    const meta = (await tx.doc(SessionsDoc)).items[String(session)];

                    if (meta !== undefined && !(ifUnset && meta.settle !== undefined)) {
                        meta.settle = { state: "settled", at: Date.now(), reason };
                    }
                }, context);
            },
            groupSession: async (session, group) => {
                const current = this.sessionMeta(session as unknown as ConversationId);

                if (current === undefined || JSON.stringify(current.group ?? null) === JSON.stringify(group)) {
                    return;
                }

                await this.harness.commit(async (tx) => {
                    const meta = (await tx.doc(SessionsDoc)).items[String(session)];

                    if (meta === undefined) {
                        return;
                    }

                    if (group === null) {
                        delete meta.group;
                    } else {
                        meta.group = group;
                    }
                }, context);
            },
            canSee: (userId, conversationId) => {
                const user = this.config.userById(userId);

                return user !== undefined && this.canSee(user, conversationId);
            },
            ask: (request, askContext) => ask(this.approvals, request, askContext),
            dropIns: {
                replaces: (pkg) => this.dropInReplaces(pkg),
                install: (userId, pkg, replace) => this.installDropIn(this.#person(userId), pkg, replace),
            },
            hide: (value) => this.hidden.add(value),
            commandEnv: (provider) => this.commandEnvs.add(provider),
            notice: (level, message, conversationId) => this.notice(level, message, conversationId),
            heldBack: (conversationId) => this.spend.heldBack(conversationId),
            onLimitsChanged: (listener) => this.spend.onLimitsChanged(listener),
            schedules: this.schedules,
            sessions: this.sessionControl,
            para: this.para,
            secrets: this.secrets,
            policy: this.policy,
            machineStore: this.machines,
            sshKeys: this.sshKeys,
            machineTools: this.machineTools,
            phone: this.phoneControl,
            computer: this.computerControl,
            rootOf: (conversationId) => Number(this.rootOf(conversationId as unknown as ConversationId)),
            web: this.web,
            envOf: (cwd) => this.places.env(cwd),
            teamServer: this.#teamServer,
            syncTeamMachines: () => this.syncTeamMachines(),
            wikiCapture: this.paraCapture,
            goals: this.goals,
            text: Object.freeze({ quoted, defang }),
            thinkingLevels: THINKING_LEVELS,
        };

        this.#registry = registry;
        // The owner's drop-ins (the owner's decision, 2026-10-26): modules the owner puts in `<data>/extensions`, each off
        // until turned on. Nothing downloads them. Its `node_modules` leads to the app's, so they import the packages the
        // server runs.
        const dropIn = join(this.dataDir, "extensions");

        prepareDropInFolder(dropIn, join(APP_ROOT, "node_modules"));

        this.loader = new ExtensionLoader(
            registry,
            host,
            { builtIn: join(APP_ROOT, "src", "server", "extensions"), dropIn },
            (file) => this.config.extensionChoice(file),
            // What a module's load says can name the server's folders, or quote a provider: the owner's to read.
            { webs: this.webs, notify: (level, message) => this.ownerNotice(level, message) },
        );
        await this.themes.load().catch((error: unknown) => {
            this.#log(`Themes could not be read: ${describe(error)}`);
        });
        await this.#themeDefaultStillHere();
        await this.loader.loadAll();

        // Pi Durable 1.4 upgrades the database as it opens, one way: a checked copy first, or no start (PP-134).
        const copied = await safetyCopyBeforeUpgrade(this.dataDir);

        if (copied.made) {
            this.#log(`Kept a copy of the database before Pi 1.4's upgrade: ${copied.file} (${copied.bytes} bytes, removed after ${SAFETY_COPY_DAYS} days).`);
        } else if (copied.removed !== undefined) {
            this.#log(`Removed the database's copy from before Pi 1.4's upgrade (${SAFETY_COPY_DAYS} days old): ${copied.removed}.`);
        }

        const storage = await openNodeSqliteStorage(join(this.dataDir, "pocket.sqlite"));

        this.#openingStorage = storage;

        this.harness = await Harness.open(
            storage,
            {
                models: this.models,
                registry,
                settings: this.#harnessSettings(),
                now: this.now,
                // Commands' output with secrets' and hidden values replaced as it streams, and what extensions add to
                // each command's environment (`secrets.ts`, `hidden.ts`).
                env: ({ conversationId, cwd }) => this.#wrapped(conversationId, cwd ?? this.defaultCwd),
                conversationCreated: async (tx, conversation) => {
                    // Every conversation gets the app's documents up front, so views can read them from the start.
                    await tx.doc(AuthorsDoc, conversation.id);
                    await tx.doc(ArtifactsDoc, conversation.id);
                    await tx.doc(SubagentsDoc, conversation.id);
                },
                onReport: (error) => this.notice("warning", describe(error)),
            },
            context,
        );

        const conversations = await this.#recover(storage);

        await this.spend.load(conversations);
        await this.spend.loadVoice();

        this.#unsubscribeCommits = this.harness.subscribeCommits((publication) =>
            this.#committed(publication),
        );
        this.#unsubscribeApprovals = this.approvals.subscribe((id) => {
            // A call that waits for a person: the phone hears of it once, under its session.
            const pending = this.approvals.all();

            for (const request of pending) {
                if (!this.#toldApprovals.has(request.id)) {
                    this.#toldApprovals.add(request.id);
                    const session = this.rootOf(request.conversationId);

                    // Said in the owner's language when the phone fetches it (`inLanguage`, PP-85).
                    const asked: Said =
                        request.form?.type === "secret"
                            ? said("Pi asks for a secret: {name}", { name: request.form.name })
                            : request.form?.type === "ask"
                              ? said("Pi asks you: {title}", { title: request.form.title })
                              : request.form?.type === "extension"
                              ? said("Pi asks to install the extension {module}", { module: request.form.module })
                              : request.form?.type === "interview"
                              ? request.form.count === 1
                                  ? said("Pi has a question: {title}", { title: request.form.title })
                                  : said("Pi has {n} questions: {title}", { n: request.form.count, title: request.form.title })
                              : said("Pi asks to run {tool}: {subject}", { tool: request.tool, subject: request.subject.slice(0, 280) });
                    const title = this.#sessions[String(session)]?.title;

                    this.phoneEvents.add({
                        kind: "approval",
                        session: Number(session),
                        title: title ?? "Session",
                        text: translator("en")(asked.text, asked.vars).slice(0, 300),
                        say: { text: asked, ...(title === undefined ? { title: said("Session") } : {}) },
                    });
                }
            }

            for (const told of this.#toldApprovals) {
                if (!pending.some((request) => request.id === told)) {
                    this.#toldApprovals.delete(told);
                }
            }

            void this.#rooms.get(id)?.then(
                (room) => room.schedule(),
                () => {},
            );
            const root = this.rootOf(id);

            // A subagent's call waits on its session's peek tile too.
            if (root !== id) {
                void this.#rooms.get(root)?.then(
                    (room) => room.schedulePeek(),
                    () => {},
                );
            }

            this.#scheduleSessions();
        });

        // Work a previous process left unfinished continues now.
        this.harness.resume();
        // Idle sessions' captures into the wiki, from now on.
        this.paraCapture.start();
        // Tabs nobody uses cost memory (a WebView, a Chrome tab: 50–150 MB each): closed after a while.
        this.#browserSweep = setInterval(() => void this.sweepBrowsers(Date.now()), BROWSER_SWEEP_MS);
        this.#browserSweep.unref();
    }

    /**
     * Close the tabs of sessions' browsers nobody has used for `BROWSER_IDLE_MS` (not while Pi acts, someone watches, or a
     * person took over), and at once those of sessions archived or deleted. Sign-ins stay: they are the place's profile.
     */
    async sweepBrowsers(now: number): Promise<void> {
        for (const [key, browser] of this.#browsers) {
            const session = this.#sessions[key.slice(key.lastIndexOf("#") + 1)];
            const gone = session === undefined || session.archived === true;

            if (gone) {
                this.#browserSizes.set(key, undefined);
            }

            if (!browser.hasTabs || (!gone && browser.idleFor(now) < BROWSER_IDLE_MS)) {
                continue;
            }

            try {
                await browser.close();
                this.#log(`browser: closed ${key}'s tabs (${gone ? "session archived or deleted" : "idle"})`);
            } catch (error) {
                this.#log(`browser: closing ${key}'s tabs: ${String(error)}`);
            }
        }
    }

    /**
     * What this process keeps in memory about every conversation, read back from storage at startup: which are busy,
     * their agents, chat, subagents, and who Pi works for in each. Authors a crash kept out of the authors documents are
     * written back, in one commit. Returns every conversation's id.
     */
    async #recover(storage: Storage): Promise<ConversationId[]> {
        this.#sessions = { ...((await this.harness.snapshot(SessionsDoc, context))?.items ?? {}) };
        const conversations: ConversationId[] = [];
        const unrecorded = new Map<ConversationId, Missing[]>();
        let cursor: Cursor | undefined;

        do {
            const page = await this.harness.commit(
                (tx) => tx.scanConversations({}, 256, cursor),
                context,
            );

            for (const { id } of page.items) {
                conversations.push(id);
                const live = await this.harness.snapshot(LiveDoc, id, context);

                if (live?.run !== undefined) {
                    this.#busy.add(id);
                    this.#busySince.set(id, Date.now());
                }

                // A compaction that resumes asks the model too: it may wait for a limit.
                if ((live?.compactions?.length ?? 0) > 0) {
                    this.#compacting.add(id);
                }

                const agent = await this.harness.snapshot(AgentDoc, id, context);

                if (agent !== undefined) {
                    this.#agents.set(id, agent as AgentState);
                }

                this.#noteChat(id, (await this.harness.snapshot(ChatDoc, id, context))?.messages);
                const missing = await this.attribution.recover(
                    storage,
                    id,
                    await this.harness.snapshot(AuthorsDoc, id, context),
                );

                if (missing.length > 0) {
                    unrecorded.set(id, missing);
                }

                this.#noteSubagents(id, await this.harness.snapshot(SubagentsDoc, id, context));
            }

            cursor = page.next;
        } while (cursor !== undefined);

        await this.attribution.repair(unrecorded);

        return conversations;
    }

    /** Every commit, as Pi Durable publishes it: what the app keeps in memory follows it, and so do the open views. */
    #committed(publication: CommitPublication): void {
        let sessionsChanged = false;

        // Usage in a commit is from the work that was going on before it: it is counted before a message the same
        // commit places changes whom Pi works for.
        for (const change of publication.changes) {
            if (
                change.type === "document" &&
                change.record.kind === UsageDoc.definition.kind &&
                change.conversationId !== undefined
            ) {
                this.spend.usageChanged(change.conversationId, change.value as UsageState | null);

                // A team's top session with a limit shows the team's spend: it follows a linked session's too.
                const root = this.rootOf(change.conversationId);
                const top = this.spend.teamRoot(root);

                if (top !== root && this.#sessions[String(top)]?.budget !== undefined) {
                    void this.#rooms.get(top)?.then(
                        (room) => room.schedule(),
                        () => {},
                    );
                }
            }
        }

        for (const change of publication.changes) {
            if (change.type === "document") {
                if (this.#documentCommitted(change)) {
                    sessionsChanged = true;
                }
            } else if (change.type === "submission") {
                this.attribution.submissionCommitted(change.value);

                // A run that failed because its provider's sign-in could not be renewed marks that provider; one that
                // was answered shows its provider works, and a mark it had (signed in again in Pi's terminal app, say)
                // is asked again.
                const ranOn = this.#agents.get(change.value.conversationId)?.model?.provider;

                if (change.value.status === "unanswered" && change.value.reason === "model_error") {
                    this.providers.runFailed(change.value.detail);
                } else if (change.value.status === "done" && ranOn !== undefined) {
                    this.providers.runAnswered(ranOn);
                }

                // Its context past the session's auto-compact percentage (PP-78): it compacts.
                if (change.value.status === "done") {
                    const ref = this.#agents.get(change.value.conversationId)?.model;
                    const window = ref === undefined ? undefined : this.models.getModel(ref.provider, ref.modelId)?.contextWindow;

                    void this.autoCompact.afterRun(change.value.conversationId, window).catch((error: unknown) => this.log(`auto-compact: ${describe(error)}`));
                }

                // A run spent some of its account's plan: its figures are asked again (`usage-limits.ts`).
                if (ranOn !== undefined && (change.value.status === "done" || change.value.status === "unanswered")) {
                    this.usageLimits.afterRun(ranOn);

                    // A team subscription's (PP-74): asked of the team server, which keeps them a minute; every tab told.
                    if (this.teamAccounts.label(ranOn) !== undefined) {
                        void this.teamAccounts
                            .usage(true)
                            .then((found) => {
                                for (const usage of found.filter((each) => each.provider === ranOn)) {
                                    for (const client of this.#clients) {
                                        client.send("usage", usage);
                                    }
                                }
                            })
                            .catch((error: unknown) => this.log(`team usage not asked: ${describe(error)}`));
                    }
                }

                // Its run failed: the commit that settles it ends the run too, so the list hears of both at once.
                if (
                    change.value.status === "unanswered" &&
                    FAILED_RUN.has(change.value.reason) &&
                    this.#sessions[String(change.value.conversationId)] !== undefined &&
                    !this.#failed.has(change.value.conversationId)
                ) {
                    this.#failed.add(change.value.conversationId);
                    sessionsChanged = true;
                }
            }
        }

        if (sessionsChanged) {
            this.#scheduleSessions();
        }
    }

    /**
     * Pi started work in session `id` at `at`: it moves up the list, as a message sent there does, whatever started it
     * (a scheduled message, a subagent's report, a message sent again after a restart). One moved up since `at` (a
     * message through `Commands.submit` moves it too) is left as it is. A commit listener may not commit, so this commits
     * after it.
     */
    #movedUp(id: ConversationId, at: number): void {
        setImmediate(() => {
            this.harness
                .commit(async (tx) => {
                    const meta = (await tx.doc(SessionsDoc)).items[String(id)];

                    if (meta !== undefined && meta.updatedAt < at) {
                        meta.updatedAt = Date.now();
                    }
                }, context)
                .catch((error: unknown) => this.log(`session not moved up: ${describe(error)}`));
        });
    }

    /** A document changed: the views that show it update. True when the session list changed too. */
    #documentCommitted(change: Extract<DocumentCommitChange, { type: "document" }>): boolean {
        const kind = change.record.kind;
        const id = change.conversationId;
        let sessionsChanged = false;

        if (kind === "pi.live" && id !== undefined) {
            const busy = (change.value as LiveState | null)?.run !== undefined;

            // A compaction asks the model too (an idle session's manual one has no run): it may wait for a limit.
            if (((change.value as LiveState | null)?.compactions?.length ?? 0) > 0) {
                this.#compacting.add(id);
            } else {
                this.#compacting.delete(id);
            }

            if (busy !== this.#busy.has(id)) {
                if (busy) {
                    this.#busy.add(id);
                    this.#busySince.set(id, Date.now());
                    this.phoneControl.runStarted(Number(id));
                    this.computerControl.runStarted(Number(id));
                    // A new run starts over: whether it fails is its own to say.
                    this.#failed.delete(id);

                    if (this.#sessions[String(id)] !== undefined) {
                        this.#movedUp(id, Date.now());
                    }
                } else {
                    this.#busy.delete(id);
                    this.#busySince.delete(id);
                }

                sessionsChanged = true;

                if (!busy) {
                    this.spend.runEnded(id);
                    // Pi is done: its phone control session ends soon after, unless it goes on (`runEnded`).
                    this.phoneControl.runEnded(Number(id));
                    this.computerControl.runEnded(Number(id));

                    if (this.#sessions[String(id)] !== undefined) {
                        this.#endedAt.set(id, Date.now());
                        this.#tellPhone(id);
                    }
                }

                // A parent shows its subagents' busy state.
                for (const pending of this.#rooms.values()) {
                    void pending.then((room) => {
                        if (
                            Object.values(room.subagents).some(
                                (record) => record.conversationId === id,
                            )
                        ) {
                            room.schedule();
                        }
                    });
                }
            }
        } else if (kind === "pi.agent" && id !== undefined) {
            if (change.value !== null) {
                this.#agents.set(id, change.value as AgentState);
            }

            sessionsChanged = true;
        } else if (kind === SessionsDoc.definition.kind) {
            this.#sessions = {
                ...((change.value as { items?: Record<string, SessionMeta> } | null)?.items ?? {}),
            };
            sessionsChanged = true;

            // Views show a session's title, limit, and worktree from here.
            for (const pending of this.#rooms.values()) {
                void pending.then(
                    (room) => room.schedule(),
                    () => {},
                );
            }
        } else if (kind === FolderFavoritesDoc.definition.kind) {
            this.folderFavorites.committed(
                change.value as { users: Record<string, string[]> } | null,
            );
        } else if (kind === SessionGroupsDoc.definition.kind) {
            this.sessionGroups.committed(change.value as { users: Record<string, SessionGroupsOf> } | null);
        } else if (ROOM_DOCS.has(kind) && id !== undefined) {
            if (kind === ChatDoc.definition.kind) {
                if (
                    this.#noteChat(
                        id,
                        (change.value as { messages?: ChatMessage[] } | null)?.messages,
                    )
                ) {
                    sessionsChanged = true;
                }
            } else if (kind === SubagentsDoc.definition.kind) {
                this.#noteSubagents(id, change.value as SubagentsValue | null);
                // The list counts each session's subagents, and the board lists them.
                sessionsChanged = true;
            }

            void this.#rooms.get(id)?.then(
                (room) => room.setDoc(kind, change.value as Record<string, unknown> | null),
                () => {},
            );

            if (kind === TurnsDoc.definition.kind) {
                for (const pending of this.#rooms.values()) {
                    void pending.then(
                        (room) => {
                            if (room.id !== id && this.rootOf(room.id) === id) {
                                room.setDoc(kind, change.value as Record<string, unknown> | null);
                            }
                        },
                        () => {},
                    );
                }
            }
        }

        return sessionsChanged;
    }

    /** How model requests stream here: Pi's timeout and retries. Pi Durable's requests and PiP's summaries use them. */
    streamSettings(): { timeoutMs: number; maxRetryDelayMs?: number; maxRetries?: number } {
        const read = <T>(get: () => T): T | undefined => {
            try {
                return get();
            } catch {
                return undefined;
            }
        };

        const provider = read(() => this.settings.getProviderRetrySettings());
        const idle = read(() => this.settings.getHttpIdleTimeoutMs()) ?? 300_000;

        return {
            timeoutMs: provider?.timeoutMs ?? (idle === 0 ? 2_147_483_647 : idle),
            ...(provider?.maxRetryDelayMs === undefined
                ? {}
                : { maxRetryDelayMs: provider.maxRetryDelayMs }),
            ...(provider?.maxRetries === undefined ? {} : { maxRetries: provider.maxRetries }),
        };
    }

    #harnessSettings(): HarnessSettings {
        const settings = this.settings;

        const safe = <T>(read: () => T): T | undefined => {
            try {
                return read();
            } catch {
                return undefined;
            }
        };

        const registry = () => this.#registry;
        const stream = () => this.streamSettings();

        return {
            // Pi Durable 1.4 parks a task cut off 5 times in a row without a change. Android stops the app often, and a
            // phase may wait for hours (a provider's limit, PP-135) without changing: such kills must not park it.
            restartLimit: Infinity,
            // Every installed extension, in install order, but the wiki capture session's own: only it selects that.
            get extensions() {
                return registry()
                    ?.snapshot()
                    .installed()
                    .filter((extension) => extension.name !== CAPTURE_EXTENSION);
            },
            get stream() {
                return stream();
            },
            get compaction() {
                return safe(() => settings.getCompactionSettings()) ?? {};
            },
            get retry() {
                return safe(() => settings.getRetrySettings()) ?? {};
            },
            get steeringMode() {
                return safe(() => settings.getSteeringMode());
            },
            get followUpMode() {
                return safe(() => settings.getFollowUpMode());
            },
        } as HarnessSettings;
    }

    /** Where a conversation's commands run (its goals' checks): its folder, as its other commands run there. */
    envFor(id: ConversationId): ExecutionEnv {
        return this.#wrapped(id, this.cwdOf(id));
    }

    /**
     * A folder's environment for a session: output with the secrets and the session's hidden values replaced as it
     * streams, and what extensions add to each command's environment (`host.commandEnv`).
     */
    #wrapped(id: ConversationId, cwd: string): ExecutionEnv {
        return this.commandEnvs.wrap(this.secrets.guard(this.places.env(cwd), Number(id)), Number(id), cwd);
    }

    // ─── Clients ────────────────────────────────────────────────────────────

    notice(
        level: "info" | "warning" | "error",
        message: string,
        conversationId?: ConversationId,
    ): void {
        this.#log(`[${level}] ${message}`);

        for (const client of this.#clients) {
            // Server-wide notices can name other sessions' folders: people invited to one session do not get them. One
            // about PiP reaches the tabs with its panel open too: the panel has no notices of its own.
            const reaches =
                conversationId === undefined
                    ? client.user.sessions === undefined
                    : (client.conversationId === conversationId ||
                          client.pip?.conversationId === conversationId) &&
                      this.canSee(client.user, conversationId);

            if (reaches) {
                client.send("notice", { level, message });
            }
        }
    }

    /** A notice for the owner's tabs alone: about what only they may change. */
    ownerNotice(level: "info" | "warning" | "error", message: string): void {
        this.#log(`[${level}] ${message}`);

        for (const client of this.#clients) {
            if (client.user.role === "owner") {
                client.send("notice", { level, message });
            }
        }
    }

    /** Every open view builds itself again: what it shows from outside its documents changed (a model's sign-in). */
    /**
     * A session's run ended: the phone hears how (`phone-events.ts`), with the end of its last answer. After this
     * commit's other changes, so a failure the same commit settles is known.
     */
    #tellPhone(id: ConversationId): void {
        setImmediate(() => {
            void (async () => {
                const named = this.#sessions[String(id)]?.title;
                const title = named ?? "Session";
                // The app's own words are said in the owner's language when the phone fetches them (PP-85); Pi's are Pi's.
                const sayTitle = named === undefined ? { title: said("Session") } : {};

                if (this.#failed.has(id)) {
                    const failed = said("The run failed. Open it to see why.");

                    this.phoneEvents.add({ kind: "failed", session: Number(id), title, text: failed.text, say: { text: failed, ...sayTitle } });

                    return;
                }

                const text = (await this.lastAnswer(id)).slice(0, 300);

                this.phoneEvents.add({
                    kind: "done",
                    session: Number(id),
                    title,
                    text: text || "Done.",
                    say: { ...(text === "" ? { text: said("Done.") } : {}), ...sayTitle },
                });
            })().catch((error: unknown) => this.log(`phone not told: ${describe(error)}`));
        });
    }

    /** Where a session's work is now (the Projects extension's checks on its task sessions). */
    sessionState(id: ConversationId): { busy: boolean; busySince?: number; waiting: boolean; failed: boolean; endedAt?: number } | undefined {
        if (this.#sessions[String(id)] === undefined) {
            return undefined;
        }

        const busySince = this.#busySince.get(id);
        const endedAt = this.#endedAt.get(id);

        return {
            busy: this.#busy.has(id),
            ...(busySince === undefined ? {} : { busySince }),
            waiting: this.approvals.all().some((approval) => this.rootOf(approval.conversationId) === id),
            failed: this.#failed.has(id),
            ...(endedAt === undefined ? {} : { endedAt }),
        };
    }

    /** A session's last answer as one line, or empty. */
    async lastAnswer(id: ConversationId): Promise<string> {
        const view = await (await this.harness.conversation(id, context))?.context(context);
        const answer = view?.messages.findLast((message) => message.role === "assistant");

        return answer?.role === "assistant"
            ? answer.content
                  .flatMap((part) => (part.type === "text" ? [part.text] : []))
                  .join(" ")
                  .replace(/\s+/g, " ")
                  .trim()
            : "";
    }

    /** Session `id`'s view builds again: something it shows changed outside its documents. */
    refreshView(id: ConversationId): void {
        void this.#rooms.get(id)?.then(
            (room) => room.schedule(),
            () => {},
        );
    }

    refreshViews(): void {
        for (const pending of this.#rooms.values()) {
            void pending.then(
                (room) => room.schedule(),
                () => {},
            );
        }
    }

    // ─── Waiting for a provider's limit (`limit-gate.ts`, PP-135) ───

    /** The conversation whose generation or compaction sends requests under a provider session id: only those wait. */
    async #conversationOfSession(sessionId: string): Promise<number | undefined> {
        for (const id of new Set([...this.#busy, ...this.#compacting])) {
            const mine = await this.harness.snapshot(ProviderDoc, id, context).catch(() => undefined);

            if (mine?.sessionId === sessionId) {
                return Number(id);
            }
        }

        return undefined;
    }

    /** An account's plan windows now (its usage bars), asked afresh: a team account's of the team server. */
    async #usageWindows(provider: string): Promise<UsageWindow[] | undefined> {
        const usage =
            this.teamAccounts.label(provider) !== undefined
                ? (await this.teamAccounts.usage(true)).find((each) => each.provider === provider)
                : await this.usageLimits.get(provider, true);

        return usage === undefined || "error" in usage ? undefined : usage.windows;
    }

    /** The usage bars known now, without asking anyone new: kept ones, and the team's kept a minute on the team server. */
    async #usageKnown(provider: string): Promise<UsageWindow[] | undefined> {
        const usage =
            this.teamAccounts.label(provider) !== undefined
                ? (await this.teamAccounts.usage(false)).find((each) => each.provider === provider)
                : await this.usageLimits.get(provider);

        return usage === undefined || "error" in usage ? undefined : usage.windows;
    }

    /** A wait began, changed, or ended: views, the session list, and the account cards follow. */
    #limitsChanged(): void {
        const waits = this.limits.waits();
        const now = new Set(waits.map((wait) => wait.conversationId));
        const changed = new Set([...this.#limitWaiting, ...now]);

        this.#limitWaiting = now;

        for (const id of this.#limitOffers.keys()) {
            if (!now.has(id)) {
                this.#limitOffers.delete(id);
            }
        }

        for (const wait of waits) {
            this.#considerOffer(wait);
        }

        for (const id of changed) {
            const conversation = id as unknown as ConversationId;

            // A subagent's wait shows in its session too: its subagents bar, and its account card.
            for (const room of new Set([conversation, this.rootOf(conversation)])) {
                void this.#rooms.get(room)?.then(
                    (open) => open.schedule(),
                    () => {},
                );
            }
        }

        if (changed.size > 0) {
            this.#scheduleSessions();
        }
    }

    /**
     * The account card of a waiting conversation (owner's decision of 2026-10-24): its account hit a plan window's limit,
     * and another account of the same provider has room by its usage bars. Made once for each wait (and again when a
     * person said to wait: then none), from the bars known now; the view shows it when it is ready.
     */
    #considerOffer(wait: Waiting): void {
        const { view } = wait;
        const key = `${view.key}|${view.since}|${view.resetAt ?? ""}|${wait.declined}|${wait.modelId}`;

        if (this.#limitOffers.get(wait.conversationId)?.key === key) {
            return;
        }

        this.#limitOffers.set(wait.conversationId, { key });

        if (wait.declined || view.scope !== "account" || view.kind !== "reset" || view.resetAt === undefined) {
            return;
        }

        void this.#makeOffer(wait)
            .then((offer) => {
                const kept = this.#limitOffers.get(wait.conversationId);

                if (kept?.key !== key) {
                    return;
                }

                // None qualifies any more (made again after a refused answer): the view drops the card.
                if (offer === undefined) {
                    delete kept.offer;
                } else {
                    kept.offer = offer;
                }

                const id = wait.conversationId as unknown as ConversationId;

                void this.#rooms.get(this.rootOf(id))?.then(
                    (room) => room.schedule(),
                    () => {},
                );
            })
            .catch((error: unknown) => this.log(`limit card not made: ${describe(error)}`));
    }

    /**
     * Every account the waiting request may move to (owner's decision of 2026-10-24: the person chooses): the person's own
     * first, then the team server's shared ones (marked, as they spend the team's subscription), each the emptiest first.
     */
    async #makeOffer(wait: Waiting): Promise<LimitOffer | undefined> {
        const { view, modelId } = wait;

        if (view.resetAt === undefined) {
            return undefined;
        }

        const accounts: LimitOffer["accounts"] = [];

        for (const provider of this.models.getProviders()) {
            const room = await this.#qualifies(view, modelId, provider.id, false);

            if (!(room instanceof HttpError)) {
                accounts.push({
                    to: provider.id,
                    name: provider.name,
                    ...(this.#teamAccount(provider.id) ? { team: true as const } : {}),
                    used: Math.round(room.used),
                    window: room.window,
                });
            }
        }

        if (accounts.length === 0) {
            return undefined;
        }

        accounts.sort((a, b) => Number(a.team === true) - Number(b.team === true) || a.used - b.used);

        const subagent = this.#subagentName(wait.conversationId as unknown as ConversationId);

        return {
            conversationId: wait.conversationId,
            ...(subagent === undefined ? {} : { subagent }),
            provider: view.provider,
            providerName: this.models.getProvider(view.provider)?.name ?? view.provider,
            ...(view.window === undefined ? {} : { window: view.window }),
            resetAt: view.resetAt,
            until: view.until,
            modelId,
            accounts,
        };
    }

    /**
     * Whether account `to` may take a request that waits at `view`'s limit, for `modelId`: the same base provider, the
     * same model, allowed by the role, signed in, no closed gate of its own, and every plan window under 100% (asked
     * afresh with `fresh`). Its room (the window that ran out here, or its fullest), or why not, as the answer's refusal.
     */
    async #qualifies(view: WaitView, modelId: string, to: string, fresh: boolean): Promise<{ used: number; window: string } | HttpError> {
        const name = this.models.getProvider(to)?.name ?? to;

        if (to === view.provider || baseProvider(to) !== baseProvider(view.provider) || this.models.getProvider(to) === undefined) {
            return new HttpError(409, `${name} is not an account this request can move to.`);
        }

        if (this.models.getModel(to, modelId) === undefined || !this.policy.modelAllowed(to, modelId)) {
            return new HttpError(409, `${name} has no ${modelId} you may use.`);
        }

        if (!this.models.hasConfiguredAuth(to) || this.providers.needsSignIn(to) !== undefined) {
            return new HttpError(409, `${name} is not signed in: sign in to it in Providers, or pick another account.`);
        }

        if (this.limits.closed(to, modelId)) {
            return new HttpError(409, `${name} is waiting for a limit of its own: pick another account, or wait.`);
        }

        const windows = await (fresh ? this.#usageWindows(to) : this.#usageKnown(to)).catch(() => undefined);

        if (windows === undefined || windows.length === 0) {
            return new HttpError(409, `${name}'s usage is not known now: pick another account, or wait.`);
        }

        const full = windows.find((window) => window.usedPercent >= 100);

        if (full !== undefined) {
            return new HttpError(409, `${name} has no room now: its ${full.label} window is full. Pick another account, or wait.`);
        }

        // The bar shown is the one that ran out here, or its fullest.
        const shown = windows.find((window) => window.label === view.window) ?? windows.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a));

        return { used: shown.usedPercent, window: shown.label };
    }

    /**
     * Check, at the moment a person answers the card, that account `to` still qualifies for the waiting conversation's
     * request (its usage asked afresh). Refused: the card is made again from what is known now, and the refusal says why.
     */
    async recheckLimitAccount(conversationId: number, to: string): Promise<void> {
        const wait = this.limits.waiting(conversationId);

        if (wait === undefined) {
            throw new HttpError(409, "That wait is over, or already answered.");
        }

        const room = await this.#qualifies(wait.view, wait.modelId, to, true);

        if (room instanceof HttpError) {
            this.#limitOffers.delete(conversationId);
            this.#considerOffer(wait);

            throw room;
        }
    }

    /** Whether a provider is one of the team server's shared accounts: registered from there, or by its id (not one of the person's own). */
    #teamAccount(provider: string): boolean {
        return this.teamAccounts.label(provider) !== undefined || (isTeamAccount(provider) && this.accounts.get(provider) === undefined);
    }

    /** The name a subagent conversation has in its parent's subagents, if it is one. */
    #subagentName(id: ConversationId): string | undefined {
        for (const { agents } of this.#subagents.values()) {
            for (const [name, record] of Object.entries(agents)) {
                if (record.conversationId === id) {
                    return name;
                }
            }
        }

        return undefined;
    }

    /** The account cards a session shows: its own wait's, and its subagents' (as their approvals show there). */
    limitOffersFor(root: ConversationId): LimitOffer[] {
        const offers: LimitOffer[] = [];

        for (const [id, { offer }] of this.#limitOffers) {
            if (offer !== undefined && this.rootOf(id as unknown as ConversationId) === root && this.limits.waiting(id)?.declined === false) {
                offers.push(offer);
            }
        }

        return offers;
    }

    /** The account card a waiting conversation shows now, if any. */
    limitOffer(id: number): LimitOffer | undefined {
        return this.limits.waiting(id)?.declined === false ? this.#limitOffers.get(id)?.offer : undefined;
    }

    /**
     * A run began to wait a long while for its provider's limit (10 minutes or more): the phone hears it once for the
     * wait, as an app event and a web push, unless the owner turned the notice off (Providers).
     */
    #limitNotice(conversationId: number, view: WaitView): void {
        if (!this.config.limitNotice) {
            return;
        }

        const root = this.rootOf(conversationId as unknown as ConversationId);

        if (this.#sessions[String(root)] === undefined) {
            return;
        }

        const named = this.#sessions[String(root)]?.title;
        const provider = this.models.getProvider(view.provider)?.name ?? view.provider;
        // In this server's zone (on the phone, the owner's); each browser's push says it in that browser's own (`#pushEvent`).
        const time = clockText(view.until);
        const hours = view.window === undefined ? undefined : /^(\d+)-hour$/.exec(view.window)?.[1];
        const text =
            hours !== undefined
                ? said("{provider}'s {n}-hour limit · goes on by itself at {time}", { provider, n: Number(hours), time })
                : view.window !== undefined
                ? said("{provider}'s {window} limit · goes on by itself at {time}", { provider, window: view.window, time })
                : view.scope === "account"
                  ? said("{provider}'s usage limit · goes on by itself at {time}", { provider, time })
                  : said("{provider}'s rate limit · goes on by itself at {time}", { provider, time });

        this.phoneEvents.add({
            kind: "limit",
            session: Number(root),
            title: named ?? "Session",
            text: text.text.replace(/\{(\w+)\}/g, (_, name: string) => String(text.vars?.[name] ?? "")),
            say: { text, ...(named === undefined ? { title: said("Session") } : {}) },
            clock: view.until,
        });
    }

    /**
     * The owner chooses how many hours a run waits for a provider's limit to clear, at most; 0 turns waiting off, and
     * runs that wait now go on at once. Another time cuts each wait to the new longest.
     */
    async setLimitWaitHours(user: User, hours: unknown): Promise<void> {
        if (user.role !== "owner") {
            throw new HttpError(403, "Only the owner can do that");
        }

        if (typeof hours !== "number" || !LIMIT_WAIT_CHOICES.includes(hours)) {
            throw new HttpError(400, `limitWaitHours must be one of ${LIMIT_WAIT_CHOICES.join(", ")}`);
        }

        if (hours === this.config.limitWaitHours) {
            return;
        }

        this.config.limitWaitHours = hours;

        if (hours === 0) {
            this.limits.releaseAll();
        } else {
            this.limits.reconsider();
        }

        await this.#refreshClients();
    }

    /** The owner turns the phone notice of a long wait for a limit on or off. */
    async setLimitNotice(user: User, on: unknown): Promise<void> {
        if (user.role !== "owner") {
            throw new HttpError(403, "Only the owner can do that");
        }

        if (typeof on !== "boolean") {
            throw new HttpError(400, "limitNotice is true or false");
        }

        this.config.limitNotice = on;
        await this.#refreshClients();
    }

    /** The owner changes what the phone's assistant sheet does (PP-146): `patch` names only the settings to change. */
    async setAssistant(user: User, patch: unknown): Promise<void> {
        if (user.role !== "owner") {
            throw new HttpError(403, "Only the owner can do that");
        }

        this.config.assistant = withAssistant(this.config.assistant, patch);
        await this.#refreshClients();
    }

    /**
     * The owner changes Settings › Voice (PP-185): `patch` names only the settings to change. A live or dictation model, a
     * voice or a language is checked with OpenAI first, with the owner's sign-in; what it refuses is not kept.
     */
    async setVoice(user: User, patch: unknown): Promise<void> {
        if (user.role !== "owner") {
            throw new HttpError(403, "Only the owner can do that");
        }

        const current = this.config.voice;
        const next = withVoice(current, patch);

        await this.voice.validate(current, next);
        this.config.voice = next;
        await this.#refreshClients();
    }

    /** Ask OpenAI again which voice models the owner's sign-in has (Settings › Voice's Check again). */
    async checkVoice(user: User): Promise<void> {
        if (user.role !== "owner") {
            throw new HttpError(403, "Only the owner can do that");
        }

        await this.voice.check();
        await this.#refreshClients();
    }

    /** Who thinks in a session's voice calls: its own mode, else Settings › Voice's. */
    voiceModeOf(id: ConversationId): VoiceMode {
        return this.sessionMeta(this.rootOf(id))?.voiceMode ?? this.config.voice.mode;
    }

    /** A session's own voice mode (work, chat, think), or "inherit" for Settings › Voice's. Whoever steers it. */
    async setSessionVoiceMode(id: ConversationId, user: User, mode: unknown): Promise<void> {
        this.requireSee(user, id);
        await this.requireDriver(id, user);

        if (mode !== "inherit" && !isVoiceMode(mode)) {
            throw new HttpError(400, "The voice mode is work, chat, think, or inherit.");
        }

        const root = this.rootOf(id);

        await this.harness.commit(async (tx) => {
            const meta = (await tx.doc(SessionsDoc)).items[String(root)];

            if (meta === undefined) {
                throw new HttpError(404, "There is no such session.");
            }

            if (mode === "inherit") {
                delete meta.voiceMode;
            } else {
                meta.voiceMode = mode;
            }
        }, context);

        // A call going on there now follows.
        await this.voiceBridge.modeChanged(Number(root), this.voiceModeOf(root));
    }

    /**
     * Start a voice call in a session (the owner's: it runs on the owner's sign-in). What the page gets sets the call up
     * and never holds the token.
     */
    async startVoiceCall(user: User, id: ConversationId): Promise<CallStart> {
        if (user.role !== "owner") {
            throw new HttpError(403, "Voice runs on the owner's ChatGPT sign-in: only the owner can call.");
        }

        this.requireSee(user, id);
        await this.requireDriver(id, user);
        const root = this.rootOf(id);

        return this.voice.start(user.id, Number(root), await this.voicePlan(root));
    }

    /** How a session's call runs: its mode, the voice's instructions with the session's context, and its tools. */
    async voicePlan(id: ConversationId): Promise<CallPlan> {
        const mode = this.voiceModeOf(id);
        const recent = await this.#voiceContext(id);
        const instructions = voiceInstructions(mode, this.sessionMeta(id)?.title);

        return {
            mode,
            instructions: recent === "" ? instructions : `${instructions}\n\n<startup_context>\nThe session so far, newest last:\n${recent}\n</startup_context>`,
            tools: mode === "work" ? VOICE_TOOLS : [],
        };
    }

    /** The person a call is for. */
    #voiceUser(id: string): User {
        const user = this.config.users.find((each) => each.id === id);

        if (user === undefined) {
            throw new HttpError(404, "There is no such person.");
        }

        return user;
    }

    /**
     * A session's recent talk for a call's start: the owner's messages and Pi's text (no tools, thinking or images), the
     * newest last, about 6000 characters.
     */
    async #voiceContext(id: ConversationId): Promise<string> {
        const view = await (await this.conversation(id)).viewState(context);

        try {
            const lines: string[] = [];

            for (const entry of view.value.entries) {
                const shown = projectEntry(entry);

                if (shown?.kind === "user" && shown.text.trim() !== "") {
                    lines.push(`Owner: ${shown.text.trim().slice(0, 800)}`);
                } else if (shown?.kind === "assistant") {
                    const text = shown.blocks
                        .filter((block) => block.type === "text")
                        .map((block) => (block as { text: string }).text)
                        .join("\n")
                        .trim();

                    if (text !== "") {
                        lines.push(`Pi: ${text.slice(0, 800)}`);
                    }
                }
            }

            const kept: string[] = [];
            let size = 0;

            for (const line of lines.reverse()) {
                if (size + line.length > 6000) {
                    break;
                }

                kept.unshift(line);
                size += line.length;
            }

            return kept.join("\n");
        } finally {
            view.dispose();
        }
    }

    /** Follow a session for a call: its entries as tabs get them, and whether Pi works there. */
    async #watchVoice(id: ConversationId, listener: (entries: readonly ClientEntry[], busy: boolean) => void): Promise<() => void> {
        const view = await (await this.conversation(id)).viewState(context);
        const emit = () =>
            listener(
                view.value.entries.map((entry) => projectEntry(entry)).filter((entry): entry is ClientEntry => entry !== undefined),
                this.isBusy(id),
            );
        const unsubscribe = view.subscribe(emit);

        emit();

        return () => {
            unsubscribe();
            view.dispose();
        };
    }

    /** Every connected tab. */
    /** The home folder: SSH keys, Pi's folder, and a backup's other parts are under it (`backup.ts`). */
    get home(): string {
        return this.#home;
    }

    get clients(): ReadonlySet<Client> {
        return this.#clients;
    }

    /** Tell every browser to reload, after a web file changed. */
    reloadClients(file: string): void {
        for (const client of this.#clients) {
            client.send("reload", { file });
        }
    }

    /**
     * Start sending a tab its events. The tab may close during the waits here (opening a room, or the guard's status
     * right after a restart, when every browser reconnects at once): `detach` has then run, and the tab must not be added.
     */
    async attach(client: Client): Promise<void> {
        const arriving = !this.#online(client.user.id);

        this.#clients.add(client);
        const hello = await this.hello(client.user);

        if (!this.#clients.has(client)) {
            return;
        }

        client.send("hello", this.#helloFor(client, hello));
        this.#sendSessions(client, this.sessions(client.user));

        if (client.user.role === "owner" && this.themes.failure !== undefined) {
            client.send("notice", { level: "warning", message: this.themes.failure });
        }

        if (arriving) {
            this.#peopleChanged(client.user.id);
        }

        if (client.conversationId === undefined) {
            return;
        }

        if (!this.canSee(client.user, client.conversationId)) {
            client.send("missing", {
                conversationId: client.conversationId,
                message: "This session is not shared with you.",
            });
            // Keep the tab for app-wide events only: nothing about that conversation reaches it, and it is not "there".
            client.conversationId = undefined;

            return;
        }

        try {
            const id = client.conversationId;
            const room = await this.room(id);

            if (!this.#clients.has(client)) {
                this.releaseRoom(room);

                return;
            }

            room.keepOpen();
            room.clients.add(client);
            room.push(client, true);
            client.send("chat", { conversationId: room.id, full: true, messages: room.chat });
            client.send("notes", { conversationId: room.id, ...room.notes });

            for (const other of room.clients) {
                if (other !== client) {
                    room.push(other, false);
                }
            }

            room.pushPresence();
            this.#scheduleSessions();
        } catch (error) {
            client.send("missing", {
                conversationId: client.conversationId,
                message: describe(error),
            });
        }
    }

    detach(client: Client): void {
        if (!this.#clients.delete(client)) {
            return;
        }

        client.browserWatch?.stop();
        client.browserWatch = undefined;

        if (client.computerWatch !== undefined) {
            this.computerControl.watch(client.computerWatch, false);
            client.computerWatch = undefined;
        }

        for (const id of client.peeks ?? []) {
            this.#unpeek(client, id);
        }

        client.peeks = undefined;

        if (!this.#online(client.user.id)) {
            this.#peopleChanged(client.user.id);
        }

        if (client.conversationId === undefined) {
            return;
        }

        this.#leaveRoom(client, client.conversationId);
    }

    /** Take a tab out of a conversation's room: the others see it go, and the room closes once no tab is left. */
    #leaveRoom(client: Client, id: ConversationId): void {
        void this.#rooms.get(id)?.then(
            (room) => {
                if (!room.clients.delete(client)) {
                    return;
                }

                if (!room.has(client.user.id)) {
                    room.setTyping(client.user.id, null);
                }

                room.pushPresence();
                room.schedule();
                this.#scheduleSessions();
                this.releaseRoom(room);
            },
            () => {},
        );
    }

    /**
     * The sessions a connection shows as peek tiles on its screen now, and the subagents its subagents bar shows. Each
     * gets short `peek` updates while it stays there; the rest stop, and their views close as they do when the last tab
     * leaves. Conversations this person may not see are left out. `connection` is the id its `hello` carried. A list
     * numbered `seq` below one already taken arrived late, and is dropped.
     */
    setPeeks(user: User, connection: string, ids: readonly ConversationId[], seq?: number): void {
        // Sessions, and the subagents of sessions: the subagents bar shows what each does now.
        const wanted = new Set(
            ids
                .filter(
                    (id) =>
                        this.#sessions[String(this.rootOf(id))] !== undefined &&
                        this.canSee(user, id),
                )
                .slice(0, MAX_PEEKS),
        );

        for (const client of this.#clients) {
            if (client.user.id !== user.id || client.connection !== connection) {
                continue;
            }

            if (seq !== undefined) {
                if (seq <= (client.peekSeq ?? -Infinity)) {
                    continue;
                }

                client.peekSeq = seq;
            }

            const had = client.peeks ?? new Set<ConversationId>();

            client.peeks = new Set(wanted);

            for (const id of had) {
                if (!wanted.has(id)) {
                    this.#unpeek(client, id);
                }
            }

            for (const id of wanted) {
                if (!had.has(id)) {
                    void this.#peek(client, id);
                }
            }
        }
    }

    async #peek(client: Client, id: ConversationId): Promise<void> {
        let room: Room;

        try {
            room = await this.room(id);
        } catch {
            // A session that is gone has no tile to show.
            return;
        }

        // The tab left, or scrolled the tile away, while the view opened.
        if (!this.#clients.has(client) || client.peeks?.has(id) !== true) {
            this.releaseRoom(room);

            return;
        }

        // Scrolled away and back while the view opened: the first of the two calls added it already.
        if (room.peekers.has(client)) {
            return;
        }

        room.keepOpen();
        room.peekers.add(client);
        room.pushPeek(client);
    }

    #unpeek(client: Client, id: ConversationId): void {
        void this.#rooms.get(id)?.then(
            (room) => {
                if (room.peekers.delete(client)) {
                    this.releaseRoom(room);
                }
            },
            () => {},
        );
    }

    /**
     * A tab was hidden or shown: hidden tabs show their person as away, and let push notifications through. `pushId`: the
     * push subscription of the tab's browser (PP-127), which gets no push while one of its tabs is visible.
     */
    setVisible(user: User, tab: string, visible: boolean, pushId?: string): void {
        for (const client of this.#clients) {
            if (client.user.id !== user.id || client.id !== tab) {
                continue;
            }

            if (pushId !== undefined) {
                client.pushId = pushId;
            }

            if (client.visible === visible) {
                continue;
            }

            client.visible = visible;
            const id = client.conversationId;

            if (id !== undefined) {
                void this.#rooms.get(id)?.then(
                    (room) => room.pushPresence(),
                    () => {},
                );
            }
        }
    }

    /**
     * What the phone is told (`phone-events.ts`), as a push to each browser that turned notifications on (PP-127): in the
     * owner's language, or the browser's with Auto; not to a browser with a pi-phone tab visible now, which shows it.
     */
    async #pushEvent(event: PhoneEvent): Promise<void> {
        const owner = this.config.users.find((user) => user.role === "owner");

        for (const record of this.webPush.list()) {
            if ([...this.#clients].some((client) => client.pushId === record.id && client.visible !== false)) {
                continue;
            }

            // A moment in the text in the browser's own time zone, when it told it (the limit notice's "at HH:MM").
            const shown = inLanguage(inZone(event, record.zone), translator(resolveLanguage(owner?.language, record.language)));
            const security = event.kind === "security";

            await this.webPush.send(record, {
                title: shown.heading,
                body: shown.text,
                url: security ? "/" : `/s/${event.session}`,
                // One per session: its newest says where it is. Security notices each their own.
                tag: security ? `pi-phone-security-${event.seq}` : `pi-phone-s${event.session}`,
                urgency: event.kind === "approval" || security ? "high" : "normal",
            });
        }
    }

    #online(userId: string): boolean {
        for (const client of this.#clients) {
            if (client.user.id === userId) {
                return true;
            }
        }

        return false;
    }

    /** Is this person looking at this conversation right now, in a visible tab? */
    watching(userId: string, id: ConversationId): boolean {
        for (const client of this.#clients) {
            if (
                client.user.id === userId &&
                (client.conversationId === id || client.pip?.conversationId === id) &&
                client.visible !== false
            ) {
                return true;
            }
        }

        return false;
    }

    /** Change someone's name: shown at once on their messages, in the people lists, and on their avatar. */
    /** The languages the app speaks (`web/i18n.js`); "auto" follows the person's browser. */
    static readonly LANGUAGES = ["auto", "en", "zh-CN", "vi"] as const;

    /** The app's language for `user` (PP-81), on every device of theirs: their tabs load again in it. */
    async setLanguage(user: User, language: unknown): Promise<void> {
        if (typeof language !== "string" || !(PocketApp.LANGUAGES as readonly string[]).includes(language)) {
            throw new HttpError(400, `The language is one of ${PocketApp.LANGUAGES.join(", ")}.`);
        }

        this.config.updateUser(user.id, { language: language === "auto" ? undefined : language });

        for (const client of this.#clients) {
            if (client.user.id === user.id) {
                client.send("language", { language });
            }
        }
    }

    /**
     * The language dictation listens for on every device of `user` (a BCP 47 tag such as "vi-VN"), or "auto" for each
     * device's own. Their tabs hear it (`dictation`).
     */
    setDictationLanguage(user: User, language: unknown): void {
        if (typeof language !== "string" || !(language === "auto" || /^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/.test(language))) {
            throw new HttpError(400, "The dictation language is a language tag such as vi-VN or en-US, or auto.");
        }

        this.config.updateUser(user.id, { dictation: language === "auto" ? undefined : language });

        for (const client of this.#clients) {
            if (client.user.id === user.id) {
                client.send("dictation", { dictation: language });
            }
        }
    }

    /**
     * The newest release marked big whose What's new card `user` has not seen (PP-235): for the owner, once past the
     * welcome (a new person starts with the welcome, not with what changed).
     */
    whatsNewFor(user: User): WhatsNew | undefined {
        if (user.role !== "owner" || this.welcomeOf(user) === "show") {
            return undefined;
        }

        const newest = newestBig(this.#whatsNewDir);

        return newest === undefined || user.whatsNewSeen === newest.version ? undefined : newest;
    }

    /**
     * The What's new card dismissed (`seen`: the newest big release as seen) or to show again (`show`). Their tabs hear
     * the card as it is now (`whats-new`).
     */
    setWhatsNew(user: User, state: unknown): void {
        if (state !== "show" && state !== "seen") {
            throw new HttpError(400, "What's new is show or seen.");
        }

        this.config.updateUser(user.id, { whatsNewSeen: state === "show" ? undefined : newestBig(this.#whatsNewDir)?.version });

        for (const client of this.#clients) {
            if (client.user.id === user.id) {
                client.send("whats-new", { whatsNew: this.whatsNewFor(user) ?? null });
            }
        }
    }

    /** Where `user` is with the first-run welcome: "show", "done" or "skipped" (PP-234). Guests are never welcomed. */
    welcomeOf(user: User): "show" | WelcomeState {
        return user.role !== "owner" ? "done" : (user.welcome ?? "show");
    }

    /**
     * The welcome finished ("done"), left ("skipped"), or to show again ("show": the next time the app opens, and now in
     * their open tabs). Their tabs hear it (`welcome`).
     */
    setWelcome(user: User, state: unknown): void {
        if (state !== "show" && state !== "done" && state !== "skipped") {
            throw new HttpError(400, "The welcome is show, done, or skipped.");
        }

        if (user.role !== "owner") {
            throw new HttpError(403, "Only the owner has the welcome.");
        }

        // Past the welcome, a new person has nothing new to see yet: the newest release counts as seen.
        this.config.updateUser(user.id, {
            welcome: state === "show" ? undefined : state,
            ...(state === "show" || user.whatsNewSeen !== undefined ? {} : { whatsNewSeen: newestBig(this.#whatsNewDir)?.version }),
        });

        for (const client of this.#clients) {
            if (client.user.id === user.id) {
                client.send("welcome", { welcome: state });
            }
        }
    }

    /**
     * The owner's Getting started session (PP-235; Menu › Getting started, the welcome's last step): opened again, back in
     * the active list, when there is one; else made, titled and started in their language (`language`: the page's, for
     * "auto"), on a model there is. `whatsNew`: a version whose notes Pi then walks through (the What's new card).
     */
    async gettingStarted(user: User, { language, whatsNew }: { language?: string; whatsNew?: string } = {}): Promise<ConversationId> {
        if (user.role !== "owner") {
            throw new HttpError(403, "Only the owner has Getting started.");
        }

        const t = translator(resolveLanguage(user.language, language));
        const ask = whatsNew === undefined ? t("Show me around.") : t("Show me what's new in {version}.", { version: whatsNew });
        const known = user.guide === undefined ? undefined : (Number(user.guide) as unknown as ConversationId);

        if (known !== undefined && this.sessionMeta(known) !== undefined) {
            await this.commands.updateSession(known, user, { settled: false, archived: false });

            if (whatsNew !== undefined) {
                await this.commands.submit(known, user, { text: ask, requestId: randomUUID() });
            }

            return known;
        }

        const available = this.models.getAvailableSnapshot();

        if (available.length === 0) {
            throw new HttpError(409, "Sign in to a model first: Pi needs one to show you around.");
        }

        const { id } = await this.commands.createSession(user, { title: t("Getting started") });

        // A new pi-phone has no model picked yet: the first there is.
        if ((await this.agentState(id))?.model === undefined) {
            await this.commands.configure(id, user, { model: { provider: available[0]!.provider, modelId: available[0]!.id } });
        }

        this.config.updateUser(user.id, { guide: String(id) });
        await this.commands.submit(id, user, { text: ask, requestId: randomUUID() });

        return id;
    }

    rename(user: User, name: string): void {
        this.config.updateUser(user.id, { name });
        this.#peopleChanged();

        for (const pending of this.#rooms.values()) {
            void pending.then(
                (room) => room.has(user.id) && room.pushPresence(),
                () => {},
            );
        }
    }

    /** Someone came, went, or changed: remember when they were last here and tell everyone. */
    #peopleChanged(userId?: string): void {
        if (userId !== undefined && this.config.userById(userId) !== undefined) {
            this.config.updateUser(userId, { lastSeen: Date.now() });
        }

        for (const client of this.#clients) {
            client.send("users", this.people(client.user));
        }
    }

    /**
     * The people with access to this server as `viewer` may see them: who is online now, and when the others were last
     * here. People invited to one session see only those who share it, and not which sessions others are limited to.
     */
    people(viewer: User) {
        const scope = viewer.sessions;

        return this.config.users
            .filter(
                (each) =>
                    scope === undefined ||
                    each.sessions === undefined ||
                    each.sessions.some((id) => scope.includes(id)),
            )
            .map((each) => ({
                id: each.id,
                name: each.name,
                role: each.role,
                online: this.#online(each.id),
                ...(each.lastSeen === undefined ? {} : { lastSeen: each.lastSeen }),
                ...(each.sessions === undefined || scope !== undefined
                    ? {}
                    : { sessions: each.sessions.map(Number) }),
            }));
    }

    // ─── Access ─────────────────────────────────────────────────────────────

    /** A session's conversations: itself and the subagents under it that are known here. */
    conversationsOf(root: ConversationId): ConversationId[] {
        return [
            ...new Set([
                root,
                ...[...this.#agents.keys()].filter((id) => this.rootOf(id) === root),
            ]),
        ];
    }

    /** The conversation that spawned a subagent's; undefined for any other conversation. */
    parentOf(id: ConversationId): ConversationId | undefined {
        return this.#parents.get(id);
    }

    /** The session a conversation belongs to: itself, or the session its subagent chain started from. */
    rootOf(id: ConversationId): ConversationId {
        let current = id;

        for (let depth = 0; depth < 32; depth++) {
            const parent = this.#parents.get(current);

            if (parent === undefined) {
                return current;
            }

            current = parent;
        }

        return current;
    }

    /**
     * People invited to one session see only that session and its subagents. A PiP is its own person's alone: its tools
     * act as them, so anyone else who could write to it would act as them too.
     */
    canSee(user: User, id: ConversationId): boolean {
        const root = this.rootOf(id);
        const pip = this.#sessions[String(root)]?.pip;

        if (pip !== undefined && pip !== user.id) {
            return false;
        }

        return user.sessions === undefined || user.sessions.includes(String(root));
    }

    requireSee(user: User, id: ConversationId): void {
        if (!this.canSee(user, id)) {
            throw new HttpError(404, "This session is not shared with you.");
        }
    }

    /**
     * What a teammate in a shared session never does here (PP-57): write or undo files, switch branches, run shell
     * commands. They read the files and changes, and ask the owner for the rest.
     */
    refuseTeammate(user: User, what: string): void {
        if (user.team === true) {
            throw new HttpError(403, `In a shared session you can't ${what}: that is the owner's. Ask them, or ask Pi.`);
        }
    }

    /** Viewers read, chat, and react; they never make Pi do anything. */
    requireSteer(user: User): void {
        if (user.role === "viewer") {
            throw new HttpError(
                403,
                "You can view this session but not steer Pi. Ask the owner for steering rights.",
            );
        }
    }

    /** While take turns is on, only the driver sends to Pi or changes its settings. */
    async requireDriver(id: ConversationId, user: User): Promise<void> {
        this.requireSteer(user);
        const turns = await this.harness.snapshot(TurnsDoc, this.rootOf(id), context);

        if (turns?.on !== true || turns.driver === user.id) {
            return;
        }

        const driver = turns.driver === undefined ? undefined : this.config.userById(turns.driver);

        throw new HttpError(
            409,
            driver === undefined
                ? "Take turns is on: take the wheel first."
                : `${driver.name} is driving. Ask to drive first.`,
        );
    }

    #noteChat(id: ConversationId, messages: readonly ChatMessage[] | undefined): boolean {
        const last = messages?.findLast((message) => message.kind !== "event");
        const key = String(id);
        const before = this.#lastChat.get(key);

        if (last === undefined) {
            return this.#lastChat.delete(key);
        }

        if (before?.at === last.at && before.userId === last.userId) {
            return false;
        }

        this.#lastChat.set(key, { at: last.at, userId: last.userId });

        return true;
    }

    #noteSubagents(id: ConversationId, doc: SubagentsValue | null | undefined): void {
        const agents = doc?.agents ?? {};

        for (const record of Object.values(agents)) {
            this.#parents.set(record.conversationId, id);
        }

        if (Object.keys(agents).length === 0) {
            this.#subagents.delete(id);
        } else {
            this.#subagents.set(id, { agents: { ...agents }, reporting: reportingOf(doc) });
        }
    }

    /**
     * Every subagent, by the session it works in (its parent's, or the session its parent's chain started from), as the
     * subagents board shows it: the subagents bar's view, with the session and the call it waits on, if any.
     */
    #subagentsBySession(): Map<string, SubagentEntry[]> {
        const asks = new Map<ConversationId, ApprovalRequest>();

        for (const approval of this.approvals.all()) {
            if (!asks.has(approval.conversationId)) {
                asks.set(approval.conversationId, approval);
            }
        }

        const sessions = new Map<string, SubagentEntry[]>();
        const limited = new Map(this.limits.waits().map((wait) => [wait.conversationId, wait.view.until]));

        for (const [parent, { agents, reporting }] of this.#subagents) {
            const session = String(this.rootOf(parent));

            if (this.#sessions[session] === undefined) {
                continue;
            }

            const list = sessions.get(session) ?? [];

            for (const [name, record] of Object.entries(agents)) {
                const ask = asks.get(record.conversationId);

                list.push({
                    id: Number(session),
                    ...subagentView(
                        name,
                        record,
                        this.#busy.has(record.conversationId),
                        reporting.has(name),
                        limited.get(Number(record.conversationId)),
                    ),
                    ...(ask === undefined
                        ? {}
                        : {
                              waiting: true,
                              approval: { tool: ask.tool, subject: ask.subject.slice(0, 200) },
                          }),
                });
            }

            sessions.set(session, list);
        }

        return sessions;
    }

    /**
     * Every subagent in the sessions this person can see, for the subagents board, but a session's oldest finished ones
     * past `BOARD_FINISHED`. Archived sessions are left out, unless one of their subagents works or waits there.
     */
    subagents(user?: User): SubagentEntry[] {
        const all: SubagentEntry[] = [];

        for (const [id, list] of this.#subagentsBySession()) {
            if (user?.sessions !== undefined && !user.sessions.includes(id)) {
                continue;
            }

            if (this.#sessions[id]?.archived === true && !list.some((entry) => entry.busy)) {
                continue;
            }

            all.push(...forBoard(list));
        }

        return all;
    }

    /**
     * A tab opened or closed the subagents board: while open, it gets every subagent with each session list. A request
     * numbered `seq` below one already taken arrived late, and is dropped.
     */
    setBoard(user: User, connection: string, on: boolean, seq?: number): void {
        for (const client of this.#clients) {
            if (client.user.id !== user.id || client.connection !== connection) {
                continue;
            }

            if (seq !== undefined) {
                if (seq <= (client.boardSeq ?? -Infinity)) {
                    continue;
                }

                client.boardSeq = seq;
            }

            client.board = on;
            client.boardSent = undefined;

            if (on) {
                this.#sendBoard(client, this.subagents(client.user));
            }
        }
    }

    /**
     * A tab opened or closed the Browser panel of one session's browser at a place (`phone` or `machine:<id>`): while
     * open, it hears of that browser's frames (`browser-frame`: the newest's number and size; the picture itself it
     * fetches, `browserFrame`). `size`: how big it draws them, in device pixels (the frames are made no bigger, PP-200);
     * a tab already watching that says a new size keeps watching at it. The owner's.
     */
    setBrowserWatch(user: User, connection: string, place: string, session: number, on: boolean, size?: FrameSize): void {
        const browser = on ? this.browserAt(place, session) : undefined;

        for (const client of this.#clients) {
            if (client.user.id !== user.id || client.connection !== connection) {
                continue;
            }

            if (client.browserWatch !== undefined && (!on || client.browserWatch.place !== place || client.browserWatch.session !== session)) {
                client.browserWatch.stop();
                client.browserWatch = undefined;
            }

            if (browser !== undefined && client.browserWatch !== undefined) {
                client.browserWatch.resize(size);

                continue;
            }

            if (browser !== undefined && client.browserWatch === undefined) {
                const watching = browser.watch(size);

                client.browserWatch = { place, session, stop: watching.stop, resize: watching.resize };
                client.send("browser", browser.state());

                // The page's last picture at once: a still page sends no frames, and the cast may already run for another
                // tab (PP-199: a panel opened after Pi stopped browsing stayed on "Waiting for the page…").
                const last = browser.lastFrame();

                if (last !== undefined) {
                    client.send("browser-frame", { seq: last.seq, width: last.width, height: last.height, place, session });
                }
            }
        }
    }

    /**
     * A tab opened or closed the Computer panel of a session (PP-178): while open, it gets that session's pictures
     * (`computer-frame`), read again every few seconds. The owner's.
     */
    setComputerWatch(user: User, connection: string, session: number, on: boolean): void {
        for (const client of this.#clients) {
            if (client.user.id !== user.id || client.connection !== connection) {
                continue;
            }

            if (client.computerWatch !== undefined && (!on || client.computerWatch !== session)) {
                this.computerControl.watch(client.computerWatch, false);
                client.computerWatch = undefined;
            }

            if (on && client.computerWatch === undefined) {
                client.computerWatch = session;
                this.computerControl.watch(session, true);
                const shown = this.computerControl.panelOfSession(session);

                if (shown !== undefined) {
                    client.send("computer", shown.panel);

                    if (shown.frame !== undefined) {
                        client.send("computer-frame", shown.frame);
                    }
                }
            }
        }
    }

    /** A browser of Pi's, whose state and frames go to the owner's tabs (frames only to tabs that watch it). */
    #makeBrowser(engine: BrowserEngine, place: string, where: string, session: number): PiBrowser {
        return new PiBrowser({
            engine: new SessionEngine(engine, place, session, this.#tabOwners),
            place,
            where,
            session,
            size: this.#browserSizes.of(`${place}#${session}`),
            sized: (size) => this.#browserSizes.set(`${place}#${session}`, size),
            // Only the owner sees Pi's browser: it may be signed in to the owner's accounts.
            changed: (state) => {
                for (const client of this.#clients) {
                    if (client.user.role === "owner") {
                        client.send("browser", state);
                    }
                }
            },
            frame: (frame) => {
                for (const client of this.#clients) {
                    if (client.browserWatch?.place === place && client.browserWatch.session === session) {
                        // Its number and size only: the tab fetches the newest picture when it can draw it (PP-200), never a
                        // queue of old ones in its event stream.
                        client.send("browser-frame", { seq: frame.seq, width: frame.width, height: frame.height, place, session });
                    }
                }
            },
            log: (line) => this.#log(line),
        });
    }

    /**
     * The newest picture of a session's browser after number `after`, for a tab that watches it (`GET
     * /api/browser/frame`): at once when there is one, else the next to come, up to `waitMs`. Taking it lets Chrome send
     * the next (`frameTaken`). Undefined when none came, or for a tab that does not watch it.
     */
    async browserFrame(user: User, connection: string, place: string, session: number, after = 0, waitMs = 0): Promise<BrowserFrame | undefined> {
        const watching = [...this.#clients].some((client) => client.user.id === user.id && client.connection === connection && client.browserWatch?.place === place && client.browserWatch.session === session);

        if (!watching) {
            return undefined;
        }

        const browser = this.browserAt(place, session);
        const frame = await browser.nextFrame(after, waitMs);

        if (frame !== undefined) {
            browser.frameTaken(frame.seq);
        }

        return frame;
    }

    /** Pi's browser for session `session` working in `cwd`: on its machine for a session on one, else the phone's. */
    browserFor(cwd: string, session: number): PiBrowser {
        const machine = /^machine:([^:]+):/.exec(cwd)?.[1];

        return this.browserAt(machine === undefined ? "phone" : `machine:${machine}`, session);
    }

    /**
     * One session's browser at a place: `phone`, or `machine:<id>` (a Chrome there, made on first use). Every session at a
     * place shares its engine (one profile: a sign-in serves them all), and sees only its own tabs.
     */
    browserAt(place: string, session: number): PiBrowser {
        if (!Number.isInteger(session) || session <= 0) {
            throw new HttpError(400, "Which session's browser? (session=<number>)");
        }

        const key = `${place}#${session}`;
        const known = this.#browsers.get(key);

        if (known !== undefined) {
            return known;
        }

        const machine = place === "phone" ? undefined : /^machine:(.+)$/.exec(place)?.[1];

        if (place !== "phone" && machine === undefined) {
            throw new HttpError(400, `No browser at ${place}.`);
        }

        const browser =
            machine === undefined
                ? this.#makeBrowser(this.#phoneEngine, "phone", "the phone", session)
                : this.#makeBrowser(this.#machineEngine(machine), place, this.machines.ready(machine).name, session);

        this.#browsers.set(key, browser);

        return browser;
    }

    /** A machine's browser engine: a Chrome there, made on first use and shared by its sessions. */
    #machineEngine(id: string): BrowserEngine {
        const known = this.#machineEngines.get(id);

        if (known !== undefined) {
            return known;
        }

        const machine = this.machines.ready(id);
        const remote = machine.remote!;
        const env = this.places.env(`machine:${id}:${remote.home}`);
        const engine = new MachineEngine({
                name: machine.name,
                home: remote.home,
                run: async (script, timeout) => {
                    let out = "";
                    // On Windows the daemon runs a command line with Git Bash; `sh` may not be on Windows' own PATH.
                    const result = await env.exec(remote.platform === "windows" ? script : ["sh", "-c", script], { cwd: remote.home, timeout, onOutput: (chunk) => (out += chunk) }, context);

                    if (!result.ok) {
                        throw new Error(`${machine.name}: ${result.error.message}`);
                    }

                    return { code: result.value.exitCode, out };
                },
                writeFile: async (path, bytes) => {
                    const folder = path.slice(0, path.lastIndexOf("/"));
                    const made = await env.exec(remote.platform === "windows" ? `mkdir -p '${folder}'` : ["mkdir", "-p", folder], { cwd: remote.home, timeout: 30 }, context);
                    const written = made.ok ? await env.writeFile(path, bytes, context) : made;

                    if (!written.ok) {
                        throw new Error(`Could not copy the file to ${machine.name}: ${written.error.message}`);
                    }
                },
                forward: async (port) => {
                    // Chrome's DevTools listens on 127.0.0.1 alone: `localhost` there may be ::1 (Windows).
                    const forward = await this.forwards.open(id, port, "127.0.0.1");

                    return {
                        port: forward.localPort,
                        close: () => {
                            try {
                                this.forwards.close(forward.id);
                            } catch {
                                // Closed already (its ssh ended).
                            }
                        },
                    };
                },
            });

        this.#machineEngines.set(id, engine);

        return engine;
    }

    /** Send a tab's board its subagents, unless they are what it last got. */
    #sendBoard(client: Client, entries: SubagentEntry[]): void {
        const json = JSON.stringify(entries);

        if (json !== client.boardSent) {
            client.boardSent = json;
            client.send("subagents", entries);
        }
    }

    /** A conversation's shared view, opened when no tab has it open. Hand it to `releaseRoom` when done with it. */
    async room(id: ConversationId): Promise<Room> {
        let pending = this.#rooms.get(id);

        if (pending === undefined) {
            pending = (async () => {
                const conversation = await this.harness.conversation(id, context);

                if (conversation === undefined) {
                    throw new HttpError(404, `Conversation ${String(id)} does not exist`);
                }

                const room = new Room(this, id);

                await room.open(conversation);

                return room;
            })();
            this.#rooms.set(id, pending);
            pending.catch(() => this.#rooms.delete(id));
        }

        return pending;
    }

    /** A conversation's shared view if it is open now; undefined otherwise, without opening it. */
    openRoom(id: ConversationId): Promise<Room> | undefined {
        return this.#rooms.get(id);
    }

    /** Close a room shortly after its last tab (or peek tile) left, unless one comes back first. */
    releaseRoom(room: Room): void {
        if (room.clients.size === 0 && room.peekers.size === 0) {
            room.closeLater(() => this.#rooms.delete(room.id));
        }
    }

    /** All signed-in models, with Pi's enabledModels scope marked for the picker. */
    async modelList() {
        // Pi settings are read from JSON; the SDK expects an array of strings.
        const configured = this.settings.getEnabledModels();
        const patterns = Array.isArray(configured)
            ? configured.filter((pattern): pattern is string => typeof pattern === "string")
            : [];
        // The scope asks Pi which models are available, which reads its sign-ins: one that cannot be read leaves the
        // scope out, as in a picker without one, rather than failing `hello` and with it every tab.
        const { scopedModels } =
            patterns.length > 0
                ? await resolveModelScopeWithDiagnostics(patterns, this.models).catch(() => ({
                      scopedModels: [],
                  }))
                : { scopedModels: [] };

        // A role's allow list (PP-22): only its models are offered.
        return modelList(this.models, this.signInNeeded, scopedModels, (provider) => this.accountLabel(provider)).filter((model) => this.policy.modelAllowed(model.provider, model.id));
    }

    /**
     * Which account a provider's models are of, for the menus: an account's name; "Default" for the original of a
     * provider that has more accounts; none otherwise.
     */
    accountLabel(provider: string): string | undefined {
        const account = this.accounts.get(provider);
        // A team account's (PP-69): "Team Work".
        const team = this.teamAccounts.label(provider);

        if (team !== undefined) {
            return team;
        }

        if (account !== undefined) {
            return account.name;
        }

        return this.accounts.list().some((each) => each.provider === provider) ? "Default" : undefined;
    }

    async hello(user: User) {
        return {
            user: {
                id: user.id,
                name: user.name,
                role: user.role,
                ...(user.sessions === undefined ? {} : { sessions: user.sessions.map(Number) }),
                // The app's language for them (PP-81): "auto" follows their browser.
                language: user.language ?? "auto",
                // The first-run welcome (PP-234): "show" until they finish or skip it. Only for this pi-phone's owner (a
                // team member owns their own): the model and the phone's permissions are theirs to set.
                welcome: this.welcomeOf(user),
                // The language dictation listens for on all their devices, or "auto" for each device's own (PP-235).
                dictation: user.dictation ?? "auto",
                // A big release's card they have not seen yet (PP-235), or null.
                whatsNew: this.whatsNewFor(user) ?? null,
            },
            users: this.people(user),
            // Removed people's names, for what they wrote.
            former: this.config.former,
            models: await this.modelList(),
            // The plan limits known now (`usage-limits.ts`), without asking: the top bar's meter has them at once.
            usage: this.usageLimits.known(),
            server: {
                supervised: this.supervised,
                gateway: this.gateway,
                // What the person's role allows (PP-22): the page leaves out what it does not.
                policy: this.policy.get() ?? null,
                startedAt: this.startedAt,
                home: homedir(),
                defaultCwd: this.defaultCwd,
                // Connected machines (`machines.ts`): the folder picker offers them, and places on them show their names.
                // A team machine (PP-82) is marked so, with this person's own folder there, where the picker starts.
                machines: this.machines
                    .list()
                    .filter((machine) => machine.remote !== undefined)
                    .map((machine) => ({
                        id: machine.id,
                        name: machine.name,
                        home: machine.remote!.home,
                        ...(machine.team === undefined ? {} : { team: true, folder: machinePaths(machine.remote).join(machine.remote!.home, machine.team.folder) }),
                    })),
                extensions: this.loader.extensionNames(),
                // OfficeCLI runs here (`officecli.ts`): the Files viewer shows Word, Excel, and PowerPoint files.
                officecli: this.officecli.available(),
                // The browser modules this person's tabs load (`extension-ui.js`), each with the tools its module
                // installs: the only ones whose calls it may describe (`pocket.toolCall`).
                ui: this.#browserModules(user),
                // The commands this person may run: viewers none, guests the ones for conversations.
                extensionCommands: this.webs
                    .commands()
                    .filter(
                        (command) =>
                            user.role === "owner" ||
                            (user.role === "guest" && command.scope === "conversation"),
                    ),
                // Tells the web app this server has people chat and typing indicators.
                chat: true,
                // Manual refresh reloads shared model configuration and catalogs; only the owner may start it.
                refreshModels: user.role === "owner",
                // Tells the web app this server sends peek tiles (`POST /api/peeks`, `peek` events).
                peeks: true,
                // This server's clock: peek tiles compare the browser's looks with when runs ended here.
                now: Date.now(),
                // Collaboration features: 2 adds roles, take turns, reactions, pins, notes, mentions, and push.
                collab: 2,
                reactions: REACTIONS,
                approvalRule: this.config.approvalRule,
                // How many messages and new sessions a session may send others in an hour (`session-control.ts`).
                sessionSendLimit: this.config.sessionSendLimit,
                // When sessions compact by themselves: a percentage, or "full" (`auto-compact.ts`).
                compactAt: this.config.compactAt,
                // Minutes idle before a session is captured into the wiki, or null (`para-capture.ts`).
                wikiCaptureMinutes: this.config.wikiCaptureMinutes,
                // The most hours a run waits for a provider's limit to clear; 0: it does not wait (`limit-gate.ts`).
                limitWaitHours: this.config.limitWaitHours,
                // Whether the phone hears of a wait of 10 minutes or more.
                limitNotice: this.config.limitNotice,
                // What the phone's assistant sheet does (PP-146): the owner's, as only the owner uses the sheet.
                ...(user.role === "owner" ? { assistant: this.config.assistant } : {}),
                // Voice with the owner's ChatGPT sign-in (PP-185): its settings and what the last model check found.
                ...(user.role === "owner" ? { voice: { settings: this.config.voice, check: this.config.voiceCheck ?? null, voices: VOICES } } : {}),
                // Pi using a phone (PP-141): the owner's tabs show the session's live line, with Stop.
                phoneControl: user.role === "owner" ? this.phoneControl.view() : [],
                computerControl: user.role === "owner" ? this.computerControl.view() : [],
                // This server runs on a phone (the pi-phone app's), which Menu › Phone control is for.
                onPhone: process.platform === "android",
                // The model and thinking level new sessions start with, or null for the last one picked.
                defaultModel: this.config.defaultModel ?? null,
                // The theme and colors of browsers that have not chosen their own, or null for the app's own.
                themeDefault: this.config.themeDefault ?? null,
                // The models Pi may start subagents on besides their session's own: the owner's to see and change.
                ...(user.role === "owner"
                    ? { subagentModels: [...this.config.subagentModels] }
                    : {}),
            },
            // Read after the guard's wait, so a connecting device does not replace a live update with an older list.
            folderFavorites: await this.folderFavorites.list(user),
            // Their folder groups in the session list (PP-76), on every device.
            sessionGroups: await this.sessionGroups.list(user),
            // Every theme folder, for Appearance and for the look this tab uses (`theme.js`).
            themes: this.themes.list(user.role === "owner"),
        };
    }

    #browserModules(user: User) {
        const tools = new Map(
            this.loader
                .list()
                .map((each) => [
                    each.file.replace(/\.ts$/, ""),
                    each.extensions.flatMap((extension) => extension.tools),
                ]),
        );

        return this.webs
            .clients(user)
            .map((each) => ({ ...each, tools: tools.get(each.module) ?? [] }));
    }

    /** A tab's hello: what everyone gets, and the id of its own connection, which its peek lists name. */
    #helloFor(client: Client, hello: Awaited<ReturnType<PocketApp["hello"]>>) {
        return { ...hello, connection: client.connection };
    }

    /** Session lists change from outside their documents (a machine's branch came back): tabs get them again. */
    sessionsChanged(): void {
        this.#scheduleSessions();
    }

    #scheduleSessions(): void {
        if (this.#sessionsTimer !== undefined) {
            return;
        }

        this.#sessionsTimer = setTimeout(() => {
            this.#sessionsTimer = undefined;
            const all = this.sessions();
            const allJson = JSON.stringify(all);
            let board: SubagentEntry[] | undefined;

            for (const client of this.#clients) {
                const scope = client.user.sessions;

                if (scope === undefined) {
                    this.#sendSessions(client, all, allJson);
                } else {
                    // Scoped lists need their own metadata projection, not just a filter over the global list.
                    this.#sendSessions(client, this.sessions(client.user));
                }

                if (client.board === true) {
                    board ??= this.subagents();
                    this.#sendBoard(
                        client,
                        scope === undefined
                            ? board
                            : board.filter((entry) => scope.includes(String(entry.id))),
                    );
                }
            }
        }, 400);
    }

    /** Send a tab its session list, unless it is what the tab last got: the list is large, and changes come often. */
    #sendSessions(
        client: Client,
        sessions: ReturnType<PocketApp["sessions"]>,
        json = JSON.stringify(sessions),
    ): void {
        if (json !== client.sessionsSent) {
            client.sessionsSent = json;
            client.send("sessions", sessions);
        }
    }

    /** The session list, with who is in each session and its newest chat message. Scoped people see only theirs. */
    sessions(user?: User) {
        const waiting = new Set(
            this.approvals.all().map((approval) => String(this.rootOf(approval.conversationId))),
        );
        const people = new Map<string, Map<string, string>>();
        const subagents = this.#subagentsBySession();
        // The sessions in a wait for a provider's limit, their subagents' included: when the next request goes out.
        const limited = new Map<string, number>();

        for (const wait of this.limits.waits()) {
            const session = String(this.rootOf(wait.conversationId as unknown as ConversationId));

            limited.set(session, Math.min(limited.get(session) ?? Infinity, wait.view.until));
        }

        for (const client of this.#clients) {
            if (client.conversationId === undefined) {
                continue;
            }

            const key = String(client.conversationId);
            const here = people.get(key) ?? new Map<string, string>();

            here.set(client.user.id, client.user.name);
            people.set(key, here);
        }

        return Object.entries(this.#sessions)
            .filter(
                ([id, meta]) =>
                    // PiP is not a session people pick: it shows in its own panel (`pip.ts`).
                    meta.pip === undefined &&
                    (user?.sessions === undefined || user.sessions.includes(id)),
            )
            .map(([id, meta]) => {
                const model = this.#agents.get(Number(id) as unknown as ConversationId)?.model;
                const busy = this.#busy.has(Number(id) as unknown as ConversationId);
                const busySince = this.#busySince.get(Number(id) as unknown as ConversationId);
                // What its folder has checked out, for the list's third line: the HEAD file here, git's last word on a machine.
                const head = meta.archived === true ? undefined : this.workspace.head(Number(id) as unknown as ConversationId, 10 * 60_000);
                const branch = head === undefined ? undefined : "branch" in head ? head.branch : head.detached.slice(0, 7);
                const here = [...(people.get(id) ?? new Map<string, string>())].map(
                    ([userId, name]) => ({ id: userId, name }),
                );
                const chat = this.#lastChat.get(id);
                const endedAt = this.#endedAt.get(Number(id) as unknown as ConversationId);
                const counts = countSubagents(subagents.get(id) ?? []);
                // Which of Pi's sessions it continues is the owner's to know (the Pi sessions sheet), not the list's.
                const { fromPi: _fromPi, piLink, linkedFrom, ...shown } = meta;
                // Linking does not share the origin: do not leak its id to someone who only sees the new chat.
                const origin =
                    linkedFrom === undefined ? undefined : this.#sessions[String(linkedFrom.id)];
                const visibleOrigin =
                    origin !== undefined &&
                    origin.pip === undefined &&
                    (user === undefined ||
                        this.canSee(user, linkedFrom!.id as unknown as ConversationId));

                const linkage: { linkedFrom?: SessionMeta["linkedFrom"]; linkedOrigin?: true } =
                    linkedFrom === undefined
                        ? {}
                        : visibleOrigin
                          ? { linkedFrom }
                          : { linkedOrigin: true };

                return {
                    id: Number(id),
                    ...shown,
                    ...linkage,
                    // Gone to Pi on a machine (`pi-handoff.ts`): the owner's to know, so the session can check on it.
                    ...(piLink !== undefined && user?.role === "owner" ? { inPi: piLink.machineId } : {}),
                    busy,
                    ...(busy && busySince !== undefined ? { busySince } : {}),
                    ...(branch === undefined ? {} : { branch }),
                    waiting: waiting.has(id),
                    ...(limited.has(id) ? { limited: limited.get(id)! } : {}),
                    ...(endedAt === undefined ? {} : { endedAt }),
                    ...(this.#failed.has(Number(id) as unknown as ConversationId)
                        ? { failed: true }
                        : {}),
                    ...(model === undefined ? {} : { model: model.modelId }),
                    ...(here.length === 0 ? {} : { people: here }),
                    ...(chat === undefined ? {} : { chatAt: chat.at, chatBy: chat.userId }),
                    ...(counts === undefined ? {} : { subagents: counts }),
                };
            })
            .sort((a, b) => b.updatedAt - a.updatedAt);
    }

    isBusy(id: ConversationId): boolean {
        return this.#busy.has(id);
    }

    /** The conversations with a run going. */
    busyConversations(): ConversationId[] {
        return [...this.#busy];
    }

    /** The catalogue entry of a session; undefined for subagents and other conversations. */
    sessionMeta(id: ConversationId): SessionMeta | undefined {
        return this.#sessions[String(id)];
    }

    /** Every session's catalogue entry, PiP's included, by id. */
    sessionCatalogue(): Readonly<Record<string, SessionMeta>> {
        return this.#sessions;
    }

    /** When a session's last run ended, since this server started. */
    endedAt(id: ConversationId): number | undefined {
        return this.#endedAt.get(id);
    }

    async conversationTitle(id: ConversationId): Promise<string> {
        const meta = this.#sessions[String(id)];

        if (meta !== undefined) {
            return meta.title ?? "New session";
        }

        return `Conversation ${String(id)}`;
    }

    conversationInfo(room: Room) {
        const meta = this.#sessions[String(room.id)];
        const agent = (room.value?.docs["pi.agent"] ?? {}) as AgentState;
        const forkedFrom = meta?.forkedFrom;
        const root = this.rootOf(room.id);
        const budget = this.#sessions[String(root)]?.budget;

        return {
            id: room.id,
            kind:
                meta === undefined
                    ? room.parent === undefined
                        ? "conversation"
                        : "subagent"
                    : "session",
            title:
                meta?.title ??
                room.subagentName ??
                (meta === undefined ? `Conversation ${String(room.id)}` : "New session"),
            cwd: agent.cwd ?? meta?.cwd ?? this.defaultCwd,
            archived: meta?.archived === true,
            // PiP's own conversation, opened as a page: some session things (a PR to watch) are not for it.
            ...(meta?.pip === undefined ? {} : { pip: true }),
            ...(room.parent === undefined ? {} : { parent: room.parent }),
            ...(room.subagentName === undefined ? {} : { subagentName: room.subagentName }),
            // Each browser finds the source's title in its own session list, so only people who can open it get a link.
            ...(forkedFrom === undefined ? {} : { forkedFrom }),
            // The session's spend with its subagents', and its limit, with what counts against it.
            spend: {
                spent:
                    budget === undefined
                        ? this.spend.sessionSpent(root)
                        : this.spend.budgetSpent(root),
                ...(budget === undefined ? {} : { budget }),
            },
            ...(meta?.worktree === undefined
                ? {}
                : { worktree: { branch: meta.worktree.branch, source: meta.worktree.source } }),
            // Its own limit on messages to other sessions (`session-control.ts`); absent, the setting for all.
            ...(meta?.sendLimit === undefined ? {} : { sendLimit: meta.sendLimit }),
            // Its own auto-compact (`auto-compact.ts`); absent, the setting for all.
            ...(meta?.compactAt === undefined ? {} : { compactAt: meta.compactAt }),
            // Who thinks in its voice calls (`voice.ts`); absent, Settings › Voice's mode.
            ...(meta?.voiceMode === undefined ? {} : { voiceMode: meta.voiceMode }),
            // Whether a fork could get a worktree of its own.
            ...(meta === undefined
                ? {}
                : { inRepository: this.workspace.inRepository(agent.cwd ?? meta.cwd) }),
        };
    }

    /** What a conversation runs with: its model, thinking level, folder, and instructions. */
    async agentState(id: ConversationId): Promise<AgentState | undefined> {
        return (
            this.#agents.get(id) ??
            ((await this.harness.snapshot(AgentDoc, id, context)) as AgentState | undefined)
        );
    }

    /** A conversation's handle; 404 when it does not exist. */
    async conversation(id: ConversationId): Promise<Conversation> {
        const conversation = await this.harness.conversation(id, context);

        if (conversation === undefined) {
            throw new HttpError(404, `Conversation ${String(id)} does not exist`);
        }

        return conversation;
    }

    /**
     * Why this person may not allow a call, or undefined when they may. With the "others" rule, a guest cannot allow a
     * call their own message led to; the owner always can. Denying is open to anyone who can steer.
     */
    cannotAllow(user: User, request: ApprovalRequest): string | undefined {
        if (user.role === "viewer") {
            return "You can view this session but not steer Pi.";
        }

        // An ask (`host.ask`) is answered by the person Pi works for: what it asks for is theirs. With nobody known, the
        // owner answers it. Anyone who can steer can decline it (pi-pocket 0.22.0).
        if (request.form?.type === "ask") {
            const answerer = request.requestedBy ?? this.config.users.find((each) => each.role === "owner")?.id;

            return answerer === user.id ? undefined : "Only the person Pi works for here can answer this.";
        }

        // In a session shared through the team server, only its owner allows calls (PP-57).
        if (user.team === true) {
            return "Waiting for the owner: in a shared session only they allow Pi's calls.";
        }

        if (this.config.approvalRule !== "others" || user.role === "owner") {
            return undefined;
        }

        // Not knowing who asked is not knowing that it was someone else.
        if (request.requestedBy === undefined) {
            return "Nobody is known to have asked for this call, so only the owner can allow it.";
        }

        return request.requestedBy === user.id
            ? "Someone else has to allow a call that your message led to."
            : undefined;
    }

    /**
     * Answer `secret_request`'s card: the value goes into Settings > Secrets, never into the conversation, and the call
     * goes on. The owner's alone: secrets are theirs.
     */
    async answerSecretRequest(id: string, value: unknown, user: User): Promise<boolean> {
        if (user.role !== "owner") {
            throw new HttpError(403, "Only the owner keeps secrets.");
        }

        const request = this.approvals.all().find((each) => each.id === id);

        if (request?.form?.type !== "secret") {
            return false;
        }

        const known = this.secrets.get(request.form.name);

        try {
            this.secrets.set(request.form.name, {
                value,
                ...(known === undefined ? { description: request.form.description.slice(0, 300) } : {}),
            });
        } catch (error) {
            throw new HttpError(400, error instanceof Error ? error.message : String(error));
        }

        return this.answerApproval(id, true, user, true);
    }

    /**
     * Answer an extension's question (`host.ask`): what the person typed, each field filled in, goes to the extension that
     * asked, never into the conversation or the request tabs see. The person Pi works for answers it (`cannotAllow`).
     */
    async answerAsk(id: string, values: unknown, user: User): Promise<boolean> {
        const request = this.approvals.all().find((each) => each.id === id);

        if (request?.form?.type !== "ask") {
            return false;
        }

        return this.answerApproval(id, true, user, true, checkValues(request.form.fields, values));
    }

    /**
     * Answer one of Pi's browser's cards (`extensions/browser.ts`): what the owner typed (or a sign-in kept in Secrets)
     * goes into the page's fields, never into the conversation, and the call goes on; "do" cards answer done or not.
     * A sign-in kept with Remember is saved in Secrets, asking before any use outside the browser. The owner's.
     */
    async answerBrowserAsk(id: string, body: { values?: unknown; remember?: unknown; useSaved?: unknown; done?: unknown }, user: User): Promise<boolean> {
        if (user.role !== "owner") {
            throw new HttpError(403, "Only the owner answers Pi's browser: it may be signed in as them.");
        }

        const request = this.approvals.all().find((each) => each.id === id);

        if (request?.form?.type !== "browser") {
            return false;
        }

        const form = request.form;

        if (form.kind === "do") {
            return this.answerApproval(id, body.done === true, user, true);
        }

        let values: Record<string, string>;

        if (body.useSaved === true) {
            const saved = form.secret === undefined ? undefined : this.secrets.value(form.secret);

            if (saved === undefined) {
                throw new HttpError(409, `No sign-in for ${form.site} is kept in Secrets.`);
            }

            try {
                values = savedSignIn(saved, form.site);
            } catch (error) {
                throw new HttpError(409, error instanceof Error ? error.message : String(error));
            }
        } else {
            values = typeof body.values === "object" && body.values !== null ? (body.values as Record<string, string>) : {};
        }

        // What the person typed stays out of what Pi reads of the page afterwards, the username too (`cardFills`).
        const fields = cardFills(form, values);

        if (fields.some((field) => typeof field.value !== "string" || field.value === "")) {
            throw new HttpError(400, `Fill in ${form.fields.map((field) => field.label).join(" and ")}.`);
        }

        try {
            await this.browserAt(form.place ?? "phone", Number(request.conversationId)).fillFields(Number(request.conversationId), fields as { index: number; value: string; hide: boolean | string }[]);
        } catch (error) {
            throw new HttpError(409, error instanceof Error ? error.message : String(error));
        }

        if (body.remember === true && form.kind === "sign-in" && form.secret !== undefined && body.useSaved !== true) {
            this.secrets.set(form.secret, {
                value: JSON.stringify(Object.fromEntries(form.fields.map((field) => [field.name, values[field.name]]))),
                description: `Sign-in for ${form.site}, kept by Pi's browser`,
                ask: true,
            });
        }

        return this.answerApproval(id, true, user, true);
    }

    /** What was typed and picked in one of a conversation's interactive answers (`openui.ts`), or null. */
    async answerState(id: ConversationId, key: string, user: User): Promise<Record<string, unknown> | null> {
        this.requireSee(user, id);

        if (!ANSWER_KEY.test(key)) {
            throw new HttpError(400, "Not an answer's key");
        }

        return (await this.harness.snapshot(OpenUiStateDoc, id, context))?.items[key]?.state ?? null;
    }

    /** Keep what was typed and picked in an interactive answer; the oldest go past `MAX_ANSWER_STATES`. */
    async saveAnswerState(id: ConversationId, key: string, user: User, state: unknown): Promise<void> {
        this.requireSteer(user);
        this.requireSee(user, id);

        if (!ANSWER_KEY.test(key)) {
            throw new HttpError(400, "Not an answer's key");
        }

        if (typeof state !== "object" || state === null || Array.isArray(state)) {
            throw new HttpError(400, "state is an object");
        }

        if (Buffer.byteLength(JSON.stringify(state)) > MAX_ANSWER_STATE_BYTES) {
            throw new HttpError(413, "This answer's state is too large to keep");
        }

        await this.harness.commit(async (tx) => {
            const doc = await tx.doc(OpenUiStateDoc, id);

            doc.items[key] = { state: JSON.parse(JSON.stringify(state)) as { [key: string]: JsonValue }, at: Date.now() };
            const keys = Object.keys(doc.items);

            if (keys.length > MAX_ANSWER_STATES) {
                for (const old of keys.sort((a, b) => doc.items[a]!.at - doc.items[b]!.at).slice(0, keys.length - MAX_ANSWER_STATES)) {
                    delete doc.items[old];
                }
            }
        }, context);
    }

    /** An interview Pi asked in a conversation, by its call: questions, the draft so far, and how it ended. */
    async interview(id: ConversationId, callId: string, user: User): Promise<Interview> {
        this.requireSee(user, id);
        const found = (await this.harness.snapshot(InterviewsDoc, id, context))?.items[callId];

        if (found === undefined) {
            throw new HttpError(404, "No such interview");
        }

        return found;
    }

    /**
     * Save a person's answers to an interview as they go; `submit` ends it with them, `cancel` without (what is
     * answered still reaches Pi). The waiting call goes on once it ends.
     */
    async answerInterview(
        id: ConversationId,
        callId: string,
        user: User,
        body: { draft?: unknown; action?: unknown },
    ): Promise<Interview> {
        this.requireSteer(user);
        this.requireSee(user, id);
        const action = body.action ?? "save";

        if (action !== "save" && action !== "submit" && action !== "cancel") {
            throw new HttpError(400, "action is save, submit, or cancel");
        }

        const draft = body.draft === undefined ? undefined : await this.#placeInterviewPhotos(id, callId, body.draft);

        const saved = await this.harness.commit(async (tx) => {
            const item = (await tx.doc(InterviewsDoc, id)).items[callId];

            if (item === undefined) {
                throw new HttpError(404, "No such interview");
            }

            if (item.status !== "waiting") {
                throw new HttpError(409, "This interview has ended");
            }

            if (draft !== undefined) {
                try {
                    item.draft = checkDraft(draft, item.questions.questions);
                } catch (error) {
                    throw new HttpError(400, error instanceof Error ? error.message : String(error));
                }
            }

            if (action !== "save") {
                item.status = action === "submit" ? "completed" : "cancelled";
                item.by = user.name;
                item.at = Date.now();
            }

            return JSON.parse(JSON.stringify(item)) as Interview;
        }, context);

        if (action !== "save") {
            const waiting = this.approvals
                .forConversation(id)
                .find((request) => request.form?.type === "interview" && request.form.callId === callId);

            if (waiting !== undefined) {
                this.approvals.answer(waiting.id, { allow: action === "submit", by: user.name });
            }
        }

        return saved;
    }

    /**
     * In a session on a machine, the photos and files a person adds to an interview are uploaded to the phone: copy each
     * one to the machine as it is saved, and keep its path there, so Pi's tools read it and the form shows it from there.
     * Paths that are not this session's uploads stay as they are.
     */
    async #placeInterviewPhotos(id: ConversationId, callId: string, draft: unknown): Promise<unknown> {
        if (this.workspace.remoteOf(id) === undefined) {
            return draft;
        }

        const item = (await this.harness.snapshot(InterviewsDoc, id, context))?.items[callId];

        if (item === undefined) {
            throw new HttpError(404, "No such interview");
        }

        let checked;

        try {
            checked = checkDraft(draft, item.questions.questions);
        } catch (error) {
            throw new HttpError(400, error instanceof Error ? error.message : String(error));
        }

        const images = new Set(item.questions.questions.filter((question) => question.type === "image").map((question) => question.id));
        const place = async (paths: readonly string[]): Promise<string[]> => {
            const local = paths.filter((path) => this.workspace.isUpload(id, path));
            const placed = await this.workspace.placeUploads(id, local);

            return paths.map((path) => (local.includes(path) ? placed[local.indexOf(path)]! : path));
        };

        return Promise.all(
            checked.map(async (response) => ({
                ...response,
                ...(images.has(response.id) && typeof response.value === "string" ? { value: (await place([response.value]))[0]! } : {}),
                ...(images.has(response.id) && Array.isArray(response.value) && response.value.every((each) => typeof each === "string")
                    ? { value: await place(response.value as string[]) }
                    : {}),
                ...(response.attachments === undefined ? {} : { attachments: await place(response.attachments) }),
            })),
        );
    }

    /** `values`: what was typed on an ask's card (`answerAsk`), for the asker alone. */
    async answerApproval(id: string, allow: boolean, user: User, formAnswered = false, values?: Record<string, string>): Promise<boolean> {
        this.requireSteer(user);
        const request = this.approvals.all().find((each) => each.id === id);

        if (request === undefined || !this.canSee(user, request.conversationId)) {
            return false;
        }

        // Pi's machine_add card (PP-139) is answered by Approve itself, and only by the owner: it adds a machine.
        if (allow && request.form?.type === "machine" && user.role !== "owner") {
            throw new HttpError(403, "Adding a machine is the owner's.");
        }

        // Its ticked tools (PP-177): only tools the card offered.
        if (request.form?.type === "machine" && values?.tools !== undefined) {
            const offered = request.form.tools.map((tool) => tool.id);
            const wrong = values.tools.split(",").filter((id) => id !== "" && !offered.includes(id));

            if (wrong.length > 0) {
                throw new HttpError(400, `The card offers no tool ${wrong.join(", ")}.`);
            }
        }

        // Pi's phone_control card (PP-141): Approve starts the session, and only the owner may give Pi the phone.
        if (allow && request.form?.type === "phone" && user.role !== "owner") {
            throw new HttpError(403, "Controlling the phone is the owner's.");
        }

        // Pi's computer_control card (PP-178): the same, for a computer.
        // computer_control setup's card (PP-230): a shell line kept and run on the machine, the owner's too.
        if (allow && (request.form?.type === "computer" || request.tool === "computer_control") && user.role !== "owner") {
            throw new HttpError(403, "Controlling a computer is the owner's.");
        }

        // Pi's extension_install card (PP-173): Install copies a module into the drop-in folder, and only the owner may.
        if (allow && request.form?.type === "extension" && user.role !== "owner") {
            throw new HttpError(403, "Installing an extension is the owner's.");
        }

        if (allow && request.form !== undefined && request.form.type !== "machine" && request.form.type !== "phone" && request.form.type !== "computer" && request.form.type !== "extension" && !formAnswered) {
            throw new HttpError(
                400,
                request.form.type === "secret"
                    ? "This asks for a secret: type it into the card's field."
                    : request.form.type === "ask"
                      ? "This is a question: fill in its card, then send it."
                      : "This is an interview: answer it in its form, then submit.",
            );
        }

        const refused = allow ? this.cannotAllow(user, request) : undefined;

        if (refused !== undefined) {
            throw new HttpError(403, refused);
        }

        if (!this.approvals.answer(id, { allow, by: user.name, ...(allow && values !== undefined ? { values } : {}) })) {
            return false;
        }

        const asked = request.form?.type === "ask";

        const conversationId = request.conversationId;

        if (request.callId !== undefined) {
            const callId = request.callId;

            await this.harness
                .commit(async (tx) => {
                    (await tx.doc(DecisionsDoc, conversationId)).calls[callId] = {
                        allow,
                        by: user.name,
                        userId: user.id,
                        at: Date.now(),
                        ...(asked ? { ask: true as const } : {}),
                    };
                }, context)
                .catch((error: unknown) => this.#log(`decision not recorded: ${describe(error)}`));
        }

        await this.collab.activity(
            conversationId,
            user,
            asked
                ? `${allow ? "answered" : "declined"} a question: ${snippet(request.subject, 120)}`
                : `${allow ? "allowed" : "denied"} the ${request.tool} call: ${snippet(request.subject, 120)}`,
        );

        return true;
    }

    /** The owner changes what someone may do: their role, or which session they may open. */
    setAccess(owner: User, userId: string, patch: { role?: unknown; sessions?: unknown }): void {
        if (owner.role !== "owner") {
            throw new HttpError(403, "Only the owner can do that");
        }

        const target = this.config.userById(userId);

        if (target === undefined) {
            throw new HttpError(404, "No such person");
        }

        if (target.role === "owner") {
            throw new HttpError(400, "The owner can do everything");
        }

        const change: { role?: "guest" | "viewer"; sessions?: string[] | undefined } = {};

        if (patch.role !== undefined) {
            if (patch.role !== "guest" && patch.role !== "viewer") {
                throw new HttpError(400, "role must be guest or viewer");
            }

            change.role = patch.role;
        }

        if (patch.sessions !== undefined) {
            if (patch.sessions === null) {
                change.sessions = undefined;
            } else if (
                Array.isArray(patch.sessions) &&
                patch.sessions.every((each) => this.#sessions[String(each)] !== undefined)
            ) {
                change.sessions = patch.sessions.map(String);
            } else {
                throw new HttpError(400, "sessions must be null or a list of session ids");
            }
        }

        this.config.updateUser(userId, change);
        const updated = this.config.userById(userId);

        for (const client of [...this.#clients]) {
            if (client.user.id !== userId || updated === undefined) {
                continue;
            }

            if (
                client.conversationId !== undefined &&
                !this.canSee(updated, client.conversationId)
            ) {
                this.#evict(client, "This session is no longer shared with you.");
            }

            for (const id of client.peeks ?? []) {
                if (!this.canSee(updated, id)) {
                    client.peeks?.delete(id);
                    this.#unpeek(client, id);
                }
            }
        }

        void this.#refreshUser(userId);
        this.#peopleChanged();
    }

    removeUser(owner: User, userId: string): void {
        if (owner.role !== "owner") {
            throw new HttpError(403, "Only the owner can do that");
        }

        if (this.config.userById(userId)?.role === "owner") {
            throw new HttpError(400, "The owner cannot be removed");
        }

        this.#forget(userId);
    }

    /**
     * Signed-in devices (Settings › People › Devices; `StoredDevice`): the owner sees everyone's, others their own. Each
     * with whose it is, its name, where it was last seen, when it signed in and was last active, whether a tab of it is
     * open now (and in front), and whether it is the one asking. Open ones first, then the most recently active.
     */
    devices(viewer: User, current?: string) {
        const open = new Map<string, { visible: boolean }>();

        for (const client of this.#clients) {
            const id = client.device?.id;

            if (id !== undefined) {
                open.set(id, { visible: (open.get(id)?.visible ?? false) || client.visible !== false });
            }
        }

        return this.config
            .devices(viewer.role === "owner" ? undefined : viewer.id)
            .flatMap((device) => {
                const user = this.config.userById(device.userId);

                return user === undefined
                    ? []
                    : [
                          {
                              id: device.id,
                              user: { id: user.id, name: user.name, role: user.role },
                              name: device.name,
                              createdAt: device.createdAt,
                              ...(device.lastSeen === undefined ? {} : { lastSeen: device.lastSeen }),
                              ...(device.address === undefined ? {} : { address: device.address }),
                              ...(device.app === true ? { app: true } : {}),
                              open: open.has(device.id),
                              ...(open.get(device.id)?.visible === false ? { background: true } : {}),
                              ...(device.id === current ? { current: true } : {}),
                          },
                      ];
            })
            .sort((a, b) => Number(b.open) - Number(a.open) || (b.lastSeen ?? 0) - (a.lastSeen ?? 0));
    }

    /** Close the open tabs of devices `which` picks, now: their next request finds them signed out. */
    #closeDevices(which: (client: Client) => boolean): void {
        for (const client of [...this.#clients]) {
            if (which(client)) {
                client.send("closing", {});
                this.detach(client);
                client.close?.();
            }
        }
    }

    /** A person by id, for what Pi does as them. */
    #person(userId: string): User {
        const user = this.config.userById(userId);

        if (user === undefined) {
            throw new HttpError(404, "That person is not here any more.");
        }

        return user;
    }

    /** Sign one device out: the owner any, others only their own. Its tabs close; the phone's app signs in again. */
    signOutDevice(viewer: User, id: string): void {
        const device = this.config.deviceById(id);

        if (device === undefined || (viewer.role !== "owner" && device.userId !== viewer.id)) {
            throw new HttpError(device === undefined ? 404 : 403, device === undefined ? "There is no such device." : "That device is someone else's.");
        }

        this.config.removeDevices((each) => each.id === id);
        this.#closeDevices((client) => client.device?.id === id);
    }

    /**
     * Sign out every other device of `user`'s (Settings › People): each device but `keep` (the one asking), and their
     * tabs. Their own token is replaced too, so an old-style sign-in holding it stops: the owner's (`rotateOwnerToken`,
     * which drops unused owner invites; the phone's service and app read it afresh), or another's. Invited people's
     * devices stay: the owner signs them out one by one, or removes the person.
     */
    signOutEverywhere(user: User, keep?: string): void {
        if (user.role === "owner") {
            this.config.rotateOwnerToken();
        } else {
            this.config.rotateUserToken(user.id);
        }

        this.config.removeDevices((device) => device.userId === user.id && device.id !== keep);
        this.#closeDevices((client) => client.user.id === user.id && (keep === undefined || client.device?.id !== keep));
    }

    /**
     * How other devices reach this server, from the launcher. People who signed in through another Cloudflare quick
     * tunnel can never sign in again (its address is gone, and their cookie works only there), so they are removed.
     */
    setReach(access: AccessInfo | undefined): void {
        this.access = access;
        let current: string | undefined;

        try {
            current = access?.url === undefined ? undefined : new URL(access.url).host;
        } catch {}

        for (const user of [...this.config.users]) {
            if (user.role !== "owner" && user.tunnel !== undefined && user.tunnel !== current) {
                this.#forget(user.id);
            }
        }
    }

    /** A teammate's scoped account (PP-55), made or changed; its open pages hear of the change at once. */
    #saveTeammate(account: { id?: string; name: string; role: "guest" | "viewer"; sessions: string[]; budget?: number | null }): { id: string; token?: string } {
        const sessions = account.sessions.filter((id) => this.#sessions[id] !== undefined);
        const budget = account.budget === null || account.budget === undefined ? undefined : account.budget;
        const known = account.id === undefined ? undefined : this.config.userById(account.id);

        if (known !== undefined && known.role !== "owner") {
            this.config.updateUser(known.id, { name: account.name, role: account.role, sessions, budget });
            void this.#refreshUser(known.id);
            this.#peopleChanged();

            return { id: known.id };
        }

        const made = this.config.addUser(account.name, account.role, sessions);

        this.config.updateUser(made.user.id, { team: true, ...(budget === undefined ? {} : { budget }) });

        this.#peopleChanged();

        return { id: made.user.id, token: made.token };
    }

    #forget(userId: string): void {
        this.config.removeUser(userId);

        // Their open tabs end now; reconnecting fails, so they land on the sign-in screen.
        for (const client of [...this.#clients]) {
            if (client.user.id !== userId) {
                continue;
            }

            client.send("closing", {});
            this.detach(client);
            client.close?.();
        }

        this.#peopleChanged();
    }

    /** Take a tab out of a conversation it may no longer see; it keeps app-wide events. */
    #evict(client: Client, message: string): void {
        const id = client.conversationId;

        if (id === undefined) {
            return;
        }

        client.conversationId = undefined;
        client.send("missing", { conversationId: id, message });
        this.#leaveRoom(client, id);
    }

    /** Someone's rights changed: their tabs get a fresh hello and session list. */
    async #refreshUser(userId: string): Promise<void> {
        const user = this.config.userById(userId);

        if (user === undefined) {
            return;
        }

        for (const client of this.#clients) {
            if (client.user.id !== userId) {
                continue;
            }

            client.send("hello", this.#helloFor(client, await this.hello(user)));
            this.#sendSessions(client, this.sessions(user));

            // An open board too: it must not keep subagents of sessions no longer shared.
            if (client.board === true) {
                client.boardSent = undefined;
                this.#sendBoard(client, this.subagents(user));
            }
        }
    }

    async artifactBody(id: ConversationId, artifact: string, version: number | undefined) {
        const index = await this.harness.snapshot(ArtifactsDoc, id, context);
        const meta = index?.items[artifact] as ArtifactMeta | undefined;

        if (meta === undefined) {
            throw new HttpError(404, "No such artifact");
        }

        const chosen =
            version === undefined
                ? meta.versions.at(-1)
                : meta.versions.find((each) => each.version === version);

        if (chosen === undefined) {
            throw new HttpError(404, "No such version");
        }

        const body = await this.harness.snapshot(
            ArtifactBodyDoc,
            id,
            `${artifact}@${chosen.version}`,
            context,
        );

        if (body === undefined) {
            throw new HttpError(404, "Artifact content is missing");
        }

        return { meta, version: chosen.version, content: body.content };
    }


    /** The folder a conversation works in. */
    cwdOf(id: ConversationId): string {
        return this.#agents.get(id)?.cwd ?? this.#sessions[String(id)]?.cwd ?? this.defaultCwd;
    }

    /** When Pi's settings were last read: Pi's CLI, or a person, can change them while Pi Pocket runs. */
    #settingsReadAt = Date.now();

    /**
     * What says where Pi's skills are, besides a session's folder: Pi's folder and settings, and the home folder. Pi's
     * settings are read again when the copy is older than `SETTINGS_STALE_MS`, in the background: a change (such as
     * `defaultProjectTrust`) counts from the request after.
     */
    #skillSources(): SkillSources {
        if (Date.now() - this.#settingsReadAt >= SETTINGS_STALE_MS) {
            this.#settingsReadAt = Date.now();
            this.settings.reload().catch(() => {
                // Unreadable now: the last good settings stay.
            });
        }

        let settingsPaths: string[] = [];
        let defaultProjectTrust: SkillSources["defaultProjectTrust"] = "ask";

        try {
            settingsPaths = this.settings.getSkillPaths();
            defaultProjectTrust = this.settings.getDefaultProjectTrust();
        } catch {
            // Unreadable settings: the default folders still count, and no project is trusted unasked.
        }

        // The app's skills: after Pi's own, so a skill of the owner's by the same name comes first.
        // pi-phone's own (`src/skills/`: getting-started), Effective HTML's (artifacts), OpenDesign's deck templates and
        // GSAP (PP-242), and OfficeCLI's where it runs (`third_party/`).
        const builtIn = [
            join(APP_ROOT, "src", "skills"),
            join(APP_ROOT, "third_party", "effective-html", "skills"),
            join(APP_ROOT, "third_party", "open-design", "skills"),
            ...(this.officecli.available() ? [this.officecli.skillsDir] : []),
        ];

        return { agentDir: getAgentDir(), home: this.#home, settingsPaths, defaultProjectTrust, builtIn };
    }

    /** Pi's skills for a session working in `cwd`, from the places Pi looks (`skills.ts`). */
    skills(cwd: string): Skill[] {
        return loadSessionSkills(cwd, this.#skillSources());
    }

    /**
     * Whether Pi trusts the project a conversation works in, and the project skills that wait for it. The owner's: the
     * skills may be in folders above the session's, which someone invited to it cannot see.
     */
    projectTrust(id: ConversationId, user: User): ProjectTrust {
        if (user.role !== "owner") {
            throw new HttpError(403, "Only the owner decides which projects Pi trusts.");
        }

        return readProjectTrust(this.cwdOf(id), this.#skillSources());
    }

    /** The owner's answer to "trust this project?", saved where Pi's CLI keeps its own, as its `/trust` does. */
    setProjectTrust(id: ConversationId, user: User, choice: TrustChoice): ProjectTrust {
        // Before anything is saved: only the owner may read it, or answer.
        const now = this.projectTrust(id, user);

        if (now.unreadable) {
            throw new HttpError(
                409,
                "Pi's trust store (~/.pi/agent/trust.json) cannot be read, so no answer can be saved. Mend or delete it first.",
            );
        }

        if (choice === "trust-parent" && now.parent === undefined) {
            throw new HttpError(400, "This folder has no folder above it.");
        }

        saveProjectTrust(this.cwdOf(id), getAgentDir(), choice);

        return this.projectTrust(id, user);
    }

    /** Pi's skills in a conversation's folder, to run as `/skill:name`. */
    skillCommands(id: ConversationId): SkillCommand[] {
        try {
            return this.skills(this.cwdOf(id)).map((skill) => ({
                name: skill.name,
                description: skill.description,
                path: skill.filePath,
                baseDir: skill.baseDir,
            }));
        } catch {
            return [];
        }
    }

    /** Pi's prompt templates, as a conversation in its folder offers them. */
    promptTemplates(id: ConversationId): PromptTemplate[] {
        let paths: string[] = [];

        try {
            paths = this.settings.getPromptTemplatePaths();
        } catch {
            // Unreadable settings: the default folders still count.
        }

        const cwd = this.cwdOf(id);

        // A project told "Don't trust" offers none of its own, as its .pi/skills.
        return loadPromptTemplates(cwd, getAgentDir(), paths, {
            project: !projectDistrusted(cwd, this.#skillSources()),
        });
    }

    // ─── Extensions ─────────────────────────────────────────────────────────

    /** The extension modules, as this person may see them: where the server keeps files is for the owner only. */
    async extensions(
        user: User,
    ): Promise<{ modules: ExtensionInfo[]; dropIns?: string; nameClashes?: { file: string; path: string }[] }> {
        const owner = user.role === "owner";
        // A load error can name the server's folders too.
        // Modules' routes are the owner's to know: others see only whose tabs load a browser module.
        const modules = this.loader.list().map(({ path, error, web, ...module }) =>
            owner
                ? {
                      ...module,
                      ...(path === undefined ? {} : { path }),
                      ...(web === undefined ? {} : { web }),
                      ...(error === undefined ? {} : { error }),
                  }
                : {
                      ...module,
                      ...(web?.client === undefined || !mayUse(user, web.client)
                          ? {}
                          : { web: { routes: [], client: web.client } }),
                      ...(error === undefined ? {} : { error: "It failed to load." }),
                  },
        );

        return {
            modules,
            // Where drop-ins go, and those never loaded for a built-in module's file name: the owner's to know.
            ...(owner ? { dropIns: join(this.dataDir, "extensions"), nameClashes: this.loader.nameClashes() } : {}),
        };
    }

    /** Turn an extension module on or off for every session, now and after restarts. */
    /**
     * Take a role's policy from the server edition's gateway (PP-22): kept, and applied now. The extensions that are a
     * permission's whole feature are turned off without it (and on again with it); the rest is checked where it is used.
     */
    async applyPolicy(user: User, given: unknown): Promise<void> {
        if (user.role !== "owner") {
            throw new HttpError(403, "Only the gateway (as this pi-phone's owner) sets its policy.");
        }

        const policy = checkPolicy(given);

        this.policy.set(policy);
        // The team accounts and machines the role may use come with the policy's change (PP-69, PP-82).
        await this.syncTeamAccounts();
        await this.syncTeamMachines();

        for (const [file, permission] of Object.entries(POLICY_EXTENSIONS)) {
            if (this.loader.list().some((each) => each.file === file)) {
                await this.setExtensionEnabled(user, file, policy.permissions.includes(permission), { byPolicy: true });
            }
        }

        for (const client of this.#clients) {
            client.send("reload", {});
        }
    }

    /**
     * The team accounts this person may use, as providers here (`team-accounts.ts`, PP-69): at start, when the role's
     * policy comes, and after one is signed in, out, or removed. A team server that does not answer leaves them as they
     * were, and says so in the log; their sessions then fail with the reason until the next try.
     */
    async syncTeamAccounts(tell = true): Promise<void> {
        try {
            await this.teamAccounts.sync(this.models);
        } catch (error) {
            this.log(`Team accounts not listed: ${describe(error)}`);
        }

        // Tabs get the models again; not while the app opens (nothing is drawn yet).
        if (tell) {
            this.providers.modelsChanged();
        }
    }

    /**
     * The team machines this person may use (PP-82): at start, with the role's policy, and when Machines opens. A team
     * server that does not answer leaves them as they were, and says so in the log.
     */
    async syncTeamMachines(): Promise<void> {
        try {
            await this.teamMachines.sync();
        } catch (error) {
            this.log(`Team machines not listed: ${describe(error)}`);
        }
    }

    /** Team accounts a teammate signed in, out, renamed or removed (PP-74): the models follow, and tabs hear of them. */
    async refreshTeamAccounts(): Promise<void> {
        try {
            if (await this.teamAccounts.refresh(this.models)) {
                this.providers.modelsChanged();
            }
        } catch (error) {
            this.log(`Team accounts not listed: ${describe(error)}`);
        }
    }

    /**
     * What installing a drop-in would replace in the drop-in folder (empty: nothing). A built-in module's name is refused:
     * that drop-in would never load.
     */
    dropInReplaces(pkg: DropInPackage): string[] {
        if (this.loader.builtInFiles().includes(pkg.module)) {
            throw new HttpError(409, `${pkg.module} is a built-in module's name: rename the module.`);
        }

        return replacedBy(pkg, this.#dropInFolder());
    }

    /**
     * Install a drop-in (PP-173), from Settings › Extensions' upload or `extension_install` after the owner's card: the
     * owner's alone. It lands switched off, and one it replaces is switched off first, so no new code runs until the owner
     * turns it on. What it would replace needs `replace`; without it, the answer says what (and nothing is written).
     */
    async installDropIn(user: User, pkg: DropInPackage, replace: boolean): Promise<{ file: string; installed: boolean; replaces: string[] }> {
        if (user.role !== "owner") {
            throw new HttpError(403, "Only the owner installs extensions.");
        }

        const replaces = this.dropInReplaces(pkg);

        if (replaces.length > 0 && !replace) {
            return { file: pkg.module, installed: false, replaces };
        }

        this.config.setExtensionEnabled(pkg.module, false);

        if (this.loader.files().includes(pkg.module)) {
            await this.loader.apply(pkg.module);
        }

        writePackage(pkg, this.#dropInFolder());
        await this.#refreshClients();
        this.notice("info", `${user.name} installed the drop-in ${pkg.module} (off until turned on).`);

        return { file: pkg.module, installed: true, replaces };
    }

    #dropInFolder(): string {
        const folder = this.loader.dropInFolder;

        if (folder === undefined) {
            throw new HttpError(409, "This pi-phone has no drop-in folder.");
        }

        return folder;
    }

    async setExtensionEnabled(user: User, file: string, enabled: boolean, { byPolicy = false }: { byPolicy?: boolean } = {}): Promise<void> {
        const module = this.loader.list().find((each) => each.file === file);

        if (module === undefined) {
            throw new HttpError(404, `There is no extension module ${file}`);
        }

        // A role's policy (PP-22): who may turn extensions on and off, and which stay off without their permission.
        if (!byPolicy) {
            const refusal = this.policy.refusal("extensions.manage") ?? (enabled && POLICY_EXTENSIONS[file] !== undefined ? this.policy.refusal(POLICY_EXTENSIONS[file]!) : undefined);

            if (refusal !== undefined) {
                throw new HttpError(403, refusal);
            }
        }

        if (module.required && !enabled) {
            throw new HttpError(400, `${module.title} is required and cannot be turned off`);
        }

        if (module.enabled === enabled) {
            return;
        }

        this.config.setExtensionEnabled(file, enabled);

        try {
            await this.loader.apply(file);
        } catch (error) {
            if (error instanceof Refused) {
                throw new HttpError(409, `${module.title} is on but refused: ${describe(error)}`);
            }

            throw new HttpError(
                500,
                `${module.title} is on but failed to load: ${describe(error)}`,
            );
        } finally {
            await this.#refreshClients();
        }

        this.notice(
            enabled ? "info" : "warning",
            `${user.name} turned ${module.title} ${enabled ? "on" : "off"}.`,
        );
    }

    async reloadExtension(file: string): Promise<void> {
        const module = this.loader.list().find((each) => each.file === file);

        if (module === undefined) {
            throw new HttpError(404, `There is no extension module ${file}`);
        }

        if (!module.enabled) {
            throw new HttpError(409, `${module.title} is off`);
        }

        try {
            await this.loader.reload(file);
        } catch (error) {
            if (error instanceof Refused) {
                throw new HttpError(409, `${module.title} is refused: ${describe(error)}`);
            }

            throw new HttpError(500, `${module.title} failed to load: ${describe(error)}`);
        } finally {
            await this.#refreshClients();
        }
    }

    /** The owner changes who may allow risky calls. */
    /** The owner's hourly limit for every session's messages to other sessions: a number, or null for none. */
    async setSessionSendLimit(user: User, limit: unknown): Promise<void> {
        if (user.role !== "owner") {
            throw new HttpError(403, "Only the owner can do that");
        }

        this.config.sessionSendLimit = checkSendLimit(limit);
        await this.#refreshClients();
    }

    /** Minutes a session is idle before it is captured into the wiki, or null: only when asked (`para-capture.ts`). */
    async setWikiCaptureMinutes(user: User, minutes: unknown): Promise<void> {
        if (user.role !== "owner") {
            throw new HttpError(403, "Only the owner can do that");
        }

        if (minutes !== null && (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < 1 || minutes > 1440)) {
            throw new HttpError(400, "Capture after a whole number of idle minutes from 1 to 1440, or null for only when asked.");
        }

        this.config.wikiCaptureMinutes = minutes;
        await this.#refreshClients();
    }

    /**
     * The model that describes images in documents (PP-49): one of the person's signed-in models that reads images, or
     * none. Nobody's model is used for it unless chosen here.
     */
    async setDocsImageModel(user: User, model: unknown): Promise<void> {
        if (user.role !== "owner") {
            throw new HttpError(403, "Only the owner can do that");
        }

        if (model === null) {
            this.config.docsImageModel = null;

            return;
        }

        const ref = (() => {
            try {
                return resolveModel(this.models, String(model), this.signInNeeded);
            } catch (error) {
                throw new HttpError(400, error instanceof Error ? error.message : String(error));
            }
        })();

        if (!this.models.getModel(ref.provider, ref.modelId)?.input.includes("image")) {
            throw new HttpError(400, `${ref.provider}/${ref.modelId} does not read images.`);
        }

        this.config.docsImageModel = `${ref.provider}/${ref.modelId}`;
    }

    /** The signed-in models that read images, for the Documents page's choice (provider/modelId). */
    imageModels(): string[] {
        return modelList(this.models, this.signInNeeded)
            .filter((model) => model.signIn !== true && this.models.getModel(model.provider, model.id)?.input.includes("image"))
            .map((model) => `${model.provider}/${model.id}`);
    }

    /** Describe an image with the chosen model (none chosen: undefined); its cost counts in Spend with the wiki's search. */
    async describeImage(mime: string, data: string, prompt: string): Promise<{ model: string; text: string } | undefined> {
        const chosen = this.config.docsImageModel;

        if (chosen === null) {
            return undefined;
        }

        const ref = resolveModel(this.models, chosen, this.signInNeeded);
        const model = this.models.getModel(ref.provider, ref.modelId);

        if (model === undefined) {
            throw new Error(`${chosen} is not available.`);
        }

        const reply = await this.models.completeSimple(
            model,
            { messages: [{ role: "user", content: [{ type: "text", text: prompt }, { type: "image", data, mimeType: mime }], timestamp: Date.now() }] },
            // A picture's description for search never waits for a provider's limit (`limit-gate.ts`).
            noWait({ maxTokens: 400, cacheRetention: "none" as const }),
        );

        this.spend.wikiUsed({ model: chosen, tokens: reply.usage.totalTokens, cost: reply.usage.cost.total });

        if (reply.stopReason === "error" || reply.stopReason === "aborted") {
            throw new Error(reply.errorMessage ?? reply.stopReason);
        }

        return { model: chosen, text: reply.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("").trim() };
    }

    /** The run model for `browser_run` (Settings › Browser), for every session, or one session's own ("inherit": none). */
    async setBrowserRunModel(user: User, model: unknown, id?: ConversationId): Promise<void> {
        if (user.role !== "owner") {
            throw new HttpError(403, "Only the owner can do that");
        }

        if (!(model === "session" || (id !== undefined && model === "inherit") || (typeof model === "string" && /^typesafe\/[a-z0-9][a-z0-9.\-]*$/i.test(model)))) {
            throw new HttpError(400, "The run model is \"session\" (the session's own model) or a Jev model's OpenRouter id, like typesafe/jev-1.13.");
        }

        if (id === undefined) {
            this.config.browserRunModel = model as string;

            return;
        }

        await this.harness.commit(async (tx) => {
            const meta = (await tx.doc(SessionsDoc)).items[String(id)];

            if (meta === undefined) {
                throw new HttpError(404, "There is no such session.");
            }

            if (model === "inherit") {
                delete meta.browserRunModel;
            } else {
                meta.browserRunModel = model as string;
            }
        }, context);
    }

    /** When every session compacts by itself (PP-78): a percentage, or "full". The owner's. */
    async setCompactAt(user: User, value: unknown): Promise<void> {
        if (user.role !== "owner") {
            throw new HttpError(403, "Only the owner can do that");
        }

        this.config.compactAt = checkCompactAt(value, false);
        await this.#refreshClients();
    }

    /** One session's own auto-compact: a percentage, "full", or "inherit" (the setting for all). Whoever steers it. */
    async setSessionCompactAt(id: ConversationId, user: User, value: unknown): Promise<void> {
        this.requireSee(user, id);
        await this.requireDriver(id, user);
        const at = checkCompactAt(value, true);
        const root = this.rootOf(id);

        await this.harness.commit(async (tx) => {
            const meta = (await tx.doc(SessionsDoc)).items[String(root)];

            if (meta === undefined) {
                throw new HttpError(404, "There is no such session.");
            }

            if (at === "inherit") {
                delete meta.compactAt;
            } else {
                meta.compactAt = at;
            }
        }, context);
    }

    /** One session's own limit: a number, null for none, or "inherit" for the owner's setting. */
    async setSendLimit(id: ConversationId, user: User, limit: unknown): Promise<void> {
        if (user.role !== "owner") {
            throw new HttpError(403, "Only the owner can do that");
        }

        const value = limit === "inherit" ? undefined : checkSendLimit(limit);

        await this.harness.commit(async (tx) => {
            const meta = (await tx.doc(SessionsDoc)).items[String(id)];

            if (meta === undefined) {
                throw new HttpError(404, "There is no such session.");
            }

            if (value === undefined) {
                delete meta.sendLimit;
            } else {
                meta.sendLimit = value;
            }
        }, context);
    }

    async setApprovalRule(user: User, rule: unknown): Promise<void> {
        if (user.role !== "owner") {
            throw new HttpError(403, "Only the owner can do that");
        }

        if (rule !== "anyone" && rule !== "others") {
            throw new HttpError(400, "approvalRule must be anyone or others");
        }

        if (rule === this.config.approvalRule) {
            return;
        }

        this.config.approvalRule = rule;
        await this.#refreshClients();
        this.notice(
            "info",
            rule === "others"
                ? `${user.name} made approvals need someone other than who asked.`
                : `${user.name} let anyone who can steer allow risky calls.`,
        );
    }

    /**
     * The theme and colors browsers start with until their person chooses (`config.themeDefault`): the owner's to set,
     * or `null` for the app's own. Everyone's tabs hear it in `hello`.
     */
    async setThemeDefault(user: User, choice: unknown): Promise<void> {
        if (user.role !== "owner") {
            throw new HttpError(403, "Only the owner sets the default theme");
        }

        if (choice === null) {
            this.config.themeDefault = undefined;
        } else {
            const { look, colors } = (choice ?? {}) as { look?: unknown; colors?: unknown };

            if (
                typeof look !== "string" ||
                typeof colors !== "string" ||
                !THEME_ID.test(look) ||
                !THEME_ID.test(colors.replace(/@(dark|light)$/, ""))
            ) {
                throw new HttpError(
                    400,
                    "The default is { look, colors }: a theme's id and colors' id, or null",
                );
            }

            if (!this.themes.list().some((each) => each.id === look && each.usable)) {
                throw new HttpError(404, "No such theme");
            }

            // Colors that are not here (the desktop's, on a machine without Omarchy) would leave new browsers on none.
            if (!(await this.themes.hasColors(colors))) {
                throw new HttpError(404, "No such colors here");
            }

            this.config.themeDefault = { look, colors };
        }

        await this.#refreshClients();
    }

    /**
     * The owner's default after a theme went (removed in Appearance or the gallery, or its folder deleted): a theme that
     * is gone gives way to Pocket, and colors that went with it (its own) to the desktop's; with both gone, no default.
     * Everyone's tabs hear it.
     */
    async #themeDefaultStillHere(): Promise<void> {
        const before = this.config.themeDefault;

        // When the owner's themes could not be read at the start, they are not gone: keep the default for the next start.
        if (before === undefined || this.themes.failure !== undefined) {
            return;
        }

        try {
            const lookGone =
                before.look !== BASE_THEME &&
                !this.themes.list().some((each) => each.id === before.look);
            // The desktop's colors are the app's own default: they never go.
            const colorsGone =
                before.colors !== "desktop" && !(await this.themes.hasColors(before.colors));

            if (!lookGone && !colorsGone) {
                return;
            }

            const look = lookGone ? BASE_THEME : before.look;
            const colors = colorsGone ? "desktop" : before.colors;

            this.config.themeDefault =
                look === BASE_THEME && colors === "desktop" ? undefined : { look, colors };
            await this.#refreshClients();
        } catch (error) {
            this.#log(`The default theme could not be checked: ${describe(error)}`);
        }
    }

    /**
     * The owner picks the model and thinking level new sessions start with: a signed-in model, its level kept to one it
     * has. Null leaves it to the last model picked, as before there was a choice.
     */
    async setDefaultModel(user: User, choice: unknown): Promise<void> {
        if (user.role !== "owner") {
            throw new HttpError(403, "Only the owner can do that");
        }

        if (choice === null) {
            if (this.config.defaultModel !== undefined) {
                this.config.defaultModel = undefined;
                await this.#refreshClients();
            }

            return;
        }

        const asked = (typeof choice === "object" ? choice : {}) as {
            provider?: unknown;
            modelId?: unknown;
            thinkingLevel?: unknown;
        };

        if (
            typeof asked.provider !== "string" ||
            typeof asked.modelId !== "string" ||
            (asked.thinkingLevel !== undefined && !isThinkingLevel(asked.thinkingLevel))
        ) {
            throw new HttpError(
                400,
                `defaultModel must be null, or { provider, modelId, thinkingLevel? } with thinkingLevel one of ${THINKING_LEVELS.join(", ")}`,
            );
        }

        const model = this.models
            .getAvailableSnapshot()
            .find((each) => each.provider === asked.provider && each.id === asked.modelId);

        if (model === undefined) {
            throw new HttpError(
                400,
                `Model ${asked.provider}/${asked.modelId} is not available: sign in to its provider first.`,
            );
        }

        const thinkingLevel = clampThinkingLevel(
            model,
            (asked.thinkingLevel ?? "off") as ModelThinkingLevel,
        );
        const before = this.config.defaultModel;

        if (
            before?.provider === model.provider &&
            before.modelId === model.id &&
            before.thinkingLevel === thinkingLevel
        ) {
            return;
        }

        this.config.defaultModel = { provider: model.provider, modelId: model.id, thinkingLevel };
        await this.#refreshClients();
    }

    /**
     * Whether a provider's sign-in expired and needs a person to sign in again: the model menu and a session's model chip
     * mark its models, and subagents on another model are refused them (`resolveModel`). A session's own run still tries.
     */
    readonly signInNeeded = (provider: string): boolean =>
        this.providers.needsSignIn(provider) !== undefined;

    /**
     * The owner picks the models Pi may start subagents on besides their session's own (`provider/modelId`, models Pi
     * knows). Empty, the default: none, and the subagent tool offers Pi no choice of model at all. The tool is rebuilt
     * to match, so its description and parameters say what Pi may do. This replaces the whole list; the Providers sheet
     * changes one model at a time (`allowSubagentModel`).
     */
    async setSubagentModels(user: User, models: unknown): Promise<void> {
        if (user.role !== "owner") {
            throw new HttpError(403, "Only the owner can do that");
        }

        if (
            !Array.isArray(models) ||
            models.length > MAX_SUBAGENT_MODELS ||
            models.some((each) => typeof each !== "string")
        ) {
            throw new HttpError(
                400,
                `subagentModels must be a list of at most ${String(MAX_SUBAGENT_MODELS)} models, each provider/modelId`,
            );
        }

        const chosen: string[] = [];

        for (const spec of models as string[]) {
            const slash = spec.indexOf("/");
            const model =
                slash > 0
                    ? this.models.getModel(spec.slice(0, slash), spec.slice(slash + 1))
                    : undefined;

            if (model === undefined) {
                throw new HttpError(400, `${spec} is not a model Pi knows (provider/modelId).`);
            }

            const key = `${model.provider}/${model.id}`;

            if (!chosen.includes(key)) {
                chosen.push(key);
            }
        }

        await this.#saveSubagentModels(chosen);
    }

    /**
     * The owner allows one model for subagents, or stops allowing it, and keeps the rest as they are now: what the
     * Providers sheet sends, so two quick taps, or two tabs, never undo each other. The list is read and written with no
     * wait between, so changes that come together all count. A model stopped need not be one Pi still knows. Returns the
     * list as it is then.
     */
    async allowSubagentModel(
        user: User,
        model: unknown,
        allowed: unknown,
    ): Promise<readonly string[]> {
        if (user.role !== "owner") {
            throw new HttpError(403, "Only the owner can do that");
        }

        if (typeof model !== "string" || typeof allowed !== "boolean") {
            throw new HttpError(400, "Send model (provider/modelId) and allowed (true or false).");
        }

        const current = this.config.subagentModels;
        let chosen = current.filter((each) => each !== model);

        if (allowed) {
            const slash = model.indexOf("/");
            const found =
                slash > 0
                    ? this.models.getModel(model.slice(0, slash), model.slice(slash + 1))
                    : undefined;

            if (found === undefined) {
                throw new HttpError(400, `${model} is not a model Pi knows (provider/modelId).`);
            }

            const key = `${found.provider}/${found.id}`;

            chosen = current.includes(key) ? [...current] : [...current, key];

            if (chosen.length > MAX_SUBAGENT_MODELS) {
                throw new HttpError(
                    400,
                    `At most ${String(MAX_SUBAGENT_MODELS)} models can be allowed for subagents.`,
                );
            }
        }

        await this.#saveSubagentModels(chosen);

        return this.config.subagentModels;
    }

    /**
     * Keep the models for subagents, rebuild the subagent tool to match, and tell the owner's tabs, the only ones whose
     * hello carries the list.
     */
    async #saveSubagentModels(chosen: readonly string[]): Promise<void> {
        const before = this.config.subagentModels;

        if (JSON.stringify(before) === JSON.stringify(chosen)) {
            return;
        }

        this.config.subagentModels = chosen;

        // The tool offers a model only while some are allowed: rebuilt now, for the next request of every session.
        if (this.loader.enabled(SUBAGENTS_FILE)) {
            try {
                await this.loader.reload(SUBAGENTS_FILE);
            } catch (error) {
                // A module's error can name the server's folders: the owner's to read.
                this.ownerNotice("error", `Subagents failed to reload: ${describe(error)}`);
            }
        }

        await this.#refreshClients((user) => user.role === "owner");
        // What changed: the checklist shows the rest.
        const added = chosen.filter((each) => !before.includes(each));
        const removed = before.filter((each) => !chosen.includes(each));
        const said = [
            ...(added.length === 0 ? [] : [`${added.join(", ")} allowed for subagents`]),
            ...(removed.length === 0
                ? []
                : [`${removed.join(", ")} no longer allowed for subagents`]),
        ];

        if (said.length > 0) {
            this.ownerNotice("info", `${said.join("; ")}.`);
        }
    }

    /** Send clients a fresh hello, every one or those of the people `to` names: what it carries changed. */
    async #refreshClients(to: (user: User) => boolean = () => true): Promise<void> {
        for (const client of this.#clients) {
            if (to(client.user)) {
                client.send("hello", this.#helloFor(client, await this.hello(client.user)));
            }
        }
    }

    // ─── Browser ────────────────────────────────────────────────────────────

    // ─── Shutdown ───────────────────────────────────────────────────────────

    /** The PATH of commands on the phone: `officecli` when installed and `pi-ssh` (the app's machines, through its agent) first. */
    #toolPath(): string {
        const office = this.officecli.available() ? `${this.officecli.binDir}:` : "";

        return `${office}${join(this.machines.piSsh, "..")}:${process.env.PATH ?? ""}`;
    }

    close(): Promise<void> {
        this.#closing ??= (async () => {
            clearTimeout(this.#sessionsTimer);
            clearInterval(this.#browserSweep);
            this.phoneControl.close();
            this.computerControl.close();
            this.voice.endAll();
            // Each call's connection closed (bounded: one that OpenAI does not answer is ended) and what was said kept,
            // before the storage closes: a stopping server waits for no socket (PP-198).
            await this.voiceBridge.closeAll();
            await this.spend.voiceStored();
            this.themes.close();
            this.spend.close();
            this.limits.close();
            this.#unsubscribeCommits?.();
            this.#unsubscribeApprovals?.();

            // Modules' cleanups may wait (closing a connection), but not for long: the rest must close too.
            const cleaned = this.loader?.close();

            // After the loader: its last changes could set it again.
            clearTimeout(this.#websTimer);

            for (const client of this.#clients) {
                client.send("closing", {});
            }

            for (const pending of this.#rooms.values()) {
                void pending.then(
                    (room) => room.close(),
                    () => {},
                );
            }

            this.providers.close();
            this.github.cancel();

            // A timer that holds the process: with nothing else to do, Node would end it here, before the rest closed.
            let limit: NodeJS.Timeout | undefined;

            await Promise.race([
                cleaned,
                new Promise<void>((resolve) => {
                    limit = setTimeout(resolve, CLEANUP_LIMIT_MS);
                }),
            ]);
            clearTimeout(limit);

            let storageClosed = false;

            try {
                // Close writes no outcome: running work resumes when the next process opens the storage.
                if (this.harness !== undefined) {
                    await this.harness.close(context);
                } else {
                    await this.#openingStorage?.close(context);
                }

                storageClosed = true;
                this.paraCapture.stop();
                this.forwards.closeAll();
                await this.para.close();
                await this.places.close(context);
                await this.teamMachines.close();
                this.sshAgent.stop();
                this.sshKeys.close();
            } finally {
                // Never while the storage may still be open: another process would open it beside this one.
                if (storageClosed) {
                    this.#releaseLock?.();
                }
            }
        })();

        return this.#closing;
    }
}
