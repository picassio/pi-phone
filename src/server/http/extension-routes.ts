/**
 * What extension modules add to the app over HTTP: `/api/x/:module/…`, the routes a module registered (after the API's
 * sign-in, and with the `X-Pocket` header on every method), and `/x/:module/:rev/…`, the files of its browser module.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PocketApp } from "../app.ts";
import type { User } from "../config.ts";
import { describe, HttpError } from "../errors.ts";
import { exposedError, MAX_FILE_BYTES } from "../extension-web.ts";
import { type ApiRequest, json, readChecked, readJson, send, SVG_CSP } from "./io.ts";

/** A request to a module's route: `parts` is the path after `/api/x/`. */
export async function extensionRoute(
    { app, request, response, url, user }: ApiRequest,
    parts: string[],
): Promise<void> {
    // First, on a GET too: the sign-in cookie goes along with a link from another site, and a module's GET may change
    // things. The app's own calls always send the header. Before the route is looked up, so such a request learns
    // nothing of the routes.
    if (request.headers["x-pocket"] !== "1") {
        throw new HttpError(403, "Missing X-Pocket header");
    }

    const [module, ...path] = parts;
    const method = request.method ?? "GET";
    // Only routes this person may use: one they may not is not there for them (404), and its methods are not told.
    const match = module === undefined ? undefined : app.webs.match(module, method, path, user);

    if (match === undefined) {
        throw new HttpError(404, "Unknown extension route");
    }

    if ("allow" in match) {
        response.setHeader("allow", match.allow.join(", "));

        throw new HttpError(405, `That route takes ${match.allow.join(", ")}`);
    }

    const { route, part, params } = match;

    // The path was decoded before it was split, so `..%2F` is a part `..`: a handler that makes a file's path of a
    // part must never get one that leads elsewhere.
    if (
        Object.values(params).some(
            (value) =>
                value === "." || value === ".." || value.includes("\\") || value.includes("\0"),
        )
    ) {
        throw new HttpError(400, "Bad path");
    }

    const body =
        method === "GET" || method === "DELETE"
            ? {}
            : await readJson<Record<string, unknown>>(request, route.maxBytes);
    const stopped = new AbortController();

    // The browser went away before the answer: the handler may stop.
    response.on("close", () => {
        if (!response.writableFinished) {
            stopped.abort();
        }
    });

    let result: unknown;

    try {
        result = await route.handle({
            method: route.method,
            params,
            query: url.searchParams,
            body,
            user: { id: user.id, name: user.name, role: user.role },
            signal: stopped.signal,
        });
    } catch (error) {
        // The browser went away: nobody waits for an answer, and the handler stopping is no failure.
        if (stopped.signal.aborted) {
            return;
        }

        return failed(response, error, part.file, user);
    }

    let text: string | undefined;

    try {
        text = JSON.stringify(result ?? {}) as string | undefined;
    } catch (error) {
        return failed(
            response,
            new Error(`its answer is not JSON: ${describe(error)}`),
            part.file,
            user,
        );
    }

    send(response, 200, text ?? "{}", "application/json");
}

/**
 * Answer with what a handler threw: an error made with `web.error`, as it is; anything else, a 500 whose words only the
 * owner gets. A library's error can carry a `status` and words not meant for everyone (a provider's 401 that quotes a
 * key): only `web.error` says they are. A 500 is logged here, with the extension's own stack, and answered here, so the
 * HTTP layer does not log it again.
 */
function failed(response: ServerResponse, error: unknown, file: string, user: User): void {
    const exposed = exposedError(error);

    if (exposed !== undefined) {
        if (exposed.status >= 500) {
            console.error(`Extension ${file} answered ${exposed.status}:`, error);
        }

        json(response, exposed.status, { error: exposed.message });

        return;
    }

    console.error(`Extension ${file} failed to answer:`, error);
    json(response, 500, {
        error:
            user.role === "owner"
                ? `${file} failed: ${describe(error)}`
                : "The extension failed to answer.",
    });
}

/** A file of a module's browser module: `parts` is the path after `/x/`, its version first and then the file's path. */
export function extensionFile(
    app: PocketApp,
    request: IncomingMessage,
    response: ServerResponse,
    parts: string[],
    user: User | undefined,
): void {
    if (user === undefined) {
        throw new HttpError(401, "Sign in first");
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
        response.setHeader("allow", "GET, HEAD");

        throw new HttpError(405, "Files are only read");
    }

    const [module, _rev, ...path] = parts;
    // Someone who may not load it learns nothing of it.
    const found = module === undefined ? undefined : app.webs.file(module, path, user);

    if (found === undefined) {
        throw new HttpError(404, "Not found");
    }

    // The very file that was checked: a folder on its way swapped for a link after the check would lead elsewhere.
    const body = readChecked(
        found,
        MAX_FILE_BYTES,
        `A browser module's file is at most ${MAX_FILE_BYTES / 1024 / 1024} MB`,
    );

    // The address holds the version, but a restart starts the versions again: always ask.
    // Another site's page may not use it, not even as a script: the sign-in cookie would go along with the request.
    send(response, 200, body, found.type, {
        "cache-control": "private, no-cache",
        "cross-origin-resource-policy": "same-origin",
        ...(found.type === "image/svg+xml" ? { "content-security-policy": SVG_CSP } : {}),
    });
}
