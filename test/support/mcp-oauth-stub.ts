// An MCP server behind OAuth for the MCP tests (PP-530): one HTTP server that is the protected resource (`/mcp`,
// Streamable HTTP, JSON answers; 401 with a resource metadata challenge without a valid token) and its authorization
// server (metadata, dynamic client registration, `/authorize` that redirects at once with a code, `/token` for the
// code and for refreshes). Access tokens are `at-<n>-<TAIL>`, refresh tokens `rt-<n>-<TAIL>`; `expire()` makes the current access
// token refused, so the client must refresh. It counts the token requests by grant.
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export type OAuthStub = {
    base: string;
    url: string;
    /** Refuse every access token given so far. */
    expire(): void;
    seen: { grants: Record<string, number>; registrations: number; authorizes: number; mcpTokens: string[] };
    close(): Promise<void>;
};

const read = (request: IncomingMessage) =>
    new Promise<string>((resolve) => {
        let text = "";

        request.on("data", (chunk) => (text += chunk));
        request.on("end", () => resolve(text));
    });

/** Tokens as long as real ones, so they are hidden from outputs as a token is. */
export const TAIL = "0123456789abcdef";

export async function startOAuthStub(): Promise<OAuthStub> {
    const seen = { grants: {} as Record<string, number>, registrations: 0, authorizes: 0, mcpTokens: [] as string[] };
    const codes = new Map<string, { challenge: string; redirect: string }>();
    const valid = new Set<string>();
    const refreshes = new Set<string>();
    const sessions = new Set<string>();
    let tokens = 0;
    let base = "";
    const json = (response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
        response.writeHead(status, { "content-type": "application/json", ...headers });
        response.end(JSON.stringify(body));
    };
    const issue = () => {
        tokens += 1;
        valid.add(`at-${tokens}-${TAIL}`);
        refreshes.add(`rt-${tokens}-${TAIL}`);

        return { access_token: `at-${tokens}-${TAIL}`, refresh_token: `rt-${tokens}-${TAIL}`, token_type: "Bearer", expires_in: 3600 };
    };
    const server: Server = createServer(async (request, response) => {
        const url = new URL(request.url ?? "/", base);

        if (url.pathname === "/.well-known/oauth-protected-resource/mcp" || url.pathname === "/.well-known/oauth-protected-resource") {
            return json(response, 200, { resource: `${base}/mcp`, authorization_servers: [base] });
        }

        if (url.pathname === "/.well-known/oauth-authorization-server") {
            return json(response, 200, {
                issuer: base,
                authorization_endpoint: `${base}/authorize`,
                token_endpoint: `${base}/token`,
                registration_endpoint: `${base}/register`,
                response_types_supported: ["code"],
                grant_types_supported: ["authorization_code", "refresh_token"],
                code_challenge_methods_supported: ["S256"],
                token_endpoint_auth_methods_supported: ["none"],
            });
        }

        if (url.pathname === "/register" && request.method === "POST") {
            seen.registrations += 1;
            const metadata = JSON.parse(await read(request)) as Record<string, unknown>;

            return json(response, 201, { ...metadata, client_id: `client-${seen.registrations}`, token_endpoint_auth_method: "none" });
        }

        if (url.pathname === "/authorize") {
            seen.authorizes += 1;
            const code = `code-${seen.authorizes}`;
            const redirect = url.searchParams.get("redirect_uri")!;

            codes.set(code, { challenge: url.searchParams.get("code_challenge")!, redirect });
            response.writeHead(302, { location: `${redirect}?code=${code}&state=${encodeURIComponent(url.searchParams.get("state")!)}&iss=${encodeURIComponent(base)}` });
            response.end();

            return;
        }

        if (url.pathname === "/token" && request.method === "POST") {
            const form = new URLSearchParams(await read(request));
            const grant = form.get("grant_type") ?? "";

            seen.grants[grant] = (seen.grants[grant] ?? 0) + 1;

            if (grant === "authorization_code") {
                const code = codes.get(form.get("code") ?? "");
                const verifier = form.get("code_verifier") ?? "";

                if (code === undefined || createHash("sha256").update(verifier).digest("base64url") !== code.challenge || form.get("redirect_uri") !== code.redirect) {
                    return json(response, 400, { error: "invalid_grant" });
                }

                codes.delete(form.get("code")!);

                return json(response, 200, issue());
            }

            if (grant === "refresh_token" && refreshes.delete(form.get("refresh_token") ?? "")) {
                return json(response, 200, issue());
            }

            return json(response, 400, { error: "invalid_grant" });
        }

        if (url.pathname === "/mcp") {
            const token = (request.headers.authorization ?? "").replace(/^Bearer /, "");

            seen.mcpTokens.push(token);

            if (!valid.has(token)) {
                response.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` });
                response.end();

                return;
            }

            if (request.method !== "POST") {
                response.writeHead(request.method === "DELETE" ? 200 : 405).end();

                return;
            }

            const message = JSON.parse(await read(request)) as { id?: number; method: string; params?: { arguments?: { message?: string } } };

            if (message.method === "initialize") {
                const id = `s-${sessions.size + 1}`;

                sessions.add(id);

                return json(response, 200, { jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "oauth-stub", version: "1" } } }, { "mcp-session-id": id });
            }

            if (message.id === undefined) {
                response.writeHead(202).end();

                return;
            }

            if (message.method === "tools/list") {
                return json(response, 200, { jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "whoami", description: "Who the token is.", inputSchema: { type: "object" } }] } });
            }

            return json(response, 200, { jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: `token ${token}` }] } });
        }

        response.writeHead(404).end();
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    return {
        base,
        url: `${base}/mcp`,
        expire: () => valid.clear(),
        seen,
        close: () =>
            new Promise<void>((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
            }),
    };
}
