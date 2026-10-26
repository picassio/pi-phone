/**
 * Installing a drop-in extension (PP-173; the owner's decisions of 2026-10-26). On the phone the drop-in folder
 * (`<data>/extensions`) is in the app's private storage, where file apps cannot reach and Pi's tools are refused, so a
 * module comes in through the app: a file or zip uploaded in Settings › Extensions, or `extension_install`, which asks
 * the owner on a card first. Both read what is given into a `DropInPackage` here, with the same checks, and
 * `PocketApp.installDropIn` writes it, switched off.
 *
 * What a package holds: one module file `<name>.ts` at its top, and what belongs to it: files beside it named
 * `<name>.<anything>` (its browser part, `<name>.js`), and a folder `<name>/`. A zip, or a folder, whose top is one
 * folder alone is read from inside that folder. Anything else at the top (a LICENSE, a README, tests' config) is left out
 * and said so: drop-ins share one folder. Refused: a path that is absolute or has `..`, a symbolic link, more than
 * `MAX_DROP_IN_BYTES` in all, an encrypted or zip64 archive.
 */
import { lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { crc32, inflateRawSync } from "node:zlib";
import { HttpError } from "./errors.ts";

/** The most a drop-in may hold, in all (and the largest upload). */
export const MAX_DROP_IN_BYTES = 5 * 1024 * 1024;
/** The most files it may hold. */
const MAX_FILES = 1000;
/** A module's name: its file's without `.ts`. No dots: `<name>.<anything>` is what belongs to it. */
const MODULE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export type DropInFile = { path: string; data: Buffer };

export interface DropInPackage {
    /** The module's file, `<name>.ts`. */
    readonly module: string;
    /** What is installed, the module file among them, paths relative to the drop-in folder. */
    readonly files: readonly DropInFile[];
    /** What was given but is not installed (top-level names; a folder ends in `/`). */
    readonly leftOut: readonly string[];
    /** The bytes of `files`. */
    readonly bytes: number;
}

/** A path inside a package: relative, with no `..`, `.`, empty part, backslash, drive or NUL. Throws otherwise. */
export function checkPath(path: string): string {
    const parts = path.split("/");

    if (
        path === "" ||
        path.startsWith("/") ||
        path.includes("\\") ||
        path.includes("\0") ||
        /^[A-Za-z]:/.test(path) ||
        parts.some((part) => part === "" || part === "." || part === "..")
    ) {
        throw new HttpError(400, `${JSON.stringify(path.slice(0, 200))} is not a path inside the extension: no absolute paths and no ..`);
    }

    return path;
}

/** The files of a zip archive (stored or deflated), each checked; directories are left out. */
export function readZip(zip: Buffer): DropInFile[] {
    if (zip.length > MAX_DROP_IN_BYTES) {
        throw new HttpError(413, "The extension is larger than 5 MB.");
    }

    // The end of the central directory: 22 bytes and a comment of up to 64 KB, at the end.
    let end = -1;

    for (let at = zip.length - 22; at >= Math.max(0, zip.length - 22 - 65_535); at--) {
        if (zip.readUInt32LE(at) === 0x06054b50) {
            end = at;
            break;
        }
    }

    if (end < 0) {
        throw new HttpError(400, "This is not a zip file.");
    }

    const count = zip.readUInt16LE(end + 10);
    let at = zip.readUInt32LE(end + 16);

    if (count === 0xffff || at === 0xffffffff) {
        throw new HttpError(400, "Zip64 archives are not read: make a plain zip.");
    }

    if (count > MAX_FILES) {
        throw new HttpError(400, "The extension has more than 1000 files.");
    }

    const files: DropInFile[] = [];
    let total = 0;

    for (let index = 0; index < count; index++) {
        if (at + 46 > zip.length || zip.readUInt32LE(at) !== 0x02014b50) {
            throw new HttpError(400, "The zip file is damaged.");
        }

        const madeBy = zip.readUInt16LE(at + 4);
        const flags = zip.readUInt16LE(at + 8);
        const method = zip.readUInt16LE(at + 10);
        const crc = zip.readUInt32LE(at + 16);
        const packed = zip.readUInt32LE(at + 20);
        const size = zip.readUInt32LE(at + 24);
        const nameLength = zip.readUInt16LE(at + 28);
        const skip = nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
        const mode = zip.readUInt32LE(at + 38) >>> 16;
        const local = zip.readUInt32LE(at + 42);
        const name = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");

        at += 46 + skip;

        // Made on Unix (or macOS), the mode says what the entry is: a link is never followed nor made.
        if ((madeBy >> 8 === 3 || madeBy >> 8 === 19) && (mode & 0o170000) === 0o120000) {
            throw new HttpError(400, `${JSON.stringify(name.slice(0, 200))} is a symbolic link: extensions hold none.`);
        }

        if (name.endsWith("/")) {
            checkPath(name.slice(0, -1));
            continue;
        }

        checkPath(name);

        if ((flags & 1) !== 0) {
            throw new HttpError(400, "Encrypted zip files are not read.");
        }

        if (method !== 0 && method !== 8) {
            throw new HttpError(400, `${JSON.stringify(name.slice(0, 200))} is compressed in a way that is not read: use deflate.`);
        }

        total += size;

        if (total > MAX_DROP_IN_BYTES) {
            throw new HttpError(413, "The extension is larger than 5 MB.");
        }

        if (local + 30 > zip.length || zip.readUInt32LE(local) !== 0x04034b50) {
            throw new HttpError(400, "The zip file is damaged.");
        }

        const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
        const raw = zip.subarray(start, start + packed);
        const data = method === 0 ? Buffer.from(raw) : inflateRawSync(raw, { maxOutputLength: MAX_DROP_IN_BYTES });

        if (data.length !== size || crc32(data) !== crc) {
            throw new HttpError(400, "The zip file is damaged.");
        }

        files.push({ path: name, data });
    }

    return files;
}

/** The files under a folder, each checked: no symbolic links, and at most `MAX_DROP_IN_BYTES` in all. */
function readFolder(folder: string): DropInFile[] {
    const files: DropInFile[] = [];
    let total = 0;

    const walk = (relative: string) => {
        for (const name of readdirSync(join(folder, relative)).sort()) {
            const path = relative === "" ? name : `${relative}/${name}`;
            const stat = lstatSync(join(folder, path));

            if (stat.isSymbolicLink()) {
                throw new HttpError(400, `${path} is a symbolic link: extensions hold none.`);
            }

            if (stat.isDirectory()) {
                walk(path);
            } else if (stat.isFile()) {
                total += stat.size;

                if (total > MAX_DROP_IN_BYTES) {
                    throw new HttpError(413, "The extension is larger than 5 MB.");
                }

                if (files.length >= MAX_FILES) {
                    throw new HttpError(400, "The extension has more than 1000 files.");
                }

                files.push({ path: checkPath(path), data: readFileSync(join(folder, path)) });
            }
        }
    };

    walk("");

    return files;
}

/** A package from a set of files: its one module file at the top, and what belongs to it. */
export function shapePackage(given: readonly DropInFile[]): DropInPackage {
    let files = given;
    const tops = new Set(files.map((file) => file.path.split("/")[0]!));

    // One folder alone at the top (a zipped folder): its inside is the package.
    if (tops.size === 1 && files.every((file) => file.path.includes("/"))) {
        const [wrapper] = tops;

        files = files.map((file) => ({ ...file, path: file.path.slice(wrapper!.length + 1) }));
    }

    const modules = files
        .map((file) => file.path)
        .filter((path) => !path.includes("/") && path.endsWith(".ts") && !path.endsWith(".test.ts") && !path.endsWith(".d.ts") && !path.startsWith("_"));

    if (modules.length === 0) {
        throw new HttpError(400, "It holds no module: a drop-in is one .ts file at its top (with, if it needs them, a folder of the same name).");
    }

    if (modules.length > 1) {
        throw new HttpError(400, `It holds ${modules.length} modules (${modules.join(", ")}): install one at a time.`);
    }

    const module = modules[0]!;
    const name = module.slice(0, -".ts".length);

    if (!MODULE_NAME.test(name)) {
        throw new HttpError(400, `${module} is not a module's name: letters, digits, _ and -, starting with a letter or digit.`);
    }

    const belongs = (path: string) => path === module || (!path.includes("/") && path.startsWith(`${name}.`)) || path.startsWith(`${name}/`);
    const kept = files.filter((file) => belongs(file.path));
    const leftOut = [...new Set(files.filter((file) => !belongs(file.path)).map((file) => (file.path.includes("/") ? `${file.path.split("/")[0]}/` : file.path)))].sort();

    return {
        module,
        // The module file last: by the time it is there, what it imports is.
        files: [...kept.filter((file) => file.path !== module), ...kept.filter((file) => file.path === module)],
        leftOut,
        bytes: kept.reduce((sum, file) => sum + file.data.length, 0),
    };
}

/** A package from an uploaded file: a module (`.ts`) or a zip. */
export function packageFromUpload(name: string, data: Buffer): DropInPackage {
    const file = basename(name);

    if (data.length > MAX_DROP_IN_BYTES) {
        throw new HttpError(413, "The extension is larger than 5 MB.");
    }

    if (file.endsWith(".zip")) {
        return shapePackage(readZip(data));
    }

    if (file.endsWith(".ts")) {
        return shapePackage([{ path: checkPath(file), data }]);
    }

    if (file.endsWith(".js")) {
        throw new HttpError(400, "A drop-in's module is a .ts file; a .js file beside it is its browser part. Put both in a .zip.");
    }

    throw new HttpError(400, "Give a module (.ts) or a .zip that holds one.");
}

/** A package from a path on this phone: a module (`.ts`), a zip, or a folder. */
export function packageFromPath(path: string): DropInPackage {
    let stat: ReturnType<typeof lstatSync>;

    try {
        stat = lstatSync(path);
    } catch {
        throw new HttpError(404, `There is nothing at ${path}.`);
    }

    if (stat.isSymbolicLink()) {
        throw new HttpError(400, `${path} is a symbolic link: give the file or folder itself.`);
    }

    if (stat.isDirectory()) {
        return shapePackage(readFolder(path));
    }

    if (stat.size > MAX_DROP_IN_BYTES) {
        throw new HttpError(413, "The extension is larger than 5 MB.");
    }

    return packageFromUpload(basename(path), readFileSync(path));
}

/** What a package would take the place of in the drop-in folder: its module's file, folder, and files named for it. */
export function replacedBy(pkg: DropInPackage, folder: string): string[] {
    const name = pkg.module.slice(0, -".ts".length);
    let present: string[];

    try {
        present = readdirSync(folder);
    } catch {
        return [];
    }

    // Another module's file (`<name>.other.ts`, put there by hand) is its own, not this one's.
    return present
        .filter((entry) => entry === name || entry === pkg.module || (entry.startsWith(`${name}.`) && (!entry.endsWith(".ts") || entry.endsWith(".test.ts") || entry.endsWith(".d.ts"))))
        .map((entry) => (lstatSync(join(folder, entry)).isDirectory() ? `${entry}/` : entry))
        .sort();
}

/** Write a package into the drop-in folder, after taking away what it replaces. */
export function writePackage(pkg: DropInPackage, folder: string): void {
    for (const entry of replacedBy(pkg, folder)) {
        rmSync(join(folder, entry), { recursive: true, force: true });
    }

    for (const file of pkg.files) {
        const target = join(folder, file.path);

        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, file.data);
    }
}

/** The first lines of a package's module, for the card that asks the owner. */
export function moduleHead(pkg: DropInPackage, lines = 40): string {
    const text = pkg.files.find((file) => file.path === pkg.module)?.data.toString("utf8") ?? "";

    return text.split("\n").slice(0, lines).join("\n");
}
