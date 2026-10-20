/**
 * The gateway's own data (PP-21), beside better-auth's tables in the same SQLite file: the setup token (the owner's way
 * in before any account, and the break-glass after), invites (a link that makes one account, with a role), and each
 * person's pi-phone: its key (the name of their container, network, and volume) and the owner token the gateway made for
 * it, which only the gateway uses.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type Role = "owner" | "member";
export const ROLES: readonly Role[] = ["owner", "member"];

export type Invite = { code: string; role: Role; createdBy: string; createdAt: number; expiresAt: number; usedBy: string | null; usedAt: number | null };
export type PersonBox = { userId: string; key: string; token: string; createdAt: number };

/** How long an invite lasts, in minutes: the choices. */
export const INVITE_MINUTES = [60, 24 * 60, 7 * 24 * 60] as const;

const token = (bytes = 24) => randomBytes(bytes).toString("base64url");

export class GatewayStore {
    readonly #db: DatabaseSync;
    readonly #now: () => number;

    constructor(db: DatabaseSync, now: () => number = Date.now) {
        this.#db = db;
        this.#now = now;
        db.exec(`
            CREATE TABLE IF NOT EXISTS pp_setting (name TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS pp_invite (
                code TEXT PRIMARY KEY, role TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL, used_by TEXT, used_at INTEGER
            );
            CREATE TABLE IF NOT EXISTS pp_person (
                user_id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, token TEXT NOT NULL, created_at INTEGER NOT NULL
            );
        `);
    }

    #setting(name: string): string | undefined {
        const row = this.#db.prepare("SELECT value FROM pp_setting WHERE name = ?").get(name) as { value: string } | undefined;

        return row?.value;
    }

    #set(name: string, value: string): void {
        this.#db.prepare("INSERT INTO pp_setting (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value").run(name, value);
    }

    /** better-auth's secret, made once and kept: sessions and its encrypted fields depend on it. */
    authSecret(): string {
        const kept = this.#setting("auth_secret");

        if (kept !== undefined) {
            return kept;
        }

        const made = token(32);

        this.#set("auth_secret", made);

        return made;
    }

    /** The setup token: made once; shown in the gateway's log for the owner. */
    setupToken(): string {
        const kept = this.#setting("setup_token");

        if (kept !== undefined) {
            return kept;
        }

        const made = token(24);

        this.#set("setup_token", made);

        return made;
    }

    setupTokenIs(given: string): boolean {
        const left = createHash("sha256").update(given).digest();
        const right = createHash("sha256").update(this.setupToken()).digest();

        return timingSafeEqual(left, right);
    }

    createInvite(role: Role, createdBy: string, minutes: number): Invite {
        if (!ROLES.includes(role)) {
            throw new Error(`An invite's role is one of ${ROLES.join(", ")}.`);
        }

        if (!(INVITE_MINUTES as readonly number[]).includes(minutes)) {
            throw new Error(`An invite lasts ${INVITE_MINUTES.join(", ")} minutes.`);
        }

        const invite: Invite = { code: token(18), role, createdBy, createdAt: this.#now(), expiresAt: this.#now() + minutes * 60_000, usedBy: null, usedAt: null };

        this.#db
            .prepare("INSERT INTO pp_invite (code, role, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
            .run(invite.code, invite.role, invite.createdBy, invite.createdAt, invite.expiresAt);

        return invite;
    }

    #invite(row: Record<string, unknown> | undefined): Invite | undefined {
        return row === undefined
            ? undefined
            : {
                  code: String(row.code),
                  role: row.role as Role,
                  createdBy: String(row.created_by),
                  createdAt: Number(row.created_at),
                  expiresAt: Number(row.expires_at),
                  usedBy: row.used_by === null ? null : String(row.used_by),
                  usedAt: row.used_at === null ? null : Number(row.used_at),
              };
    }

    /** An invite that can still be used: not expired, not used. */
    liveInvite(code: string): Invite | undefined {
        const invite = this.#invite(this.#db.prepare("SELECT * FROM pp_invite WHERE code = ?").get(code) as Record<string, unknown> | undefined);

        return invite !== undefined && invite.usedBy === null && invite.expiresAt > this.#now() ? invite : undefined;
    }

    /** Spend an invite for a new account; false when someone else spent it first. */
    useInvite(code: string, userId: string): boolean {
        const changed = this.#db.prepare("UPDATE pp_invite SET used_by = ?, used_at = ? WHERE code = ? AND used_by IS NULL AND expires_at > ?").run(userId, this.#now(), code, this.#now());

        return changed.changes === 1;
    }

    invites(): Invite[] {
        return (this.#db.prepare("SELECT * FROM pp_invite ORDER BY created_at DESC LIMIT 50").all() as Record<string, unknown>[]).map((row) => this.#invite(row)!);
    }

    cancelInvite(code: string): void {
        this.#db.prepare("DELETE FROM pp_invite WHERE code = ? AND used_by IS NULL").run(code);
    }

    /**
     * A person's pi-phone: made on first use. Its key is lowercase hex from their id (Docker names take it as it is), and
     * its owner token is the gateway's alone.
     */
    box(userId: string): PersonBox {
        const row = this.#db.prepare("SELECT * FROM pp_person WHERE user_id = ?").get(userId) as Record<string, unknown> | undefined;

        if (row !== undefined) {
            return { userId, key: String(row.key), token: String(row.token), createdAt: Number(row.created_at) };
        }

        const box: PersonBox = { userId, key: createHash("sha256").update(`pi-phone person ${userId}`).digest("hex").slice(0, 24), token: token(24), createdAt: this.#now() };

        this.#db.prepare("INSERT INTO pp_person (user_id, key, token, created_at) VALUES (?, ?, ?, ?)").run(box.userId, box.key, box.token, box.createdAt);

        return box;
    }

    boxOf(userId: string): PersonBox | undefined {
        const row = this.#db.prepare("SELECT * FROM pp_person WHERE user_id = ?").get(userId) as Record<string, unknown> | undefined;

        return row === undefined ? undefined : { userId, key: String(row.key), token: String(row.token), createdAt: Number(row.created_at) };
    }

    /** How many accounts better-auth has (its `user` table), 0 before its tables exist. */
    userCount(): number {
        const table = this.#db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user'").get();

        return table === undefined ? 0 : Number((this.#db.prepare('SELECT COUNT(*) AS n FROM "user"').get() as { n: number }).n);
    }

    /** A person's TOTP removed (better-auth's `twoFactor` table and flag): they sign in with their password and set it up again. */
    resetTwoFactor(userId: string): void {
        this.#db.prepare('DELETE FROM "twoFactor" WHERE "userId" = ?').run(userId);
        this.#db.prepare('UPDATE "user" SET "twoFactorEnabled" = 0 WHERE "id" = ?').run(userId);
    }

    forgetBox(userId: string): void {
        this.#db.prepare("DELETE FROM pp_person WHERE user_id = ?").run(userId);
    }
}
