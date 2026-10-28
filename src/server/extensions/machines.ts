/**
 * The owner's machines, for Pi in any session, without `ssh` in its bash (the app's ssh, its keys, and its agent are
 * the app's own: `machines.ts`, `ssh-agent.ts`):
 * - `machine_run`: one command on a machine, over the app's connection to it, as bash runs one: secrets it names are
 *   set (the secrets module's rules apply), and their values are hidden in what it prints.
 * - `machine_copy`: a file from the phone to a machine, a machine to the phone, or one machine to another.
 * - `machine_add` (PP-139): add one, as the Machines sheet does, after the owner approves one card that shows it all:
 *   the address, the key, the host key as scanned now (checked against one Pi read on the machine itself, when given),
 *   and the install. Approve adds it, trusts that host key, installs pi-env and connects; Deny, or any step that fails,
 *   leaves nothing saved.
 * For longer work there, a session in a folder on the machine runs all of Pi's tools there.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { PocketHost } from "../host.ts";
import { machinePaths } from "../machine-paths.ts";
import { toolOffer, toolsToInstall } from "../machine-tools.ts";
import { namesIn } from "../secrets.ts";
import { MAX_SAVE_COMMAND } from "./secrets.ts";

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
                    ? "No machine is connected: add one with machine_add (the owner approves it), or the owner adds one in Settings › Machines."
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
            "Run one shell command on one of the owner's machines, over the app's connection (no ssh needed): to check a log, a disk, a service, or a quick build step there. Secrets work as in bash ($NAME). For longer work on a machine, start a session in a folder there instead. " +
            "A machine the owner set to ask before each command (Settings › Machines) shows the command on a card first, and runs it only when they allow it.",
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

            // The owner's "Pi asks before each command" for this machine (Settings › Machines, PP-230): a card shows the
            // whole command, where it runs, before it does.
            if (machine.askRun) {
                if (args.command.length > MAX_SAVE_COMMAND) {
                    return failed(
                        `${machine.alias} asks before each command, and the card shows at most ${MAX_SAVE_COMMAND.toLocaleString("en")} characters; this one is ${args.command.length.toLocaleString("en")}. Use a shorter one (a script it runs, say). Nothing ran.`,
                    );
                }

                const answer = await host.approvals.request(
                    {
                        id: `machine_run-${String(api.taskId)}-${String(api.callId)}`,
                        conversationId: api.conversationId as never,
                        taskId: api.taskId as never,
                        ...(api.callId === undefined ? {} : { callId: api.callId }),
                        tool: "machine_run",
                        subject: args.command,
                        reason: `On ${machine.alias}, in ${cwd}: it asks before each command (Settings › Machines).`,
                        createdAt: Date.now(),
                    },
                    context as never,
                );

                if (!answer.allow) {
                    return failed(`${answer.by === "superseded" ? "The request was replaced" : `${answer.by} said no`}: nothing ran on ${machine.alias}.`);
                }
            }
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
            const shown = host.secrets.redact(tail, api.conversationId);
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

    const add = defineTool({
        name: "machine_add",
        description:
            "Add a computer to pi-phone's machines, after the owner approves one card: it scans the machine's host key, shows it with the address and the SSH key, and on Approve trusts that key, installs pi-env (~2 MB, in ~/.pi/mobile/tools there) and connects. Give expectedFingerprint when you read the host key on the machine itself (ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub, from its console or guest agent): a different key is refused. The machine must have the key's public half in ~/.ssh/authorized_keys; with key \"new\", a new key is made on Approve and, if the machine refuses it, its public half comes back for you to install, then call again with that key. Owner only.",
        parameters: Type.Object({
            name: Type.String({ description: "The machine's name in pi-phone, like build-box" }),
            address: Type.String({ description: "user@host or user@host:port" }),
            key: Type.String({ description: 'The SSH key to sign in with: a key\'s name or id from Settings › SSH keys, or "new" to make one named after the machine' }),
            expectedFingerprint: Type.Optional(Type.String({ description: "The host key's SHA256 fingerprint as read on the machine itself, like SHA256:a1Va..." })),
            reason: Type.String({ description: "Why, in a sentence: shown on the card" }),
        }),
        execute: async (args, api, context) => {
            try {
                const asker = host.requesterOf(Number(api.conversationId) as never);

                if (asker === undefined || host.person(asker).role !== "owner") {
                    return failed("Only the owner adds machines.");
                }

                const keys = await host.sshKeys.list();
                const wanted = args.key.trim();
                const existing = wanted.toLowerCase() === "new" ? undefined : keys.find((each) => each.id === wanted || each.name.toLowerCase() === wanted.toLowerCase());

                if (wanted.toLowerCase() !== "new" && existing === undefined) {
                    return failed(`There is no SSH key ${wanted}. Keys: ${keys.map((each) => each.name).join(", ") || "none"}; or give "new".`);
                }

                const scanned = await host.machineStore.scanNew({ name: args.name, address: args.address, ...(existing === undefined ? {} : { keyId: existing.id }) });
                const expected = args.expectedFingerprint?.trim();
                const bare = (fingerprint: string) => fingerprint.replace(/\s*\(\w+\)\s*$/, "").replace(/^SHA256:/i, "");
                const matched = expected === undefined || expected === "" ? undefined : scanned.fingerprints.find((each) => bare(each) === bare(expected));

                if (expected !== undefined && expected !== "" && matched === undefined) {
                    return failed(
                        `${args.address} presents ${scanned.fingerprints.join(", ")}, not ${expected}: refused, nothing saved. Check the address, and read the key on the machine again; if it changed for a known reason, call again with the new fingerprint.`,
                    );
                }

                const { machine } = scanned;
                const address = `${machine.user}@${machine.host}${machine.port === undefined ? "" : `:${machine.port}`}`;
                const keyName = existing?.name ?? machine.name;
                const answer = await host.approvals.request(
                    {
                        id: `machine_add-${String(api.conversationId)}-${String(api.callId)}`,
                        conversationId: Number(api.conversationId) as never,
                        taskId: api.taskId as never,
                        ...(api.callId === undefined ? {} : { callId: api.callId }),
                        tool: "machine_add",
                        subject: `Add ${machine.name} (${address}) with the key ${keyName}${existing === undefined ? " (new)" : ""}, host key ${matched ?? scanned.fingerprints.join(", ")}`,
                        reason: args.reason,
                        form: {
                            type: "machine",
                            name: machine.name,
                            address,
                            key: { name: keyName, fingerprint: existing?.fingerprint ?? "", new: existing === undefined },
                            hostKeys: scanned.fingerprints,
                            ...(expected === undefined || expected === "" ? {} : { expected, matches: true }),
                            tools: host.machineTools.catalog.map(toolOffer),
                        },
                        createdAt: Date.now(),
                    },
                    context as never,
                );

                if (!answer.allow) {
                    return failed(`${answer.by} said no: nothing was saved.`);
                }

                const key = existing ?? (await host.sshKeys.generate(machine.name));
                const store = host.machineStore;

                store.add({ name: machine.name, address, keyId: key.id }, machine.id);

                try {
                    await store.accept(machine.id, scanned.lines, matched ?? scanned.fingerprints[0]);
                    const connected = (await store.connect(machine.id)) as Awaited<ReturnType<typeof store.connect>> & { warnings?: string[] };
                    const remote = connected.remote;

                    if (remote === undefined) {
                        throw new Error("it connected but said nothing of its system.");
                    }

                    const alias = host.machines().find((each) => each.id === machine.id)?.alias ?? machine.name;
                    // The tools the card kept ticked, those the machine offers (PP-177), as Settings › Machines does.
                    // A tool that fails leaves the machine added: it says why, and Settings › Machines › Install tools tries again.
                    const ticked = (answer.values?.tools ?? "").split(",").filter((id) => id !== "");
                    let installed: { id: string; ok: boolean; version?: string; said: string }[] = [];

                    try {
                        const installs = ticked.length === 0 ? [] : toolsToInstall(await host.machineTools.status(machine.id), ticked, host.machineTools.catalog);

                        installed = installs.length === 0 ? [] : (await host.machineTools.install(machine.id, installs)).results;
                    } catch (error) {
                        installed = ticked.map((id) => ({ id, ok: false, said: error instanceof Error ? error.message : String(error) }));
                    }

                    return {
                        output: [
                            text(
                                [
                                    `Added ${machine.name} (${address}) and connected: ${remote.platform} ${remote.arch}, home ${remote.home}. Ready for sessions (machine:${machine.id}:<path>) and for machine_run as ${alias}.`,
                                    installed.length === 0
                                        ? "No tools installed (none ticked on the card, or the machine has them)."
                                        : `Tools: ${installed.map((each) => (each.ok ? `${each.id} ${each.version} installed` : `${each.id} not installed (${each.said})`)).join("; ")}.`,
                                    ...(connected.warnings ?? []).map((warning) => `Note: ${warning}`),
                                ].join("\n"),
                            ),
                        ],
                        details: { id: machine.id, alias, platform: remote.platform, arch: remote.arch, home: remote.home },
                    };
                } catch (error) {
                    await store.remove(machine.id);

                    const said = error instanceof Error ? error.message : String(error);
                    const refused = /refused the key/.test(said);

                    return failed(
                        [
                            `Could not finish adding ${machine.name}: ${said} Nothing was saved${existing === undefined ? ` but the new key ${key.name}` : ""}.`,
                            ...(refused ? [`Its public half, for ~/.ssh/authorized_keys on the machine (then call machine_add again with key "${key.name}"):`, key.publicKey] : []),
                        ].join("\n"),
                    );
                }
            } catch (error) {
                return failed(error instanceof Error ? error.message : String(error));
            }
        },
    });

    return defineExtension({ name: "pocket-machines", tools: [run, copy, add] });
}
