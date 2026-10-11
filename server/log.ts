// Worker logging. pi spawns workers with stdio ignored, so console output goes to `<dataDir>/logs/worker.log`,
// one line per entry with time and pid. The server process keeps its own stdout.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { format } from "node:util";

export function redirectConsoleToFile(dataDir: string, name: string): string {
	const dir = join(dataDir, "logs");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const path = join(dir, `${name}.log`);
	const write = (level: string, args: unknown[]): void => {
		appendFileSync(path, `${new Date().toISOString()} ${process.pid} ${level} ${format(...args)}\n`);
	};
	console.log = (...args: unknown[]) => write("info", args);
	console.info = console.log;
	console.warn = (...args: unknown[]) => write("warn", args);
	console.error = (...args: unknown[]) => write("error", args);
	process.on("uncaughtException", (error) => {
		write("fatal", [error instanceof Error ? (error.stack ?? error.message) : String(error)]);
		process.exit(1);
	});
	process.on("unhandledRejection", (reason) => {
		write("fatal", ["unhandled rejection", reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)]);
		process.exit(1);
	});
	return path;
}
