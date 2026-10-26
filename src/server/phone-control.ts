/**
 * Pi controls phones (PP-141, part A: this phone). The app's accessibility service (`PiAccessibility.java`) reads the
 * screen and acts; `PhoneControl.java` long-polls this module's channel (`GET /api/phone/control`, answers
 * `POST /api/phone/control/<id>`), as Pi's browser's service does (`phone-requests.ts`).
 *
 * A control session is the owner's yes on one card (`extensions/phone.ts`): the apps it names (and the home screen, to
 * open them), for 5 to 60 minutes. It is kept in the data folder, so a restart keeps it, and it ends at its time, on Stop
 * (the phone's banner and notification, the app's live line) or when Pi stops it. Never: pi-phone itself, the built-in
 * lists of banking and payment apps and password managers, and the apps the owner adds in the app (Menu › Phone
 * control); only the owner changes that list, there. Every scoped request carries the session's apps, the Never list
 * and its end, and the service checks the app in front again before it acts.
 *
 * Devices: `phone` (this phone) now; other phones with pi-phone (B) and devices behind a machine (C) come as more
 * `PhoneDevice` kinds, each with its own sessions.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clockText } from "./phone-events.ts";
import { type Outline, type PhoneScreen, renderOutline } from "./phone-outline.ts";
import { PhoneRequests } from "./phone-requests.ts";

/** How long a session waits after Pi's run ended for the next one before it ends (`PhoneControl.runEnded`). */
export const IDLE_END_MS = 20_000;

/** pi-phone's own package: never read or controlled (Pi must never tap its own approval cards). */
export const PI_PHONE_PACKAGE = "io.piphone";

/** Minutes a session may last: the card's default, and its range. */
export const MINUTES = { default: 15, min: 5, max: 60 } as const;

/**
 * Apps Pi never reads or controls, by package (`name*`: every package starting so). Curated: common global ones, and
 * Vietnamese banks and wallets; the owner adds any others in the app.
 */
export const NEVER_GROUPS = [
    {
        id: "banking",
        label: "Banking and payment apps",
        patterns: [
            // Vietnam
            "com.vietcombank*", "com.VCB*", "com.mbmobile*", "vn.com.techcombank*", "com.vnpay*", "com.mservice.momo*", "vn.zalopay*", "vn.com.vng.zalopay*",
            "com.bidv*", "com.vietinbank*", "com.tpb*", "vn.tpb*", "com.agribank*", "mobile.acb.com.vn*", "com.acb*", "com.vpbank*", "vn.com.vpbank*",
            "com.sacombank*", "vn.com.msb*", "com.hdbank*", "com.vib*", "com.ocb*", "vn.shb*", "com.shb*", "com.seabank*", "vn.com.seabank*",
            "com.lpbank*", "com.bplus.vtpay*", "com.viettel.viettelpay*", "vn.vnpt.vnptpay*", "xyz.be.cake*", "io.lifestyle.plus*", "com.namabank*",
            "com.eximbank*", "com.scb*", "vn.com.bacabank*", "com.pvcombank*", "com.abbank*", "com.kienlongbank*", "com.ncb*", "com.vietbank*",
            "com.shinhan*", "com.wooribank*", "com.hsbc*", "com.sc.*", "com.citi*", "com.uob*",
            // Payments and wallets
            "com.paypal*", "com.venmo*", "com.squareup.cash*", "com.google.android.apps.walletnfcrel*", "com.google.android.apps.nbu.paisa*",
            "com.samsung.android.spay*", "com.samsung.android.samsungpay*", "com.revolut*", "com.transferwise*", "com.wise*", "com.klarna*",
            "com.eg.android.AlipayGphone*", "hk.alipay*", "com.alipay*", "net.one97.paytm*", "com.phonepe*", "com.payoneer*", "com.skrill*", "com.stripe*",
            // Banks elsewhere
            "com.chase*", "com.infonow.bofa*", "com.bankofamerica*", "com.wf.wellsfargomobile*", "com.usaa*", "com.konylabs.capitalone*", "com.capitalone*",
            "com.americanexpress*", "com.discoverfinancial*", "com.barclays*", "uk.co.hsbc*", "com.lloydsbank*", "com.monzo*", "com.starlingbank*",
            "de.number26*", "com.ing*", "com.bbva*", "com.dbs*", "com.ocbc*", "com.maybank*", "com.kasikorn*", "com.scb.phone*", "com.krungthai*",
            "jp.co.rakuten_bank*", "jp.co.smbc*", "jp.co.mufg*", "jp.mizuhobank*",
            // Crypto
            "com.coinbase*", "com.binance*", "piuk.blockchain*", "io.metamask*", "com.wallet.crypto.trustapp*", "com.kraken*", "co.okex*", "com.okinc*",
            "com.bybit*", "com.exodus*", "com.ledger*",
        ],
    },
    {
        id: "passwords",
        label: "Password managers and authenticators",
        patterns: [
            "com.x8bit.bitwarden*", "com.bitwarden*", "com.agilebits.onepassword*", "com.onepassword*", "com.lastpass.lpandroid*", "com.dashlane*",
            "keepass2android*", "com.kunzisoft.keepass*", "com.android.keepass*", "org.keepassdroid*", "com.callpod.android_apps.keeper*", "io.enpass*",
            "com.nordpass*", "proton.android.pass*", "com.roboform*", "com.zoho.vault*", "com.mseven.barolo*",
            "com.google.android.apps.authenticator2*", "com.azure.authenticator*", "com.authy*", "com.duosecurity*", "org.fedorahosted.freeotp*",
            "com.beemdevelopment.aegis*", "com.yubico*", "com.okta*",
        ],
    },
] as const;

