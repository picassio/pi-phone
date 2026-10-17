/**
 * Sign the app's `gh` and `git` in to GitHub (DESIGN.md section 4). GitHub's device flow with `gh`'s own OAuth app:
 * the owner enters a code at github.com/login/device; the token goes to `gh auth login --with-token`, and
 * `gh auth setup-git` makes git use it for https remotes. Credentials live where `gh` keeps them
 * (`~/.config/gh/hosts.yml`), so the agent's `git` and `gh` use them too.
 */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** `gh`'s OAuth app (cli/cli `internal/authflow`), whose tokens `gh` stores and refreshes as its own. */
const GH_CLIENT_ID = "178c6fc778ccc68e1d6a";
const SCOPES = "repo read:org gist workflow";
const HOST = "github.com";

export type GitHubStatus =
    | { state: "signed-out" }
    | { state: "signed-in"; login: string }
    | {
          state: "waiting";
          userCode: string;
          verificationUri: string;
          expiresAt: number;
      }
    | { state: "failed"; error: string };

type DeviceCode = {
    device_code: string;
    user_code: string;
    verification_uri: string;
    expires_in: number;
    interval: number;
};

async function post(url: string, body: Record<string, string>): Promise<Record<string, unknown>> {
    const response = await fetch(url, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(body).toString(),
    });

    if (!response.ok) {
        throw new Error(`${url}: HTTP ${response.status}`);
    }

    return (await response.json()) as Record<string, unknown>;
}

function withStdin(command: string, args: string[], input: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: ["pipe", "ignore", "pipe"] });
        let stderr = "";

        child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
        child.on("error", reject);
        child.on("close", (code) =>
            code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")}: ${stderr.trim()}`)),
        );
        child.stdin.end(input);
    });
}

export class GitHubLogin {
    #flow: { status: GitHubStatus; cancel: () => void } | undefined;

    /** Who `gh` is signed in as, or the device flow under way. */
    async status(): Promise<GitHubStatus> {
        if (this.#flow !== undefined && this.#flow.status.state !== "signed-in") {
            return this.#flow.status;
        }

        try {
            const { stdout } = await run("gh", ["api", "user", "--jq", ".login"], { timeout: 15_000 });

            return { state: "signed-in", login: stdout.trim() };
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                throw new Error("gh is not installed in this runtime", { cause: error });
            }

            return { state: "signed-out" };
        }
    }

    /** Start the device flow; answers the code to enter. A flow already under way is replaced. */
    async start(): Promise<GitHubStatus> {
        this.#flow?.cancel();
        const code = (await post(`https://${HOST}/login/device/code`, {
            client_id: GH_CLIENT_ID,
            scope: SCOPES,
        })) as unknown as DeviceCode;

        if (typeof code.device_code !== "string") {
            throw new Error(`GitHub did not give a device code: ${JSON.stringify(code)}`);
        }

        let cancelled = false;
        const flow = {
            status: {
                state: "waiting",
                userCode: code.user_code,
                verificationUri: code.verification_uri,
                expiresAt: Date.now() + code.expires_in * 1000,
            } as GitHubStatus,
            cancel: () => {
                cancelled = true;
            },
        };

        this.#flow = flow;
        void this.#poll(code, () => cancelled).then(
            (login) => {
                if (!cancelled) {
                    flow.status = { state: "signed-in", login };
                }
            },
            (error: unknown) => {
                if (!cancelled) {
                    flow.status = { state: "failed", error: (error as Error).message };
                }
            },
        );

        return flow.status;
    }

    cancel(): void {
        this.#flow?.cancel();
        this.#flow = undefined;
    }

    async logout(): Promise<void> {
        this.cancel();
        await run("gh", ["auth", "logout", "--hostname", HOST], { timeout: 15_000 });
    }

    async #poll(code: DeviceCode, cancelled: () => boolean): Promise<string> {
        let interval = code.interval * 1000;
        const until = Date.now() + code.expires_in * 1000;

        while (Date.now() < until) {
            await new Promise((resolve) => setTimeout(resolve, interval));

            if (cancelled()) {
                throw new Error("cancelled");
            }

            const answer = await post(`https://${HOST}/login/oauth/access_token`, {
                client_id: GH_CLIENT_ID,
                device_code: code.device_code,
                grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            });

            if (typeof answer.access_token === "string") {
                await withStdin("gh", ["auth", "login", "--hostname", HOST, "--with-token"], answer.access_token);
                await run("gh", ["auth", "setup-git", "--hostname", HOST], { timeout: 15_000 });
                const { stdout } = await run("gh", ["api", "user", "--jq", ".login"], { timeout: 15_000 });

                return stdout.trim();
            }

            if (answer.error === "slow_down") {
                interval += 5000;
            } else if (answer.error !== "authorization_pending") {
                throw new Error(String(answer.error_description ?? answer.error ?? "GitHub refused the sign-in"));
            }
        }

        throw new Error("The code expired before it was entered. Start again.");
    }
}
