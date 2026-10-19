/**
 * Paths on a machine, as its system spells them (DESIGN.md section 4): POSIX on Linux, macOS and Termux; on Windows,
 * drive paths written with forward slashes (`C:/Users/tuan/project`). Windows takes `/` as well as `\`, and with `/`
 * the app's places, the web's path joins, and Git Bash (Pi's shell there) all read them the same way. What a Windows
 * daemon answers with `\` is turned to `/` here, once, so a place is spelled one way only.
 */
import { posix, win32 } from "node:path";

/** What a machine's paths depend on: its system, as `Machine.remote` holds it. */
export type PathSystem = { platform: string } | undefined;

export type MachinePaths = {
    readonly windows: boolean;
    /** The path in this machine's one spelling: on Windows, `\` as `/`. */
    normal(path: string): string;
    isAbsolute(path: string): boolean;
    resolve(...paths: string[]): string;
    join(...paths: string[]): string;
    dirname(path: string): string;
    basename(path: string): string;
    /** Whether `path` is `root` or inside it (on Windows, letters in either case). */
    within(root: string, path: string): boolean;
    /** `~` and `~/…` (or `~\…`) from `home`; other paths as written. */
    expandHome(path: string, home: string): string;
    /** On Windows, a path from `/` (no drive: Windows reads it on the current one) on `home`'s drive; others as they are. */
    onDrive(path: string, home: string): string;
};

const slashes = (path: string) => path.replaceAll("\\", "/");

const POSIX: MachinePaths = {
    windows: false,
    normal: (path) => path,
    isAbsolute: (path) => posix.isAbsolute(path),
    resolve: (...paths) => posix.resolve(...paths),
    join: (...paths) => posix.join(...paths),
    dirname: (path) => posix.dirname(path),
    basename: (path) => posix.basename(path),
    within: (root, path) => path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`),
    expandHome: (path, home) => (path === "~" ? home : path.startsWith("~/") ? `${home}${path.slice(1)}` : path),
    onDrive: (path) => path,
};

const WINDOWS: MachinePaths = {
    windows: true,
    normal: slashes,
    // A drive path (`C:/…`) or a share (`//server/share`); `/x` alone is on the current drive, not absolute.
    isAbsolute: (path) => /^[a-zA-Z]:[\\/]/.test(path) || /^[\\/]{2}[^\\/]/.test(path),
    resolve: (...paths) => slashes(win32.resolve(...paths)),
    join: (...paths) => slashes(win32.join(...paths)),
    dirname: (path) => slashes(win32.dirname(path)),
    basename: (path) => win32.basename(path),
    within: (root, path) => {
        const [r, p] = [slashes(root).toLowerCase(), slashes(path).toLowerCase()];

        return p === r || p.startsWith(r.endsWith("/") ? r : `${r}/`);
    },
    expandHome: (path, home) => (path === "~" ? home : /^~[\\/]/.test(path) ? `${home}/${slashes(path.slice(2))}` : path),
    onDrive: (path, home) => (/^[\\/](?![\\/])/.test(path) && /^[a-zA-Z]:/.test(home) ? `${home.slice(0, 2)}${slashes(path)}` : path),
};

/** The paths of a machine with this system; POSIX until it is known. */
export function machinePaths(system: PathSystem): MachinePaths {
    return system?.platform === "windows" ? WINDOWS : POSIX;
}