export type PhoneApp = { label: string; package: string };

export type PhoneDevice = { id: string; name: string; kind: "this-phone" };

export type ControlSession = {
    device: string;
    /** The conversation whose Pi it is for, and its session (the root, for a subagent's). */
    conversationId: number;
    session: number;
    /** Who said yes (the owner's id). */
    approvedBy: string;
    apps: PhoneApp[];
    /**
     * Follow along (the owner's choice on the card): an app one of `apps` opens while Pi acts in it (Settings' Battery,
     * which on a Samsung is Device care) joins the session, in `followed`. Only from the named apps, one step: not an app
     * a followed one opens, nor one reached by back, home or recents, nor one opened from the home screen. The Never list
     * and pi-phone itself stay out. Off: only `apps` and the home screen.
     */
    follow?: boolean;
    followed?: PhoneApp[];
    /** The home screen's package, allowed with the apps to open them. */
    launcher: string | undefined;
    reason: string;
    startedAt: number;
    until: number;
};

/** How the last session on a device ended. */
type Ended = { at: number; why: string };

type Kept = { sessions: ControlSession[]; never: PhoneApp[]; ended: Record<string, Ended> };

/** What the service says of the phone (`status`). */
export type PhoneStatus = {
    enabled: boolean;
    android: number;
    screenshot: boolean;
    foreground: string | null;
    launcher: string | null;
    unrestricted: boolean;
};

const matches = (pattern: string, name: string) => (pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern);

/** The actions that may open another app, for following along: a tap, a long press, typing (with Enter). */
const OPENING = new Set(["tap", "press", "type"]);

export class PhoneControl {
    /** The channel the app's service polls (`PhoneControl.java`). */
    readonly requests = new PhoneRequests("phone control");
    readonly #file: string;
    readonly #kept: Kept;
    readonly #gateway: boolean;
    readonly #now: () => number;
    readonly #log: (line: string) => void;
    readonly #timers = new Map<string, NodeJS.Timeout>();
    /** How long after Pi's run ends its session goes on, waiting for the next run (`runEnded`). */
    readonly #idleEndMs: number;
    /** The sessions whose run ended, by conversation: their end, unless a run starts again first. */
    readonly #idle = new Map<number, NodeJS.Timeout>();
    readonly #listeners = new Set<() => void>();
    /** The named app Pi last acted in by a tap, a long press or typing, per device: what a followed app came from. */
    readonly #opener = new Map<string, string>();
    /** The newest outline read on each device: `[n]` in an action is from it. */
    readonly #outlines = new Map<string, Outline & { foreground: string }>();

