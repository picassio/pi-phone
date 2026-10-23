/**
 * The team server's people, roles, invites, audit log, server settings, provider accounts and machines, for Pi (PP-45): what the gateway's pages do,
 * as tools, with the rights of the person this pi-phone is theirs: the gateway checks their role on every call, as on its
 * pages, and its audit log says the change was Pi's. Reads run freely; every change asks that person first, on a card.
 * Never here: passwords, people's data and the server's backups (only people, on the gateway's pages). Only on the team
 * server (`host.teamServer`); and only for this pi-phone's own person, never for a guest Pi works for here.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { PocketHost } from "../host.ts";

const reply = (text: string, isError = false) => ({ output: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) });
const LASTS: Record<string, number> = { "1 hour": 60, "1 day": 24 * 60, "7 days": 7 * 24 * 60 };
const ACTIONS = ["role", "reset-two-factor", "disable", "enable", "remove", "always-on", "not-always-on"] as const;

type Person = { id: string; name: string; email: string; role: string; roleName: string; banned: boolean; twoFactor: boolean; alwaysOn: boolean };
type Role = { id: string; name: string; permissions: string[]; memoryMb: number; cpus: number; models: string[]; spendLimit: number | null; teamAccounts?: string[]; teamSpendLimit?: number | null; teamMachines?: string[]; builtin: boolean };
type TeamAccount = { id: string; provider: string; name: string; providerName: string; configured: boolean; usable: boolean; roles: string[] };
type TeamMachine = {
    id: string;
    name: string;
    host: string;
    user: string;
    port?: number;
    hostKey?: string;
    remote?: { platform: string; arch: string };
    publicKey: string;
    usable: boolean;
    roles: string[];
    folder: string;
};
type Usage = { provider: string; windows?: { label: string; usedPercent: number; resetsAt?: number }[]; plan?: string; error?: string };
/** Providers a team account can be of: those with a key or a subscription sign-in (src/server/accounts.ts). */
const PROVIDER_HINT = "a provider's id, like anthropic, openai, openrouter, openai-codex, github-copilot, google";

