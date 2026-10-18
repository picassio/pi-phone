/**
 * A conversation's folder on this machine, as people reach it through the app: which files a person may load or read,
 * the file viewer, the files for `@` mentions, Changes, its git branch, uploads, and new folders from the folder picker. The
 * operations people call directly check who may do them; the path helpers (`conversationPath`, `conversationFile`,
 * `readableFile`, `uploadDirectory`) leave seeing the conversation to their callers.
 */
import { lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, posix, resolve, sep } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import {
    type Branches,
    branchesIn,
    gitDirOf,
    type GitRunner,
    type Head,
    headByGit,
    headOf,
    isRemoteBranch,
    localName,
    switchBranch,
    validBranchName,
} from "./branches.ts";
import { type Changes, changesIn, diffOf, revertFile } from "./changes.ts";
import type { User } from "./config.ts";
import { describe, HttpError } from "./errors.ts";
import { FileLists, type FileListing, type FileView, listRemoteFiles, viewFile, viewRemoteFile } from "./files.ts";
import { type FolderAccess, localAccess, remoteAccess } from "./folder-access.ts";
import { sniffImage } from "./http/assets.ts";
import type { Machine } from "./machines.ts";
import { displayPath, expandHome } from "./paths.ts";
import { isRemote, parsePlace } from "./places.ts";

/** The largest image the viewer shows from a machine: it travels over the link whole. */
const MAX_REMOTE_IMAGE = 20 * 1024 * 1024;

/** How long the branch a machine's folder has checked out is taken as known before git there is asked again. */
const REMOTE_HEAD_MS = 15_000;
/** The largest file the viewer downloads to the device. */
const MAX_DOWNLOAD = 200 * 1024 * 1024;

export class Workspace {
    readonly #app: PocketApp;

    constructor(app: PocketApp) {
        this.#app = app;
    }

    /** The files in each folder, for `@` mentions. */
    readonly #files = new FileLists();

    /**
     * The looks at what a conversation's folder changed that are under way, per reach (its folder only, or its
     * repository). Every tab that shows a session asks (the top bar's count), often together as Pi moves on; those that
     * ask while a look is under way share it, as each reads the whole history for Pi's edits and runs git. One asked
     * after it ends looks again, so what it says is never older than the question.
     */
    readonly #changesUnderWay = new Map<string, Promise<Changes>>();

    /**
     * Where each folder's repository keeps its files, for a minute: views ask on every update. A folder in none is
     * asked about again after a few seconds, so one Pi has just run `git init` in shows its branch soon.
     */
    readonly #gitDirs = new Map<string, { gitDir: string | undefined; at: number }>();

    #gitDir(cwd: string): string | undefined {
        // A machine's folder is not on this disk: its branch shows in Changes, read there (`folder-access.ts`).
        if (isRemote(cwd)) {
            return undefined;
        }

        const known = this.#gitDirs.get(cwd);

        if (
            known !== undefined &&
            Date.now() - known.at < (known.gitDir === undefined ? 5000 : 60_000)
        ) {
            return known.gitDir;
        }

        const gitDir = gitDirOf(cwd);

        this.#gitDirs.set(cwd, { gitDir, at: Date.now() });

