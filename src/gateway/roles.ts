/**
 * Custom roles (PP-22): the permission catalogue, and the roles the gateway starts with. A role is a set of permissions
 * from the catalogue, the memory and CPU its people's pi-phones get, the models they may use (none listed: any), and a
 * monthly spend limit (null: none). The owner's role is built in, has everything, and is nobody's to change. The others
 * are the owner's (or a `roles.manage` person's) to edit, add, and delete.
 */

/** Every permission, grouped as the Roles page shows them, with what each lets someone do. */
export const CATALOGUE = [
    {
        group: "People",
        enforced: "gateway",
        permissions: {
            "people.invite": "Make invite links (for any role but the owner's)",
            "people.manage": "Change people's roles, reset passwords and two-factor, disable and remove people",
            "roles.manage": "Add, edit and delete roles",
            "audit.view": "See the audit log",
        },
    },
    {
        group: "Server",
        enforced: "gateway",
        permissions: {
            "server.manage": "Server settings, and downloading people's data and backups (which hold everyone's sign-ins and secrets)",
        },
    },
    {
        group: "Team accounts",
        enforced: "gateway",
        permissions: {
            "providers.manage": "Add, sign in and remove the team's provider accounts (a provider's sign-in or key for the whole team)",
        },
    },
    {
        group: "Documents",
        enforced: "gateway",
        permissions: {
            "docs.team": "Edit team documents (everyone with a pi-phone reads them)",
        },
    },
    {
        group: "Their own pi-phone",
        enforced: "container",
        permissions: {
            "pi.use": "Have a pi-phone of their own (without it: only what others share with them)",
            "browser.use": "Pi's browser",
            "web.search": "Web search and reading pages",
            "machines.use": "Machines (SSH) and their tools",
            "secrets.use": "Secrets",
            "terminal.use": "The terminal",
            "providers.signin": "Sign in to model providers of their own",
            "settings.change": "Change their pi-phone's settings",
            "extensions.manage": "Turn extensions on and off",
        },
    },
    {
        group: "Sharing",
        enforced: "gateway",
        permissions: {
            "sessions.share": "Share a chat session with other people",
            "projects.create": "Make project boards",
            "projects.share": "Share project boards",
            "projects.delete": "Delete project boards",
            "projects.view_all": "See every board, private ones too (each look is logged)",
            "projects.team": "Make and manage team boards (they belong to the team, not a person)",
            "tasks.run": "Let Pi run a board's tasks",
            "tasks.merge": "Merge a task's branch",
        },
    },
] as const;

export type Permission = { [G in (typeof CATALOGUE)[number] as string]: keyof G["permissions"] }[string];

export const PERMISSIONS: readonly Permission[] = CATALOGUE.flatMap((group) => Object.keys(group.permissions) as Permission[]);

export type Role = {
    id: string;
    name: string;
    permissions: Permission[];
    memoryMb: number;
    cpus: number;
    /** Model ids (`provider/model`) its people may use; empty: any. */
    models: string[];
    /** Dollars a month its people's Pi may spend; null: no limit. */
    spendLimit: number | null;
    /** The team accounts (`<provider>~team-<slug>`) its people may use (PP-69); the owner's role: every one. */
    teamAccounts?: string[];
    /** The owner's role: everything, not editable. */
    builtin: boolean;
};

export const OWNER_ROLE: Role = { id: "owner", name: "Owner", permissions: [...PERMISSIONS], memoryMb: 4096, cpus: 2, models: [], spendLimit: null, builtin: true };

const member: Permission[] = ["pi.use", "browser.use", "web.search", "machines.use", "secrets.use", "terminal.use", "providers.signin", "settings.change", "extensions.manage", "sessions.share", "projects.create", "projects.share", "tasks.run", "tasks.merge"];

/** The roles a new gateway starts with (the owner's decision, 2026-10-20): editable and deletable. */
export const SEEDED: readonly Role[] = [
    // Not server.manage: its downloads hold everyone's sign-ins and secrets (the owner's to give).
    { id: "admin", name: "Admin", permissions: PERMISSIONS.filter((each) => each !== "roles.manage" && each !== "projects.view_all" && each !== "server.manage"), memoryMb: 4096, cpus: 2, models: [], spendLimit: null, builtin: false },
    { id: "member", name: "Member", permissions: member, memoryMb: 2048, cpus: 1, models: [], spendLimit: null, builtin: false },
    { id: "viewer", name: "Viewer", permissions: [], memoryMb: 512, cpus: 0.5, models: [], spendLimit: null, builtin: false },
];

/** A role as given (a form, an API call), checked: the shape and limits of a role, or why not. */
export function checkRole(given: Record<string, unknown>, id: string): Role {
    const name = String(given.name ?? "").trim();
    const permissions = Array.isArray(given.permissions) ? given.permissions.map(String) : [];
    const memoryMb = Number(given.memoryMb);
    const cpus = Number(given.cpus);
    const models = Array.isArray(given.models) ? given.models.map((each) => String(each).trim()).filter((each) => each !== "") : [];
    const spendLimit = given.spendLimit === null || given.spendLimit === undefined || given.spendLimit === "" ? null : Number(given.spendLimit);
    const teamAccounts = Array.isArray(given.teamAccounts) ? [...new Set(given.teamAccounts.map((each) => String(each).trim()).filter((each) => each !== ""))] : [];

    if (name === "" || name.length > 40) {
        throw new Error("A role's name is 1 to 40 characters.");
    }

    const unknown = permissions.filter((each) => !(PERMISSIONS as readonly string[]).includes(each));

    if (unknown.length > 0) {
        throw new Error(`No such permission: ${unknown.join(", ")}.`);
    }

    if (!Number.isInteger(memoryMb) || memoryMb < 256 || memoryMb > 16_384) {
        throw new Error("Memory is 256 to 16384 MB.");
    }

    if (!Number.isFinite(cpus) || cpus < 0.25 || cpus > 8) {
        throw new Error("CPUs are 0.25 to 8.");
    }

    if (models.some((each) => !/^[\w.-]+\/[\w./:-]+$/.test(each)) || models.length > 100) {
        throw new Error("Models are provider/model ids, one per line (100 at most).");
    }

    if (spendLimit !== null && (!Number.isFinite(spendLimit) || spendLimit < 0 || spendLimit > 100_000)) {
        throw new Error("A spend limit is 0 to 100000 dollars a month, or none.");
    }

    if (teamAccounts.some((each) => !/^[\w.-]+~team-[a-z0-9-]+$/.test(each)) || teamAccounts.length > 100) {
        throw new Error("Team accounts are given by their ids (provider~team-name).");
    }

    return { id, name, permissions: permissions as Permission[], memoryMb, cpus, models, spendLimit, teamAccounts, builtin: false };
}
