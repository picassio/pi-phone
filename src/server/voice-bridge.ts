/**
 * The voice bridge (PP-187): the server's side of a call once it is set up (`voice.ts`). The page holds the media; the
 * server holds the conversation's control with the owner's sign-in:
 *
 * - `key` and `server` calls: the server joins the call by OpenAI's id over its own WebSocket (the sideband,
 *   `wss://…/v1/realtime?call_id=rtc_…`), sets the call's instructions with the session's context and its tools, and
 *   hears what happens in it.
 * - `codex` calls (`gpt-live-*`, ChatGPT's private endpoint): no sideband; the page passes the call's data channel
 *   events here and the server's back (`fromPage`, `toPage`), in Codex's own delegation protocol.
 *
 * In "Pi works" the live model hands work to the session's Pi with `ask_pi` (a message marked voice, steering Pi when it
 * is busy) and stops it with `stop_pi`; Pi's words come back to be spoken: its text as it comes (the first two
 * sentences, then by paragraph) or only its answer, and a short cue on what it runs at most every `cueSeconds`. In "Pi
 * thinks" what is said goes to Pi as it is, and Pi's words are read out: by the live model, or by the device's own
 * voice (`reader`, the page reads them: `say`). In "Chat only" Pi does not run. What was said
 * goes to the transcript (`said`, `voice-turns.ts`).
 */
import { WebSocket } from "ws";
import type { ClientBlock, ClientEntry } from "./projection.ts";
import { callSession, type CallPlan, type VoiceCall, type VoiceMode, type VoiceService, type VoiceSettings } from "./voice.ts";

/** One thing said in a call: by the owner, or by the live model. */
export type VoiceTurn = { speaker: "you" | "voice"; text: string };

/** What the bridge needs of the app; tests stand in their own. */
export interface BridgeHost {
    readonly service: VoiceService;
    settings(): VoiceSettings;
    /** The call's plan as it starts: its mode, instructions with the session's context, its tools. */
    plan(session: number): Promise<CallPlan>;
    /** Follow a session's entries and whether Pi works there; returns how to stop. */
    watch(session: number, listener: (entries: readonly ClientEntry[], busy: boolean) => void): Promise<() => void>;
    /** A spoken request to the session's Pi, as the owner's message marked voice. */
    submit(call: VoiceCall, text: string): Promise<void>;
    /** Stop the session's run. */
    stop(call: VoiceCall): Promise<void>;
    /** What was said: to the transcript, marked voice. `delegated`: the owner's words went to Pi as a message. */
    said(call: VoiceCall, turns: readonly VoiceTurn[], delegated: boolean): Promise<void>;
    /** Codex calls: events for the page to put on the call's data channel. */
    toPage(call: VoiceCall, events: readonly Record<string, unknown>[]): void;
    /** "Pi thinks" with the device's voice: words for the page to read out. */
    say(call: VoiceCall, text: string): void;
    log(line: string): void;
    now(): number;
}

/** The live model's tools in "Pi works". */
export const VOICE_TOOLS: readonly Record<string, unknown>[] = [
    {
        type: "function",
        name: "ask_pi",
        description:
            "Hand work to Pi, the coding agent of this session: any action, any fact about the owner's projects, files or systems, any check, or real reasoning. Give the owner's request complete, in their words. Pi answers in its own time; its words reach you as \"Pi says:\" messages.",
        parameters: { type: "object", properties: { request: { type: "string", description: "The owner's request, complete." } }, required: ["request"] },
    },
    {
        type: "function",
        name: "stop_pi",
        description: "Stop what Pi is doing now, when the owner says so.",
        parameters: { type: "object", properties: {} },
    },
];