    constructor(options: { dataDir: string; gateway: boolean; now?: () => number; log?: (line: string) => void; idleEndMs?: number }) {
        this.#idleEndMs = options.idleEndMs ?? IDLE_END_MS;
        this.#file = join(options.dataDir, "phone-control.json");
        this.#gateway = options.gateway;
        this.#now = options.now ?? Date.now;
        this.#log = options.log ?? (() => {});
        this.#kept = existsSync(this.#file) ? { sessions: [], never: [], ended: {}, ...(JSON.parse(readFileSync(this.#file, "utf8")) as Partial<Kept>) } : { sessions: [], never: [], ended: {} };

        // A restart keeps sessions: those still running go on, with their end armed again.
        for (const session of [...this.#kept.sessions]) {
            if (session.until <= this.#now()) {
                this.#remove(session.device, session.until, "time ran out");
            } else {
                this.#arm(session);
            }
        }
    }

    #save(): void {
        writeFileSync(this.#file, JSON.stringify(this.#kept), { mode: 0o600 });
    }

    /** Call `listener` when a session starts or ends, or the Never list changes. */
    onChange(listener: () => void): () => void {
        this.#listeners.add(listener);

        return () => this.#listeners.delete(listener);
    }

    #changed(): void {
        for (const listener of this.#listeners) {
            listener();
        }
    }

    /** Why phone control cannot work on this server, or undefined. */
    unavailable(): string | undefined {
        return this.#gateway ? "Phone control is for the pi-phone app on a phone: the team server has no phone." : undefined;
    }

    devices(): PhoneDevice[] {
        return this.#gateway ? [] : [{ id: "phone", name: "This phone", kind: "this-phone" }];
    }

    /** A device by id (default this phone), or why not. */
    device(id = "phone"): PhoneDevice {
        const refused = this.unavailable();

        if (refused !== undefined) {
            throw new Error(refused);
        }

        const found = this.devices().find((each) => each.id === id);

        if (found === undefined) {
            throw new Error(`No device ${id}. Devices: ${this.devices().map((each) => `${each.id} (${each.name.toLowerCase()})`).join(", ")}.`);
        }

        return found;
    }

    /** Whether the app's service polls now. */
    present(device = "phone"): boolean {
        this.device(device);

        return this.requests.present();
    }

    /** A request to the device's service, or why it cannot be asked. */
    async #ask(device: string, payload: Record<string, unknown>, timeoutMs = 30_000): Promise<Record<string, unknown>> {
        if (!this.present(device)) {
            throw new Error("Phone control needs the pi-phone app's service, which polls the server on the phone itself: open pi-phone on the phone.");
        }

