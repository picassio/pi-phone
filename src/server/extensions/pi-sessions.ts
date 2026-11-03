/**
 * Pi's own sessions (the terminal's `pi`), for Pi here: list them on this phone or a machine, continue one as a new
 * session, hand a session to Pi in a machine's terminal, and bring back what Pi did there. The same steps as the Pi
 * sessions sheet and the session menu's Continue in Pi and Bring back (`pi-sessions.ts`, `pi-handoff.ts`), as the person
 * Pi works for (`session-control.ts`): the owner's only, as those are. Owner's decisions of 2026-10-19 (wiki:
 * pi-session-agent-tools): a file changed in the last two minutes is listed as busy and imported as usual.
 */
import { bool, num, obj, opt, str } from "@earendil-works/pi-schema";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { PocketHost } from "../host.ts";

const reply = (text: string) => ({ output: [{ type: "text" as const, text }] });
const failed = (error: unknown) => ({
    output: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
    isError: true,
});

/** "3m ago", "2d ago": how long since. */
function ago(at: number): string {
    const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000));

    return minutes < 60 ? `${minutes}m ago` : minutes < 48 * 60 ? `${Math.round(minutes / 60)}h ago` : `${Math.round(minutes / 1440)}d ago`;
}

export default function createPiSessions(host: PocketHost) {
    /** A connected machine by its name, alias, or id; or an error that lists them. */
    const machineOf = (name: string) => {
        const wanted = name.trim().toLowerCase();
        const all = host.machines();
        const found = all.find((each) => each.id === name || each.alias === wanted || each.name.toLowerCase() === wanted);

        if (found === undefined) {
            throw new Error(
                all.length === 0 ? "No machine is connected." : `No machine ${name}. Machines: ${all.map((each) => each.alias).join(", ")}.`,
            );
        }

        return found;
    };
    const session = num({ description: "The pi-phone session's id, from the sessions tool" });

    const list = defineTool({
        name: "pi_sessions",
        description:
            "Pi's own sessions from the terminal (pi CLI, ~/.pi/agent/sessions), on this phone or on one of the owner's machines: each one's file path, title (its first message), folder, last activity, size, whether a pi-phone session already continues it, and busy when it changed in the last 2 minutes (pi may still be running there). Continue one here with pi_session_import. The owner's only.",
        parameters: obj({
            machine: opt(str({ description: "A machine's name or alias; leave out for this phone's" })),
            query: opt(str({ description: "Words in the title or folder" })),
            limit: opt(num({ description: "At most this many, newest first (default 20)" })),
        }, { open: true }),
        replay: "safe",
        execute: async (args, api) => {
            try {
                const machine = args.machine === undefined ? undefined : machineOf(args.machine);
                const found = await host.sessions.piSessions(api.conversationId, machine?.id, args.query ?? "");
                const shown = found.slice(0, Math.max(1, Math.min(100, args.limit ?? 20)));
                const where = machine === undefined ? "this phone" : machine.alias;

                return reply(
                    shown.length === 0
                        ? `No Pi sessions on ${where}${args.query ? ` match "${args.query}"` : ""}.`
                        : [
                              `Pi sessions on ${where}, newest first:`,
                              ...shown.map((each) =>
                                  [
                                      `- ${host.text.quoted(each.title || "(no message)")}`,
                                      `  folder ${each.cwd} · ${ago(each.modified)}${each.size === undefined ? "" : ` · ${Math.round(each.size / 1024)} KB`}${each.messages === undefined ? "" : ` · ${each.messages} messages`}${each.busy ? " · busy: changed in the last 2 minutes, pi may still be running there" : ""}${each.continuedIn === undefined ? "" : ` · continued here in #${each.continuedIn}`}`,
                                      `  path ${each.path}`,
                                  ].join("\n"),
                              ),
                              ...(found.length > shown.length ? [`(${found.length - shown.length} more)`] : []),
                          ].join("\n"),
                );
            } catch (error) {
                return failed(error);
            }
        },
    });

    const importSession = defineTool({
        name: "pi_session_import",
        description:
            "Continue one of Pi's terminal sessions as a new pi-phone session, as the Pi sessions sheet does: a machine's file is copied here (Pi's file there is never changed), then the new session continues where Pi left it, in its folder (on that machine), with every message to read and Pi's context. Answers the new session's id and link. The owner's only.",
        parameters: obj({
            path: str({ description: "The session file's path, from pi_sessions" }),
            machine: opt(str({ description: "The machine it is on (name or alias); leave out for this phone's" })),
            folder: opt(str({ description: "Continue in this folder instead of the one Pi worked in (on the same machine)" })),
        }, { open: true }),
        execute: async (args, api) => {
            try {
                const machine = args.machine === undefined ? undefined : machineOf(args.machine);
                const made = await host.sessions.importPiSession(api.conversationId, {
                    path: args.path,
                    ...(machine === undefined ? {} : { machineId: machine.id }),
                    ...(args.folder === undefined ? {} : { folder: args.folder }),
                });

                return reply(`Continued as session #${made.id}, [${made.title}](/s/${made.id}), in ${made.cwd}.`);
            } catch (error) {
                return failed(error);
            }
        },
    });

    const continueInPi = defineTool({
        name: "continue_in_pi",
        description:
            "Hand a pi-phone session to Pi in a machine's terminal (the session menu's Continue in Pi): its conversation becomes a new Pi session file in a folder there, for `pi -c` (or `pi --resume`) in that folder; pi_bring_back brings Pi's work back later. Not this session. The owner's only.",
        parameters: obj({
            session,
            machine: str({ description: "The machine's name or alias" }),
            folder: str({ description: "The folder on the machine Pi continues in" }),
        }, { open: true }),
        execute: async (args, api) => {
            try {
                const machine = machineOf(args.machine);
                const done = await host.sessions.continueInPi(api.conversationId, args.session, machine.id, args.folder);

                return reply(`Session #${args.session} continues in Pi on ${done.machine}: run \`pi -c\` in ${done.cwd} there. The file: ${done.path}`);
            } catch (error) {
                return failed(error);
            }
        },
    });

    const bringBack = defineTool({
        name: "pi_bring_back",
        description:
            "Bring what Pi did in a machine's terminal since a session went there (continue_in_pi, or the session menu) back into that pi-phone session (Bring back). When either went another way since, as_new brings it back as a new session instead. Not this session. The owner's only.",
        parameters: obj({
            session,
            as_new: opt(bool({ description: "Bring it back as a new session (when the two went different ways)" })),
        }, { open: true }),
        execute: async (args, api) => {
            try {
                const done = await host.sessions.bringBack(api.conversationId, args.session, args.as_new === true);

                return reply(
                    done.id === args.session
                        ? `Brought back ${done.added} message${done.added === 1 ? "" : "s"} into session #${done.id}.`
                        : `Brought back as a new session: [#${done.id}](/s/${done.id}), ${done.added} message${done.added === 1 ? "" : "s"}.`,
                );
            } catch (error) {
                return failed(error);
            }
        },
    });

    return defineExtension({ name: "pocket-pi-sessions", tools: [list, importSession, continueInPi, bringBack] });
}
