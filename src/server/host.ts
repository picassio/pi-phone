import type { Context } from "@earendil-works/chord";
import type { Shot } from "./screenshots.ts";
import type { PiBrowser } from "./browser/pi-browser.ts";
import type { AppAction, Setting, TargetKind } from "./settings-registry.ts";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { awaitWithContext } from "@earendil-works/chord/context";
import type { Skill } from "@earendil-works/pi-coding-agent";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type {
    ConversationId,
    DocumentReader,
    Extension,
    ModelRef,
    TaskId,
    Tx,
} from "@earendil-works/pi-durable";
import type { Role, User } from "./config.ts";
import type { Goals } from "./goals.ts";
import type { Schedules } from "./schedules.ts";
import type { SessionControl } from "./session-control.ts";
import type { Para } from "./para.ts";
import type { ParaCapture } from "./para-capture.ts";
import type { Secrets } from "./secrets.ts";
import type { PolicyStore } from "./policy.ts";
import type { Machines } from "./machines.ts";
import type { MachineTools, ToolOffer } from "./machine-tools.ts";
import type { SshKeys } from "./ssh-keys.ts";
import type { PhoneApp, PhoneControl } from "./phone-control.ts";
import type { ComputerApp, ComputerControl } from "./computer-control.ts";
import type { WebSearch } from "./web/access.ts";
import type { ImageGen } from "./image-gen.ts";
import type { CommandEnvProvider, HiddenValue } from "./hidden.ts";
import type { DropInPackage } from "./drop-in-install.ts";

export type { CommandEnvProvider, CommandRun, HiddenValue } from "./hidden.ts";

export interface ApprovalRequest {
    id: string;
    conversationId: ConversationId;
    taskId: TaskId;
    /** The model's tool call id, to show the decision on the call's card afterwards. */
    callId?: string;
    tool: string;
    subject: string;
    reason: string;
    score?: number;
    /**
     * What the person answers besides allow or deny: a secret's value, typed into a hidden field (`secret_request`), or
     * an interview's questions, answered in its sheet (`interview`, by its call's id).
     */
    form?:
        | { type: "secret"; name: string; description: string }
        | { type: "interview"; callId: string; title: string; count: number }
        /**
         * Pi adds a machine (`machine_add`, PP-139): what Approve does, shown whole. The host key as scanned now, and
         * whether it is the one Pi was given (`expected`, read on the machine itself), when Pi gave one.
         */
        | {
              type: "machine";
              name: string;
              address: string;
              key: { name: string; fingerprint: string; new: boolean };
              hostKeys: string[];
              expected?: string;
              matches?: boolean;
              /** The tools offered to install once it is connected, every one ticked (PP-177); the answer names those kept. */
              tools: ToolOffer[];
          }
        /**
         * Pi asks to control a phone (`phone_control`, PP-141): the device, the apps the session may touch (with the home
         * screen), and for how long. Approve starts it, and only the owner approves.
         */
        | { type: "phone"; device: string; deviceName: string; apps: PhoneApp[]; minutes: number; follow: boolean }
        /**
         * Pi asks to control a computer (`computer_control`, PP-178): the machine, the apps (by their window titles and
         * names), and the minutes Pi asked for. Approve starts it, and only the owner approves.
         */
        | { type: "computer"; machine: string; machineName: string; platform: string; ocu: string; apps: ComputerApp[]; minutes: number; follow: boolean }
        /**
         * Pi asks the owner to sign in in a window of its computer control session (`computer_sign_in`, PP-183): the
         * machine, the app, and the elements (by Pi's numbers) the username, password or code go into, named in the
         * app's own words (`label`), never the window's. What the owner types goes into the window through ocu, never to
         * Pi; a sign-in may be kept in Secrets as `secret` and used again from there.
         */
        | {
              type: "computer-sign-in";
              machine: string;
              machineName: string;
              app: ComputerApp;
              fields: { name: "username" | "password" | "code"; index: number; label: string }[];
              secret?: string;
              saved?: boolean;
          }
        /**
         * Pi asks the owner to connect Chrome Remote Desktop on a Windows machine to their Google account
         * (`computer_control setup` with crd: connect, PP-263): the card shows Google's steps; the command the owner
         * pastes and the PIN they choose go to the machine through the server (`answerCrdConnect`), never to Pi.
         */
        | { type: "crd-connect"; machine: string; machineName: string }
        /**
         * Pi's browser asks the person (`extensions/browser.ts`): to sign in (a username and a password, typed into the
         * page's fields `fields` name), for a one-time code, or to do something on the page themselves. What they type
         * goes into the page, never to Pi; a sign-in may be kept in Secrets as `secret` and used again from there.
         */
        | {
              type: "browser";
              kind: "sign-in" | "code" | "do";
              site: string;
              fields: { name: "username" | "password" | "code"; index: number; label: string }[];
              instruction?: string;
              /** The Secrets name a sign-in for this site is kept under, and whether one is kept there now. */
              secret?: string;
              saved?: boolean;
              /** Which browser the page is in: `phone`, or `machine:<id>` (absent: the phone's). */
              place?: string;
          }
        /**
         * An extension's question (`host.ask`, pi-pocket 0.22.0): what the card asks, and its fields. Only the person Pi
         * works for answers it; anyone who can steer can decline it. Its values go to the asker, never here.
         */
        | AskForm
        /**
         * Pi installs a drop-in extension (`extension_install`, PP-173): what Install copies into the drop-in folder, shown
         * first: where it comes from, its size, its files and what is left out, what it replaces, and the module's first
         * lines. The owner's to approve.
         */
        | {
              type: "extension";
              path: string;
              module: string;
              bytes: number;
              files: string[];
              leftOut: string[];
              replaces: string[];
              head: string;
          };
    createdAt: number;
    /** Who Pi was working for when the call asked: set by `Approvals`, not by the asker. */
    requestedBy?: string;
}

