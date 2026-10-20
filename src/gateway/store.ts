/**
 * The gateway's own data (PP-21), beside better-auth's tables in the same SQLite file: the setup token (the owner's way
 * in before any account, and the break-glass after), invites (a link that makes one account, with a role), and each
 * person's pi-phone: its key (the name of their container, network, and volume) and the owner token the gateway made for
 * it, which only the gateway uses.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { OWNER_ROLE, type Permission, type Role, SEEDED } from "./roles.ts";

export type Invite = { code: string; role: string; createdBy: string; createdAt: number; expiresAt: number; usedBy: string | null; usedAt: number | null };
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
            CREATE TABLE IF NOT EXISTS pp_role (id TEXT PRIMARY KEY, body TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS pp_user_role (user_id TEXT PRIMARY KEY, role_id TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS pp_audit (
                id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL,
                target TEXT, details TEXT
            );
        `);

        // The roles a new gateway starts with, once (PP-22): from then on they are the owner's to change.
        if (this.#setting("roles_seeded") === undefined) {
            for (const role of SEEDED) {
                this.saveRole(role);
            }

            this.#set("roles_seeded", "1");
        }
    }

    // ─── Roles (PP-22) ───

    /** Every role, the owner's first. */
    roles(): Role[] {
        const rows = this.#db.prepare("SELECT body FROM pp_role ORDER BY id").all() as { body: string }[];

        return [OWNER_ROLE, ...rows.map((row) => JSON.parse(row.body) as Role)];
    }

    role(id: string): Role | undefined {
        return this.roles().find((role) => role.id === id);
    }

    saveRole(role: Role): void {
        if (role.id === OWNER_ROLE.id) {
            throw new Error("The owner's role is built in.");
        }

        this.#db.prepare("INSERT INTO pp_role (id, body) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body").run(role.id, JSON.stringify({ ...role, builtin: false }));
    }

    /** Delete a role nobody has; false when someone still does. */
    deleteRole(id: string): boolean {
        if (id === OWNER_ROLE.id) {
            throw new Error("The owner's role is built in.");
        }

        const used = this.#db.prepare("SELECT COUNT(*) AS n FROM pp_user_role WHERE role_id = ?").get(id) as { n: number };

        if (used.n > 0) {
            return false;
        }

        this.#db.prepare("DELETE FROM pp_role WHERE id = ?").run(id);

        return true;
    }

    /** A person's role: the owner's when better-auth has them as owner, else the one given them (Member by default). */
    roleOf(userId: string, authRole: string | null | undefined): Role {
        if (authRole === "owner") {
            return OWNER_ROLE;
        }

        const row = this.#db.prepare("SELECT role_id FROM pp_user_role WHERE user_id = ?").get(userId) as { role_id: string } | undefined;

        return this.role(row?.role_id ?? "member") ?? this.role("member") ?? { ...SEEDED[1]! };
    }

    setRoleOf(userId: string, roleId: string): void {
        if (roleId === OWNER_ROLE.id) {
            this.#db.prepare("DELETE FROM pp_user_role WHERE user_id = ?").run(userId);

            return;
        }

        this.#db.prepare("INSERT INTO pp_user_role (user_id, role_id) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET role_id = excluded.role_id").run(userId, roleId);
    }

    /**
     * better-auth's own role for a person: `owner` or `member` (its admin plugin needs one it knows; all authorization is
     * the gateway's roles). Written here, as the person acting may hold a custom role better-auth knows nothing of.
     */
    setAuthRole(userId: string, role: "owner" | "member"): void {
        this.#db.prepare('UPDATE "user" SET "role" = ? WHERE "id" = ?').run(role, userId);
    }

    /**
     * Every account, as better-auth keeps them (its `user` table): read here, since its admin API wants an admin of its
     * own, and who may see people is the gateway's roles' to say.
     */
    users(): { id: string; name: string; email: string; role: string | null; banned: boolean; twoFactorEnabled: boolean }[] {
        const rows = this.#db.prepare('SELECT "id", "name", "email", "role", "banned", "twoFactorEnabled" FROM "user" ORDER BY "createdAt"').all() as Record<string, unknown>[];

        return rows.map((row) => ({ id: String(row.id), name: String(row.name), email: String(row.email), role: row.role === null ? null : String(row.role), banned: Number(row.banned ?? 0) === 1, twoFactorEnabled: Number(row.twoFactorEnabled ?? 0) === 1 }));
    }

    ownerCount(): number {
        return Number((this.#db.prepare(`SELECT COUNT(*) AS n FROM "user" WHERE "role" = 'owner' AND COALESCE("banned", 0) = 0`).get() as { n: number }).n);
    }

    /** The people given role `roleId` (by id). */
    peopleWithRole(roleId: string): [string][] {
        return (this.#db.prepare("SELECT user_id FROM pp_user_role WHERE role_id = ?").all(roleId) as { user_id: string }[]).map((row) => [row.user_id]);
    }

    /** A removed person's two-factor and passkeys (better-auth's plugins' tables; its own deleteUser leaves them). */
    forgetAuthExtras(userId: string): void {
        this.#db.prepare('DELETE FROM "twoFactor" WHERE "userId" = ?').run(userId);
        this.#db.prepare('DELETE FROM "passkey" WHERE "userId" = ?').run(userId);
    }

    forgetRoleOf(userId: string): void {
        this.#db.prepare("DELETE FROM pp_user_role WHERE user_id = ?").run(userId);
    }

    can(userId: string, authRole: string | null | undefined, permission: Permission): boolean {
        return this.roleOf(userId, authRole).permissions.includes(permission);
    }

    // ─── The audit log (PP-22) ───

    audit(actor: string, action: string, target?: string, details?: Record<string, unknown>): void {
        this.#db.prepare("INSERT INTO pp_audit (at, actor, action, target, details) VALUES (?, ?, ?, ?, ?)").run(this.#now(), actor, action, target ?? null, details === undefined ? null : JSON.stringify(details));
    }

    auditLog(limit = 200): { at: number; actor: string; action: string; target: string | null; details: Record<string, unknown> | null }[] {
        const rows = this.#db.prepare("SELECT at, actor, action, target, details FROM pp_audit ORDER BY id DESC LIMIT ?").all(limit) as { at: number; actor: string; action: string; target: string | null; details: string | null }[];

        return rows.map((row) => ({ ...row, details: row.details === null ? null : (JSON.parse(row.details) as Record<string, unknown>) }));
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

    createInvite(role: string, createdBy: string, minutes: number): Invite {
        if (this.role(role) === undefined) {
            throw new Error(`There is no role ${role}.`);
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
                  role: String(row.role),
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
