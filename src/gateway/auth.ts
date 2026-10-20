/**
 * The gateway's sign-in (PP-21): better-auth on the gateway's SQLite file. Email and password (no sign-up: accounts come
 * from invites and the owner's setup), TOTP as a second step, passkeys for the host name people open, and the admin
 * plugin for the owner's resets. Its routes are under `/auth/api/`; pi-phone's own `/api/` goes to each person's
 * container.
 */
import { passkey } from "@better-auth/passkey";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { admin, twoFactor } from "better-auth/plugins";
import { adminAc, defaultStatements, userAc } from "better-auth/plugins/admin/access";
import { createAccessControl } from "better-auth/plugins/access";
import type { DatabaseSync } from "node:sqlite";

export type GatewayAuthOptions = {
    db: DatabaseSync;
    secret: string;
    /** The address people open: `https://tuanlh-devbox-01.tailf11d61.ts.net`. Passkeys are tied to its host name. */
    origin: string;
};

/** The roles in phase 1: the owner (better-auth's admin rights) and members. Phase 2 makes them the owner's to define. */
const ac = createAccessControl(defaultStatements);
const roles = { owner: ac.newRole(adminAc.statements), member: ac.newRole(userAc.statements) };

/** better-auth's options for the gateway: its tables follow from them (`migrate`), then `makeAuth` uses them. */
function authOptions({ db, secret, origin }: GatewayAuthOptions) {
    const url = new URL(origin);

    return {
        appName: "pi-phone",
        baseURL: origin,
        basePath: "/auth/api",
        secret,
        database: db,
        trustedOrigins: [origin],
        emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 10, maxPasswordLength: 256, autoSignIn: true },
        session: { expiresIn: 30 * 24 * 3600, updateAge: 24 * 3600 },
        rateLimit: { enabled: true, window: 60, max: 100, customRules: { "/sign-in/email": { window: 60, max: 10 }, "/two-factor/verify-totp": { window: 60, max: 10 } } },
        advanced: { cookiePrefix: "pp", useSecureCookies: url.protocol === "https:" },
        plugins: [
            twoFactor({ issuer: "pi-phone" }),
            passkey({ rpID: url.hostname, rpName: "pi-phone", origin }),
            admin({ ac, roles, defaultRole: "member", adminRoles: ["owner"] }),
        ],
    } satisfies BetterAuthOptions;
}

/**
 * better-auth for the gateway, its tables made or brought up to date first: it checks the schema as it starts, and a
 * check before the tables existed logged a false "schema mismatch".
 */
export async function makeAuth(options: GatewayAuthOptions) {
    const settings = authOptions(options);
    const { runMigrations } = await getMigrations(settings);

    await runMigrations();

    return betterAuth(settings);
}

export type GatewayAuth = Awaited<ReturnType<typeof makeAuth>>;
