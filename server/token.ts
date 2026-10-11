// The connection token: a random secret in the data directory that every WebSocket and HTTP request must carry.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const TOKEN_FILE = "token";
const TOKEN_BYTES = 32;

/** Read the token, creating it on first start. */
export async function loadToken(dataDir: string): Promise<string> {
	await mkdir(dataDir, { recursive: true, mode: 0o700 });
	const path = join(dataDir, TOKEN_FILE);
	try {
		const existing = (await readFile(path, "utf8")).trim();
		if (!/^[a-f0-9]{64}$/.test(existing)) throw new Error(`Invalid token in ${path}; delete it to generate a new one`);
		return existing;
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
	}
	const token = randomBytes(TOKEN_BYTES).toString("hex");
	await writeFile(path, `${token}\n`, { mode: 0o600, flag: "wx" });
	return token;
}

export function tokenMatches(expected: string, presented: string | null | undefined): boolean {
	if (typeof presented !== "string" || presented.length !== expected.length) return false;
	return timingSafeEqual(Buffer.from(expected), Buffer.from(presented));
}