        return gitDir;
    }

    /** Whether a folder is in a git repository. */
    inRepository(cwd: string): boolean {
        return this.#gitDir(cwd) !== undefined;
    }

    /** On a machine: what each folder had checked out when git there last said, and when it was asked. */
    readonly #remoteHeads = new Map<string, { head: Head | undefined; at: number; asking: boolean }>();

    /**
     * What a conversation's folder has checked out, for its view: its repository's HEAD file, read as it is now. On a
     * machine, what git there said last; asked again when that is older than `REMOTE_HEAD_MS`, and the view updates
     * when the answer differs.
     */
    head(id: ConversationId): Head | undefined {
        const cwd = this.#app.cwdOf(id);

        if (isRemote(cwd)) {
            return this.#remoteHead(id, cwd);
        }

        const gitDir = this.#gitDir(cwd);

        return gitDir === undefined ? undefined : headOf(gitDir);
    }

    #remoteHead(id: ConversationId, cwd: string): Head | undefined {
        const known = this.#remoteHeads.get(cwd) ?? { head: undefined, at: 0, asking: false };

        this.#remoteHeads.set(cwd, known);

        if (!known.asking && Date.now() - known.at > REMOTE_HEAD_MS) {
            known.asking = true;
            const remote = this.#remote(id)!;

            void headByGit((folder, args) => remote.access.git(folder, args, { timeoutMs: 15_000 }), remote.cwd)
                .catch(() => undefined)
                .then((head) => {
                    const changed = JSON.stringify(head) !== JSON.stringify(known.head);

                    known.head = head;
                    known.at = Date.now();
                    known.asking = false;

                    if (changed) {
                        this.#app.refreshView(id);
                    }
                });
        }

        return known.head;
    }

    /** Git in a session's folder: here, or on its machine. */
    #git(id: ConversationId): { cwd: string; run: GitRunner | undefined } {
        const remote = this.#remote(id);

        return remote === undefined
            ? { cwd: this.#app.cwdOf(id), run: undefined }
            : { cwd: remote.cwd, run: (folder, args) => remote.access.git(folder, args, { timeoutMs: 15_000 }) };
    }

    /** The branches of a session's repository, for the branch sheet: for people who can steer, as Changes is. */
    async branches(id: ConversationId, user: User): Promise<Branches> {
        this.#app.requireSee(user, id);
        this.#app.requireSteer(user);

        const { cwd, run } = this.#git(id);
        const inRepository =
            run === undefined
                ? this.#gitDir(cwd) !== undefined
                : await run(cwd, ["rev-parse", "--git-dir"]).then(
                      () => true,
                      () => false,
                  );

        if (!inRepository) {
            throw new HttpError(404, "This session's folder is not in a git repository.");
        }

        return branchesIn(cwd, run).catch((error: unknown) => {
            throw new HttpError(409, describe(error));
        });
    }

    /**
     * Switch a session's folder to another branch: one there already, a new one from what is checked out (`create`),
     * or a new one following a remote branch (`track`). It changes the files under Pi, so as with moving the session to
     * another folder it takes the right to drive, someone not invited to one session only, and Pi not working; Pi is
     * told with its next message.
     */
    async switchBranch(
        id: ConversationId,
        user: User,
        request: { name?: unknown; create?: unknown; track?: unknown },
    ): Promise<{ branch: string }> {
        this.#app.requireSee(user, id);
        this.#app.requireSteer(user);

        if (user.sessions !== undefined) {
            throw new HttpError(403, "You were invited to one session.");
        }

        await this.#app.requireDriver(id, user);

        const track = typeof request.track === "string" ? request.track : undefined;
        const name =
            typeof request.name === "string" ? request.name.trim() : track && localName(track);
        const { cwd, run } = this.#git(id);

        if (track !== undefined && !(await isRemoteBranch(cwd, track, run))) {
            throw new HttpError(400, `${track} is not a remote branch here.`);
        }

        if (!name || !(await validBranchName(cwd, name, run))) {
            throw new HttpError(400, `${name ? `“${name}”` : "That"} cannot be a branch name.`);
        }

        if (this.#app.isBusy(id)) {
            throw new HttpError(
                409,
                "Pi is working here: wait for it, or stop it, before switching branches.",
            );
        }

        const before = this.head(id);

        await switchBranch(
            cwd,
            {
                name,
                create: request.create === true,
                ...(track ? { track } : {}),
            },
            run,
        ).catch((error: unknown) => {
            throw new HttpError(409, describe(error));
        });
        // On a machine the chip shows what git there says now.
        this.#remoteHeads.delete(this.#app.cwdOf(id));
        this.#app.refreshView(id);
        const from = before !== undefined && "branch" in before ? ` from ${before.branch}` : "";
        const what =
            request.create === true || track !== undefined
                ? `made the branch ${name}${track ? `, following ${track},` : ""} and switched to it${from}`
                : `switched the branch${from} to ${name}`;

        await this.#app.commands.note(id, user, what);
        await this.#app.collab.activity(id, user, what);

        return { branch: name };
    }

    /** A folder to work in, as its whole path: a 404 when it is not there, so the folder picker can offer to make it. */
    /**
     * What still reads the phone's files directly: on a machine (`places.ts`), it says so instead of failing on a path
     * that is not here. Each goes through the machine's environment in turn (DESIGN.md).
     */
    #localOnly(id: ConversationId, what: string): void {
        const machine = this.#app.places.machineOf(this.#app.cwdOf(id));

        if (machine !== undefined) {
            throw new HttpError(501, `${what} is not available yet for a session on a machine (${machine.name}). Ask Pi: its tools run there.`);
        }
    }

    /** A session's folder on a machine, with its environment; undefined for one on the phone. */
    #remote(id: ConversationId) {
        const cwd = this.#app.cwdOf(id);

        if (!isRemote(cwd)) {
            return undefined;
        }

        const place = parsePlace(cwd);
        const machine: Machine = this.#app.machines.ready(place.machineId!);
        const env = this.#app.places.env(cwd);

        return { cwd: place.path, machine, env, access: remoteAccess(env) };
    }

    /** The folder Changes looks in, and how it reaches it: here, or on the session's machine. */
    #folder(id: ConversationId): { cwd: string; access: FolderAccess } {
        const remote = this.#remote(id);

        return remote === undefined ? { cwd: this.#app.cwdOf(id), access: localAccess } : remote;
    }

    /**
     * A path on the session's machine as the session means it: absolute, `~/…` (the machine's home), or relative to its
     * folder. Someone invited to one session gets only files under that folder, by path (the machine's links are not
     * resolved from here).
     */
    #remotePath(remote: NonNullable<ReturnType<Workspace["remoteOf"]>>, user: User, path: string): string {
        // The panel names its folders as places (`machine:<id>:<path>`): one on this session's machine only.
        const place = parsePlace(path.trim());

        if (place.machineId !== undefined && place.machineId !== remote.machine.id) {
            throw new HttpError(404, `${path} is not on this session's machine.`);
        }

        const written = place.path;
        const home = remote.machine.remote!.home;
        const expanded = written === "~" ? home : written.startsWith("~/") ? `${home}${written.slice(1)}` : written;
        const file = posix.resolve(remote.cwd, expanded);

        if (user.sessions !== undefined && file !== remote.cwd && !file.startsWith(`${remote.cwd}/`)) {
            throw new HttpError(404, "Image not found");
        }

        return file;
    }

    /**
     * Copy files the person uploaded on the phone (`uploadDirectory`) to the session's machine, under
     * `~/.pi/mobile/uploads/<id>/`, so Pi's tools there read them: each one's path there, in order. Nothing to do in a
     * session on the phone. Fails, with the machine's reason, when one cannot be written.
     */
    async placeUploads(id: ConversationId, paths: readonly string[]): Promise<string[]> {
        const remote = this.#remote(id);

        if (remote === undefined || paths.length === 0) {
            return [...paths];
        }

        const folder = `${remote.machine.remote!.home}/.pi/mobile/uploads/${String(id)}`;
        const made = await remote.env.createDir(folder, { recursive: true }, BACKGROUND_CONTEXT);

        if (!made.ok) {
            throw new HttpError(502, `Could not make ${folder} on ${remote.machine.name}: ${made.error.message}`);
        }

        const placed: string[] = [];

        for (const path of paths) {
            const target = `${folder}/${basename(path)}`;
            const written = await remote.env.writeFile(target, await readFile(path), BACKGROUND_CONTEXT);

            if (!written.ok) {
                throw new HttpError(502, `Could not copy ${basename(path)} to ${remote.machine.name}: ${written.error.message}`);
            }

            placed.push(target);
        }

        return placed;
    }

    /** Whether `path` is a file the person uploaded to this session on the phone. */
    isUpload(id: ConversationId, path: string): boolean {
        return resolve(path).startsWith(join(this.#app.dataDir, "uploads", String(id)) + sep);
    }

    /** `#remote` for the routes that need it. */
    remoteOf(id: ConversationId) {
        return this.#remote(id);
    }

    /** An image on the session's machine, read through its environment, for the image route. */
    async remoteImage(user: User, id: ConversationId, path: string): Promise<{ data: Buffer; type: string } | undefined> {
        const remote = this.#remote(id);

        if (remote === undefined) {
            return undefined;
        }

        const file = this.#remotePath(remote, user, path);
        const info = await remote.env.fileInfo(file, BACKGROUND_CONTEXT);

        if (!info.ok || info.value.kind !== "file") {
            throw new HttpError(404, "Image not found");
        }

        if (info.value.size > MAX_REMOTE_IMAGE) {
            throw new HttpError(413, "This image is too large to show from the machine.");
        }

        const bytes = await remote.env.readBinaryFile(file, BACKGROUND_CONTEXT);

        if (!bytes.ok) {
            throw new HttpError(404, "Image not found");
        }

        const data = Buffer.from(bytes.value);
        const type = sniffImage(data.subarray(0, 1024));

        if (type === undefined) {
            throw new HttpError(415, "Only image files can be shown");
        }

        return { data, type };
    }

    /** A place to work: a folder here (`checkDirectory`), or one on a machine, checked there (`places.ts`). */
    checkPlace(cwd: string): Promise<string> {
        return isRemote(cwd)
            ? this.#app.places.checkDirectory(cwd, BACKGROUND_CONTEXT)
            : Promise.resolve(this.checkDirectory(cwd));
    }

    checkDirectory(path: string): string {
        const absolute = resolve(expandHome(path.trim() === "" ? "~" : path.trim()));
        let found;

        try {
            found = statSync(absolute);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;

            if (code === "ENOTDIR") {
                throw new HttpError(400, `${absolute} is inside a file, not a folder.`);
            }

            if (code === "ELOOP") {
                throw new HttpError(400, `${absolute} is a link to nothing.`);
            }

            if (code !== "ENOENT") {
                throw new HttpError(400, `Could not open ${absolute}: ${describe(error)}`);
            }

            // Not there, unless it is a link to nowhere: that cannot be made a folder either.
            throw lstatSync(absolute, { throwIfNoEntry: false }) === undefined
                ? new HttpError(404, `${absolute} isn't there.`)
                : new HttpError(400, `${absolute} is a link to nothing.`);
        }

        if (!found.isDirectory()) {
            throw new HttpError(400, `${absolute} is a file, not a folder.`);
        }

        return absolute;
    }

    /**
     * Make a folder to start a session in or move one to, with any folders missing above it, for someone who may browse
     * folders (`/api/fs`): who can steer, and was not invited to one session. A folder already there is fine: it is the
     * one asked for. Returns its path.
     */
    async makePlace(user: User, cwd: string): Promise<string> {
        if (!isRemote(cwd)) {
            return this.makeFolder(user, cwd);
        }

        this.#app.requireSteer(user);

        if (user.sessions !== undefined) {
            throw new HttpError(403, "You were invited to one session.");
        }

        // On a machine: made through its environment (with the folders above it), then checked as any folder there.
        const place = parsePlace(cwd);
        const machine = this.#app.machines.ready(place.machineId!);
        const env = this.#app.places.env(cwd);
        const made = await env.createDir(place.path, { recursive: true }, BACKGROUND_CONTEXT);

        if (!made.ok) {
            throw new HttpError(502, `Could not make ${place.path} on ${machine.name}: ${made.error.message}`);
        }

        return this.checkPlace(cwd);
    }

    makeFolder(user: User, path: string): string {
        this.#app.requireSteer(user);

        if (user.sessions !== undefined) {
            throw new HttpError(403, "You were invited to one session.");
        }

        const written = path.trim();

        if (written === "" || written.includes("\0")) {
            throw new HttpError(400, "Name the folder to make.");
        }

        const expanded = expandHome(written);

        if (!isAbsolute(expanded)) {
            throw new HttpError(400, "Give the folder's whole path, from / or ~.");
        }

        const absolute = resolve(expanded);

        try {
            mkdirSync(absolute, { recursive: true });
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;

            // A file in the way, or a link that leads nowhere (or in a loop): the path cannot be a folder.
            throw new HttpError(
                409,
                code === "EEXIST" || code === "ENOTDIR"
                    ? `${absolute} is a file, or inside one.`
                    : code === "ENOENT" || code === "ELOOP"
                      ? `${absolute} is a broken link, or inside one.`
                      : `Could not make ${absolute}: ${describe(error)}`,
            );
        }

        // Made, or a folder already: either way it must be a folder now.
        return this.checkDirectory(absolute);
    }

    /** A path as a conversation means it: absolute, `~/…`, or relative to the conversation's working directory. */
    conversationPath(id: ConversationId, path: string): string {
        return resolve(this.#app.cwdOf(id), expandHome(path.trim()));
    }

    /**
     * A file a person may load through a conversation. People who can steer reach the whole machine through Pi anyway;
     * viewers and people invited to one session get only files under the conversation's folder or its uploads.
     */
    conversationFile(user: User, id: ConversationId, path: string): string {
        this.#localOnly(id, "Loading files");
        const file = this.conversationPath(id, path);

        if (user.role !== "viewer" && user.sessions === undefined) {
            return file;
        }

        const real = (target: string) => {
            try {
                return realpathSync(target);
            } catch {
                return undefined;
            }
        };

        const target = real(file);
        const cwd = this.#app.cwdOf(id);
        // A fork shows the messages it inherited, with the files attached to them in the sessions it came from. Their
        // later uploads are in the same folders, but an upload's name has random bits in it and shows only in its
        // message, so nobody who cannot read that message can name the file.
        const uploads = this.#lineage(id).map((each) =>
            join(this.#app.dataDir, "uploads", String(each)),
        );
        const roots = [cwd, ...uploads]
            .map(real)
            .filter((root): root is string => root !== undefined);

        if (
            target === undefined ||
            !roots.some((root) => target === root || target.startsWith(root + sep))
        ) {
            throw new HttpError(404, "Image not found");
        }

        return target;
    }

    /**
     * A file a person may read whole through a session: the viewer, and files sent along with a message. As
     * `conversationFile`, but Pi's own folder (sign-ins, settings) and this app's data (people, tokens, the database)
     * are the owner's alone. Uploads, worktrees, and PiP's clones (`repos/`), which sessions use, are not kept back.
     */
    readableFile(user: User, id: ConversationId, path: string): string {
        this.#localOnly(id, "Reading files");
        const file = this.conversationFile(user, id, path);

        if (user.role === "owner") {
            return file;
        }

        const real = (target: string) => {
            try {
                return realpathSync(target);
            } catch {
                return resolve(target);
            }
        };

        const target = real(file);
        const inside = (root: string) => target === root || target.startsWith(root + sep);
        const data = real(this.#app.dataDir);

        if (
            inside(real(getAgentDir())) ||
            (inside(data) &&
                !inside(join(data, "uploads")) &&
                !inside(join(data, "worktrees")) &&
                !inside(join(data, "repos")))
        ) {
            throw new HttpError(404, "Not found");
        }

        return file;
    }

    /** This session and the sessions it was forked from, nearest first. */
    #lineage(id: ConversationId): ConversationId[] {
        const lineage = [id];

        for (
            let meta = this.#app.sessionMeta(id);
            meta?.forkedFrom !== undefined && lineage.length < 64;
        ) {
            const parent = meta.forkedFrom.id as unknown as ConversationId;

            if (lineage.includes(parent)) {
                break;
            }

            lineage.push(parent);
            meta = this.#app.sessionMeta(parent);
        }

        return lineage;
    }

    /**
     * The files in a conversation's folder, for `@` mentions in the message box: for people who can write to Pi. It lists
     * names under the folder only, so someone invited to one session sees no more than `conversationFile` lets them load.
     */
    async fileList(id: ConversationId, user: User): Promise<FileListing> {
        this.#app.requireSee(user, id);
        this.#app.requireSteer(user);
        await this.#app.conversation(id);
        const remote = this.#remote(id);

        return remote === undefined
            ? this.#files.get(this.#app.cwdOf(id))
            : this.#files.get(this.#app.cwdOf(id), () => listRemoteFiles(remote.env, remote.cwd));
    }

    /**
     * A file or folder for the viewer, as a person who can steer may load it through the session (`conversationFile`):
     * its text, or that it is an image, a folder's entries, or binary.
     */
    async viewFile(
        id: ConversationId,
        user: User,
        path: string,
    ): Promise<{ path: string; display: string } & FileView> {
        this.#app.requireSee(user, id);
        this.#app.requireSteer(user);
        await this.#app.conversation(id);
        let file: string;
        const remote = this.#remote(id);

        if (remote !== undefined) {
            file = this.#remotePath(remote, user, path);

            try {
                return { path: file, display: displayPath(file, remote.cwd), ...(await viewRemoteFile(remote.env, file)) };
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                    throw new HttpError(404, `${path} is not there.`);
                }

                throw new HttpError(409, describe(error));
            }
        }

        try {
            file = this.readableFile(user, id, path);

            return {
                path: file,
                display: displayPath(file, this.#app.cwdOf(id)),
                ...(await viewFile(file)),
            };
        } catch (error) {
            if (error instanceof HttpError || (error as NodeJS.ErrnoException).code === "ENOENT") {
                throw new HttpError(404, `${path} is not there.`);
            }

            throw new HttpError(409, describe(error));
        }
    }

    /**
     * A file to save on the device (the viewer's Download): its name and bytes, from here or the session's machine, as
     * the viewer may read it. Whole files up to `MAX_DOWNLOAD`.
     */
    async downloadFile(id: ConversationId, user: User, path: string): Promise<{ name: string; data: Buffer }> {
        this.#app.requireSee(user, id);
        this.#app.requireSteer(user);
        await this.#app.conversation(id);
        const remote = this.#remote(id);
        const tooLarge = () => new HttpError(413, `Files up to ${MAX_DOWNLOAD / 1024 / 1024} MB can be downloaded.`);

        if (remote !== undefined) {
            const file = this.#remotePath(remote, user, path);
            const info = await remote.env.fileInfo(file, BACKGROUND_CONTEXT);

            if (!info.ok || info.value.kind !== "file") {
                throw new HttpError(404, `${path} is not a file there.`);
            }

            if (info.value.size > MAX_DOWNLOAD) {
                throw tooLarge();
            }

            const bytes = await remote.env.readBinaryFile(file, BACKGROUND_CONTEXT);

            if (!bytes.ok) {
                throw new HttpError(502, `Could not read ${path} on ${remote.machine.name}: ${bytes.error.message}`);
            }

            return { name: posix.basename(file), data: Buffer.from(bytes.value) };
        }

        let file: string;

        try {
            file = this.readableFile(user, id, path);
        } catch {
            throw new HttpError(404, `${path} is not there.`);
        }

        const info = statSync(file, { throwIfNoEntry: false });

        if (info === undefined || !info.isFile()) {
            throw new HttpError(404, `${path} is not a file.`);
        }

        if (info.size > MAX_DOWNLOAD) {
            throw tooLarge();
        }

        return { name: basename(file), data: await readFile(file) };
    }

    /**
     * A file uploaded into the session's folder (the Files panel's upload): into `dir`, the folder or one under it,
     * here or on its machine. Never written over: a name already there is refused, by name.
     */
    async putFile(id: ConversationId, user: User, dir: string, name: string, data: Buffer): Promise<{ path: string }> {
        this.#app.requireSee(user, id);
        this.#app.requireSteer(user);
        await this.#app.conversation(id);
        const remote = this.#remote(id);
        const root = remote === undefined ? this.#app.cwdOf(id) : remote.cwd;
        // A folder of the panel's: a place on the machine (`machine:<id>:<path>`), or a path.
        const folder = posix.resolve(root, parsePlace(dir).path);

        if (folder !== root && !folder.startsWith(`${root}/`)) {
            throw new HttpError(400, "Files go into the session's folder, or a folder in it.");
        }

        const path = `${folder}/${name}`;

        if (remote === undefined) {
            try {
                await writeFile(path, data, { flag: "wx", mode: 0o644 });
            } catch (error) {
                throw new HttpError(
                    (error as NodeJS.ErrnoException).code === "EEXIST" ? 409 : 400,
                    (error as NodeJS.ErrnoException).code === "EEXIST" ? `There is already a ${name} there.` : describe(error),
                );
            }
        } else {
            const there = await remote.env.fileInfo(path, BACKGROUND_CONTEXT);

            if (there.ok) {
                throw new HttpError(409, `There is already a ${name} there.`);
            }

            const written = await remote.env.writeFile(path, data, BACKGROUND_CONTEXT);

            if (!written.ok) {
                throw new HttpError(502, `Could not write ${name} on ${remote.machine.name}: ${written.error.message}`);
            }
        }

        // The panel and the @ menu list it at once.
        this.#files.forget(this.#app.cwdOf(id));

        return { path };
    }

    /**
     * Undo the uncommitted changes to one file of a session's repository. It changes files under Pi, so it takes the
     * right to drive and waits until Pi is not working; Pi is told, with its next message.
     */
    async revertChange(id: ConversationId, user: User, path: string): Promise<void> {
        this.#app.requireSee(user, id);
        await this.#app.requireDriver(id, user);

        if (this.#app.isBusy(id)) {
            throw new HttpError(
                409,
                "Pi is working here: wait for it, or stop it, before undoing a file.",
            );
        }

        const folder = this.#folder(id);
        const kind = await revertFile(folder.cwd, path, user.sessions !== undefined, folder.access).catch(
            (error: unknown) => {
                throw new HttpError(409, describe(error));
            },
        );
        const what =
            kind === "new" || kind === "added"
                ? `deleted ${path}, which was new since the last commit`
                : `undid the uncommitted changes to ${path}`;

        this.#forgetChanges(id);
        await this.#app.commands.note(id, user, what);
        await this.#app.collab.activity(id, user, what);
    }

    /** What changed in a session's folder: Pi's edits, and the uncommitted changes of its git repository. */
    async changes(id: ConversationId, user: User): Promise<Changes> {
        this.#app.requireSee(user, id);
        this.#app.requireSteer(user);

        // Someone invited to this session only sees the files in its folder, here as in `conversationFile`.
        const onlyHere = user.sessions !== undefined;
        const key = `${id}:${onlyHere}`;
        const underWay = this.#changesUnderWay.get(key);

        if (underWay !== undefined) {
            return underWay;
        }

        const folder = this.#folder(id);
        const pending = (async () =>
            changesIn(folder.cwd, await this.#app.transcripts.allEntries(id, false), onlyHere, folder.access))().finally(() => {
            if (this.#changesUnderWay.get(key) === pending) {
                this.#changesUnderWay.delete(key);
            }
        });

        this.#changesUnderWay.set(key, pending);

        return pending;
    }

    /** Looks under way began before a file was undone: one asked from now on looks again. */
    #forgetChanges(id: ConversationId): void {
        this.#changesUnderWay.delete(`${id}:true`);
        this.#changesUnderWay.delete(`${id}:false`);
    }

    /** The diff of one changed file in a session's repository. */
    async changeDiff(id: ConversationId, user: User, path: string): Promise<string> {
        this.#app.requireSee(user, id);
        this.#app.requireSteer(user);
        const folder = this.#folder(id);

        try {
            return await diffOf(folder.cwd, path, user.sessions !== undefined, folder.access);
        } catch (error) {
            throw new HttpError(404, describe(error));
        }
    }

    uploadDirectory(id: ConversationId): string {
        const directory = join(this.#app.dataDir, "uploads", String(id));

        mkdirSync(directory, { recursive: true });

        return directory;
    }
}
