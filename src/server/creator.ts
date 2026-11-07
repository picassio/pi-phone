/**
 * The Creator flow (PP-369; the owner's decisions of 2026-11-03): Pi makes a drop-in for this app with a subagent, and
 * the owner decides each step on a card. Part of the Extension builder extension (`extensions/extension-builder.ts`), so
 * it is off with it. Adapted from DeepSeek Harness's background Creator (MIT, `third_party/deepseek-harness/`).
 *
 * 1. `extension_create` (name, title, brief, places): a card first, "Make a drop-in: <title>", with what it will be and
 *    where it shows, Make it or Not now. It gets the same rights as any drop-in, and stays off until the owner switches
 *    it on (the card says so).
 * 2. Make it: the session's subagent `made-<name>` (the subagents' model setting, as any) writes it in
 *    `<session folder>/.made/made-<name>/` with the extension-builder skill, and ends its answer with
 *    `READY made-<name>: <note>` (or `NOT READY …: <why>`). Its report comes back to Pi as any subagent's does.
 * 3. `extension_made install`: reads that last line, checks the folder without running its code (`checkMade`), and
 *    installs it through the install card (the same as `extension_install`'s): it lands switched off, and its files are
 *    kept as a version (`made-drop-ins.ts`).
 * 4. The owner switches it on (the progress card's Switch it on, Settings › Extensions, or `setting_change`); Pi looks at
 *    it in the live app with `screenshot` at 390, 1280 and 1920 px, has the subagent fix what it saw (each fix a new version
 *    through the same card), and says `extension_made checked`.
 * 5. Keep ends the flow; Undo (back to the previous version, or removed from the first) and Restore (a kept version)
 *    ask on a card when Pi asks, and are the owner's buttons on the progress card and in Settings › Extensions.
 *
 * The progress card is the web's (`web/made-card.js`), under the `extension_create` call: it reads `GET
 * /api/x/extension-builder/made/<name>`, and hears `made` events as the state changes.
 */
