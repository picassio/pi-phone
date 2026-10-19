/**
 * The owner's machines, for Pi in any session, without `ssh` in its bash (the app's ssh, its keys, and its agent are
 * the app's own: `machines.ts`, `ssh-agent.ts`):
 * - `machine_run`: one command on a machine, over the app's connection to it, as bash runs one: secrets it names are
 *   set (the secrets module's rules apply), and their values are hidden in what it prints.
 * - `machine_copy`: a file from the phone to a machine, a machine to the phone, or one machine to another.
 * For longer work there, a session in a folder on the machine runs all of Pi's tools there.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { PocketHost } from "../host.ts";
import { machinePaths } from "../machine-paths.ts";
import { namesIn } from "../secrets.ts";

type Text = { type: "text"; text: string };
const text = (value: string): Text => ({ type: "text", text: value });
const failed = (message: string) => ({ output: [text(message)], isError: true });

const MAX_OUTPUT = 30_000;
const MAX_COPY = 100 * 1024 * 1024;

export default function createMachines(host: PocketHost) {
    /** A machine by its name, alias, or id, connected; or an error that lists them. */
    const find = (name: string) => {
        const wanted = name.trim().toLowerCase();
        const all = host.machines();
        const found = all.find((each) => each.id === name || each.alias === wanted || each.name.toLowerCase() === wanted);

        if (found === undefined) {
            throw new Error(
                all.length === 0
                    ? "No machine is connected: the owner adds one in Settings › Machines."
                    : `No machine ${name}. Machines: ${all.map((each) => each.alias).join(", ")}.`,
            );
        }

        return found;
    };

    /**
     * `machine:/path` (`machine:C:/path` on Windows) or a path on the phone (absolute or `~/…`): where, the
     * environment to reach it with, and its system's paths (`machine-paths.ts`).
     */
    const locate = (spec: string) => {
        const colon = spec.indexOf(":");
        const onMachine = colon > 0 && !spec.startsWith("/") && !spec.startsWith("~");

        if (onMachine) {
            const machine = find(spec.slice(0, colon));
            const paths = machinePaths(machine.windows ? { platform: "windows" } : undefined);
            const path = paths.normal(paths.expandHome(spec.slice(colon + 1), machine.home));

            if (!paths.isAbsolute(path)) {
                throw new Error(`${spec}: give the path on ${machine.alias} from ${machine.windows ? "a drive (C:/…)" : "/"} or ~.`);
            }

            return { where: `${machine.alias}:${path}`, path, paths, env: host.envOf(`machine:${machine.id}:${machine.home}`) };
        }

        const paths = machinePaths(undefined);
        const path = paths.expandHome(spec, host.home);

        if (!paths.isAbsolute(path)) {
            throw new Error(`${spec}: give a phone path from / or ~, or <machine>:<path>.`);
        }

        return { where: `phone:${path}`, path, paths, env: host.envOf(host.home) };
    };

    const run = defineTool({
        name: "machine_run",
        description:
            "Run one shell command on one of the owner's machines, over the app's connection (no ssh needed): to check a log, a disk, a service, or a quick build step there. Secrets work as in bash ($NAME). For longer work on a machine, start a session in a folder there instead.",
        parameters: Type.Object({
            machine: Type.String({ description: "The machine's name (or alias) from your environment section" }),
            command: Type.String({ description: "A shell command, run with sh -c (Git Bash's bash on Windows)" }),
            cwd: Type.Optional(Type.String({ description: "Folder on the machine; default its home" })),
            timeout: Type.Optional(Type.Number({ description: "Seconds before it is stopped (default 120, at most 1800)" })),
        }),
        execute: async (args, api, context) => {
            let machine: ReturnType<typeof find>;

            try {
                machine = find(args.machine);
            } catch (error) {
                return failed(error instanceof Error ? error.message : String(error));
            }

            const paths = machinePaths(machine.windows ? { platform: "windows" } : undefined);
            const cwd = paths.normal(paths.expandHome(args.cwd ?? machine.home, machine.home));
            const place = `machine:${machine.id}:${cwd}`;
            const env = host.envOf(place);
            const secrets = host.secrets.environment(namesIn(args.command), place);
            let out = "";
            let skipped = 0;
            // On Windows, the daemon runs a command line with Git Bash (`machines.ts` checks it is there); `sh` may
            // not be on Windows' own PATH.
            const result = await env.exec(
                machine.windows ? args.command : ["sh", "-c", args.command],
                {
                    cwd,
                    env: secrets,
                    timeout: Math.max(1, Math.min(1800, args.timeout ?? 120)),
                    onOutput: (chunk) => {
                        out += chunk;

                        // Kept to its last part as it comes: a chatty command does not fill the phone's memory.
                        if (out.length > MAX_OUTPUT * 2) {
                            skipped += out.length - MAX_OUTPUT;
                            out = out.slice(-MAX_OUTPUT);
                        }
                    },
                },
                context,
            );

            host.secrets.used(Object.keys(secrets));

            if (!result.ok) {
                return failed(`${machine.alias}: ${result.error.message}`);
            }

            const tail = out.length > MAX_OUTPUT ? out.slice(-MAX_OUTPUT) : out;
            const cut = skipped + (out.length - tail.length);
            const shown = host.secrets.redact(tail);
            const head = `${machine.alias}:${cwd} · exit ${result.value.exitCode}${cut > 0 ? ` · the first ${cut.toLocaleString("en")} characters of output left out` : ""}`;

            return {
                output: [text(`${head}\n${shown}`)],
                details: { machine: machine.alias, cwd, exitCode: result.value.exitCode },
                ...(result.value.exitCode === 0 ? {} : { isError: true }),
            };
        },
    });

    const copy = defineTool({
        name: "machine_copy",
        description:
            "Copy one file between the phone and a machine, or between two machines, over the app's connections (no scp needed). Write a place on a machine as <machine>:<path> (from / or ~), and one on the phone as a plain path. Copying into a folder keeps the file's name. Files up to 100 MB; for a folder, pack it first with machine_run (tar).",
        parameters: Type.Object({
            from: Type.String({ description: "The file: /phone/path, ~/path, or <machine>:<path>" }),
            to: Type.String({ description: "Where to: a file path, or a folder ending in /" }),
        }),
        execute: async (args, _api, context) => {
            try {
                const from = locate(args.from);
                const to = locate(args.to);
                const info = await from.env.fileInfo(from.path, context);

                if (!info.ok) {
                    return failed(`${from.where}: ${info.error.message}`);
                }

                if (info.value.kind === "directory") {
                    return failed(`${from.where} is a folder: pack it with machine_run (tar -czf) and copy the archive.`);
                }

                if (info.value.size > MAX_COPY) {
                    return failed(`${from.where} is ${Math.round(info.value.size / 1024 / 1024)} MB; machine_copy takes up to ${MAX_COPY / 1024 / 1024} MB.`);
                }

                const target = await to.env.fileInfo(to.path, context);
                const into = /[\\/]$/.test(args.to) || (target.ok && target.value.kind === "directory");
                const destination = into ? to.paths.join(to.path, from.paths.basename(from.path)) : to.path;
                const bytes = await from.env.readBinaryFile(from.path, context);

                if (!bytes.ok) {
                    return failed(`${from.where}: ${bytes.error.message}`);
                }

                await to.env.createDir(to.paths.dirname(destination), { recursive: true }, context);
                const written = await to.env.writeFile(destination, bytes.value, context);

                if (!written.ok) {
                    return failed(`${to.where}: ${written.error.message}`);
                }

                const where = to.where.replace(/:.*$/, `:${destination}`);

                return {
                    output: [text(`Copied ${from.where} to ${where} (${bytes.value.length.toLocaleString("en")} bytes).`)],
                    details: { from: from.where, to: where, size: bytes.value.length },
                };
            } catch (error) {
                return failed(error instanceof Error ? error.message : String(error));
            }
        },
    });

    return defineExtension({ name: "pocket-machines", tools: [run, copy] });
}