/** What an ask's card shows (`ApprovalRequest.form`). */
export type AskForm = { type: "ask"; title: string; text?: string; fields: AskField[]; submit: string };

/** The answer to an approval; an ask's also carries what the person typed, which no one else sees. */
export type ApprovalAnswer = { allow: boolean; by: string; values?: Record<string, string> };

/** One field of an ask's card. */
export interface AskField {
    /** The value's key in the answer: letters, digits, and _, starting with a letter. */
    name: string;
    /** What the card says above the field. */
    label: string;
    /** A hidden input, as for a password. */
    secret?: boolean;
    /** What the field shows while empty. */
    placeholder?: string;
    /** A hint for the browser and the phone's keyboard: `username`, `current-password`, `one-time-code`, … */
    autocomplete?: string;
}

/** A question for the person Pi works for, on a card in the session (`host.ask`). */
export interface AskRequest {
    readonly conversationId: ConversationId;
    /** Unique while it waits, and the same when the call asks again: `${api.taskId}:${api.callId}`. */
    readonly id: string;
    /** The task that asks, so the card shows on its call. */
    readonly taskId: TaskId;
    /** The model's tool call id, to show the answer on the call's card. */
    readonly callId?: string;
    /** One line: what is asked, such as "Sign in to example.com". */
    readonly title: string;
    /** More words, such as what to do first. */
    readonly text?: string;
    /** Up to 6 fields; none for a question answered with the button alone ("Done"). */
    readonly fields?: readonly AskField[];
    /** The button's words: "Send" by default, or "Done" with no fields. */
    readonly submit?: string;
}

/** What the person did: answered, with the values they typed, or declined. */
export type AskAnswer =
    | { readonly answered: true; readonly by: string; readonly values: Readonly<Record<string, string>> }
    | { readonly answered: false; readonly by: string };

/**
 * Tool calls waiting for a human. In memory on purpose: the guard hook runs before a call's intent is stored, so after
 * a restart the hook runs again and asks again, unless its memo already holds the answer.
 */
export class Approvals {
    readonly #pending = new Map<
        string,
        { request: ApprovalRequest; resolve: (answer: ApprovalAnswer) => void }
    >();
    readonly #listeners = new Set<(conversationId: ConversationId) => void>();
    readonly #requesterOf: (conversationId: ConversationId) => string | undefined;

    /** `requesterOf`: who Pi works for in a conversation right now. */
    constructor(requesterOf: (conversationId: ConversationId) => string | undefined) {
        this.#requesterOf = requesterOf;
    }