import { arr, num, obj, opt, str, union } from "@earendil-works/pi-schema";
import { literal } from "./tool-schema.ts";
import { defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { moduleHead } from "./drop-in-install.ts";
import { BUILDER_SKILL } from "./extension-builder.ts";
import type { ExtensionWeb, PocketHost } from "./host.ts";
import {
    checkMade,
    MADE_MAX_FILES,
    MADE_PLACES,
    type MadeDropIns,
    type MadeHands,
    madeModule,
    madeName,
    type MadeState,
    nameProblem,
    parseReady,
} from "./made-drop-ins.ts";

const reply = (text: string, isError = false, details?: Record<string, string | number>) => ({
    output: [{ type: "text" as const, text }],
    ...(isError ? { isError: true } : {}),
    ...(details === undefined ? {} : { details }),
});
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** What the subagent is asked: everything it needs, as it does not see this conversation. */
export function subagentTask(state: MadeState, next: boolean): string {
    const module = state.module;

    return [
        next
            ? `Change the pi-phone drop-in ${module} ("${state.title}") in ${state.folder}: the folder holds the version installed now.`
            : `Make the pi-phone drop-in ${module} ("${state.title}") in ${state.folder}.`,
        "",
        `What it ${next ? "should become" : "is"}: ${state.brief}`,
        `Where it shows: ${state.places.join(", ")}.`,
        "",
        `Read the extension-builder skill (${join(BUILDER_SKILL, "SKILL.md")} and its references) and start from its closest template. Write it in ${state.folder} only: ${module}.ts at the top, with ${module}.js or a folder ${module}/ for its browser part, nothing else (at most 1 MB and ${MADE_MAX_FILES} files). Its tools, if any, are named ${module.replaceAll("-", "_")}_<verb>. Keep it small: one screen, one or two tools.`,
        `Check it until it says ok: node ${join(BUILDER_SKILL, "scripts", "check.mjs")} ${state.folder}`,
        "Do not install it, switch it on, or write in the app's data folder: the session that asked does that, after the owner's cards.",
        "",
        "End your answer with exactly one last line:",
        `READY ${module}: <one line saying what this version is>`,
        "or, if you could not make it work:",
        `NOT READY ${module}: <why>`,
    ].join("\n");
}

type Asker = { id: string; name: string; role: string };

export function createCreator(host: PocketHost, web: ExtensionWeb, made: () => MadeDropIns) {
    const personOf = (conversationId: unknown): Asker => {
        const id = host.requesterOf(Number(conversationId) as never);

        if (id === undefined) {
            throw new Error("No one Pi works for here is signed in to pi-phone.");
        }

        return host.person(id);
    };
    const ownerOf = (conversationId: unknown, tool: string): Asker => {
        const asker = personOf(conversationId);

        if (asker.role !== "owner") {
            throw new Error(`${tool} is the owner's: a drop-in runs in the app with everything it has. Ask the owner.`);
        }

        return asker;
    };
    const hands = (userId: string): MadeHands => ({
        install: async (pkg) => {
            await host.dropIns.install(userId, pkg, true, { creator: true });
        },
        remove: async (file) => {
            await host.dropIns.remove(userId, file);
        },
    });
    /**
     * A state as it stands: a made drop-in removed some other way (Settings › Extensions' Remove, `app_action
     * extensions.remove`, PP-372) has nothing installed; its versions stay, to restore.
     */
    const fresh = (state: MadeState): MadeState => {
        if (state.current !== null && !host.extensionModules.list().some((each) => each.file === `${state.module}.ts`)) {
            state.current = null;
            state.phase = "removed";
            made().save(state);
        }

        return state;
    };
    /** A state as the card shows it: with whether it is switched on now. */
    const view = (state: MadeState) => ({ ...state, enabled: state.current !== null && host.dropIns.enabled(`${state.module}.ts`) });
    const changed = (state: MadeState) => {
        web.send("made", view(state));

        return state;
    };
    const stateOf = (given: string): MadeState => {
        const name = madeName(given);
        const state = made().get(name);

        if (state === undefined) {
            throw new Error(`Pi made no drop-in ${madeModule(name)}: start one with extension_create.`);
        }

        return fresh(state);
    };
    const card = async (api: ToolExecutionApi, context: unknown, tool: string, subject: string, reason: string) =>
        host.approvals.request(
            {
                id: `${tool}-${String(api.taskId)}-${String(api.callId)}`,
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

    // ─── The owner's buttons: the progress card's and Settings › Extensions' (`web/made-card.js`) ───

    const answer = (run: () => Promise<MadeState> | MadeState) =>
        Promise.resolve()
            .then(run)
            .then(
                (state) => ({ made: view(changed(state)) }),
                (error: unknown) => {
                    throw web.error(400, message(error));
                },
            );

    web.route("GET", "made", () => ({ made: made().list().map(fresh).map(view) }));
    web.route("GET", "made/:name", (request) => answer(() => stateOf(request.params.name ?? "")));
    web.route("POST", "made/:name/keep", (request) =>
        answer(() => {
            const state = stateOf(request.params.name ?? "");

            state.phase = "kept";

            return made().save(state);
        }),
    );
    web.route("POST", "made/:name/undo", (request) => answer(() => made().undo(stateOf(request.params.name ?? ""), hands(request.user.id))));
    web.route("POST", "made/:name/restore", (request) =>
        answer(() => made().restore(stateOf(request.params.name ?? ""), Number(request.body.version), hands(request.user.id))),
    );

    // ─── Pi's tools: the same operations, each change of the app on the owner's card ───

    const next = (existing: MadeState | undefined) => (existing === undefined ? "it" : "its next version");

    const create = defineTool({
        name: "extension_create",
        description:
            "Make a drop-in extension for this app with a subagent (the Creator flow). The owner first sees a card (Make it / Not now) with its name made-<name>, what it will be and where it shows. On Make it, a subagent of this session writes it in .made/made-<name>/ under this session's folder with the extension-builder skill, and its report ends READY made-<name>. Then call extension_made install. The same name again makes its next version (the subagent changes it). It gets the same rights as any drop-in and stays off until the owner switches it on.",
        parameters: obj({
            name: str({ description: "Its name after made-: lowercase letters, digits and hyphens, like pomodoro" }),
            title: str({ description: "Its title in a few words, like Pomodoro" }),
            brief: str({ description: "One paragraph: what it will be and do, and where it shows; for a next version, what changes" }),
            places: arr(union(MADE_PLACES.map((place) => literal(place))), {
                description: "Where it shows: tool (a tool for Pi), rail, page, sheet, menu, launcher, dock, overlay, panelTab, sessionMenu, theme",
            }),
        }, { open: true }),
        execute: async (args, api, context) => {
            try {
                ownerOf(api.conversationId, "extension_create");

                const cwd = (await api.agent(context)).cwd ?? host.home;

                if (cwd.startsWith("machine:")) {
                    return reply("Drop-ins are made from a session on this phone: its subagent writes it there, and the install copies it from there.", true);
                }

                if (host.extensionModules.dropInFolder() === undefined) {
                    return reply("This pi-phone has no drop-in folder.", true);
                }

                const name = madeName(args.name);
                const module = madeModule(name);
                const existing = made().get(name);
                const files = [...host.extensionModules.list().map((each) => each.file), ...host.extensionModules.nameClashes().map((each) => each.file)];
                const problem = nameProblem(name, files, existing !== undefined);
                const title = args.title.trim().slice(0, 60);
                const brief = args.brief.trim().slice(0, 1500);
                const places = [...new Set(args.places as string[])];

                if (problem !== undefined) {
                    return reply(problem, true);
                }

                if (title === "" || brief === "" || places.length === 0) {
                    return reply("Give it a title, a brief (what it will be and where it shows), and at least one place.", true);
                }

                if (existing?.phase === "writing") {
                    return reply(`${module} is being written now: wait for its subagent's report, then call extension_made install.`, true);
                }

                const decision = await host.approvals.request(
                    {
                        id: `extension-create-${String(api.taskId)}-${String(api.callId)}`,
                        conversationId: Number(api.conversationId) as never,
                        taskId: api.taskId as never,
                        ...(api.callId === undefined ? {} : { callId: api.callId }),
                        tool: "extension_create",
                        subject: module,
                        reason: `Make a drop-in: ${title}`,
                        form: { type: "creator", module, title, brief, places, next: existing !== undefined },
                        createdAt: Date.now(),
                    },
                    context,
                );

                if (!decision.allow) {
                    return reply(`${decision.by === "superseded" ? "The card was replaced" : `${decision.by} said not now`}: nothing was made.`);
                }

                const folder = join(cwd, ".made", module);
                const store = made();

                mkdirSync(folder, { recursive: true });

                // A next version starts from the one installed now, should its folder be gone.
                if (existing !== undefined && existing.current !== null && !existsSync(join(folder, `${module}.ts`))) {
                    for (const file of store.version(existing, existing.current).files) {
                        mkdirSync(dirname(join(folder, file.path)), { recursive: true });
                        writeFileSync(join(folder, file.path), file.data);
                    }
                }

                const now = Date.now();
                const state = changed(
                    store.save({
                        ...(existing ?? { name, module, versions: [], current: null, createdAt: now, updatedAt: now }),
                        title,
                        brief,
                        places,
                        session: Number(api.conversationId),
                        folder,
                        phase: "writing",
                        build: { n: Math.max(0, ...(existing?.versions ?? []).map((version) => version.n)) + 1 },
                    }),
                );
                const task = subagentTask(state, existing !== undefined);
                let started = await api.executeTool("subagent", { action: existing?.subagent === undefined ? "spawn" : "send", name: module, message: task }, context);

                // A subagent by that name from before (its record kept in this session): it gets the work.
                if (!started.isError && typeof started.structuredOutput === "string" && started.structuredOutput.includes("already exists")) {
                    started = await api.executeTool("subagent", { action: "send", name: module, message: task }, context, { key: "send" });
                }

                const child = (started.details as { conversationId?: unknown } | undefined)?.conversationId;

                if (started.isError || typeof child !== "number") {
                    const why = typeof started.structuredOutput === "string" ? started.structuredOutput : started.diagnostics.map((each) => each.message).join("; ");

                    state.phase = "failed";
                    state.build.failed = `its subagent did not start: ${why || "the subagent tool is off (Settings › Extensions › Subagents)"}`;
                    changed(store.save(state));

                    return reply(`${module}: ${state.build.failed}`, true, { module, name });
                }

                state.subagent = { name: module, conversationId: child };
                changed(store.save(state));

                return reply(
                    `The subagent ${module} is writing ${next(existing)} in ${folder}. Its report comes back to you; when it ends "READY ${module}", call extension_made with action install and name ${name} (it checks it, and installs it on the owner's card, switched off). If it says NOT READY, tell the owner why.`,
                    false,
                    { module, name },
                );
            } catch (error) {
                return reply(message(error), true);
            }
        },
    });

    const madeTool = defineTool({
        name: "extension_made",
        description:
            "The next steps of a drop-in made with extension_create (made-<name>). install: once its subagent's report ends READY, check it (without running its code) and install it on the owner's card, switched off, keeping the version; checked: you looked at it switched on in the live app with screenshot at 390, 1280 and 1920 px, with a one-line note; keep: the owner keeps it (ends the flow); undo: back to the previous version, or remove it if it is the first (owner's card); restore: install a kept version (owner's card); list: the drop-ins made, with their versions.",
        parameters: obj({
            action: union([literal("install"), literal("checked"), literal("keep"), literal("undo"), literal("restore"), literal("list")]),
            name: opt(str({ description: "Its name, like pomodoro or made-pomodoro" })),
            note: opt(str({ description: "checked: what you saw, in one line" })),
            version: opt(num({ description: "restore: the version's number" })),
        }, { open: true }),
        execute: async (args, api, context) => {
            try {
                const store = made();

                if (args.action === "list") {
                    const all = store.list().map(fresh);

                    return reply(
                        all.length === 0
                            ? "Pi made no drop-ins here yet."
                            : all
                                  .map(
                                      (state) =>
                                          `${state.module} (${state.title}): ${state.phase}${state.current === null ? ", none installed" : `, version ${state.current} installed, ${host.dropIns.enabled(`${state.module}.ts`) ? "on" : "off"}`}; versions: ${state.versions.map((version) => `${version.n} (${new Date(version.at).toISOString().slice(0, 16)}, ${version.note})`).join("; ") || "none"}`,
                                  )
                                  .join("\n"),
                    );
                }

                const asker = ownerOf(api.conversationId, "extension_made");

                if (args.name === undefined) {
                    return reply(`${args.action} needs the drop-in's name.`, true);
                }

                const state = stateOf(args.name);
                const module = state.module;

                if (args.action === "install") {
                    if (state.subagent === undefined) {
                        return reply(`${module} has no subagent: make it with extension_create.`, true);
                    }

                    const said = parseReady(await host.lastAnswer(state.subagent.conversationId, true), module);

                    if (said === undefined) {
                        return reply(`${module}'s subagent has not said "READY ${module}: …" or "NOT READY ${module}: …" in its last answer: wait for its report, or send it a message to finish.`, true);
                    }

                    if (!said.ready) {
                        state.phase = "failed";
                        state.build.failed = said.note;
                        changed(store.save(state));

                        return reply(`${module} is not ready: ${said.note}. Tell the owner.`, true);
                    }

                    state.build.written = { at: Date.now(), note: said.note };

                    const { checks, pkg } = checkMade(state.folder, state.name, host.extensionModules.builtInToolNames());

                    state.build.checks = checks;

                    if (pkg === undefined) {
                        state.phase = "refused";
                        changed(store.save(state));

                        return reply(
                            `${module} did not pass the checks:\n${checks.problems.map((problem) => `- ${problem}`).join("\n")}\nSend these to its subagent (subagent send, name ${module}) to fix, and call install again after its next READY.`,
                            true,
                        );
                    }

                    changed(store.save(state));

                    const decision = await host.approvals.request(
                        {
                            id: `extension-made-${String(api.taskId)}-${String(api.callId)}`,
                            conversationId: Number(api.conversationId) as never,
                            taskId: api.taskId as never,
                            ...(api.callId === undefined ? {} : { callId: api.callId }),
                            tool: "extension_made",
                            subject: state.folder,
                            reason: `Install the drop-in ${pkg.module}`,
                            form: {
                                type: "extension",
                                path: state.folder,
                                module: pkg.module,
                                bytes: pkg.bytes,
                                files: pkg.files.map((file) => file.path),
                                leftOut: [...pkg.leftOut],
                                replaces: host.dropIns.replaces(pkg),
                                head: moduleHead(pkg),
                            },
                            createdAt: Date.now(),
                        },
                        context,
                    );

                    if (!decision.allow) {
                        state.phase = "declined";
                        changed(store.save(state));

                        return reply(`${decision.by === "superseded" ? "The card was replaced" : `${decision.by} declined`}: ${module} was not installed.`, true);
                    }

                    await hands(asker.id).install(pkg);

                    const version = store.keep(state, pkg, said.note);

                    state.current = version.n;
                    state.phase = "installed";
                    state.build.installed = { at: Date.now() };
                    delete state.build.checked;
                    changed(store.save(state));

                    return reply(
                        `Installed ${module} version ${version.n}, switched off. The owner switches it on (the progress card's Switch it on, Settings › Extensions, or setting_change extensions.${module}.ts on). Then look at it with screenshot at 390, 1280 and 1920 px (extension_inspect ${module} gives its page and sheet links), have its subagent fix what is wrong (then install again: a new version), and call extension_made checked with a one-line note when it works.`,
                    );
                }

                if (args.action === "checked") {
                    if (state.current === null || !host.dropIns.enabled(`${module}.ts`)) {
                        return reply(`${module} is not switched on: the owner switches it on first, then look at it.`, true);
                    }

                    state.build.checked = { at: Date.now(), note: (args.note ?? "").trim().slice(0, 200) };
                    state.phase = "checked";
                    changed(store.save(state));

                    return reply(`${module} version ${state.current} is checked. The owner keeps it, undoes it, or restores another version on its card.`);
                }

                if (args.action === "keep") {
                    state.phase = "kept";
                    changed(store.save(state));

                    return reply(`${module} is kept: the flow ended. Its versions stay (Settings › Extensions).`);
                }

                if (args.action === "undo") {
                    const previous = state.current === null ? undefined : store.previous(state);
                    const what = state.current === null ? "" : previous === undefined ? `remove it (version ${state.current} is its first; its versions stay)` : `back to version ${previous}`;

                    if (state.current === null) {
                        return reply(`${module} is not installed now: restore one of its versions instead.`, true);
                    }

                    const decision = await card(api, context, "extension_made", `Undo ${module}: ${what}`, `Undo ${module}`);

                    if (!decision.allow) {
                        return reply(`${decision.by} said no: ${module} stays at version ${state.current}.`, true);
                    }

                    const after = changed(await store.undo(state, hands(asker.id)));

                    return reply(after.current === null ? `${module} is removed; its versions are kept, to restore.` : `${module} is back at version ${after.current}, switched off.`);
                }

                const wanted = Number(args.version);

                if (!state.versions.some((version) => version.n === wanted)) {
                    return reply(`${module} has no version ${String(args.version)}: it has ${state.versions.map((version) => version.n).join(", ") || "none"}.`, true);
                }

                const decision = await card(api, context, "extension_made", `Restore ${module} version ${wanted}`, `Restore ${module} to version ${wanted}, switched off`);

                if (!decision.allow) {
                    return reply(`${decision.by} said no: ${module} stays as it is.`, true);
                }

                changed(await store.restore(state, wanted, hands(asker.id)));

                return reply(`${module} is at version ${wanted}, switched off: the owner switches it on.`);
            } catch (error) {
                return reply(message(error), true);
            }
        },
    });

    return [create, madeTool];
}
