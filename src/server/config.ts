import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The repository root: `web/`, `src/`, and `node_modules/` live here. */
export const APP_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** Where Pi Pocket keeps its database, users, uploads, and logs. */
export function dataDir(): string {
    return process.env.PI_POCKET_DIR ?? join(homedir(), ".pi-pocket");
}

/** owner: everything. guest: steers Pi (which can run commands here). viewer: reads, chats, and reacts, never steers. */
export type Role = "owner" | "guest" | "viewer";

export interface User {
    id: string;
    name: string;
    role: Role;
    /** sha256 of the user's login token; the token itself is only kept for the owner. */
    tokenHash: string;
    createdAt: number;
    lastSeen?: number;
    /** Conversation ids of the only sessions this person may open; absent means every session. */
    sessions?: string[];
    /**
     * The Cloudflare quick tunnel host (`abc-def.trycloudflare.com`) this person's device signed in through. Its sign-in
     * cookie works only there, and each tunnel gets a new address, so they are removed once that tunnel is gone.
     */
    tunnel?: string;
    /** The most Pi may spend for this person, in dollars; never for the owner. */
    budget?: number;
}

/** An invite not yet used, kept by its code's sha256 (the code itself is only shown to whoever made it). */
export interface StoredInvite {
    codeHash: string;
    role: Role;
    /** The one session it is for; absent means every session. Never set for an owner invite. */
    session?: string;
    expiresAt: number;
    /** Who made it: it works only while they may still invite. */
    createdBy: string;
}

/**
 * One signed-in device (a browser, the phone's app): its own token, kept by its sha256, which the device's cookie holds.
 * A person's own token is never handed to a device; signing a device out ends only it (owner's decisions of 2026-10-19,
 * wiki: pi-phone-sign-in-management).
 */
export interface StoredDevice {
    id: string;
    userId: string;
    tokenHash: string;
    /** "Chrome on Windows", "pi-phone app": from the browser that signed in. */
    name: string;
    createdAt: number;
    lastSeen?: number;
    /** The address it was last seen from. */
    address?: string;
    /** The phone's own app (its WebView): signs in again by itself, and stays one device. */
    app?: true;
}

/** How often a device's last seen time is written to the file; it is kept to the second in memory. */
const DEVICE_SEEN_SAVE_MS = 60_000;

/** The theme (a theme folder's id, or "pocket") and the colors ("desktop", a palette's id, or a folder's) a browser
 * starts with until its person chooses. */
export interface ThemeDefault {
    look: string;
    colors: string;
}
export interface ModelChoice {
    provider: string;
    modelId: string;
    thinkingLevel?: string;
}

interface PocketConfig {
    version: 1;
    /** Printed in the login URL at every start. Keep this file private. */
    ownerToken: string;
    users: User[];
    /** Invites not yet used: kept here so one that lasts a day or a week outlives a restart. */
    invites?: StoredInvite[];
    /** Signed-in devices, each with its own token (`StoredDevice`). */
    devices?: StoredDevice[];
    /** The owner's recovery code (break glass), by its sha256: it signs a browser in as the owner once. */
    recovery?: { codeHash: string; createdAt: number };
    lastModel?: ModelChoice;
    /** The model and thinking level new sessions start with, as the owner chose; absent: the last one picked. */
    defaultModel?: ModelChoice;
    /** The theme and colors of browsers that have not chosen their own (`theme.js`), as the owner chose; absent: Pocket. */
    themeDefault?: ThemeDefault;
    /** Extension modules (file names in `src/server/extensions/`) the owner turned off. */
    disabledExtensions?: string[];
    /** Extension modules the owner turned on. Matters for modules that are off by default, like Lancet Guard. */
    enabledExtensions?: string[];
    /** "others": a guest cannot allow a risky call that their own message led to. Absent: anyone who can steer may. */
    approvals?: ApprovalRule;
    /** The tokens of context above which PiP compacts itself once idle; 0: only as sessions do. Absent: the default. */
    pipCompactAt?: number;
    /**
     * The models (`provider/modelId`) Pi may start subagents on besides their session's own, as the owner allowed them.
     * Absent or empty: none, and subagents always run on their session's model.
     */
    subagentModels?: string[];
    /**
     * How many messages and new sessions one session may send other sessions in an hour (`session-control.ts`); null:
     * no limit. Absent: `DEFAULT_SEND_LIMIT`. A session's own (`SessionMeta.sendLimit`) comes first.
     */
    sessionSendLimit?: number | null;
    /** Minutes a session is idle before what it learned goes to the wiki (`para-capture.ts`); null: never by itself. */
    wikiCaptureMinutes?: number | null;
    /**
     * Web access (`web/access.ts`): the search provider `web_search` uses, by its id, and the addresses set for
     * self-hosted ones. Absent provider: web search is off until the owner picks one.
     */
    web?: { provider?: string; endpoints?: Record<string, string> };
    /**
     * The run model `browser_run` decides each step with (`browser/run.ts`): "session" (each session's own model) or a
     * Jev model's OpenRouter id ("typesafe/jev-1.13"). Absent: "session"; Jev runs only once the owner picks it.
     */
    browserRunModel?: string;
    /** Also listen on the phone's Tailscale address, for people on the owner's tailnet (`tailnet.ts`). Absent: off. */
    tailscale?: boolean;
}