        return this.requests.request(payload, timeoutMs);
    }

    async status(device = "phone"): Promise<PhoneStatus> {
        return (await this.#ask(device, { op: "status" }, 10_000)) as unknown as PhoneStatus;
    }

    /** The apps the phone can open (launchable), by name. */
    async apps(device = "phone"): Promise<PhoneApp[]> {
        const { apps } = (await this.#ask(device, { op: "apps" })) as { apps?: PhoneApp[] };

        if (!Array.isArray(apps)) {
            throw new Error("The phone sent no list of apps.");
        }

        return apps;
    }

    // ─── Never ──────────────────────────────────────────────────────────────

    /** Why Pi never touches an app, or undefined when it may (in a session that names it). */
    neverReason(name: string): string | undefined {
        if (name === PI_PHONE_PACKAGE) {
            return "pi-phone itself";
        }

        for (const group of NEVER_GROUPS) {
            if (group.patterns.some((pattern) => matches(pattern, name))) {
                return group.id === "banking" ? "a banking or payment app" : "a password manager or authenticator";
            }
        }

        return this.#kept.never.some((each) => each.package === name) ? "on the owner's Never list" : undefined;
    }

    /** Every package pattern the service refuses, for its own check. */
    #neverPatterns(): string[] {
        return [PI_PHONE_PACKAGE, ...NEVER_GROUPS.flatMap((group) => [...group.patterns]), ...this.#kept.never.map((each) => each.package)];
    }

    neverList(): { groups: { id: string; label: string; patterns: string[] }[]; own: PhoneApp[] } {
        return { groups: NEVER_GROUPS.map((group) => ({ id: group.id, label: group.label, patterns: [...group.patterns] })), own: [...this.#kept.never] };
    }

    /** The owner adds an app to their Never list (the app's sheet only: no tool changes it). It ends a session using it. */
    async addNever(app: PhoneApp): Promise<void> {
        if (!/^[A-Za-z][\w]*(\.[A-Za-z_][\w]*)+$/.test(app.package)) {
            throw new Error(`${app.package} is not an Android package name.`);
        }

        if (!this.#kept.never.some((each) => each.package === app.package)) {
            this.#kept.never.push({ label: String(app.label || app.package).slice(0, 80), package: app.package });
            this.#save();
        }

        for (const session of this.sessions()) {
            if (session.apps.some((each) => each.package === app.package)) {
                await this.end(session.device, `the owner put ${app.label || app.package} on the Never list`);
            }
        }

        this.#changed();
    }

    removeNever(name: string): void {
        this.#kept.never = this.#kept.never.filter((each) => each.package !== name);
        this.#save();
        this.#changed();
    }

    // ─── Sessions ───────────────────────────────────────────────────────────

    /** The sessions running now. */
    sessions(): ControlSession[] {
        const now = this.#now();

        for (const session of this.#kept.sessions.filter((each) => each.until <= now)) {
            void this.end(session.device, "time ran out");
        }

        return this.#kept.sessions.filter((each) => each.until > now);
    }

    /** The session running on a device, if any. */
    active(device = "phone"): ControlSession | undefined {
        return this.sessions().find((each) => each.device === device);
    }

    /** Why there is no session to act in, with what to do. */
    noSession(device = "phone"): string {
        const ended = this.#kept.ended[device];
        const last = ended === undefined ? "" : ` (the last one ended at ${clockText(ended.at)}: ${ended.why})`;

        return `No phone control session is active on ${this.device(device).name.toLowerCase()}${last}. Ask for one with phone_control start, naming the apps: the owner approves it on a card.`;
    }

    /**
     * Start a session the owner approved: kept at once, then the phone shows its banner and notification. When the phone
     * cannot show them, the session ends again and this fails: nobody would see that Pi has the phone.
     */
    async start(given: Omit<ControlSession, "startedAt" | "until" | "launcher"> & { minutes: number }): Promise<ControlSession> {
        const { minutes, ...rest } = given;
        const status = await this.status(given.device);

        if (!status.enabled) {
            throw new Error("pi-phone's accessibility service is off: turn it on in Android's settings (Menu › Phone control › Set up this phone).");
        }

        const startedAt = this.#now();
        const session: ControlSession = { ...rest, launcher: status.launcher ?? undefined, startedAt, until: startedAt + minutes * 60_000 };

        this.#kept.sessions = [...this.#kept.sessions.filter((each) => each.device !== session.device), session];
        this.#save();
        this.#arm(session);
        this.#outlines.delete(session.device);

        try {
            await this.#ask(session.device, { op: "banner", show: true, until: session.until, apps: session.apps.map((each) => each.label).join(", ") });
        } catch (error) {
            this.#remove(session.device, this.#now(), "the phone could not show its banner");
            this.#changed();

            throw new Error(`The phone could not show that Pi is using it, so the session did not start: ${error instanceof Error ? error.message : String(error)}`);
        }

        this.#changed();

        return session;
    }

    #arm(session: ControlSession): void {
        clearTimeout(this.#timers.get(session.device));
        const timer = setTimeout(() => void this.end(session.device, "time ran out"), Math.max(0, session.until - this.#now()) + 50);

        timer.unref();
        this.#timers.set(session.device, timer);
    }

    #remove(device: string, at: number, why: string): ControlSession | undefined {
        const session = this.#kept.sessions.find((each) => each.device === device);

        clearTimeout(this.#timers.get(device));
        this.#timers.delete(device);
        this.#outlines.delete(device);

        if (session === undefined) {
            return undefined;
        }

        this.#kept.sessions = this.#kept.sessions.filter((each) => each !== session);
        this.#kept.ended[device] = { at, why };
        this.#save();

        return session;
    }

    /**
     * Pi's run in `conversationId` ended (the app's busy state): its control session ends a little later unless a run
     * starts again (`runStarted`), as Pi going on after a tool's answer does. So the banner goes when Pi is done, even
     * when Pi did not stop it (the owner, 2026-10-26: "the user does not know whether you are done").
     */
    runEnded(conversationId: number): void {
        if (!this.#kept.sessions.some((each) => each.conversationId === conversationId)) {
            return;
        }

        clearTimeout(this.#idle.get(conversationId));
        const timer = setTimeout(() => {
            this.#idle.delete(conversationId);

            for (const session of this.#kept.sessions.filter((each) => each.conversationId === conversationId)) {
                void this.end(session.device, "Pi's turn ended");
            }
        }, this.#idleEndMs);

        timer.unref();
        this.#idle.set(conversationId, timer);
    }

    /** A run started again in `conversationId`: its session goes on. */
    runStarted(conversationId: number): void {
        clearTimeout(this.#idle.get(conversationId));
        this.#idle.delete(conversationId);
    }

    /** End a device's session (`why`: "time ran out", "Stop on the phone", …), and take the phone's banner down. */
    async end(device: string, why: string): Promise<boolean> {
        const session = this.#remove(device, this.#now(), why);

        if (session === undefined) {
            return false;
        }

        this.#log(`Phone control on ${device} ended: ${why}.`);
        this.#changed();

        // The phone takes its banner down at the session's end by itself too; ended early, it is told.
        if (this.requests.present()) {
            await this.#ask(device, { op: "banner", show: false }, 10_000).catch((error: unknown) =>
                this.#log(`The phone's banner was not taken down: ${error instanceof Error ? error.message : String(error)}`),
            );
        }

        return true;
    }

    // ─── Reading and acting ─────────────────────────────────────────────────

    /** The session of a device, for a conversation: or why not. */
    sessionFor(device: string, conversationId: number): ControlSession {
        const session = this.active(device);

        if (session === undefined) {
            throw new Error(this.noSession(device));
        }

        if (session.conversationId !== conversationId) {
            throw new Error(`Session #${session.session}'s Pi is using ${this.device(device).name.toLowerCase()} until ${clockText(session.until)}: only one session controls it at a time.`);
        }

        return session;
    }

    /**
     * What each scoped request carries: the apps it may touch, the Never list, and its end, which the service checks; and
     * the apps' names, for the banner it shows again when it is not up (pi-phone's process started again in a session).
     */
    #scope(session: ControlSession): { allowed: string[]; never: string[]; until: number; apps: string } {
        const apps = [...session.apps, ...(session.followed ?? [])];

        return {
            allowed: [...apps.map((each) => each.package), ...(session.launcher === undefined ? [] : [session.launcher])],
            never: this.#neverPatterns(),
            until: session.until,
            apps: apps.map((each) => each.label).join(", "),
        };
    }

    /** The app's name in a session's words: its label on the card, "the home screen", or its package. */
    #name(session: ControlSession, name: string): string {
        return name === session.launcher
            ? "the home screen"
            : ([...session.apps, ...(session.followed ?? [])].find((each) => each.package === name)?.label ?? name);
    }

    /**
     * In a session that follows along: when the app in front came up from an action Pi took in one of the named apps (its
     * `#opener`), it joins the session. Answers whether it did.
     */
    async #follow(session: ControlSession, foreground: string | null): Promise<boolean> {
        if (
            session.follow !== true ||
            foreground === null ||
            foreground === "" ||
            foreground === PI_PHONE_PACKAGE ||
            foreground === session.launcher ||
            this.#opener.get(session.device) === undefined ||
            this.neverReason(foreground) !== undefined ||
            [...session.apps, ...(session.followed ?? [])].some((each) => each.package === foreground)
        ) {
            return false;
        }

        // Its name from Android, launchable or not (Device care has no icon of its own).
        const { label } = (await this.#ask(session.device, { op: "label", package: foreground })) as { label: string };

        session.followed = [...(session.followed ?? []), { label, package: foreground }];
        this.#save();
        this.#log(`Phone control on ${session.device} follows into ${foreground}, opened from ${this.#opener.get(session.device)}.`);
        this.#changed();

        return true;
    }

    /** Why Pi may not read or touch the app in front, or undefined when it may. */
    refusal(session: ControlSession, foreground: string | null, hidden?: string): string | undefined {
        // A screen Android keeps from accessibility services (Android 14+: permission and default-app screens, such as
        // Settings › Apps › Choose default apps on a Samsung): its window is there, its content and app are not.
        if ((foreground === null || foreground === "") && hidden !== undefined) {
            return `Android hides the screen in front${hidden === "" ? "" : ` ("${hidden}")`} from accessibility services, as it does permission and default-app screens: Pi cannot read or touch it. Ask the owner to do this step on the phone, or go back with phone_act button.`;
        }

        if (foreground === null || foreground === "") {
            return "Android reports no app in front: wait a moment and read the screen again.";
        }

        if (foreground === PI_PHONE_PACKAGE) {
            return "pi-phone itself is in front: Pi never reads or controls pi-phone. Open an app of this session with phone_act open_app.";
        }

        const never = this.neverReason(foreground);

        if (never !== undefined) {
            return `${foreground} is in front, ${never}: Pi never reads or controls it. Go back or home with phone_act button.`;
        }

        const apps = [...session.apps, ...(session.followed ?? [])];

        if (foreground !== session.launcher && !apps.some((each) => each.package === foreground)) {
            return `${foreground} is in front, and it is not in this session (${apps.map((each) => each.label).join(", ")}, and the home screen${session.follow === true ? "; apps the named ones open join it, but not this one: it was not opened from them" : ""}): Pi does not read or touch it. Go back or home with phone_act button, or ask for it with phone_control start${session.follow === true ? "" : " (follow: true lets apps the named ones open join)"}.`;
        }

        return undefined;
    }

    /** The app in front now, checked against the session: or why Pi may not act there. */
    async front(session: ControlSession): Promise<string> {
        const { foreground, hidden } = (await this.#ask(session.device, { op: "front" })) as { foreground?: string | null; hidden?: string };

        await this.#follow(session, foreground ?? null);
        const refused = this.refusal(session, foreground ?? null, hidden);

        if (refused !== undefined) {
            throw new Error(refused);
        }

        return foreground!;
    }

    /** The screen as an outline: the app in front, when the session may read it. */
    async screen(session: ControlSession): Promise<Outline & { foreground: string }> {
        let screen = (await this.#ask(session.device, { op: "tree", ...this.#scope(session) })) as unknown as PhoneScreen;

        // An app the session follows into: the phone held its nodes back (it was not in the scope sent), so again.
        if (await this.#follow(session, screen.foreground)) {
            screen = (await this.#ask(session.device, { op: "tree", ...this.#scope(session) })) as unknown as PhoneScreen;
        }

        const refused = this.refusal(session, screen.foreground, screen.hidden);

        if (refused !== undefined) {
            this.#outlines.delete(session.device);

            throw new Error(refused);
        }

        const outline = { ...renderOutline(screen, this.#name(session, screen.foreground!)), foreground: screen.foreground! };

        this.#outlines.set(session.device, outline);

        return outline;
    }

    /** The newest outline read in a session, or a fresh read when there is none. */
    async lastOutline(session: ControlSession): Promise<Outline & { foreground: string }> {
        return this.#outlines.get(session.device) ?? this.screen(session);
    }

    /** An element of the newest outline, by its number. */
    entry(session: ControlSession, index: number) {
        const outline = this.#outlines.get(session.device);

        if (outline === undefined) {
            throw new Error("Read the screen first (phone_screen): [n] numbers are from the newest read.");
        }

        const found = outline.entries.find((each) => each.index === index);

        if (found === undefined) {
            throw new Error(`There is no [${index}] on the screen as last read (1 to ${outline.entries.length}): read it again.`);
        }

        return found;
    }

    /** An action in the app in front (checked first), or a scoped one that needs no app in front (`anywhere`). */
    async act(session: ControlSession, payload: Record<string, unknown>, anywhere = false): Promise<Record<string, unknown>> {
        if (!anywhere) {
            const front = await this.front(session);

            // What may open an app the session then follows into: a tap, a long press or typing, in a named app.
            if (OPENING.has(String(payload.op)) && session.apps.some((each) => each.package === front)) {
                this.#opener.set(session.device, front);
            } else {
                this.#opener.delete(session.device);
            }
        } else {
            this.#opener.delete(session.device);
        }

        return this.#ask(session.device, { ...payload, ...this.#scope(session) });
    }

    /**
     * Open one of the session's apps; whether it came to the front within `waitMs`. Android may not let an app start
     * another while it is in the background (the owner's phone, 2026-10-26: Zalo stayed behind), and says nothing.
     */
    async open(session: ControlSession, app: PhoneApp, waitMs = 2500): Promise<boolean> {
        if (!session.apps.some((each) => each.package === app.package) || this.neverReason(app.package) !== undefined) {
            throw new Error(`${app.label} is not in this session: ask for it with phone_control start.`);
        }

        await this.act(session, { op: "open", package: app.package }, true);

        // Real time, not the session clock (`now`): this waits on the phone.
        for (const started = Date.now(); ; ) {
            const { foreground } = (await this.#ask(session.device, { op: "front" })) as { foreground?: string | null };

            if (foreground === app.package) {
                return true;
            }

            if (Date.now() - started >= waitMs) {
                return false;
            }

            await new Promise((resolve) => setTimeout(resolve, 250));
        }
    }

    /** A picture of the screen (JPEG), with the screen's size in pixels. */
    async picture(session: ControlSession): Promise<{ jpeg: string; width: number; height: number }> {
        const answer = (await this.act(session, { op: "shot", quality: 80 })) as { jpeg?: string; width?: number; height?: number };

        if (typeof answer.jpeg !== "string" || answer.jpeg === "") {
            throw new Error("The phone sent no picture.");
        }

        return { jpeg: answer.jpeg, width: Number(answer.width), height: Number(answer.height) };
    }

    /** The sessions as the app's tabs show them (the live line). */
    view(): { device: string; deviceName: string; conversationId: number; session: number; apps: PhoneApp[]; follow: boolean; until: number }[] {
        return this.sessions().map((each) => ({
            device: each.device,
            deviceName: this.devices().find((device) => device.id === each.device)?.name ?? each.device,
            conversationId: each.conversationId,
            session: each.session,
            apps: [...each.apps, ...(each.followed ?? [])],
            follow: each.follow === true,
            until: each.until,
        }));
    }

    close(): void {
        for (const timer of this.#timers.values()) {
            clearTimeout(timer);
        }

        this.#timers.clear();
    }
}
