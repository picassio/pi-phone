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
 * - `machine_rekey` (PP-509): a machine's host key changed for a known reason (a reinstall, a move to another host):
 *   Pi reads the new key on the machine itself (its console, a Proxmox guest agent) and gives it; a scanned key that is
 *   not that one is refused before any card. The owner's card shows the old key and the new; Approve replaces it, and
 *   the machine stays set up when pi-env is there with its hash (`Machines.replaceKey`).
 * - `machine_tools` (PP-325): the tools pi-phone installs on a machine, as Settings › Machines shows them (status), and
 *   installing, updating or removing them after the owner approves one card with the machine, the tools, their versions
 *   from and to, and their sizes; Approve runs what Settings › Machines runs (`MachineTools.install`, `installScript`).
 * For longer work there, a session in a folder on the machine runs all of Pi's tools there.
 */
import type { JsonValue } from "@earendil-works/chord";
import { arr, num, obj, opt, str, union } from "@earendil-works/pi-schema";
import { literal } from "../tool-schema.ts";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { MachineToolChange, PocketHost } from "../host.ts";
import { machinePaths } from "../machine-paths.ts";
import { hostKeyChanged } from "../machines.ts";
import { installOrder, type InstallResult, type ToolStatus, toolOffer, toolsToInstall } from "../machine-tools.ts";
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

        if (found !== undefined) {
            return found;
        }

        // One that is there but not set up (never connected, or its host key forgotten): say so, not "no machine".
        const unset = host.machineStore.list().find((each) => each.team === undefined && each.remote === undefined && (each.id === name || each.name.toLowerCase() === wanted));

        if (unset !== undefined) {
            throw new Error(`${unset.name} is not set up: the owner connects it in Settings › Machines${unset.hostKey === undefined ? " (scan and accept its host key, then Install and connect)" : " (Install and connect)"}.`);
        }

        throw new Error(
            all.length === 0
                ? "No machine is connected: add one with machine_add (the owner approves it), or the owner adds one in Settings › Machines."
                : `No machine ${name}. Machines: ${all.map((each) => each.alias).join(", ")}.`,
        );
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
            "The tools pi-phone installed there (Settings › Machines › Install tools) are in ~/.pi/mobile/tools/bin, not on this command's PATH: run them by that path, e.g. ~/.pi/mobile/tools/bin/hyperframes render <project folder> -o <file>.mp4 (HTML and GSAP to MP4) and ~/.pi/mobile/tools/bin/ffprobe <file>.mp4. " +
            "A machine the owner set to ask before each command (Settings › Machines) shows the command on a card first, and runs it only when they allow it.",
        parameters: obj({
            machine: str({ description: "The machine's name (or alias) from your environment section" }),
            command: str({ description: "A shell command, run with sh -c (Git Bash's bash on Windows)" }),
            cwd: opt(str({ description: "Folder on the machine; default its home" })),
            timeout: opt(num({ description: "Seconds before it is stopped (default 120, at most 1800)" })),
        }, { open: true }),
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
                // A changed host key (PP-509): the way on, for Pi and for the owner.
                return failed(
                    hostKeyChanged(result.error.message)
                        ? `${machine.alias}: ${result.error.message}. It presents another host key than the one the owner accepted. If the owner knows why (a reinstall, a move to another host), read the new key on the machine itself (its console or guest agent: ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub) and call machine_rekey with it; the owner approves on a card. Or the owner compares and replaces it on its row in Settings › Machines. Otherwise it may be an attack: do not connect.`
                        : `${machine.alias}: ${result.error.message}`,
                );
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
        parameters: obj({
            from: str({ description: "The file: /phone/path, ~/path, or <machine>:<path>" }),
            to: str({ description: "Where to: a file path, or a folder ending in /" }),
        }, { open: true }),
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
        parameters: obj({
            name: str({ description: "The machine's name in pi-phone, like build-box" }),
            address: str({ description: "user@host or user@host:port" }),
            key: str({ description: 'The SSH key to sign in with: a key\'s name or id from Settings › SSH keys, or "new" to make one named after the machine' }),
            expectedFingerprint: opt(str({ description: "The host key's SHA256 fingerprint as read on the machine itself, like SHA256:a1Va..." })),
            reason: str({ description: "Why, in a sentence: shown on the card" }),
        }, { open: true }),
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

    const rekey = defineTool({
        name: "machine_rekey",
        description:
            "Replace a machine's changed SSH host key (after a reinstall, a move to another host, cloud-init making new keys), after the owner approves one card with the old key and the new. Read the new key on the machine itself first, through another channel than ssh (its console, a Proxmox guest agent: ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub), and give it as expectedFingerprint: a scanned key that is not that one is refused, nothing changed. On Approve the machine stays set up when pi-env is there with its hash; otherwise the owner taps Install and connect in Settings › Machines. Owner only.",
        parameters: obj({
            machine: str({ description: "The machine's name, alias or id" }),
            expectedFingerprint: str({ description: "The new host key's SHA256 fingerprint as read on the machine itself, like SHA256:BHtq..." }),
            reason: str({ description: "Why the key changed, in a sentence: shown on the card" }),
        }, { open: true }),
        execute: async (args, api, context) => {
            try {
                const asker = host.requesterOf(Number(api.conversationId) as never);

                if (asker === undefined || host.person(asker).role !== "owner") {
                    return failed("Only the owner replaces a machine's host key.");
                }

                const wanted = args.machine.trim().toLowerCase();
                const store = host.machineStore;
                const alias = host.machines().find((each) => each.alias === wanted)?.id;
                const machine = store.list().find((each) => each.id === args.machine.trim() || each.id === alias || each.name.toLowerCase() === wanted);

                if (machine === undefined) {
                    return failed(`No machine ${args.machine}. Machines: ${store.list().map((each) => each.name).join(", ") || "none"}.`);
                }

                if (machine.team !== undefined) {
                    return failed(`${machine.name} is the team's: its host key is changed on the team server, by someone who manages the team's machines.`);
                }

                if (machine.hostKey === undefined) {
                    return failed(`${machine.name} has no accepted host key to replace: the owner scans and accepts it in Settings › Machines.`);
                }

                const scanned = await store.scan(machine.id);
                const bare = (fingerprint: string) => fingerprint.replace(/\s*\(\w+\)\s*$/, "").replace(/^SHA256:/i, "");
                const expected = args.expectedFingerprint.trim();
                const address = `${machine.user}@${machine.host}${machine.port === undefined ? "" : `:${machine.port}`}`;

                if (scanned.fingerprints.some((each) => bare(each) === bare(machine.hostKey!))) {
                    return failed(`${machine.name} (${address}) presents the key accepted already, ${machine.hostKey}: nothing to replace.`);
                }

                const matched = scanned.fingerprints.find((each) => bare(each) === bare(expected));

                if (matched === undefined) {
                    return failed(
                        `${address} presents ${scanned.fingerprints.join(", ")}, not ${expected}: refused, nothing changed. Read the key on the machine itself again; a key you did not read there may be an attack.`,
                    );
                }

                const answer = await host.approvals.request(
                    {
                        id: `machine_rekey-${String(api.conversationId)}-${String(api.callId)}`,
                        conversationId: Number(api.conversationId) as never,
                        taskId: api.taskId as never,
                        ...(api.callId === undefined ? {} : { callId: api.callId }),
                        tool: "machine_rekey",
                        subject: `Replace ${machine.name}'s host key ${machine.hostKey} with ${matched}`,
                        reason: args.reason,
                        form: { type: "machine-rekey", machine: machine.id, name: machine.name, address, old: machine.hostKey, hostKeys: scanned.fingerprints, expected },
                        createdAt: Date.now(),
                    },
                    context as never,
                );

                if (!answer.allow) {
                    return failed(`${answer.by === "superseded" ? "The request was replaced" : `${answer.by} said no`}: ${machine.name} keeps its old host key.`);
                }

                const { machine: now, kept } = await store.replaceKey(machine.id, scanned.lines, matched);

                return {
                    output: [
                        text(
                            kept
                                ? `Replaced ${machine.name}'s host key with ${matched} and connected again: pi-env ${now.daemon} was there with its hash, nothing installed. machine_run and sessions there work now.`
                                : `Replaced ${machine.name}'s host key with ${matched}. pi-env is not there with this app's hash${machine.remote === undefined ? " (it was not set up)" : ""}: the owner taps Install and connect on its row in Settings › Machines.`,
                        ),
                    ],
                    details: { id: machine.id, hostKey: matched, kept },
                };
            } catch (error) {
                return failed(error instanceof Error ? error.message : String(error));
            }
        },
    });

    /** One tool's state, as Settings › Machines words it. */
    const stateOf = (tool: ToolStatus): string => {
        if (!tool.supported) {
            return tool.windowsOnly ? "for Windows x64 only, for now" : "no build for this machine";
        }

        if (tool.crd !== undefined) {
            return tool.installed === undefined ? `not installed (${tool.size})` : `installed, ${tool.installed}, ${tool.crd}`;
        }

        if (tool.installed !== undefined) {
            return tool.installed === tool.version ? `installed, ${tool.installed} (current)` : `installed, ${tool.installed}; ${tool.version} available (update)`;
        }

        if (tool.own !== undefined) {
            return `the machine's own (${tool.own}), not installed by pi-phone`;
        }

        return `not installed; ${tool.version}, ${tool.size}`;
    };

    const resultLine = (tools: readonly ToolStatus[], result: InstallResult, removing: boolean) => {
        const name = tools.find((each) => each.id === result.id)?.name ?? result.id;

        return result.ok
            ? removing
                ? `${name}: removed.`
                : `${name}: ${result.version} installed; it says: ${result.said || "(nothing)"}`
            : `${name}: failed. ${result.said}`;
    };

    const tools = defineTool({
        name: "machine_tools",
        description:
            "The tools pi-phone installs on the owner's machines (OfficeCLI, rg, fd, Chrome headless, ocu, ffmpeg, HyperFrames, TLC, Chrome Remote Desktop), as Settings › Machines › Install tools shows them. " +
            "status: each tool on a machine (or on every connected machine): installed and at which version, the current version, its size, or the machine's own. " +
            "install, update, remove: the owner approves one card first (the machine, the tools, versions from and to, sizes); Approve runs what Settings › Machines runs (pinned versions, each download checked by its sha256), and the result says each tool's version line, or the step that failed. " +
            "update without tools updates every tool there with a newer version. When status shows an update, offer it to the owner. Owner only.",
        parameters: obj({
            action: union([literal("status"), literal("install"), literal("update"), literal("remove")], { description: "status, install, update, or remove" }),
            machine: opt(str({ description: "The machine's name, alias or id; status without it: every connected machine" })),
            tools: opt(arr(str(), { description: "Tool ids (officecli, rg, fd, chrome, ocu, ffmpeg, hyperframes, tlc, crd); update without them: every tool with an update" })),
            reason: opt(str({ description: "Why, in a sentence: shown on the card" })),
        }, { open: true }),
        execute: async (args, api, context) => {
            try {
                const asker = host.requesterOf(Number(api.conversationId) as never);

                if (asker === undefined || host.person(asker).role !== "owner") {
                    return failed("Only the owner changes or reads the tools on machines.");
                }

                const machineTools = host.machineTools;

                if (args.action === "status") {
                    const machines = args.machine === undefined ? host.machines() : [find(args.machine)];

                    if (machines.length === 0) {
                        return failed("No machine is connected.");
                    }

                    const updates: string[] = [];
                    const blocks = await Promise.all(
                        machines.map(async (machine) => {
                            const remote = host.machineStore.get(machine.id).remote;

                            try {
                                const statuses = await machineTools.status(machine.id);

                                for (const tool of statuses.filter((each) => each.installed !== undefined && each.crd === undefined && each.installed !== each.version)) {
                                    updates.push(`${tool.id} ${tool.installed} → ${tool.version} on ${machine.alias}`);
                                }

                                return [`${machine.alias} (${remote?.platform ?? "?"} ${remote?.arch ?? "?"}):`, ...statuses.map((tool) => `- ${tool.id} (${tool.name}): ${stateOf(tool)}`)].join("\n");
                            } catch (error) {
                                return `${machine.alias}: could not read its tools: ${error instanceof Error ? error.message : String(error)}`;
                            }
                        }),
                    );

                    return {
                        output: [
                            text(
                                [
                                    ...blocks,
                                    updates.length === 0
                                        ? "No updates."
                                        : `Updates: ${updates.join("; ")}. Offer them to the owner: machine_tools update (one card for each machine).`,
                                ].join("\n\n"),
                            ),
                        ],
                        details: { updates } as JsonValue,
                    };
                }

                if (args.machine === undefined) {
                    return failed(`${args.action} needs machine.`);
                }

                const found = find(args.machine);
                const machine = host.machineStore.get(found.id);
                const remote = machine.remote;

                if (remote === undefined) {
                    return failed(`${found.alias} is not connected: connect it in Settings › Machines.`);
                }

                const statuses = await machineTools.status(machine.id);
                const byId = new Map(statuses.map((each) => [each.id, each]));
                const unknown = (args.tools ?? []).filter((id) => !byId.has(id));

                if (unknown.length > 0) {
                    return failed(`No tool ${unknown.join(", ")}. The tools are ${statuses.map((each) => each.id).join(", ")}.`);
                }

                const removing = args.action === "remove";
                const named = [...new Set(args.tools ?? [])];
                const outdated = statuses.filter((each) => each.supported && each.installed !== undefined && each.crd === undefined && each.installed !== each.version);
                const wanted = args.action === "update" && named.length === 0 ? outdated.map((each) => each.id) : named;

                if (wanted.length === 0) {
                    return args.action === "update"
                        ? { output: [text(`Every tool pi-phone installed on ${found.alias} is current: nothing to update.`)] }
                        : failed(`${args.action} needs tools (ids).`);
                }

                // Why each named tool is left out, if it is; the rest go on the card.
                const refusals: string[] = [];
                const now: string[] = [];

                for (const id of wanted) {
                    const tool = byId.get(id)!;

                    if (removing) {
                        if (tool.installed === undefined) {
                            refusals.push(tool.own === undefined ? `${tool.name} is not installed there.` : `${tool.name} there is the machine's own (${tool.own}), not pi-phone's: left alone.`);
                        } else {
                            now.push(id);
                        }

                        continue;
                    }

                    if (!tool.supported) {
                        refusals.push(`${tool.name} has no build for ${found.alias} (${remote.platform} ${remote.arch})${tool.windowsOnly ? ": it is for Windows x64 only, for now" : ""}.`);
                    } else if (tool.installed !== undefined && (tool.installed === tool.version || tool.crd !== undefined)) {
                        refusals.push(`${tool.name} ${tool.installed} is installed there already, the current version.`);
                    } else if (args.action === "update" && tool.installed === undefined) {
                        refusals.push(`${tool.name} is not installed there: install it instead.`);
                    } else if (tool.installed === undefined && tool.own !== undefined && !tool.offered) {
                        refusals.push(`${tool.name}: the machine has its own (${tool.own}), so pi-phone does not install it.`);
                    } else {
                        now.push(id);
                    }
                }

                if (now.length === 0) {
                    return failed(`Nothing to ${args.action} on ${found.alias}: ${refusals.join(" ")}`);
                }

                // What installs, in order: each tool's needs first, unless current there (as Settings › Machines does).
                const order = removing ? now : installOrder(now, statuses, machineTools.catalog);
                const changes: MachineToolChange[] = order.map((id) => {
                    const tool = byId.get(id)!;
                    const neededBy = removing ? statuses.filter((each) => each.installed !== undefined && !now.includes(each.id) && (machineTools.catalog.find((spec) => spec.id === each.id)?.needs ?? []).includes(id)) : [];

                    return {
                        id,
                        name: tool.name,
                        ...(tool.installed === undefined ? {} : { from: tool.installed }),
                        ...(removing ? {} : { to: tool.signer === undefined ? tool.version : `${tool.version} (signed by ${tool.signer.replace(/^CN=/, "")})` }),
                        size: tool.size,
                        ...(now.includes(id) ? {} : { needed: true }),
                        ...(neededBy.length === 0 ? {} : { note: `${neededBy.map((each) => each.name).join(", ")} needs it` }),
                    };
                });
                const verb = removing ? "Remove" : args.action === "update" ? "Update" : "Install";
                const answer = await host.approvals.request(
                    {
                        id: `machine_tools-${String(api.conversationId)}-${String(api.callId)}`,
                        conversationId: Number(api.conversationId) as never,
                        taskId: api.taskId as never,
                        ...(api.callId === undefined ? {} : { callId: api.callId }),
                        tool: "machine_tools",
                        subject: `${verb} on ${found.alias}: ${changes
                            .map((each) => `${each.id} ${removing ? each.from : `${each.from === undefined ? "" : `${each.from} → `}${each.to}`} (${each.size})${each.needed === true ? " [needed]" : ""}`)
                            .join(", ")}`,
                        reason: args.reason ?? `${verb} tools on ${found.alias}`,
                        form: { type: "machine-tools", machine: machine.id, machineName: found.alias, platform: `${remote.platform} ${remote.arch}`, action: args.action, tools: changes },
                        createdAt: Date.now(),
                    },
                    context as never,
                );

                if (!answer.allow) {
                    return failed(`${answer.by === "superseded" ? "The request was replaced" : `${answer.by} said no`}: nothing changed on ${found.alias}.`);
                }

                const done = removing ? await machineTools.remove(machine.id, now) : await machineTools.install(machine.id, now);
                const lines = done.results.map((result) => resultLine(done.tools, result, removing));
                const bad = done.results.some((result) => !result.ok);
                const left = refusals.length === 0 ? [] : [`Left out: ${refusals.join(" ")}`];
                const shown = done.tools.filter((each) => order.includes(each.id)).map((each) => `${each.id}: ${stateOf(each)}`);

                return {
                    output: [text([`On ${found.alias}:`, ...lines, ...left, `Settings › Machines now shows: ${shown.join("; ")}.`].join("\n"))],
                    details: { machine: found.alias, results: done.results.map((result) => ({ id: result.id, ok: result.ok, version: result.version ?? null, said: result.said })) } as JsonValue,
                    ...(bad ? { isError: true } : {}),
                };
            } catch (error) {
                return failed(error instanceof Error ? error.message : String(error));
            }
        },
    });

    return defineExtension({ name: "pocket-machines", tools: [run, copy, add, rekey, tools] });
}