export const DEFAULT_SEND_LIMIT = 30;
export const DEFAULT_CAPTURE_MINUTES = 20;

/** Who may allow a risky tool call: anyone who can steer, or (for guests) only someone other than who asked. */
export type ApprovalRule = "anyone" | "others";

function newToken(): string {
    return randomBytes(24).toString("base64url");
}

function hashToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
}

function sameHash(a: string, b: string): boolean {
    const left = Buffer.from(a, "hex");
    const right = Buffer.from(b, "hex");

    return left.length === right.length && timingSafeEqual(left, right);
}

/** The most invites one person keeps live at once. */
export const MAX_INVITES = 50;

/** `config.json` in the data directory, written atomically with mode 0600. */
export class ConfigStore {
    readonly file: string;
    #config: PocketConfig;

    /**
     * `ownerToken`: the owner token to have, given from outside (the server edition's gateway makes each person's, PP-21):
     * a new data folder starts with it, and one with another token takes it, as a rotation would.
     */
    constructor(directory: string, { ownerToken: given }: { ownerToken?: string } = {}) {
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        this.file = join(directory, "config.json");

        if (given !== undefined && !/^[A-Za-z0-9_-]{24,128}$/.test(given)) {
            throw new Error("A given owner token is 24 to 128 letters, digits, - or _.");
        }

        if (existsSync(this.file)) {
            this.#config = JSON.parse(readFileSync(this.file, "utf8")) as PocketConfig;

            if (given !== undefined && given !== this.#config.ownerToken) {
                this.#config.ownerToken = given;
                const owner = this.#config.users.find((user) => user.role === "owner");

                if (owner !== undefined) {
                    owner.tokenHash = hashToken(given);
                }

                this.save();
            }
        } else {
            const ownerToken = given ?? newToken();

            this.#config = {
                version: 1,
                ownerToken,
                users: [
                    {
                        id: randomUUID(),
                        name: "Owner",
                        role: "owner",
                        tokenHash: hashToken(ownerToken),
                        createdAt: Date.now(),
                    },
                ],
            };
            this.save();
        }
    }

    get ownerToken(): string {
        return this.#config.ownerToken;
    }

    get users(): readonly User[] {
        return this.#config.users;
    }

    get lastModel(): ModelChoice | undefined {
        return this.#config.lastModel;
    }

    set lastModel(choice: ModelChoice | undefined) {
        this.#config.lastModel = choice;
        this.save();
    }

    get themeDefault(): ThemeDefault | undefined {
        return this.#config.themeDefault;
    }

    set themeDefault(choice: ThemeDefault | undefined) {
        if (choice === undefined) {
            delete this.#config.themeDefault;
        } else {
            this.#config.themeDefault = choice;
        }

        this.save();
    }

    get defaultModel(): ModelChoice | undefined {
        return this.#config.defaultModel;
    }

    set defaultModel(choice: ModelChoice | undefined) {
        if (choice === undefined) {
            delete this.#config.defaultModel;
        } else {
            this.#config.defaultModel = choice;
        }

        this.save();
    }

    /** The owner's choice of when PiP compacts itself (`pip-compact.ts`); undefined: its default. */
    get pipCompactAt(): number | undefined {
        return this.#config.pipCompactAt;
    }

    set pipCompactAt(tokens: number | undefined) {
        if (tokens === undefined) {
            delete this.#config.pipCompactAt;
        } else {
            this.#config.pipCompactAt = tokens;
        }

        this.save();
    }

    /** The models Pi may start subagents on besides their session's own (`provider/modelId`); empty: none. */
    get subagentModels(): readonly string[] {
        const models = this.#config.subagentModels;

        // Read from a file people may have edited: only strings count.
        return Array.isArray(models) ? models.filter((each) => typeof each === "string") : [];
    }

    set subagentModels(models: readonly string[]) {
        if (models.length === 0) {
            delete this.#config.subagentModels;
        } else {
            this.#config.subagentModels = [...models];
        }

        this.save();
    }

    get tailscale(): boolean {
        return this.#config.tailscale === true;
    }

    set tailscale(on: boolean) {
        if (on) {
            this.#config.tailscale = true;
        } else {
            delete this.#config.tailscale;
        }

        this.save();
    }

    get wikiCaptureMinutes(): number | null {
        const minutes = this.#config.wikiCaptureMinutes;

        return minutes === null ? null : typeof minutes === "number" && minutes > 0 ? minutes : DEFAULT_CAPTURE_MINUTES;
    }

    set wikiCaptureMinutes(minutes: number | null) {
        if (minutes === DEFAULT_CAPTURE_MINUTES) {
            delete this.#config.wikiCaptureMinutes;
        } else {
            this.#config.wikiCaptureMinutes = minutes;
        }

        this.save();
    }

    get sessionSendLimit(): number | null {
        const limit = this.#config.sessionSendLimit;

        return limit === null ? null : typeof limit === "number" && Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_SEND_LIMIT;
    }

    set sessionSendLimit(limit: number | null) {
        if (limit === DEFAULT_SEND_LIMIT) {
            delete this.#config.sessionSendLimit;
        } else {
            this.#config.sessionSendLimit = limit;
        }

        this.save();
    }

    /** Web search's provider and self-hosted addresses, as the owner set them in Settings › Web access. */
    get web(): { provider: string | undefined; endpoints: Record<string, string> } {
        return { provider: this.#config.web?.provider, endpoints: { ...(this.#config.web?.endpoints ?? {}) } };
    }

    set web(web: { provider: string | undefined; endpoints: Record<string, string> }) {
        this.#config.web = {
            ...(web.provider === undefined ? {} : { provider: web.provider }),
            ...(Object.keys(web.endpoints).length === 0 ? {} : { endpoints: web.endpoints }),
        };
        this.save();
    }

    /** The owner's run model for `browser_run` (Settings › Browser): "session", or a Jev model's OpenRouter id. */
    get browserRunModel(): string {
        return this.#config.browserRunModel ?? "session";
    }

    set browserRunModel(model: string) {
        if (model === "session") {
            delete this.#config.browserRunModel;
        } else {
            this.#config.browserRunModel = model;
        }

        this.save();
    }

    get approvalRule(): ApprovalRule {
        return this.#config.approvals ?? "anyone";
    }

    set approvalRule(rule: ApprovalRule) {
        if (rule === "anyone") {
            delete this.#config.approvals;
        } else {
            this.#config.approvals = rule;
        }

        this.save();
    }

    get disabledExtensions(): readonly string[] {
        return this.#config.disabledExtensions ?? [];
    }

    get enabledExtensions(): readonly string[] {
        return this.#config.enabledExtensions ?? [];
    }

    /** Whether the owner turned a module on or off; undefined when they never chose, so its default applies. */
    extensionChoice(file: string): boolean | undefined {
        if (this.#config.disabledExtensions?.includes(file)) {
            return false;
        }

        if (this.#config.enabledExtensions?.includes(file)) {
            return true;
        }

        return undefined;
    }

    setExtensionEnabled(file: string, enabled: boolean): void {
        const disabled = new Set(this.#config.disabledExtensions ?? []);
        const turnedOn = new Set(this.#config.enabledExtensions ?? []);

        if (enabled) {
            disabled.delete(file);
            turnedOn.add(file);
        } else {
            disabled.add(file);
            turnedOn.delete(file);
        }

        if (disabled.size === 0) {
            delete this.#config.disabledExtensions;
        } else {
            this.#config.disabledExtensions = [...disabled].sort();
        }

        if (turnedOn.size === 0) {
            delete this.#config.enabledExtensions;
        } else {
            this.#config.enabledExtensions = [...turnedOn].sort();
        }

        this.save();
    }

    userByToken(token: string): User | undefined {
        const hash = hashToken(token);

        return this.#config.users.find((user) => sameHash(user.tokenHash, hash));
    }

    userById(id: string): User | undefined {
        return this.#config.users.find((user) => user.id === id);
    }

    addUser(name: string, role: Role, sessions?: string[]): { user: User; token: string } {
        const token = newToken();
        const user: User = {
            id: randomUUID(),
            name,
            role,
            tokenHash: hashToken(token),
            createdAt: Date.now(),
            ...(sessions === undefined ? {} : { sessions: [...sessions] }),
        };

        this.#config.users.push(user);
        this.save();

        return { user, token };
    }

    updateUser(
        id: string,
        patch: Partial<Pick<User, "name" | "lastSeen" | "role" | "sessions" | "tunnel" | "budget">>,
    ): void {
        const user = this.userById(id);

        if (user === undefined) {
            return;
        }

        // The owner stays the owner, and nobody else becomes one.
        if (patch.role !== undefined && (user.role === "owner" || patch.role === "owner")) {
            delete patch.role;
        }

        if ("sessions" in patch && user.role === "owner") {
            delete patch.sessions;
        }

        if ("budget" in patch && user.role === "owner") {
            delete patch.budget;
        }

        Object.assign(user, patch);

        if (user.sessions === undefined) {
            delete user.sessions;
        }

        if (user.budget === undefined) {
            delete user.budget;
        }

        this.save();
    }

    /** Remove someone (never the owner), the invites they made, which could no longer be used, and their devices. */
    removeUser(id: string): void {
        this.#config.users = this.#config.users.filter(
            (user) => user.id !== id || user.role === "owner",
        );

        if (!this.#config.users.some((user) => user.id === id)) {
            this.#config.invites = this.#config.invites?.filter(
                (invite) => invite.createdBy !== id,
            );
            this.#config.devices = this.#config.devices?.filter((device) => device.userId !== id);
        }

        this.save();
    }

    /**
     * A new signed-in device of `userId`, and its token (for its cookie only). The phone's app is one device: a new
     * sign-in of it replaces the one before.
     */
    addDevice(userId: string, name: string, address: string | undefined, app = false): { device: StoredDevice; token: string } {
        const token = newToken();
        const now = Date.now();
        const device: StoredDevice = {
            id: randomUUID(),
            userId,
            tokenHash: hashToken(token),
            name,
            createdAt: now,
            lastSeen: now,
            ...(address === undefined || address === "" ? {} : { address }),
            ...(app ? { app: true as const } : {}),
        };
        const kept = (this.#config.devices ?? []).filter((each) => !(app && each.app === true && each.userId === userId));

        this.#config.devices = [...kept, device];
        this.save();

        return { device, token };
    }

    deviceByToken(token: string): StoredDevice | undefined {
        const hash = hashToken(token);

        return this.#config.devices?.find((device) => sameHash(device.tokenHash, hash));
    }

    deviceById(id: string): StoredDevice | undefined {
        return this.#config.devices?.find((device) => device.id === id);
    }

    /** Every device, or one person's. */
    devices(userId?: string): readonly StoredDevice[] {
        return (this.#config.devices ?? []).filter((device) => userId === undefined || device.userId === userId);
    }

    /** Sign devices out: those `which` picks. Answers how many went. */
    removeDevices(which: (device: StoredDevice) => boolean): number {
        const before = this.#config.devices?.length ?? 0;

        this.#config.devices = (this.#config.devices ?? []).filter((device) => !which(device));

        if (this.#config.devices.length !== before) {
            this.save();
        }

        return before - this.#config.devices.length;
    }

    #deviceSeenSaved = 0;

    /** A device was here: when, and from where. Written to the file at most once a minute (and with any other change). */
    touchDevice(device: StoredDevice, address: string | undefined): void {
        const now = Date.now();
        const moved = address !== undefined && address !== "" && address !== device.address;

        device.lastSeen = now;

        if (moved) {
            device.address = address;
        }

        if (moved || now - this.#deviceSeenSaved > DEVICE_SEEN_SAVE_MS) {
            this.#deviceSeenSaved = now;
            this.save();
        }
    }

    /**
     * A new recovery code for the owner (break glass): shown once, kept only by its sha256, and the one before it ends.
     * Six groups of four letters and digits that cannot be mistaken for one another, about 120 bits.
     */
    newRecoveryCode(): { code: string; createdAt: number } {
        const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
        const bytes = randomBytes(24);
        const letters = [...bytes].map((byte) => alphabet[byte % alphabet.length]).join("");
        const code = letters.match(/.{4}/g)!.join("-");
        const createdAt = Date.now();

        this.#config.recovery = { codeHash: hashToken(code), createdAt };
        this.save();

        return { code, createdAt };
    }

    /** When the owner's recovery code was made; undefined when there is none. */
    get recoveryMadeAt(): number | undefined {
        return this.#config.recovery?.createdAt;
    }

    /** Spend the recovery code: true once for the right one (spaces, dashes, and letter case aside), then never again. */
    useRecoveryCode(code: string): boolean {
        const kept = this.#config.recovery;
        const typed = code.toLowerCase().replace(/[^a-z0-9]/g, "").match(/.{1,4}/g)?.join("-") ?? "";

        if (kept === undefined || !sameHash(kept.codeHash, hashToken(typed))) {
            return false;
        }

        delete this.#config.recovery;
        this.save();

        return true;
    }

    /** A new token for someone who is not the owner: an old-style sign-in that holds their token stops working. */
    rotateUserToken(id: string): void {
        const user = this.userById(id);

        if (user === undefined || user.role === "owner") {
            return;
        }

        user.tokenHash = hashToken(newToken());
        this.save();
    }

    /** Keep a new invite. A person keeps at most `MAX_INVITES` live: beyond that, their oldest ends. */
    addInvite(code: string, invite: Omit<StoredInvite, "codeHash">): void {
        this.#pruneInvites();
        const theirs = (this.#config.invites ?? []).filter(
            (each) => each.createdBy === invite.createdBy,
        );
        const ending = new Set(theirs.slice(0, Math.max(0, theirs.length - MAX_INVITES + 1)));

        this.#config.invites = [
            ...(this.#config.invites ?? []).filter((each) => !ending.has(each)),
            { codeHash: hashToken(code), ...invite },
        ];
        this.save();
    }

    /** A live invite by its code, or undefined when there is none or it expired. */
    invite(code: string): StoredInvite | undefined {
        this.#pruneInvites();
        const hash = hashToken(code);

        return this.#config.invites?.find((invite) => sameHash(invite.codeHash, hash));
    }

    /** Remove an invite, and say whether it was there (and live). */
    removeInvite(code: string): boolean {
        const found = this.invite(code);

        if (found === undefined) {
            return false;
        }

        this.#config.invites = this.#config.invites?.filter((invite) => invite !== found);
        this.save();

        return true;
    }

    #pruneInvites(): void {
        const now = Date.now();
        const live = (this.#config.invites ?? []).filter((invite) => invite.expiresAt >= now);

        if (live.length !== (this.#config.invites ?? []).length) {
            this.#config.invites = live;
            this.save();
        }
    }

    /**
     * Replace the owner token, signing out every device that used the old one. Owner invites not yet used go too: one
     * spent later would hand out the new token.
     */
    rotateOwnerToken(): string {
        const token = newToken();

        this.#config.ownerToken = token;
        const owner = this.#config.users.find((user) => user.role === "owner");

        if (owner !== undefined) {
            owner.tokenHash = hashToken(token);
        }

        if (this.#config.invites !== undefined) {
            this.#config.invites = this.#config.invites.filter((invite) => invite.role !== "owner");
        }

        this.save();

        return token;
    }

    save(): void {
        mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
        const temp = `${this.file}.${process.pid}.tmp`;

        writeFileSync(temp, `${JSON.stringify(this.#config, null, "\t")}\n`, { mode: 0o600 });
        renameSync(temp, this.file);
        chmodSync(this.file, 0o600);
    }
}
