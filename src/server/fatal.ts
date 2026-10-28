/**
 * The server's last words: an exception nothing caught is written to the log with its stack, under a line that starts
 * with "FATAL" (the phone's failure screen shows it as the last error: MainActivity's status page), and the process
 * exits with 1, as Node would. The write is synchronous, so it is in server.log before the process ends (PP-198: a
 * phone's "server exited with code 1" with no cause in view).
 */
import { writeSync } from "node:fs";

/** The text logged for an uncaught `error`: one FATAL line, then its stack and causes. */
export function fatalText(error: unknown, origin: string, now = new Date()): string {
    const what = origin === "unhandledRejection" ? "an unhandled rejection" : "an uncaught exception";
    const describe = (value: unknown): string => {
        if (!(value instanceof Error)) {
            return String(value);
        }

        const own = value.stack ?? `${value.name}: ${value.message}`;

        return value.cause === undefined ? own : `${own}\nCaused by: ${describe(value.cause)}`;
    };

    return `FATAL ${now.toISOString()}: pi-phone stopped on ${what}:\n${describe(error)}\n`;
}

/** Log every uncaught exception (`fatalText`) to stderr, then exit with 1. */
export function installFatalLog(write: (text: string) => void = (text) => void writeSync(2, text), exit: (code: number) => void = (code) => process.exit(code)): void {
    process.on("uncaughtException", (error, origin) => {
        try {
            write(fatalText(error, origin));
        } finally {
            exit(1);
        }
    });
}