export default function createTeam(host: PocketHost) {
    const server = host.teamServer;

    if (server === undefined) {
        return defineExtension({ name: "pocket-team", tools: [] });
    }

    /** One of the gateway's routes, as this pi-phone's person; its refusal, in its words, throws. */
    const call = async (route: string, method: "GET" | "POST", body?: unknown): Promise<unknown> => {
        const response = await fetch(`${server.url}/internal/team`, {
            method: "POST",
            headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
            body: JSON.stringify({ route, method, ...(body === undefined ? {} : { body }) }),
            signal: AbortSignal.timeout(20_000),
        });
        const answer = (await response.json()) as { error?: string };

        if (!response.ok) {
            throw new Error(answer.error ?? `The team server answered ${response.status}.`);
        }

        return answer;
    };
    /** Only this pi-phone's own person: never a guest Pi works for here. */
    const mine = (conversationId: unknown) => {
        const id = host.requesterOf(Number(conversationId) as never);

        if (id === undefined || host.person(id).role !== "owner") {
            throw new Error("The team's people, roles and settings are this pi-phone's person's to change, not a guest's.");
        }
    };
    const ask = async (api: { conversationId: unknown; taskId: unknown; callId?: string }, context: unknown, tool: string, subject: string, reason: string) => {
        const answer = await host.approvals.request(
            {
                id: `${tool}-${String(api.conversationId)}-${String(api.callId)}`,
                conversationId: Number(api.conversationId) as never,
                taskId: api.taskId as never,
                ...(api.callId === undefined ? {} : { callId: api.callId }),
                tool,
                subject,
                reason,
                createdAt: Date.now(),
            },
            context as never,
        );

        if (!answer.allow) {
            throw new Error(`${answer.by} said no: nothing was done.`);
        }
    };
    const people = async () => ((await call("people", "GET")) as { people: Person[] }).people;
    /** Someone by name or email (or id). */
    const find = async (who: string) => {
        const wanted = who.trim().toLowerCase();
        const all = await people();
        const found = all.filter((person) => person.id === who || person.email.toLowerCase() === wanted || person.name.toLowerCase() === wanted);

        if (found.length !== 1) {
            throw new Error(found.length === 0 ? `Nobody on the team is called ${who}: team_people lists them.` : `More than one person is called ${who}: give their email.`);
        }

        return found[0]!;
    };
    /** The team accounts' own route, as this pi-phone's person; Pi's changes are logged as Pi's. */
    const accounts = async (body: Record<string, unknown>): Promise<unknown> => {
        const response = await fetch(`${server.url}/internal/team-accounts`, {
            method: "POST",
            headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
            body: JSON.stringify({ ...body, pi: true }),
            signal: AbortSignal.timeout(20_000),
        });
        const answer = (await response.json()) as { value?: unknown; error?: string };

        if (!response.ok) {
            throw new Error(answer.error ?? `The team server answered ${response.status}.`);
        }

        return answer.value;
    };
    const teamAccounts = async () => (await accounts({ action: "list" })) as { manage: boolean; accounts: TeamAccount[] };
    /** A team account by id, or by its name ("Work") when only one has it. */
    const findAccount = async (which: string) => {
        const all = (await teamAccounts()).accounts;
        const wanted = which.trim().toLowerCase();
        const found = all.filter((account) => account.id === which.trim() || account.name.toLowerCase() === wanted);

        if (found.length !== 1) {
            throw new Error(found.length === 0 ? `No team account is called ${which}: team_providers lists them.` : `More than one team account is called ${which}: give its id.`);
        }

        return found[0]!;
    };
    /** The team machines' own route (PP-82), as this pi-phone's person; Pi's changes are logged as Pi's. */
    const machinesCall = async (body: Record<string, unknown>): Promise<unknown> => {
        const response = await fetch(`${server.url}/internal/team-machines`, {
            method: "POST",
            headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
            body: JSON.stringify({ ...body, pi: true }),
            signal: AbortSignal.timeout(20_000),
        });
        const answer = (await response.json()) as { value?: unknown; error?: string };

        if (!response.ok) {
            throw new Error(answer.error ?? `The team server answered ${response.status}.`);
        }

        return answer.value;
    };
    const teamMachines = async () => (await machinesCall({ action: "list" })) as { manage: boolean; machines: TeamMachine[] };
    /** A team machine by id, or by its name. */
    const findMachine = async (which: string) => {
        const wanted = which.trim().toLowerCase();
        const found = (await teamMachines()).machines.filter((machine) => machine.id === which.trim() || `team-${machine.id}` === which.trim() || machine.name.toLowerCase() === wanted);

        if (found.length !== 1) {
            throw new Error(found.length === 0 ? `No team machine is called ${which}: team_machines lists them.` : `More than one team machine is called ${which}: give its id.`);
        }

        return found[0]!;
    };
    const address = (machine: TeamMachine) => `${machine.user}@${machine.host}${machine.port === undefined ? "" : `:${machine.port}`}`;
    const roles = async () => (await call("roles", "GET")) as { roles: Role[]; counts: Record<string, number>; catalogue: { group: string; permissions: Record<string, string> }[] };
    const tool = <P extends Parameters<typeof defineTool>[0]["parameters"]>(name: string, description: string, parameters: P, run: (args: never, api: { conversationId: unknown; taskId: unknown; callId?: string }, context: unknown) => Promise<string>) =>
        defineTool({
            name,
            description,
            parameters,
            execute: async (args, api, context) => {
                try {
                    mine(api.conversationId);

                    return reply(await run(args as never, api as never, context));
                } catch (error) {
                    return reply(error instanceof Error ? error.message : String(error), true);
                }
            },
        });

    const tools = [
        tool("team_people", "The team server's people: name, email, role, and whether they are disabled, have two-factor, or are always on. Needs people.invite or people.manage.", Type.Object({}), async () =>
            (await people()).map((person) => `- ${person.name} <${person.email}> · ${person.roleName}${person.banned ? " · disabled" : ""}${person.twoFactor ? " · 2FA" : ""}${person.alwaysOn ? " · always on" : ""}`).join("\n"),
        ),
        tool(
            "team_invite",
            "Make an invite link to the team server for a role (asks the person first). Give the link to whoever it is for; it works once. Needs people.invite.",
            Type.Object({ role: Type.String({ description: "The role's id or name" }), lasts: Type.Union(Object.keys(LASTS).map((each) => Type.Literal(each))), reason: Type.String() }),
            async (args: { role: string; lasts: string; reason: string }, api, context) => {
                const all = (await roles()).roles;
                const role = all.find((each) => each.id === args.role || each.name.toLowerCase() === args.role.trim().toLowerCase());

                if (role === undefined) {
                    throw new Error(`There is no role ${args.role}: ${all.map((each) => each.name).join(", ")}.`);
                }

                await ask(api, context, "team_invite", `Invite someone to the team as ${role.name}, the link lasting ${args.lasts}`, args.reason);

                const made = (await call("invites", "POST", { role: role.id, minutes: LASTS[args.lasts] })) as { url: string; expiresAt: number };

                return `Invite link (${role.name}, until ${new Date(made.expiresAt).toISOString().slice(0, 16).replace("T", " ")} UTC): ${made.url}`;
            },
        ),
        tool(
            "team_person",
            "Change someone on the team (asks the person first): give them a role, reset their two-factor, disable or enable them, remove their account (their data is kept), or keep their pi-phone always on. Never passwords: those are reset on the gateway's People page. Needs people.manage (always on: server.manage).",
            Type.Object({
                person: Type.String({ description: "Their name or email" }),
                action: Type.Union(ACTIONS.map((each) => Type.Literal(each))),
                role: Type.Optional(Type.String({ description: "With action role: the role's id or name" })),
                reason: Type.String(),
            }),
            async (args: { person: string; action: (typeof ACTIONS)[number]; role?: string; reason: string }, api, context) => {
                const person = await find(args.person);
                let body: unknown = {};
                let words = "";

                if (args.action === "role") {
                    const all = (await roles()).roles;
                    const role = all.find((each) => each.id === args.role || each.name.toLowerCase() === String(args.role ?? "").trim().toLowerCase());

                    if (role === undefined) {
                        throw new Error(`Name the role to give: ${all.map((each) => each.name).join(", ")}.`);
                    }

                    body = { role: role.id };
                    words = `Make ${person.name} ${role.name} (now ${person.roleName})`;
                } else if (args.action === "always-on" || args.action === "not-always-on") {
                    body = { on: args.action === "always-on" };
                    words = `${args.action === "always-on" ? "Keep" : "Stop keeping"} ${person.name}'s pi-phone always on`;
                } else {
                    words = { "reset-two-factor": `Reset ${person.name}'s two-factor`, disable: `Disable ${person.name} (their pi-phone stops)`, enable: `Enable ${person.name}`, remove: `Remove ${person.name}'s account (their data is kept)` }[args.action];
                }

                await ask(api, context, "team_person", words, args.reason);
                await call(`people/${person.id}/${args.action === "not-always-on" ? "always-on" : args.action}`, "POST", body);

                return `Done: ${words}.`;
            },
        ),
        tool("team_roles", "The team server's roles: each one's permissions, memory and CPUs, models, monthly spend limit and how many have it, and every permission there is.", Type.Object({}), async () => {
            const { roles: all, counts, catalogue } = await roles();

            return [
                ...all.map(
                    (role) =>
                        `- ${role.name} (${role.id}${role.builtin ? ", built in" : ""}; ${counts[role.id] ?? 0} people): ${role.memoryMb} MB, ${role.cpus} CPU, models ${role.models.length === 0 ? "any" : role.models.join(", ")}, spend ${role.spendLimit === null ? "no limit" : `$${role.spendLimit}/month`}; team accounts ${role.builtin ? "all" : (role.teamAccounts ?? []).join(", ") || "none"}, team spend ${(role.teamSpendLimit ?? null) === null ? "no limit" : `$${role.teamSpendLimit}/month each`}; ${role.permissions.join(", ") || "no permissions"}`,
                ),
                "Permissions:",
                ...catalogue.flatMap((group) => Object.entries(group.permissions).map(([id, words]) => `  ${id}: ${words} (${group.group})`)),
            ].join("\n");
        }),
        tool(
            "team_role_save",
            "Add a role, or change one (give its id), on the team server (asks the person first): its permissions (team_roles lists them), memory and CPUs of its people's pi-phones, the models they may use (none: any), a monthly spend limit (none: no limit), the team accounts its people may use (team_providers lists them; left out when changing a role: kept) and a team spend limit, dollars a month each on those accounts (none: no limit; left out when changing: kept). Needs roles.manage.",
            Type.Object({
                id: Type.Optional(Type.String({ description: "An existing role's id to change; leave out to add one" })),
                name: Type.String(),
                permissions: Type.Array(Type.String()),
                memoryMb: Type.Number(),
                cpus: Type.Number(),
                models: Type.Optional(Type.Array(Type.String())),
                spendLimit: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
                teamAccounts: Type.Optional(Type.Array(Type.String({ description: "A team account's id, like anthropic~team-max" }))),
                teamSpendLimit: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
                reason: Type.String(),
            }),
            async (args: { id?: string; name: string; permissions: string[]; memoryMb: number; cpus: number; models?: string[]; spendLimit?: number | null; teamAccounts?: string[]; teamSpendLimit?: number | null; reason: string }, api, context) => {
                // Changing a role keeps its team accounts and team spend limit unless given: the role's form sends them all.
                const was = args.id === undefined ? undefined : (await roles()).roles.find((each) => each.id === args.id);

                if (args.id !== undefined && was === undefined) {
                    throw new Error(`No role ${args.id}: team_roles lists them.`);
                }

                const role = {
                    name: args.name,
                    permissions: args.permissions,
                    memoryMb: args.memoryMb,
                    cpus: args.cpus,
                    models: args.models ?? [],
                    spendLimit: args.spendLimit ?? null,
                    teamAccounts: args.teamAccounts ?? was?.teamAccounts ?? [],
                    teamSpendLimit: args.teamSpendLimit === undefined ? (was?.teamSpendLimit ?? null) : args.teamSpendLimit,
                    // Team machines (PP-82) are kept as they are; team_machine_access changes them.
                    teamMachines: was?.teamMachines ?? [],
                };

                await ask(
                    api,
                    context,
                    "team_role_save",
                    `${args.id === undefined ? "Add the role" : `Change the role ${args.id} to`} ${args.name}: ${args.permissions.join(", ") || "no permissions"}; ${args.memoryMb} MB, ${args.cpus} CPU; models ${role.models.length === 0 ? "any" : role.models.join(", ")}; spend ${role.spendLimit === null ? "no limit" : `$${role.spendLimit}/month`}; team accounts ${role.teamAccounts.join(", ") || "none"}, team spend ${role.teamSpendLimit === null ? "no limit" : `$${role.teamSpendLimit}/month each`}`,
                    args.reason,
                );

                const saved = (await call(args.id === undefined ? "roles" : `roles/${args.id}`, "POST", role)) as Role;

                return `Saved the role ${saved.name} (${saved.id}).`;
            },
        ),
        tool("team_role_delete", "Delete a role on the team server (asks the person first). Its people move to Member. Needs roles.manage.", Type.Object({ role: Type.String({ description: "Its id" }), reason: Type.String() }), async (args: { role: string; reason: string }, api, context) => {
            await ask(api, context, "team_role_delete", `Delete the role ${args.role}`, args.reason);
            await call(`roles/${args.role}/delete`, "POST", {});

            return `Deleted the role ${args.role}.`;
        }),
        tool("team_audit", "The team server's audit log, newest first: invites, joins, roles, resets, disabling and removing people, shares, settings. Pi's changes show as \"Pi for\" the person. Needs audit.view.", Type.Object({ limit: Type.Optional(Type.Number({ description: "How many, newest first (default 40)" })) }), async (args: { limit?: number }) => {
            const { entries } = (await call("audit", "GET")) as { entries: { at: number; actor: string; action: string; target: string | null; details: Record<string, unknown> | null }[] };
            let names: Map<string, string> = new Map();

            try {
                names = new Map((await people()).map((person) => [person.id, person.name]));
            } catch {
                // Without people.invite or people.manage: ids as they are.
            }

            const who = (id: string | null) => (id === null ? "" : id.startsWith("pi:") ? `Pi for ${names.get(id.slice(3)) ?? id.slice(3)}` : (names.get(id) ?? id));

            return entries
                .slice(0, Math.max(1, Math.min(200, args.limit ?? 40)))
                .map((entry) => `- ${new Date(entry.at).toISOString().slice(0, 16).replace("T", " ")} ${who(entry.actor)}: ${entry.action}${entry.target === null ? "" : ` · ${who(entry.target)}`}`)
                .join("\n");
        }),
        tool(
            "team_server",
            "The team server's settings: how many idle minutes before a pi-phone stops (0: never); how many pi-phones there are, running, and on an older image; and search in team documents (its OpenRouter embedding model, whether the owner set its key, how much is indexed, this month's spend). With idleMinutes, docsModel (an OpenRouter embedding model's id; empty for keyword only) or docsVision (an OpenRouter model that reads images, to describe pictures in team documents; empty for none), changes it (asks the person first). The key itself is only typed by a person on the Server page. Needs server.manage.",
            Type.Object({ idleMinutes: Type.Optional(Type.Number()), docsModel: Type.Optional(Type.String()), docsVision: Type.Optional(Type.String()), reason: Type.Optional(Type.String()) }),
            async (args: { idleMinutes?: number; docsModel?: string; docsVision?: string; reason?: string }, api, context) => {
                type Server = { idleMinutes: number; containers: { all: number; running: number; outdated: number }; docs: { model: string | null; vision: string | null; keySet: boolean; month: { tokens: number; cost: number }; indexed: { passages: number; embedded: number } } };
                const show = (answer: Server) =>
                    [
                        `Idle pi-phones stop after ${answer.idleMinutes === 0 ? "never" : `${answer.idleMinutes} minutes`}. ${answer.containers.all} pi-phones, ${answer.containers.running} running, ${answer.containers.outdated} on an older image.`,
                        answer.docs.model === null || !answer.docs.keySet
                            ? `Team documents are searched by keyword only (${answer.docs.model === null ? "no embedding model" : "no OpenRouter key: the owner types it on the Server page"}).`
                            : `Team documents are searched by meaning too, with ${answer.docs.model}: ${answer.docs.indexed.embedded} of ${answer.docs.indexed.passages} passages indexed; images described ${answer.docs.vision === null ? "by nobody (no image description model)" : `with ${answer.docs.vision}`}; this month ${answer.docs.month.tokens} tokens, ${answer.docs.month.cost < 0.01 ? "under $0.01" : `$${answer.docs.month.cost.toFixed(2)}`}.`,
                    ].join("\n");

                if (args.idleMinutes === undefined && args.docsModel === undefined && args.docsVision === undefined) {
                    return show((await call("server", "GET")) as never);
                }

                const change = [
                    args.idleMinutes === undefined ? undefined : `stop idle pi-phones after ${args.idleMinutes === 0 ? "never" : `${args.idleMinutes} minutes`}`,
                    args.docsModel === undefined ? undefined : args.docsModel.trim() === "" ? "search team documents by keyword only" : `search team documents with ${args.docsModel.trim()}`,
                    args.docsVision === undefined ? undefined : args.docsVision.trim() === "" ? "describe no images in team documents" : `describe images in team documents with ${args.docsVision.trim()}`,
                ].filter((each) => each !== undefined).join(", and ");

                await ask(api, context, "team_server", change.charAt(0).toUpperCase() + change.slice(1), args.reason ?? "");

                return show((await call("server", "POST", { ...(args.idleMinutes === undefined ? {} : { idleMinutes: args.idleMinutes }), ...(args.docsModel === undefined ? {} : { docsModel: args.docsModel }), ...(args.docsVision === undefined ? {} : { docsVision: args.docsVision }) })) as never);
            },
        ),
        // The team's provider accounts (PP-69): set up once on the team server, used by roles. Never their keys or
        // sign-ins: a person signs in on the account's row in Providers.
        tool(
            "team_providers",
            "The team server's provider accounts (API keys or subscriptions, set up once for the team) you can see: each one's id, whether it is signed in, which roles may use it, and its plan's usage where it has one (a Claude, Codex or Copilot subscription). Their keys and sign-ins stay on the team server: never here.",
            Type.Object({}),
            async () => {
                const { manage, accounts: all } = await teamAccounts();

                if (all.length === 0) {
                    return `No team accounts${manage ? " yet: team_provider_add makes one." : " you may use."}`;
                }

                const usage = new Map((((await accounts({ action: "usage", fresh: false })) as { usage: Usage[] }).usage).map((each) => [each.provider, each]));
                const bars = (id: string) => {
                    const found = usage.get(id);

                    if (found === undefined) {
                        return "";
                    }

                    return found.error !== undefined ? `; ${found.error}` : `; usage: ${(found.windows ?? []).map((window) => `${window.label} ${Math.round(window.usedPercent)}%`).join(", ")}`;
                };

                return [
                    ...all.map((account) => `- ${account.providerName} · Team ${account.name} (${account.id}): ${account.configured ? "signed in" : "not signed in yet (a person signs in on its row in Providers)"}; ${manage ? `${account.roles.length === 0 ? "no role uses it" : `used by ${account.roles.join(", ")}`} (and the owner's)` : account.usable ? "you may use it" : "your role may not use it"}${bars(account.id)}`),
                    manage ? "You manage them: team_provider_add, team_provider_access, team_provider_remove." : "",
                ]
                    .filter((line) => line !== "")
                    .join("\n");
            },
        ),
        tool(
            "team_provider_add",
            `Add a team account on the team server (asks the person first): ${PROVIDER_HINT}, and a name ("Work"). It starts signed out: tell the person to sign it in on its row in Providers (a key, or a subscription; a subscription is licensed to one person, so check its terms). Then team_provider_access says which roles may use it. Needs providers.manage.`,
            Type.Object({ provider: Type.String(), name: Type.String(), reason: Type.String() }),
            async (args: { provider: string; name: string; reason: string }, api, context) => {
                await ask(api, context, "team_provider_add", `Add a team account of ${args.provider} called ${args.name}`, args.reason);
                const { account } = (await accounts({ action: "add", provider: args.provider, name: args.name })) as { account: { id: string } };

                return `Added ${account.id}. It isn't signed in: the person signs it in on its row in Providers (Menu › Providers, under ${args.provider}). No role uses it yet: team_provider_access.`;
            },
        ),
        tool(
            "team_provider_access",
            "Say which roles may use a team account (asks the person first): the whole list of role ids (team_roles lists them; the owner's role always may). Their people see its models in their model menu at once. Needs roles.manage.",
            Type.Object({ account: Type.String({ description: "Its id, or its name" }), roles: Type.Array(Type.String({ description: "A role's id" })), reason: Type.String() }),
            async (args: { account: string; roles: string[]; reason: string }, api, context) => {
                const account = await findAccount(args.account);
                const all = (await roles()).roles.filter((role) => !role.builtin);
                const unknown = args.roles.filter((id) => !all.some((role) => role.id === id));

                if (unknown.length > 0) {
                    throw new Error(`No role ${unknown.join(", ")}: team_roles lists them.`);
                }

                const changed = all
                    .map((role) => {
                        const has = (role.teamAccounts ?? []).includes(account.id);
                        const wants = args.roles.includes(role.id);

                        return has === wants ? undefined : { role, teamAccounts: wants ? [...(role.teamAccounts ?? []), account.id] : (role.teamAccounts ?? []).filter((id) => id !== account.id) };
                    })
                    .filter((each) => each !== undefined);

                if (changed.length === 0) {
                    return `Nothing to change: ${args.roles.length === 0 ? "no role uses it" : `${args.roles.join(", ")} already use it, and no other role`}.`;
                }

                const words = changed.map(({ role, teamAccounts: next }) => `${next.includes(account.id) ? "let" : "stop"} ${role.name}`).join(", ");

                await ask(api, context, "team_provider_access", `${words.charAt(0).toUpperCase() + words.slice(1)} use ${account.providerName} · Team ${account.name}`, args.reason);

                for (const { role, teamAccounts: next } of changed) {
                    const { id, builtin, ...body } = role;

                    void builtin;
                    await call(`roles/${id}`, "POST", { ...body, teamAccounts: next });
                }

                return `Done: ${words} use ${account.id}.`;
            },
        ),
        tool(
            "team_provider_remove",
            "Remove a team account from the team server, with its sign-in (asks the person first). Every role that used it stops at once. Needs providers.manage.",
            Type.Object({ account: Type.String({ description: "Its id, or its name" }), reason: Type.String() }),
            async (args: { account: string; reason: string }, api, context) => {
                const account = await findAccount(args.account);

                await ask(api, context, "team_provider_remove", `Remove the team account ${account.providerName} · Team ${account.name}, with its sign-in${account.roles.length === 0 ? "" : `: ${account.roles.join(", ")} can no longer use it`}`, args.reason);
                await accounts({ action: "remove", id: account.id });

                return `Removed ${account.id}.`;
            },
        ),
        // The team's machines (PP-82): added once, used by roles. Their keys stay on the team server; a person accepts a
        // machine's host key on its row in Machines.
        tool(
            "team_machines",
            "The team server's machines (computers added once for the team, their key kept on the team server) you can see: each one's address, whether its host key is accepted and it is set up, which roles may use it, and your own folder there. A session or machine_run reaches one by the name host.machines gives it once set up.",
            Type.Object({}),
            async () => {
                const { manage, machines } = await teamMachines();

                if (machines.length === 0) {
                    return `No team machines${manage ? " yet: team_machine_add adds one." : " you may use."}`;
                }

                const aliases = new Map(host.machines().map((machine) => [machine.id, machine.alias]));

                return [
                    ...machines.map((machine) => {
                        const state =
                            machine.hostKey === undefined
                                ? "its host key isn't accepted yet (a person accepts it on its row in Machines)"
                                : machine.remote === undefined
                                  ? "host key accepted, not set up yet (Install on its row in Machines)"
                                  : `${machine.remote.platform} ${machine.remote.arch}, set up${aliases.has(`team-${machine.id}`) ? `, machine_run name ${aliases.get(`team-${machine.id}`)}` : ""}`;
                        const who = manage ? `${machine.roles.length === 0 ? "no role uses it" : `used by ${machine.roles.join(", ")}`} (and the owner's)` : machine.usable ? "you may use it" : "your role may not use it";

                        return `- ${machine.name} (${machine.id}): ${address(machine)}; ${state}; ${who}; your folder there: ~/${machine.folder}`;
                    }),
                    manage ? "You manage them: team_machine_add, team_machine_access, team_machine_remove." : "",
                ]
                    .filter((line) => line !== "")
                    .join("\n");
            },
        ),
        tool(
            "team_machine_add",
            "Add a team machine on the team server (asks the person first): a name and its address, user@host or user@host:port, reached from the team server's network. The team server makes its key and keeps it; the answer has the public half for the machine's authorized_keys. The person then accepts its host key and sets it up on its row in Machines (yours never). Then team_machine_access says which roles may use it. Needs machines.manage.",
            Type.Object({ name: Type.String(), address: Type.String({ description: "user@host or user@host:port" }), reason: Type.String() }),
            async (args: { name: string; address: string; reason: string }, api, context) => {
                await ask(api, context, "team_machine_add", `Add a team machine called ${args.name} at ${args.address}`, args.reason);
                const made = (await machinesCall({ action: "add", name: args.name, address: args.address })) as { machine: TeamMachine; publicKey: string };

                await host.syncTeamMachines();

                return [
                    `Added ${made.machine.name} (${made.machine.id}). Its key is on the team server only. Next, for the person:`,
                    `1. On ${made.machine.host}, add this line to ~${made.machine.user}/.ssh/authorized_keys:`,
                    made.publicKey,
                    `2. Menu › Machines, on ${made.machine.name}'s row under Team machines: check and accept its host key, then set it up.`,
                    "No role uses it yet: team_machine_access.",
                ].join("\n");
            },
        ),
        tool(
            "team_machine_access",
            "Say which roles may use a team machine (asks the person first): the whole list of role ids (team_roles lists them; the owner's role always may). Their people see it in Machines and the folder picker; a role taken off loses its open connections at once. Needs roles.manage.",
            Type.Object({ machine: Type.String({ description: "Its id, or its name" }), roles: Type.Array(Type.String({ description: "A role's id" })), reason: Type.String() }),
            async (args: { machine: string; roles: string[]; reason: string }, api, context) => {
                const machine = await findMachine(args.machine);
                const all = (await roles()).roles.filter((role) => !role.builtin);
                const unknown = args.roles.filter((id) => !all.some((role) => role.id === id));

                if (unknown.length > 0) {
                    throw new Error(`No role ${unknown.join(", ")}: team_roles lists them.`);
                }

                const changed = all
                    .map((role) => {
                        const has = (role.teamMachines ?? []).includes(machine.id);
                        const wants = args.roles.includes(role.id);

                        return has === wants ? undefined : { role, teamMachines: wants ? [...(role.teamMachines ?? []), machine.id] : (role.teamMachines ?? []).filter((id) => id !== machine.id) };
                    })
                    .filter((each) => each !== undefined);

                if (changed.length === 0) {
                    return `Nothing to change: ${args.roles.length === 0 ? "no role uses it" : `${args.roles.join(", ")} already use it, and no other role`}.`;
                }

                const words = changed.map(({ role, teamMachines: next }) => `${next.includes(machine.id) ? "let" : "stop"} ${role.name}`).join(", ");

                await ask(api, context, "team_machine_access", `${words.charAt(0).toUpperCase() + words.slice(1)} use the team machine ${machine.name}`, args.reason);

                for (const { role, teamMachines: next } of changed) {
                    const { id, builtin, ...body } = role;

                    void builtin;
                    await call(`roles/${id}`, "POST", { ...body, teamMachines: next });
                }

                return `Done: ${words} use ${machine.name}.`;
            },
        ),
        tool(
            "team_machine_remove",
            "Remove a team machine from the team server (asks the person first): everyone's sessions there stop and the team server deletes its key. The machine's files stay, and so does the key's public half in its authorized_keys (a person takes it out there). Needs machines.manage.",
            Type.Object({ machine: Type.String({ description: "Its id, or its name" }), reason: Type.String() }),
            async (args: { machine: string; reason: string }, api, context) => {
                const machine = await findMachine(args.machine);

                await ask(api, context, "team_machine_remove", `Remove the team machine ${machine.name} (${address(machine)}) for the whole team: everyone's sessions there stop and its key is deleted${machine.roles.length === 0 ? "" : `; ${machine.roles.join(", ")} can no longer use it`}`, args.reason);
                await machinesCall({ action: "remove", id: machine.id });
                await host.syncTeamMachines();

                return `Removed ${machine.name}. If its key's public half went into ${address(machine)}'s ~/.ssh/authorized_keys, it is still there: take the line ending "pi-phone team ${machine.name.replace(/\s+/g, "-")}" out.`;
            },
        ),
    ];

    return defineExtension({ name: "pocket-team", tools });
}
