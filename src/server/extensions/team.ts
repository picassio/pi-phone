/**
 * The team server's people, roles, invites, audit log and server settings, for Pi (PP-45): what the gateway's pages do,
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
type Role = { id: string; name: string; permissions: string[]; memoryMb: number; cpus: number; models: string[]; spendLimit: number | null; builtin: boolean };

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
                ...all.map((role) => `- ${role.name} (${role.id}${role.builtin ? ", built in" : ""}; ${counts[role.id] ?? 0} people): ${role.memoryMb} MB, ${role.cpus} CPU, models ${role.models.length === 0 ? "any" : role.models.join(", ")}, spend ${role.spendLimit === null ? "no limit" : `$${role.spendLimit}/month`}; ${role.permissions.join(", ") || "no permissions"}`),
                "Permissions:",
                ...catalogue.flatMap((group) => Object.entries(group.permissions).map(([id, words]) => `  ${id}: ${words} (${group.group})`)),
            ].join("\n");
        }),
        tool(
            "team_role_save",
            "Add a role, or change one (give its id), on the team server (asks the person first): its permissions (team_roles lists them), memory and CPUs of its people's pi-phones, the models they may use (none: any), and a monthly spend limit (none: no limit). Needs roles.manage.",
            Type.Object({
                id: Type.Optional(Type.String({ description: "An existing role's id to change; leave out to add one" })),
                name: Type.String(),
                permissions: Type.Array(Type.String()),
                memoryMb: Type.Number(),
                cpus: Type.Number(),
                models: Type.Optional(Type.Array(Type.String())),
                spendLimit: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
                reason: Type.String(),
            }),
            async (args: { id?: string; name: string; permissions: string[]; memoryMb: number; cpus: number; models?: string[]; spendLimit?: number | null; reason: string }, api, context) => {
                const role = { name: args.name, permissions: args.permissions, memoryMb: args.memoryMb, cpus: args.cpus, models: args.models ?? [], spendLimit: args.spendLimit ?? null };

                await ask(api, context, "team_role_save", `${args.id === undefined ? "Add the role" : `Change the role ${args.id} to`} ${args.name}: ${args.permissions.join(", ") || "no permissions"}; ${args.memoryMb} MB, ${args.cpus} CPU; models ${role.models.length === 0 ? "any" : role.models.join(", ")}; spend ${role.spendLimit === null ? "no limit" : `$${role.spendLimit}/month`}`, args.reason);

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
            "The team server's settings: how many idle minutes before a pi-phone stops (0: never); how many pi-phones there are, running, and on an older image; and search in team documents (its OpenRouter embedding model, whether the owner set its key, how much is indexed, this month's spend). With idleMinutes or docsModel (an OpenRouter embedding model's id; empty for keyword only), changes it (asks the person first). The key itself is only typed by a person on the Server page. Needs server.manage.",
            Type.Object({ idleMinutes: Type.Optional(Type.Number()), docsModel: Type.Optional(Type.String()), reason: Type.Optional(Type.String()) }),
            async (args: { idleMinutes?: number; docsModel?: string; reason?: string }, api, context) => {
                type Server = { idleMinutes: number; containers: { all: number; running: number; outdated: number }; docs: { model: string | null; keySet: boolean; month: { tokens: number; cost: number }; indexed: { passages: number; embedded: number } } };
                const show = (answer: Server) =>
                    [
                        `Idle pi-phones stop after ${answer.idleMinutes === 0 ? "never" : `${answer.idleMinutes} minutes`}. ${answer.containers.all} pi-phones, ${answer.containers.running} running, ${answer.containers.outdated} on an older image.`,
                        answer.docs.model === null || !answer.docs.keySet
                            ? `Team documents are searched by keyword only (${answer.docs.model === null ? "no embedding model" : "no OpenRouter key: the owner types it on the Server page"}).`
                            : `Team documents are searched by meaning too, with ${answer.docs.model}: ${answer.docs.indexed.embedded} of ${answer.docs.indexed.passages} passages indexed; this month ${answer.docs.month.tokens} tokens, ${answer.docs.month.cost < 0.01 ? "under $0.01" : `$${answer.docs.month.cost.toFixed(2)}`}.`,
                    ].join("\n");

                if (args.idleMinutes === undefined && args.docsModel === undefined) {
                    return show((await call("server", "GET")) as never);
                }

                const change = [
                    args.idleMinutes === undefined ? undefined : `stop idle pi-phones after ${args.idleMinutes === 0 ? "never" : `${args.idleMinutes} minutes`}`,
                    args.docsModel === undefined ? undefined : args.docsModel.trim() === "" ? "search team documents by keyword only" : `search team documents with ${args.docsModel.trim()}`,
                ].filter((each) => each !== undefined).join(", and ");

                await ask(api, context, "team_server", change.charAt(0).toUpperCase() + change.slice(1), args.reason ?? "");

                return show((await call("server", "POST", { ...(args.idleMinutes === undefined ? {} : { idleMinutes: args.idleMinutes }), ...(args.docsModel === undefined ? {} : { docsModel: args.docsModel }) })) as never);
            },
        ),
    ];

    return defineExtension({ name: "pocket-team", tools });
}