    request(asked: ApprovalRequest, context: Context): Promise<ApprovalAnswer> {
        // Who asked is fixed now: someone writing to Pi while the call waits does not become its requester.
        const { requestedBy: _ignored, ...rest } = asked;
        const requestedBy = this.#requesterOf(asked.conversationId);
        const request: ApprovalRequest =
            requestedBy === undefined ? rest : { ...rest, requestedBy };
        const existing = this.#pending.get(request.id);

        if (existing !== undefined) {
            existing.resolve({ allow: false, by: "superseded" });
        }

        const answered = new Promise<ApprovalAnswer>((resolve) => {
            this.#pending.set(request.id, { request, resolve });
        });

        this.#emit(request.conversationId);

        return awaitWithContext(answered, context).finally(() => {
            if (this.#pending.get(request.id)?.request === request) {
                this.#pending.delete(request.id);
                this.#emit(request.conversationId);
            }
        });
    }

    answer(id: string, answer: ApprovalAnswer): boolean {
        const pending = this.#pending.get(id);

        if (pending === undefined) {
            return false;
        }

        this.#pending.delete(id);
        pending.resolve(answer);
        this.#emit(pending.request.conversationId);

        return true;
    }

    forConversation(conversationId: ConversationId): ApprovalRequest[] {
        return [...this.#pending.values()]
            .map((pending) => pending.request)
            .filter((request) => request.conversationId === conversationId);
    }

    all(): ApprovalRequest[] {
        return [...this.#pending.values()].map((pending) => pending.request);
    }

    subscribe(listener: (conversationId: ConversationId) => void): () => void {
        this.#listeners.add(listener);

        return () => this.#listeners.delete(listener);
    }

    #emit(conversationId: ConversationId): void {
        for (const listener of this.#listeners) {
            listener(conversationId);
        }
    }
}

/** What a command gives back: a notice for the person who ran it alone, or a card of plain text for everyone here. */
export type CommandResult =
    | { type: "toast"; level: "info" | "warning" | "error"; message: string }
    | { type: "card"; output: string };

/** Who ran a command and where, with the durable task that runs it: read and change documents through it. */
export interface CommandContext {
    readonly user: Readonly<Pick<User, "id" | "name" | "role">>;
    readonly conversationId: ConversationId;
    readonly cwd: string;
    readonly signal: AbortSignal;
    readonly snapshot: DocumentReader["snapshot"];
    readonly context: Context;
    /** Change documents in one commit; answers what `change` returns. */
    commit<T>(change: (tx: Tx) => T | Promise<T>): Promise<T>;
}

/**
 * A command people run from the message box (`web.command(name, command)`), without asking Pi. `scope` says who may run
 * it: `"conversation"`, whoever may drive the session; `"global"`, the owner alone. Either way it runs in the session it
 * was typed in, and its card goes there.
 */
export interface ExtensionCommand {
    description: string;
    args?: string;
    scope: "conversation" | "global";
    handler(args: string, context: CommandContext): CommandResult | Promise<CommandResult>;
}

/** What browsers know about a command: no handler, and no file. The id changes with each version of its module. */
export type CommandInfo = Omit<ExtensionCommand, "handler"> & { id: string; name: string };

/** What the app gives its extensions. Extensions are reloaded on edit; the host is not. */
export interface PocketHost {
    readonly approvals: Approvals;
    readonly agentDir: string;
    readonly dataDir: string;
    /** Pi's configured extra skill paths, from its settings. */
    skillPaths(): string[];
    /** Pi's skills for a session working in `cwd`, from the places Pi looks (`skills.ts`). */
    skills(cwd: string): Skill[];
    /** The app's own skill folders now: those of extensions that are on (Design & video's) among them. */
    builtInSkills(): string[];
    /** What the prompt says of the person's default design system (`design-systems.ts`), or undefined for none. */
    designSystem(): string | undefined;
    /**
     * The connected machines, each with the short alias Pi names it by (machine_run, machine_copy), and whether Pi asks
     * before each machine_run command there (`askRun`, PP-230).
     */
    machines(): { id: string; name: string; alias: string; address: string; home: string; windows: boolean; askRun: boolean }[];
    /** The phone's home folder. */
    readonly home: string;
    /** The machine a session's cwd is on (`places.ts`), with what the prompt says about it; undefined on this phone. */
    machineOf(cwd: string): { name: string; address: string; path: string; platform: string; tools: Record<string, string> } | undefined;
    /** The app's own address for the phone's WebView (`http://127.0.0.1:<port>`), once it listens. */
    serverBase(): string | undefined;
    /** Pictures of a page, rendered by the app's service on the phone (`screenshots.ts`). */
    render(url: string, options: { widths: number[]; fullPage?: boolean; settleMs?: number }): Promise<Shot[]>;
    /**
     * Pi's browser for a session working in `cwd` (`browser/pi-browser.ts`): the phone's, or for a session on a machine,
     * a Chrome on that machine (`browser/machine-engine.ts`). The pages Pi reads and acts on, which the owner watches.
     */
    browserFor(cwd: string, session: number): PiBrowser;
    /**
     * Where a session browses from now on (PP-274): "phone", or a machine by name or id. Answers its place
     * (`phone`, `machine:<id>`); refused while it is attached to a browser.
     */
    setBrowserPlace(cwd: string, session: number, where: string): string;
    /** A place in words ("this phone", a machine's name). */
    browserWhere(place: string): string;
    /**
     * Attach a session's browser to a browser's DevTools on a machine's 127.0.0.1 (`browser_attach`, PP-274), asking the
     * owner first (`ask`) unless it is pi-phone's own there; and let go of it (`browser_detach`). What Pi is told.
     */
    attachBrowser(
        cwd: string,
        session: number,
        options: { machine: string; port?: number; activePort?: string; label?: string; tabs?: "own" | "all" },
        ask: (request: { subject: string; reason: string }) => Promise<{ allow: boolean; by: string }>,
    ): Promise<string>;
    detachBrowser(session: number): Promise<string>;
    /** The run model for a session's `browser_run`: "session", or a Jev model's OpenRouter id (the session's own, else the owner's). */
    browserRunModel(conversationId: ConversationId): string;
    /** A provider's API key from the app's sign-ins (OpenRouter's, for Jev), or undefined when it is not signed in. */
    apiKey(provider: string): Promise<string | undefined>;
    /** Ask a session's own model a prompt alone (no history, no tools): its reply's text; it counts as the session's spend. */
    askSessionModel(conversationId: ConversationId, prompt: string, maxTokens: number): Promise<string>;
    /** Count a request made for a session elsewhere (Jev's decisions) in its Spend, under `key`. */
    chargeSession(conversationId: ConversationId, key: string, usage: { input: number; output: number; cost: number }): Promise<void>;
    /** The skills of tools pi-phone installed on the session's machine, formatted for the prompt; undefined for none. */
    machineSkills(cwd: string): string | undefined;
    /**
     * `provider/modelId` (or a bare model id) to a signed-in model whose sign-in has not expired, or an error that says
     * it is not available. The error names no other models: models are a person's to choose.
     */
    resolveModel(spec: string): ModelRef;
    /**
     * The models Pi may start subagents on besides their session's own, as the owner allowed them (`provider/modelId`).
     * Empty, the default: none.
     */
    subagentModels(): readonly string[];
    /** Images in documents (PP-49): the model the person chose to describe them (provider/modelId) or null, the ones they may choose, and a description. */
    readonly docsImages: {
        model(): string | null;
        models(): string[];
        choose(model: string | null): Promise<void>;
        describe(mime: string, data: string, prompt: string): Promise<{ model: string; text: string } | undefined>;
    };
    /**
     * Why Pi may not use a model now, in words for Pi to pass on (not known here, its provider not signed in, or its
     * sign-in expired), or undefined when it may. `fresh` asks the provider's sign-in again first.
     */
    modelProblem(ref: ModelRef, fresh?: boolean): Promise<string | undefined>;
    /** Who Pi works for in a conversation now: whose message led to its current work. */
    requesterOf(conversationId: ConversationId): string | undefined;
    /**
     * Start a session in `cwd` (here, or `machine:<id>:<path>`) as a person, with a first message sent for them
     * (`via` says by what): the Projects extension's main and task sessions. Answers its id.
     */
    startSession(request: { userId: string; cwd: string; title: string; message: string; via: string }): Promise<number>;
    /** Send a session a message for a person, after its current work (`via` says by what): a task session's report. */
    sendToSession(request: { userId: string; session: number; message: string; via: string }): Promise<void>;
    /** Hear sessions' runs end, fail, or wait for approval, as the phone does; returns how to stop. */
    onSessionEvent(listener: (event: { kind: string; session: number; text: string }) => void): () => void;
    /** Keep the ends of the sessions `test` names from the phone (approvals and failures still reach it). */
    quietSessions(test: (session: number) => boolean): () => void;
    /** Run a command in a folder here or on a machine; never throws for its exit code. */
    run(cwd: string, command: string, timeoutSeconds?: number): Promise<{ code: number; stdout: string; stderr: string }>;
    /**
     * Settle a session (out of the active list until something happens there): a task session whose run ended. `ifUnset`:
     * only when nothing settled or un-settled it before (a backfill must not undo a person's Un-settle).
     */
    settleSession(session: number, reason: string, ifUnset?: boolean): Promise<void>;
    /** Put a session in a group the list shows together (a project's team), or take it out (null). */
    groupSession(session: number, group: { id: string; title: string; role: "lead" | "task" } | null): Promise<void>;
    /** A session's title, or undefined when there is no such session. */
    sessionTitle(session: number): string | undefined;
    /** The machine a session works on (its name), or undefined when it works here or there is no such session. */
    sessionMachine(session: number): string | undefined;
    /** A conversation's folder (`machine:<id>:<path>` on a machine), where its bash starts. */
    cwdOf(conversationId: ConversationId): string;
    /**
     * Teammates' scoped accounts in this pi-phone (PP-55: sessions shared through the team server). `save` makes one
     * (answering its token, once) or changes one: Can write is `guest`, Can watch is `viewer`, each limited to
     * `sessions`; `budget` is their spend limit (null: none). `remove` ends it, and its open pages, at once.
     */
    readonly sharedCopy: {
        /** A session as a Pi session file (PP-59), for the gateway to hand to a teammate. */
        export(session: number): Promise<{ title: string; text: string }>;
        /** A Pi session file from a teammate's shared session, continued here as a new session in the default folder. */
        import(name: string, text: string): Promise<{ id: number }>;
    };
    readonly teammates: {
        save(account: { id?: string; name: string; role: "guest" | "viewer"; sessions: string[]; budget?: number | null }): { id: string; token?: string };
        remove(id: string): void;
        exists(id: string): boolean;
    };
    /**
     * Where a session's work is now: working (since when), waiting for an approval, or ended (failed or not, and when, if
     * this process saw it end). Undefined when there is no such session.
     */
    sessionState(session: number): { busy: boolean; busySince?: number; waiting: boolean; failed: boolean; endedAt?: number } | undefined;
    /** A session's last answer, as one line (empty when it has none): what a run that ended unheard said. */
    lastAnswer(session: number): Promise<string>;
    /**
     * Resolves once the app has opened: its sessions read back and the harness up. Extensions load before that, so what
     * they do with sessions as they start waits for it.
     */
    ready(): Promise<void>;
    /** Everyone in the app now, by id, name, and role (the Projects extension's sharing). */
    people(): { id: string; name: string; role: Role }[];
    /**
     * Signed-in devices as `userId` sees them (Settings › People › Devices): the owner everyone's, others their own; and
     * signing one out, or every other one of theirs (the owner's also replaces the owner token).
     */
    devices(userId: string): { id: string; user: { id: string; name: string; role: Role }; name: string; createdAt: number; lastSeen?: number; address?: string; app?: boolean; open: boolean }[];
    signOutDevice(userId: string, id: string): void;
    /** Every app setting and action Pi may use (`settings-registry.ts`), as `userId` may: the `settings` tools' source. */
    appSettings(): { settings: Setting[]; actions: AppAction[]; targets: Record<TargetKind, () => Promise<string[]> | string[]> };
    /** A person by id, for what Pi does as them. */
    person(userId: string): User;
    signOutEverywhere(userId: string): void;
    /** Whether a person may see a session, as the app decides it for them (`canSee`). */
    canSee(userId: string, conversationId: ConversationId): boolean;
    /**
     * Ask the person Pi works for on a card in the session, as an approval asks: their answer, with the values they
     * typed, goes to the extension, never to Pi or into the transcript. Do not keep the values in a memo or a document.
     * (pi-pocket 0.22.0's extension point.)
     *
     * @experimental As in pi-pocket 0.22: it can change in a minor release.
     */
    ask(request: AskRequest, context: Context): Promise<AskAnswer>;
    /**
     * The owner's drop-in extensions (`drop-in-install.ts`, PP-173): what a package would replace (it throws for a
     * built-in module's name), and installing one as a person (the owner alone), switched off.
     */
    readonly dropIns: {
        replaces(pkg: DropInPackage): string[];
        install(userId: string, pkg: DropInPackage, replace: boolean): Promise<{ file: string; installed: boolean; replaces: string[] }>;
    };
    /**
     * Hide a value from what Pi and people read: command output as it streams, every tool's result, and people's
     * messages to Pi. It shows as `[label]`, as the owner's secrets show as `[secret NAME]`. Returns how to stop; pass
     * that to `web.onDispose`. (pi-pocket 0.22.0's extension point.)
     *
     * @experimental As in pi-pocket 0.22: it can change in a minor release.
     */
    hide(value: HiddenValue): () => void;
    /**
     * Add environment variables to the commands Pi and people run in sessions (bash, `!` commands, goal checks), chosen
     * for each command. What the app sets itself (PATH, the owner's secrets a command names) is not replaced. Returns
     * how to stop; pass that to `web.onDispose`. (pi-pocket 0.22.0's extension point.)
     *
     * @experimental As in pi-pocket 0.22: it can change in a minor release.
     */
    commandEnv(provider: CommandEnvProvider): () => void;
    /** Report something odd to the log and the connected clients: with `conversationId`, to that session's tabs only. */
    notice(
        level: "info" | "warning" | "error",
        message: string,
        conversationId?: ConversationId,
    ): void;
    /**
     * Why work Pi would start in a conversation with nobody asking (a subagent's report, say) may not start now: the
     * spend limit its session or whoever pays there reached. Undefined when it may.
     */
    heldBack(conversationId: ConversationId): string | undefined;
    /** Call `listener` whenever the owner changes a spend limit; returns how to stop. */
    onLimitsChanged(listener: () => void): () => void;
    /** The PARA wiki (`para.ts`): pi-para's, opened on the para module's first load. */
    readonly para: Para;
    /** The owner's secrets (`secrets.ts`): what Pi may use where, and values for commands, never for the model. */
    readonly secrets: Secrets;
    /** A role's policy from the server edition's gateway (`policy.ts`, PP-22): everything allowed without one. */
    readonly policy: PolicyStore;
    /** The app's machines and SSH keys, as the Machines sheet changes them: for Pi's `machine_add` (PP-139). */
    readonly machineStore: Machines;
    readonly sshKeys: SshKeys;
    /** The tools pi-phone installs on machines (`machine-tools.ts`): `machine_add` installs those its card kept ticked. */
    readonly machineTools: MachineTools;
    /** Pi controls phones (`phone-control.ts`, PP-141): control sessions, the Never list, the phone's service. */
    readonly phone: PhoneControl;
    /** Pi controls computers (`computer-control.ts`, PP-178): sessions on machines through ocu, the Never list, the panel. */
    readonly computer: ComputerControl;
    /** The session a conversation belongs to: itself, or a subagent's session. */
    rootOf(conversationId: number): number;
    /** Image generation (`image-gen.ts`, PP-275): its providers and models, as Settings › Images has them. */
    readonly images: ImageGen;
    /** Web search's provider and keys (`web/access.ts`), as Settings › Web access has them. */
    readonly web: WebSearch;
    /**
     * The team server's gateway (PP-40): its internal address, and this pi-phone's token there, for the services
     * pi-phones share (the team's boards). Undefined on the phone and a single-owner server.
     */
    readonly teamServer: { url: string; token: string } | undefined;
    /** The team machines this person may use, asked of the team server again (PP-82): after Pi changed them. */
    syncTeamMachines(): Promise<void>;
    /** Where commands run for a session in `cwd`, its output not redacted: for `secret_save` to read a value. */
    envOf(cwd: string): ExecutionEnv;
    /** Capture of idle sessions into the wiki (`para-capture.ts`). */
    readonly wikiCapture: Pick<ParaCapture, "capture" | "status" | "setMinutes">;
    /** Other sessions, as the person a session works for (`session-control.ts`): the sessions tools. */
    readonly sessions: Pick<
        SessionControl,
        | "list"
        | "status"
        | "read"
        | "start"
        | "send"
        | "stop"
        | "wait"
        | "approvals"
        | "deny"
        | "piSessions"
        | "importPiSession"
        | "continueInPi"
        | "bringBack"
        | "update"
        | "groups"
        | "checkRescue"
        | "fork"
        | "newContext"
        | "compact"
    >;
    /** Messages to Pi for later: the schedule tool sets up Pi's own. */
    readonly schedules: Pick<Schedules, "add" | "cancel" | "list" | "task">;
    /** Sessions' goals: the goals extension runs their checks and counts them. */
    readonly goals: Pick<Goals, "get" | "run" | "record" | "mayContinue">;
    /**
     * Text from elsewhere made safe for Pi to read (`fence.ts`): `quoted` gives one line, cut to `max`, without
     * invisible characters or any tag, in quotes it cannot close; `defang` keeps the lines, but no closing tag survives,
     * for text put between tags of your own. Tell Pi in the same place that it is data.
     */
    readonly text: { quoted(text: string, max?: number): string; defang(text: string): string };
    /** The thinking levels, lowest first, as a model and a session name them. */
    readonly thinkingLevels: readonly ModelThinkingLevel[];
}

/**
 * Who may use a module's web part: the owner alone (the default), anyone who can steer, or anyone who can view. People
 * invited to one session never may: a web part belongs to the whole app.
 */
export type WebAccess = "owner" | "steer" | "view";

export type WebMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** A request to a module's route, as its handler gets it. */
export interface WebRequest {
    readonly method: WebMethod;
    /** The path's `:name` parts, by name. */
    readonly params: Readonly<Record<string, string>>;
    readonly query: URLSearchParams;
    /** The JSON object the browser sent; empty for GET and DELETE. */
    readonly body: Readonly<Record<string, unknown>>;
    /** Who asked. */
    readonly user: { readonly id: string; readonly name: string; readonly role: Role };
    /** Aborted when the browser stops waiting for the answer. */
    readonly signal: AbortSignal;
}

/**
 * What a route answers: a value sent as JSON (undefined sends `{}`). An error made with `web.error` answers with its
 * status and words; any other throw is a 500, whose words only the owner sees.
 */
export type WebHandler = (request: WebRequest) => unknown;

/**
 * A module's own part of the app, the second argument of its default export: routes under `/api/x/<module>/`, a browser
 * module that adds to the app's screens, events from here to that browser module, and commands for the message box.
 * Routes, the browser module, and commands are registered while the module loads; they go with it when it reloads or
 * is turned off.
 */
export interface ExtensionWeb {
    /** The version of this API (`POCKET_API` in `extension-web.ts`). */
    readonly api: number;
    /** The module's name: its file's, without `.ts`. Its routes are under `/api/x/<module>/`. */
    readonly module: string;
    /** Answer `method` requests to `/api/x/<module>/<path>`. A part of `path` written `:name` matches any one part. */
    route(
        method: WebMethod,
        path: string,
        handle: WebHandler,
        /** `maxBytes`: the largest JSON body it takes, up to 16 MB (1 MB unless said). */
        options?: { access?: WebAccess; maxBytes?: number },
    ): void;
    /**
     * The browser module that adds to the app: a `.js` file beside this module, or a folder with an `index.js` and the
     * files it imports. Browsers of the people `access` lets in load it.
     */
    client(entry: string, options?: { access?: WebAccess }): void;
    /**
     * Send the browser module an event (`pocket.on(event, …)` there): to everyone it loads for, or to one person. Never
     * throws: an event it cannot send (not JSON, too large) goes to the server's log instead.
     */
    send(event: string, data?: unknown, options?: { to?: string }): void;
    /** An error for a route to throw: whoever asked gets `status` (400 to 599) and `message` as they are. */
    error(status: number, message: string): Error;
    /**
     * Run `dispose` when this version of the module goes: replaced by an edit, turned off, or the server stopping. It
     * may return a promise: a stopping server waits for it, up to 3 s.
     */
    onDispose(dispose: () => unknown): void;
    /**
     * A command people run from the message box as `/name`, while the module loads. It goes with this version of the
     * module, as routes do. `scope: "conversation"` is for whoever may drive the session; `"global"` is the owner's.
     */
    command(name: string, command: ExtensionCommand): void;
}

/** The shape of every module in `src/server/extensions/`: a default export building one or more extensions. */
export type ExtensionModule = {
    /** Builds the module's extensions; a module that only adds to the app returns nothing. It may be async. */
    default: (
        host: PocketHost,
        web: ExtensionWeb,
    ) => Extension | readonly Extension[] | void | Promise<Extension | readonly Extension[] | void>;
    /** The version of the extension API the module needs, when it says: a newer one than the app's is not loaded. */
    pocketApi?: unknown;
};