/** Speakable text: no code, no Markdown marks. */
export function speakable(text: string): string {
    return text
        .replace(/```[\s\S]*?```/g, " (code) ")
        .replace(/`([^`\n]+)`/g, "$1")
        .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
        .replace(/(\*\*|__|\*|_|~~)(\S[^*_~]*?\S|\S)\1/g, "$2")
        .replace(/\|/g, " ")
        .replace(/[ \t]+/g, " ")
        .trim();
}

/**
 * Pi's text in the pieces it is spoken in: the first two sentences on their own (so the voice starts soon), then a
 * paragraph at a time.
 */
export function speechChunks(text: string): string[] {
    const paragraphs = text
        .split(/\n\s*\n/)
        .map((each) => speakable(each).replace(/\s*\n\s*/g, " "))
        .filter((each) => each !== "");

    if (paragraphs.length === 0) {
        return [];
    }

    const sentences = paragraphs[0]!.match(/[^.!?。！？]+[.!?。！？]+["')\]]*\s*|[^.!?。！？]+$/g) ?? [paragraphs[0]!];

    if (sentences.length <= 2) {
        return paragraphs;
    }

    return [sentences.slice(0, 2).join("").trim(), sentences.slice(2).join("").trim(), ...paragraphs.slice(1)];
}

/** What a tool call is doing, in a few words: its name and the first text argument. */
function toolCue(block: Extract<ClientBlock, { type: "toolCall" }>): string {
    const first = Object.values(block.args ?? {}).find((value): value is string => typeof value === "string" && value.trim() !== "");

    return `${block.name}${first === undefined ? "" : ` ${first.replace(/\s+/g, " ").slice(0, 80)}`}`;
}

const textOf = (entry: Extract<ClientEntry, { kind: "assistant" }>) =>
    entry.blocks
        .filter((block): block is Extract<ClientBlock, { type: "text" }> => block.type === "text")
        .map((block) => block.text)
        .join("\n\n")
        .trim();

/** How long a closed sideband may wait for OpenAI to answer its close before it is ended (ws alone waits 30 s). */
export const CLOSE_GRACE_MS = 1500;

/** A call's link to OpenAI: the sideband WebSocket, or the page's data channel (Codex). */
interface Link {
    send(event: Record<string, unknown>): void;
    close(): void;
}

/** One call joined: what it hears, what it says, and what waits to be spoken. */
class CallBridge {
    readonly call: VoiceCall;
    readonly #host: BridgeHost;
    readonly #codex: boolean;
    #link: Link | undefined;
    #unwatch: (() => void) | undefined;
    #closed = false;
    /** Pi's entries seen already (the history as the call began is not spoken). */
    readonly #seen = new Set<number>();
    #seeded = false;
    #busy = false;
    /** Pi's last text of the run, for "only the answer". */
    #answer = "";
    /** What waits to be spoken, one response at a time. */
    readonly #queue: { text: string; cue: boolean }[] = [];
    #responding = false;
    #spokeAt = 0;
    /** The owner's words since the last response that ended, and the voice's in this response. */
    #heard: string[] = [];
    #voice: string[] = [];
    #delegated = false;
    /** The response running is one the bridge asked for, to speak for Pi. */
    #ours = false;
    /** A tool's ack was asked for and has not started yet. */
    #ack = false;
    /** What waits for the running response to end: a tool's answer. */
    readonly #afterResponse: (() => void)[] = [];
    /** Codex: the delegation Pi works on, whose context Pi's words go to. */
    #delegation: string | undefined;

    constructor(host: BridgeHost, call: VoiceCall) {
        this.#host = host;
        this.call = call;
        this.#codex = call.path === "codex";
    }

    get mode(): VoiceMode {
        return this.call.mode;
    }

    async start(): Promise<void> {
        this.#unwatch = await this.#host.watch(this.call.session, (entries, busy) => this.#pi(entries, busy));

        if (this.#closed) {
            this.#unwatch();

            return;
        }

        if (this.#codex) {
            this.#link = { send: (event) => this.#host.toPage(this.call, [event]), close: () => {} };

            return;
        }

        const auth = await this.#host.service.auth();
        const plan = await this.#host.plan(this.call.session);
        const settings = this.#host.settings();
        const { model: _model, ...session } = callSession({ ...settings, model: this.call.model }, plan);

        if (this.#closed) {
            // Ended (the app closing) while it joined: no connection to leave open.
            return;
        }

        const socket = new WebSocket(`${this.#host.service.endpoints.socket}/realtime?call_id=${encodeURIComponent(this.call.rtc ?? "")}`, {
            headers: this.#host.service.headers(auth),
        });

        this.#link = {
            send: (event) => {
                if (socket.readyState === WebSocket.OPEN) {
                    socket.send(JSON.stringify(event));
                }
            },
            close: () => {
                if (socket.readyState === WebSocket.CONNECTING) {
                    // Not open yet: nothing to say goodbye on (close() here would only throw on the socket).
                    socket.terminate();

                    return;
                }

                socket.close(1000);

                // OpenAI answers the close at once; one that does not (a dead network) would hold the socket, and a
                // stopping server with it, for ws's 30 s: ended for good after a moment.
                const ending = setTimeout(() => socket.terminate(), CLOSE_GRACE_MS);

                ending.unref();
                socket.once("close", () => clearTimeout(ending));
            },
        };
        socket.on("open", () => this.#link?.send({ type: "session.update", session }));
        socket.on("message", (data) => {
            try {
                this.receive(JSON.parse(String(data)) as Record<string, unknown>);
            } catch (error) {
                this.#host.log(`voice: an event that did not read: ${error instanceof Error ? error.message : String(error)}`);
            }
        });
        socket.on("error", (error) => this.#host.log(`voice: the call's connection failed: ${error.message.split(auth.token).join("[token]")}`));
        socket.on("close", () => {
            if (!this.#closed) {
                // OpenAI ended the call (its time cap, or the page went): its minutes are counted.
                this.#host.service.end(this.call.id);
            }
        });
    }

    /** An event from the call: OpenAI's realtime events on the sideband, or Codex's from the page. */
    receive(event: Record<string, unknown>): void {
        if (this.#closed) {
            return;
        }

        switch (event.type) {
            case "error": {
                const error = event.error as { message?: unknown } | undefined;

                this.#host.log(`voice: ${String(error?.message ?? "an error").slice(0, 300)}`);
                // A response asked for that did not start: nothing waits for it.
                this.#ack = false;
                this.#pump();

                return;
            }

            case "response.created":
                this.#responding = true;
                this.#ack = false;

                return;

            case "conversation.item.input_audio_transcription.completed":
                this.#owner(event.transcript);

                return;

            case "response.output_audio_transcript.done":
            case "response.output_text.done": {
                const text = String(event.transcript ?? event.text ?? "").trim();

                if (text !== "") {
                    this.#voice.push(text);
                    this.#spokeAt = this.#host.now();
                }

                return;
            }

            case "response.function_call_arguments.done":
                void this.#tool(String(event.name ?? ""), String(event.call_id ?? ""), String(event.arguments ?? "{}"));

                return;

            case "response.done":
                this.#responding = false;

                for (const next of this.#afterResponse.splice(0)) {
                    next();
                }

                // What the voice said for Pi (its words, a cue, a reading) is Pi's, in the transcript already.
                if (this.#ours) {
                    this.#voice = [];
                    this.#ours = false;
                }

                void this.#flush();
                this.#pump();

                return;

            // Codex's own protocol (gpt-live), from the page.
            case "delegation.created":
                void this.#codexDelegation(event.item);

                return;

            case "turn.done": {
                const turn = event.turn as { role?: unknown; transcript?: unknown } | undefined;

                if (turn?.role === "user") {
                    this.#owner(turn.transcript);
                } else if (turn?.role === "assistant" && typeof turn.transcript === "string" && turn.transcript.trim() !== "") {
                    this.#voice.push(turn.transcript.trim());
                    void this.#flush();
                }

                return;
            }

            default:
                return;
        }
    }

    /** The owner said something: noted; in "Pi thinks" it goes to Pi as it is. */
    #owner(transcript: unknown): void {
        const text = typeof transcript === "string" ? transcript.trim() : "";

        if (text === "") {
            return;
        }

        if (this.mode === "think") {
            void this.#host.submit(this.call, text).catch((error: unknown) => this.#speakError(error));

            return;
        }

        this.#heard.push(text);
    }

    /** What was said in the response that ended goes to the transcript: the owner's words only when they did not go to Pi. */
    async #flush(): Promise<void> {
        const turns: VoiceTurn[] = [
            ...(this.#delegated ? [] : this.#heard.map((text) => ({ speaker: "you" as const, text }))),
            ...this.#voice.map((text) => ({ speaker: "voice" as const, text })),
        ];
        const delegated = this.#delegated;

        this.#heard = [];
        this.#voice = [];
        this.#delegated = false;

        if (turns.length > 0) {
            await this.#host.said(this.call, turns, delegated).catch((error: unknown) => this.#host.log(`voice: not in the transcript: ${error instanceof Error ? error.message : String(error)}`));
        }
    }

    async #tool(name: string, callId: string, args: string): Promise<void> {
        let output: string;

        try {
            if (name === "ask_pi" && this.mode === "work") {
                const request = (JSON.parse(args) as { request?: unknown }).request;

                if (typeof request !== "string" || request.trim() === "") {
                    throw new Error("Say the request.");
                }

                const working = this.#busy;

                this.#delegated = true;
                await this.#host.submit(this.call, request.trim());
                output = working ? "Pi got it while it works; it will take it into account." : "Pi is on it.";
            } else if (name === "stop_pi" && this.mode === "work") {
                await this.#host.stop(this.call);
                output = "Pi stopped.";
            } else {
                output = `There is no tool ${name} in this call.`;
            }
        } catch (error) {
            output = `It did not reach Pi: ${error instanceof Error ? error.message : String(error)}`;
        }

        // The tool's answer and the ack go once the response that called the tool has ended (one response at a time);
        // Pi's words wait until the ack has run.
        const answer = () => {
            this.#link?.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output } });
            this.#link?.send({ type: "response.create" });
            this.#ack = true;
        };

        if (this.#responding) {
            this.#afterResponse.push(answer);
        } else {
            answer();
        }
    }

    /** Codex: the live model hands the owner's request to Pi. */
    async #codexDelegation(item: unknown): Promise<void> {
        const record = item as { type?: unknown; id?: unknown; content?: unknown } | undefined;

        if (record?.type !== "delegation" || typeof record.id !== "string" || !Array.isArray(record.content)) {
            return;
        }

        const request = (record.content as { type?: unknown; text?: unknown }[])
            .filter((part) => part.type === "input_text" && typeof part.text === "string")
            .map((part) => String(part.text))
            .join("")
            .trim();

        if (request === "") {
            return;
        }

        this.#delegation = record.id;
        this.#delegated = true;
        await this.#host.submit(this.call, request).catch((error: unknown) => this.#speakError(error));
    }

    #speakError(error: unknown): void {
        this.#say(`It did not reach Pi: ${error instanceof Error ? error.message : String(error)}`, false);
    }

    /** Pi's session changed: new words of Pi's are spoken, a tool started is a cue; its answer when the run ends. */
    #pi(entries: readonly ClientEntry[], busy: boolean): void {
        if (!this.#seeded) {
            for (const entry of entries) {
                this.#seen.add(entry.id);
            }

            this.#seeded = true;
            this.#busy = busy;

            return;
        }

        if (this.mode === "chat") {
            return;
        }

        const settings = this.#host.settings();

        for (const entry of entries) {
            if (this.#seen.has(entry.id)) {
                continue;
            }

            this.#seen.add(entry.id);

            if (entry.kind !== "assistant") {
                continue;
            }

            const text = textOf(entry);
            const calls = entry.blocks.filter((block): block is Extract<ClientBlock, { type: "toolCall" }> => block.type === "toolCall");

            if (text !== "") {
                this.#answer = text;

                if (settings.progress === "text" || this.mode === "think") {
                    for (const chunk of speechChunks(text)) {
                        this.#say(chunk, false);
                    }
                }
            } else if (calls.length > 0 && settings.cueSeconds > 0 && this.mode === "work") {
                const since = this.#host.now() - this.#spokeAt;

                if (since >= settings.cueSeconds * 1000 && this.#queue.length === 0) {
                    this.#say(toolCue(calls[0]!), true);
                }
            }
        }

        // The run ended: with "only the answer", Pi's last words now.
        if (this.#busy && !busy && settings.progress === "answer" && this.mode === "work" && this.#answer !== "") {
            for (const chunk of speechChunks(this.#answer)) {
                this.#say(chunk, false);
            }
        }

        if (busy && !this.#busy) {
            this.#answer = "";
        }

        this.#busy = busy;
    }

    /** Queue something for the voice: Pi's words, or a cue on what Pi runs. */
    #say(text: string, cue: boolean): void {
        this.#queue.push({ text, cue });
        this.#spokeAt = this.#host.now();
        this.#pump();
    }

    /** Speak what waits, one response at a time (a response asked for while one runs is refused). */
    #pump(): void {
        const link = this.#link;

        if (link === undefined || this.#closed) {
            return;
        }

        if (this.#codex) {
            // Codex speaks what is appended to the delegation's context (or the session's) by itself.
            for (const next of this.#queue.splice(0)) {
                const content = [{ type: "input_text", text: next.cue ? `Pi is working: ${next.text}` : next.text }];

                link.send(
                    this.#delegation === undefined
                        ? { type: "session.context.append", channel: "speakable", content }
                        : { type: "delegation.context.append", delegation_item_id: this.#delegation, channel: "speakable", content },
                );
            }

            return;
        }

        // "Pi thinks" with the device's own voice as the reader (PP-193): the page reads Pi's words out itself.
        if (this.mode === "think" && this.#host.settings().reader === "device") {
            for (const next of this.#queue.splice(0)) {
                this.#host.say(this.call, next.text);
            }

            return;
        }

        if (this.#responding || this.#ack) {
            return;
        }

        const next = this.#queue.shift();

        if (next === undefined) {
            return;
        }

        const think = this.mode === "think";
        const text = think ? `Read aloud: ${next.text}` : next.cue ? `Pi is working: ${next.text}` : `Pi says: ${next.text}`;

        this.#responding = true;
        this.#ours = true;
        link.send({ type: "conversation.item.create", item: { type: "message", role: "system", content: [{ type: "input_text", text }] } });
        link.send({
            type: "response.create",
            ...(think
                ? { response: { instructions: "Read the last message out exactly as written, after \"Read aloud:\", in its language. Add nothing." } }
                : next.cue
                  ? { response: { instructions: "In one short sentence, tell the owner what Pi is doing now." } }
                  : {}),
        });
    }

    /** The session's voice mode changed during the call: the call's instructions, tools and turn-taking follow. */
    async changeMode(mode: VoiceMode): Promise<void> {
        if (this.call.mode === mode || this.#closed) {
            return;
        }

        await this.#flush();
        this.call.mode = mode;

        if (this.#codex) {
            return;
        }

        const plan = await this.#host.plan(this.call.session);
        const { model: _model, ...session } = callSession({ ...this.#host.settings(), model: this.call.model }, plan);

        this.#link?.send({ type: "session.update", session: { ...session, tools: plan.tools } });
    }

    /** End the bridge: the connection, the watch; what was said and not yet kept goes to the transcript. */
    async close(): Promise<void> {
        if (this.#closed) {
            return;
        }

        this.#closed = true;
        this.#unwatch?.();
        this.#link?.close();
        await this.#flush();
    }
}

export class VoiceBridge {
    readonly #host: BridgeHost;
    readonly #calls = new Map<string, CallBridge>();

    constructor(host: BridgeHost) {
        this.#host = host;
    }

    /** A call went through: join it. */
    async join(call: VoiceCall): Promise<void> {
        if (this.#calls.has(call.id)) {
            return;
        }

        const bridge = new CallBridge(this.#host, call);

        this.#calls.set(call.id, bridge);

        try {
            await bridge.start();
        } catch (error) {
            this.#host.log(`voice: could not join the call: ${error instanceof Error ? error.message : String(error)}`);
            this.#calls.delete(call.id);
            this.#host.service.end(call.id);
        }
    }

    /** A session's voice mode changed: its call, if one goes on, follows. */
    async modeChanged(session: number, mode: VoiceMode): Promise<void> {
        for (const bridge of this.#calls.values()) {
            if (bridge.call.session === session) {
                await bridge.changeMode(mode);
            }
        }
    }

    /** A Codex call's data channel events, from the page. */
    fromPage(call: VoiceCall, events: unknown): void {
        const bridge = this.#calls.get(call.id);

        if (bridge === undefined || !Array.isArray(events)) {
            return;
        }

        for (const event of events.slice(0, 50)) {
            if (typeof event === "object" && event !== null) {
                bridge.receive(event as Record<string, unknown>);
            }
        }
    }

    /** The call ended. */
    async leave(id: string): Promise<void> {
        const bridge = this.#calls.get(id);

        this.#calls.delete(id);
        await bridge?.close();
    }

    /**
     * End every call's bridge (the app closing): each connection closed, at most CLOSE_GRACE_MS each, and what was said
     * written to the transcript, before the storage closes.
     */
    async closeAll(): Promise<void> {
        const bridges = [...this.#calls.values()];

        this.#calls.clear();
        await Promise.all(bridges.map((bridge) => bridge.close().catch((error: unknown) => this.#host.log(`voice: a call did not close: ${error instanceof Error ? error.message : String(error)}`))));
    }

    /** For tests: whether a call is joined. */
    has(id: string): boolean {
        return this.#calls.has(id);
    }
}
