// A stand-in for one of Chrome's helper processes (PP-329): it writes the profile's cache after the browser process has
// gone, as Chrome's do. It ends 600 ms after a SIGTERM (its group's), or 1.5 s after the browser process has gone, and
// writes a cache file every 50 ms until then. Its pid goes to argv[3].
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [, , profile, pidFile] = process.argv;

if (profile === undefined || pidFile === undefined) {
    process.exit(2);
}

writeFileSync(pidFile, String(process.pid));

const parent = process.ppid;
const cache = join(profile, "Default", "Cache");
let n = 0;
let endAt = Number.POSITIVE_INFINITY;

process.on("SIGTERM", () => {
    endAt = Math.min(endAt, Date.now() + 600);
});

setInterval(() => {
    const gone = (() => {
        try {
            process.kill(parent, 0);

            return false;
        } catch {
            return true;
        }
    })();

    if (gone) {
        endAt = Math.min(endAt, Date.now() + 1500);
    }

    if (Date.now() >= endAt) {
        process.exit(0);
    }

    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, `entry-${n++}`), "cached");
}, 50);
