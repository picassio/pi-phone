/**
 * `/api`: the routes the web app calls. Each needs a signed-in person, and each but a GET needs the `X-Pocket` header,
 * which a form on another site cannot send. A conversation's routes are in `conversation-routes.ts`.
 */
import { createReadStream, readdirSync, rmSync, statSync } from "node:fs";
import { TOOLS, toolOffer } from "../machine-tools.ts";
import { pipeline } from "node:stream/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir, networkInterfaces, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import QRCode from "qrcode";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { MAX_PEEKS } from "../app.ts";
import type { SecretPatch } from "../secrets.ts";
import { openUiRoute } from "../openui.ts";
import {
    type Auth,
    COOKIE,
    clearAuthCookie,
    INVITE_MINUTES,
    type InviteGrant,
    type InviteMinutes,
    origin,
    parseCookies,
    quickTunnelHost,
    setAuthCookie,
} from "../auth.ts";
import type { User } from "../config.ts";
import type { ConversationId } from "@earendil-works/pi-durable";
import { VOICES } from "../voice.ts";
import { makeBackup, MAX_RESTORE, stageRestore } from "../backup.ts";
import { addressOf, deviceName } from "../devices.ts";
import { HttpError } from "../errors.ts";
import { resolveLanguage, translator } from "../i18n.ts";
import { inLanguage } from "../phone-events.ts";
import { machinePaths } from "../machine-paths.ts";
import { formatPlace, isRemote, parsePlace } from "../places.ts";
import { activity, runningNow } from "../running.ts";
import { conversationRoutes } from "./conversation-routes.ts";
import { createEventStreams } from "./events.ts";
import { extensionRoute } from "./extension-routes.ts";
import { type ApiRequest, conversationId, type HttpOptions, json, readJson, readBody } from "./io.ts";
import { MAX_DROP_IN_BYTES, packageFromUpload } from "../drop-in-install.ts";
import { addressOf as browserAddress } from "../browser/page.ts";
import { JevDecider, testDecision } from "../browser/run.ts";

/** Pictures from the phone's renderer, as base64 JSON: a few full-page shots. */
const MAX_RENDER_BODY = 30 * 1024 * 1024;

/**
 * Files a page has only in itself (an image in a conversation as a `data:` address), kept a few minutes at an address
 * of the app so the app's shell can save them to Downloads (PP-16): it saves only the app's own addresses. Per person.
 */
const kept = new Map<string, { owner: string; type: string; bytes: Buffer; until: number }>();
const KEEP_MS = 5 * 60_000;
const MAX_KEPT = 25 * 1024 * 1024;

/** This machine's non-internal IPv4 addresses, for invite links other devices on its networks can open. */
function lanAddresses(): string[] {
    return Object.values(networkInterfaces())
        .flat()
        .filter((net) => net !== undefined && net.family === "IPv4" && !net.internal)
        .map((net) => net!.address);
}

/** The `/api` routes. Each HTTP handler makes its own, and its event streams live as long as it does. */
export function createApi(options: HttpOptions, auth: Auth) {
    const { app } = options;
    const { events, poll } = createEventStreams(app);

    /** The request is the pi-phone app on this phone: its own device (its WebView, signed in here), from this phone. */
    const onThePhone = (request: IncomingMessage): boolean =>
        auth.session(request)?.device?.app === true &&
        /^(127\.|::1$)/.test(addressOf(request)) &&
        request.headers["x-forwarded-for"] === undefined;

    const requireUser = (request: IncomingMessage): User => {
        const user = auth.user(request);

        if (user === undefined) {
            throw new HttpError(401, "Sign in first");
        }

        return user;
    };

    const requireOwner = (user: User): void => {
        if (user.role !== "owner") {
            throw new HttpError(403, "Only the owner can do that");
        }
    };

    /**
     * What an invite may grant: viewers and people invited to one session cannot invite anyone, and only the owner can
     * sign a device in as the owner (never for one session).
     */
    const inviteGrant = (user: User, body: { role?: unknown; session?: unknown }): InviteGrant => {
        if (body.role === "owner") {
            requireOwner(user);

            return { role: "owner" };
        }

        if (user.role === "viewer" || user.sessions !== undefined) {
            throw new HttpError(403, "Only people with access to every session can invite others.");
        }

        const role = body.role === "viewer" ? "viewer" : "guest";

        if (body.session === undefined || body.session === null) {
            return { role };
        }

        const session = conversationId(String(body.session));

        if (!app.sessions(user).some((each) => each.id === Number(session))) {
            throw new HttpError(400, "No such session");
        }

        return { role, session: String(session) };
    };

    /** How long an invite lasts, in minutes: one of `INVITE_MINUTES`, 15 when not said. */
    const inviteMinutes = (body: { minutes?: unknown }): InviteMinutes => {
        if (body.minutes === undefined) {
            return 15;
        }

        const minutes = INVITE_MINUTES.find((each) => each === body.minutes);

        if (minutes === undefined) {
            throw new HttpError(400, "An invite lasts 15 minutes, an hour, a day, or a week.");
        }

        return minutes;
    };

    /** A guest signed in by a cookie set on a Cloudflare quick tunnel can only come back through it: remember which one. */
    const noteTunnel = (request: IncomingMessage, user: User): void => {
        if (
            user.role === "owner" ||
            user.tunnel !== undefined ||
            !parseCookies(request.headers.cookie)[COOKIE]
        ) {
            return;
        }

        const tunnel = quickTunnelHost(request);

        if (tunnel !== undefined) {
            app.config.updateUser(user.id, { tunnel });
        }
    };

    return async (
        request: IncomingMessage,
        response: ServerResponse,
        url: URL,
        parts: string[],
    ): Promise<void> => {
        const method = request.method ?? "GET";
        const user = requireUser(request);

        noteTunnel(request, user);

        if (method !== "GET" && request.headers["x-pocket"] !== "1") {
            throw new HttpError(403, "Missing X-Pocket header");
        }

        const [first, second, third] = parts;

        // A role's policy from the server edition's gateway (PP-22): the features it leaves out are refused here.
        const refusedByRole = app.policy.routeRefusal(first, method);

        if (refusedByRole !== undefined) {
            throw new HttpError(403, refusedByRole);
        }

        // The gateway sets this pi-phone's policy with its owner token; through the gateway, browsers cannot reach this.
        if (first === "policy" && second === undefined) {
            requireOwner(user);

            if (method === "GET") {
                return json(response, 200, { policy: app.policy.get() ?? null });
            }

            if (method === "POST") {
                try {
                    await app.applyPolicy(user, await readJson(request));
                } catch (error) {
                    throw error instanceof HttpError ? error : new HttpError(400, error instanceof Error ? error.message : String(error));
                }

                return json(response, 200, { policy: app.policy.get() });
            }
        }
        const route: ApiRequest = { app, request, response, url, user };

        // Each tab's connection knows its device, so signing that device out closes it.
        if (first === "events" && method === "GET") {
            return events(request, response, url, user, auth.session(request)?.device?.id);
        }

        if (first === "poll" && method === "GET") {
            return poll(request, response, url, user, auth.session(request)?.device?.id);
        }

        if (first === "me" && method === "GET") {
            // A browser signed in before devices (its cookie holds the person's token) becomes a device now: no one signs
            // in again, and the token leaves the browser.
            if (auth.session(request)?.legacy === true) {
                setAuthCookie(request, response, auth.signIn(user, request));
            }

            return json(response, 200, await app.hello(user));
        }

        // The owner's Getting started session (PP-235): opened again, or made and started. `whatsNew`: a version to show.
        if (first === "getting-started" && second === undefined && method === "POST") {
            const body = await readJson<{ language?: unknown; whatsNew?: unknown }>(request);
            const session = await app.gettingStarted(user, {
                ...(typeof body.language === "string" ? { language: body.language } : {}),
                ...(typeof body.whatsNew === "string" && /^[\w.-]{1,40}$/.test(body.whatsNew) ? { whatsNew: body.whatsNew } : {}),
            });

            return json(response, 200, { session: Number(session) });
        }

        if (first === "me" && method === "POST") {
            const body = await readJson<{ name?: string; language?: unknown; welcome?: unknown; dictation?: unknown }>(request);

            // The language dictation listens for on all their devices (PP-235).
            if (body.dictation !== undefined && body.name === undefined) {
                app.setDictationLanguage(user, body.dictation);

                return json(response, 200, { ok: true });
            }

            // The app's language for them (PP-81).
            if (body.language !== undefined && body.name === undefined) {
                await app.setLanguage(user, body.language);

                return json(response, 200, { ok: true });
            }

            // The first-run welcome finished or skipped, or to show again (PP-234).
            if (body.welcome !== undefined && body.name === undefined) {
                app.setWelcome(user, body.welcome);

                return json(response, 200, { ok: true });
            }

            const name = String(body.name ?? "")
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 40);

            if (name === "") {
                throw new HttpError(400, "Name is empty");
            }

            app.rename(user, name);

            return json(response, 200, { ok: true });
        }

        if (first === "folder-favorites" && second === undefined && method === "GET") {
            return json(response, 200, await app.folderFavorites.list(user));
        }

        if (first === "folder-favorites" && second === undefined && method === "POST") {
            await app.folderFavorites.set(user, await readJson(request));

            return json(response, 200, { ok: true });
        }

        // Folder groups in the session list (PP-76): one change at a time.
        if (first === "session-groups" && second === undefined && method === "GET") {
            return json(response, 200, await app.sessionGroups.list(user));
        }

        if (first === "session-groups" && second === undefined && method === "POST") {
            return json(response, 200, await app.sessionGroups.change(user, await readJson(request)));
        }

        if (first === "logout" && method === "POST") {
            clearAuthCookie(response);

            return json(response, 200, { ok: true });
        }

        if (first === "users" && second === undefined && method === "GET") {
            return json(response, 200, app.people(user));
        }

        // The owner's recovery code (break glass): when it was made; a new one, shown once, ends the one before.
        if (first === "recovery-code" && second === undefined && method === "GET") {
            requireOwner(user);

            return json(response, 200, { madeAt: app.config.recoveryMadeAt ?? null, here: onThePhone(request) });
        }

        // Made only in the app on the phone (owner's decision): a browser elsewhere, signed in or stolen, cannot mint a
        // way in.
        if (first === "recovery-code" && second === undefined && method === "POST") {
            requireOwner(user);

            if (!onThePhone(request)) {
                throw new HttpError(403, "Make the recovery code in the pi-phone app on the phone.");
            }

            return json(response, 200, app.config.newRecoveryCode());
        }

        // Settings › People › Devices: the owner's list is everyone's, others see their own.
        if (first === "devices" && second === undefined && method === "GET") {
            return json(response, 200, { devices: app.devices(user, auth.session(request)?.device?.id) });
        }

        if (first === "devices" && second !== undefined && third === "sign-out" && method === "POST") {
            app.signOutDevice(user, decodeURIComponent(second));

            return json(response, 200, { ok: true });
        }

        // "Sign out every device": every other device of the one asking; it stays signed in (a device of its own, if it
        // was not one yet).
        if (first === "sign-out-everywhere" && second === undefined && method === "POST") {
            const current = auth.session(request)?.device?.id;

            app.signOutEverywhere(user, current);

            if (current === undefined) {
                setAuthCookie(request, response, auth.signIn(user, request));
            }

            return json(response, 200, { ok: true });
        }

        if (first === "users" && second !== undefined && third === "remove" && method === "POST") {
            app.removeUser(user, second);

            return json(response, 200, { ok: true });
        }

        if (first === "users" && second !== undefined && third === undefined && method === "POST") {
            app.setAccess(user, second, await readJson(request));

            return json(response, 200, app.people(user));
        }

        if (first === "visibility" && method === "POST") {
            const body = await readJson<{ tab?: unknown; visible?: unknown; push?: unknown }>(request);

            app.setVisible(user, String(body.tab ?? ""), body.visible !== false, typeof body.push === "string" ? body.push.slice(0, 64) : undefined);

            return json(response, 200, { ok: true });
        }

        // The sessions a connection shows as peek tiles on screen now: they get `peek` events until it sends another list.
        if (first === "peeks" && method === "POST") {
            const body = await readJson<{ connection?: unknown; ids?: unknown; seq?: unknown }>(
                request,
            );

            if (!Array.isArray(body.ids)) {
                throw new HttpError(400, "ids must be a list of session ids");
            }

            if (body.seq !== undefined && !Number.isSafeInteger(body.seq)) {
                throw new HttpError(400, "seq must be a whole number");
            }

            app.setPeeks(
                user,
                String(body.connection ?? ""),
                body.ids.slice(0, MAX_PEEKS).map((id) => conversationId(String(id))),
                body.seq as number | undefined,
            );

            return json(response, 200, { ok: true });
        }

        // Every subagent in the sessions this person can see, as the subagents board shows them.
        if (first === "subagents" && method === "GET") {
            return json(response, 200, app.subagents(user));
        }

        // The subagents board opened or closed in a tab: while open, it gets every subagent (`subagents` events).
        if (first === "subagents" && method === "POST") {
            const body = await readJson<{ connection?: unknown; on?: unknown; seq?: unknown }>(
                request,
            );

            if (body.seq !== undefined && !Number.isSafeInteger(body.seq)) {
                throw new HttpError(400, "seq must be a whole number");
            }

            app.setBoard(
                user,
                String(body.connection ?? ""),
                body.on === true,
                body.seq as number | undefined,
            );

            return json(response, 200, { ok: true });
        }

        // Theme folders (`themes.ts`): everyone signed in lists them, as everyone chooses one for their own browsers;
        // only the owner adds, edits, and removes them.
        if (first === "themes" && second === undefined && method === "GET") {
            return json(response, 200, { themes: app.themes.list(user.role === "owner") });
        }

        if (first === "themes" && second === "default" && method === "PUT") {
            await app.setThemeDefault(
                user,
                (await readJson<{ default?: unknown }>(request)).default,
            );

            return json(response, 200, { ok: true });
        }

        if (first === "themes" && second === "duplicate" && method === "POST") {
            requireOwner(user);
            const body = await readJson<{ from?: unknown; name?: unknown; colors?: unknown }>(
                request,
            );

            if (typeof body.from !== "string") {
                throw new HttpError(400, "Say which theme or colors to copy");
            }

            return json(response, 200, {
                id: await app.themes.duplicate(body.from, body.name, body.colors === true),
            });
        }

        if (first === "themes" && second !== undefined && third === "edit" && method === "GET") {
            requireOwner(user);

            return json(response, 200, app.themes.edit(second));
        }

        if (
            first === "themes" &&
            second !== undefined &&
            third === undefined &&
            method === "DELETE"
        ) {
            requireOwner(user);
            app.themes.remove(second);

            return json(response, 200, { ok: true });
        }

        if (first === "running" && method === "GET") {
            return json(response, 200, await runningNow(app, user));
        }

        // Whether this pi-phone is at work, for the server edition's gateway that stops idle ones (PP-33); browsers never reach it.
        if (first === "activity" && second === undefined && method === "GET") {
            requireOwner(user);

            return json(response, 200, await activity(app, user));
        }

        if (first === "spend" && method === "GET") {
            return json(response, 200, app.spend.summary(user));
        }

        if (first === "spend" && method === "POST") {
            const body = await readJson<{ session?: unknown; person?: unknown; budget?: unknown }>(
                request,
            );

            if (body.session !== undefined) {
                await app.spend.setSessionBudget(
                    user,
                    conversationId(String(body.session)),
                    body.budget,
                );
            } else if (typeof body.person === "string") {
                app.spend.setPersonBudget(user, body.person, body.budget);
            } else {
                throw new HttpError(400, "Say which session or person");
            }

            return json(response, 200, app.spend.summary(user));
        }

        if (first === "sessions" && second === undefined && method === "GET") {
            return json(response, 200, app.sessions(user));
        }

        // Pi's sessions, which the owner can continue here: listed, previewed, imported from a file, continued.
        if (first === "pi-sessions" && second === undefined && method === "GET") {
            return json(
                response,
                200,
                await app.piSessions.list(user, url.searchParams.get("q") ?? ""),
            );
        }

        if (first === "pi-sessions" && second === "preview" && method === "GET") {
            return json(
                response,
                200,
                await app.piSessions.preview(user, url.searchParams.get("path") ?? ""),
            );
        }

        if (first === "pi-sessions" && second === "import" && method === "POST") {
            const chunks: Buffer[] = [];

            for await (const chunk of request) {
                chunks.push(chunk as Buffer);
            }

            return json(
                response,
                200,
                await app.piSessions.import(
                    user,
                    url.searchParams.get("name") ?? "",
                    Buffer.concat(chunks),
                ),
            );
        }

        // Ports of machines opened here (`forwards.ts`): the owner's, as the machines are.
        if (first === "forwards") {
            if (user.role !== "owner") {
                throw new HttpError(403, "Only the owner opens ports of machines.");
            }

            if (second === undefined && method === "GET") {
                return json(response, 200, { forwards: app.forwards.list() });
            }

            if (second === undefined && method === "POST") {
                const body = await readJson<{ machineId?: unknown; port?: unknown }>(request);

                if (typeof body.machineId !== "string") {
                    throw new HttpError(400, "machineId is required");
                }

                return json(response, 200, await app.forwards.open(body.machineId, body.port));
            }

            if (second !== undefined && method === "DELETE") {
                app.forwards.close(second);

                return json(response, 200, { ok: true });
            }
        }

        // Push notifications for the web UI (PP-127, `web-push.ts`): the key to subscribe with, and the browsers that did.
        if (first === "push" && second === undefined && method === "GET") {
            requireOwner(user);

            return json(response, 200, {
                publicKey: app.webPush.publicKey(),
                subscriptions: app.webPush.list().map((each) => ({ id: each.id, name: each.name, createdAt: each.createdAt, ...(each.lastSentAt === undefined ? {} : { lastSentAt: each.lastSentAt }), ...(each.lastError === undefined ? {} : { lastError: each.lastError }) })),
            });
        }

        // This browser turned notifications on: its subscription, named after the browser, at the app's address it uses.
        if (first === "push" && second === undefined && method === "POST") {
            requireOwner(user);

            const body = await readJson<{ subscription?: unknown; language?: unknown; zone?: unknown }>(request);
            const origin = request.headers.origin;

            if (typeof origin !== "string" || origin === "null") {
                throw new HttpError(400, "Turn notifications on from the app's page.");
            }

            try {
                const record = app.webPush.subscribe(body.subscription, {
                    name: deviceName(String(request.headers["user-agent"] ?? ""), addressOf(request)),
                    ...(typeof body.language === "string" ? { language: body.language } : {}),
                    // Its time zone: a time in a notification is said in it (the limit notice's "at HH:MM").
                    ...(typeof body.zone === "string" ? { zone: body.zone } : {}),
                    origin,
                });

                return json(response, 200, { id: record.id, name: record.name });
            } catch (error) {
                throw new HttpError(400, error instanceof Error ? error.message : String(error));
            }
        }

        if (first === "push" && second !== undefined && third === undefined && method === "DELETE") {
            requireOwner(user);
            app.webPush.remove(second);

            return json(response, 200, { ok: true });
        }

        // A test notification to one browser, in its language (or the owner's choice).
        if (first === "push" && second !== undefined && third === "test" && method === "POST") {
            requireOwner(user);

            const record = app.webPush.list().find((each) => each.id === second);

            if (record === undefined) {
                throw new HttpError(404, "Notifications are not on for that device.");
            }

            const t = translator(resolveLanguage(user.language, record.language));
            const outcome = await app.webPush.send(record, { title: "pi-phone", body: t("Notifications work on {device}.", { device: record.name }), url: "/", tag: "pi-phone-test" });

            if (outcome !== "sent") {
                throw new HttpError(502, outcome === "gone" ? t("That device's notifications ended: turn them on there again.") : t("The notification did not go: {why}", { why: app.webPush.list().find((each) => each.id === second)?.lastError ?? "" }));
            }

            return json(response, 200, { ok: true });
        }

        // What the app's background service notifies the owner of (`phone-events.ts`): a long poll.
        if (first === "phone" && second === "events" && method === "GET") {
            if (user.role !== "owner") {
                throw new HttpError(403, "Only the owner gets the phone's notifications.");
            }

            const abort = new AbortController();

            request.on("close", () => abort.abort());
            const found = await app.phoneEvents.after(Number(url.searchParams.get("after") ?? -1), abort.signal);
            // In the owner's language: their choice, or with "auto" the phone's own (`lang`, Android's locale) (PP-85).
            const t = translator(resolveLanguage(user.language, url.searchParams.get("lang") ?? undefined));

            return json(response, 200, { ...found, events: found.events.map((event) => inLanguage(event, t)) });
        }

        // Screenshots (`screenshots.ts`): the app's service takes what to render (a long poll), and answers with pictures.
        if (first === "phone" && second === "renders" && third === undefined && method === "GET") {
            requireOwner(user);
            const abort = new AbortController();

            request.on("close", () => abort.abort());

            return json(response, 200, await app.screenshots.after(Number(url.searchParams.get("after") ?? -1), abort.signal));
        }

        if (first === "phone" && second === "renders" && third !== undefined && method === "POST") {
            requireOwner(user);
            let body: { shots?: unknown; error?: unknown };

            try {
                body = JSON.parse((await readBody(request, MAX_RENDER_BODY)).toString("utf8")) as typeof body;
            } catch (error) {
                throw error instanceof HttpError ? error : new HttpError(400, "Invalid JSON");
            }

            try {
                app.screenshots.answer(third, body);
            } catch (error) {
                throw new HttpError(404, error instanceof Error ? error.message : String(error));
            }

            return json(response, 200, { ok: true });
        }

        // A file to save from the page itself (an image's `data:` address): kept briefly, then fetched by a download.
        if (first === "kept-downloads" && second === undefined && method === "POST") {
            const bytes = await readBody(request, MAX_KEPT);
            const type = String(request.headers["content-type"] ?? "application/octet-stream").split(";")[0]!;
            const id = crypto.randomUUID();
            const now = Date.now();

            for (const [key, file] of kept) {
                if (file.until < now) {
                    kept.delete(key);
                }
            }

            kept.set(id, { owner: user.id, type, bytes, until: now + KEEP_MS });

            return json(response, 200, { url: `/api/kept-downloads/${id}` });
        }

        if (first === "kept-downloads" && second !== undefined && third === undefined && method === "GET") {
            const file = kept.get(second);

            if (file === undefined || file.owner !== user.id || file.until < Date.now()) {
                throw new HttpError(404, "That download is no longer kept: download it again.");
            }

            response.writeHead(200, { "content-type": file.type, "content-length": file.bytes.length, "cache-control": "no-store" });
            response.end(file.bytes);

            return;
        }

        // Pi's browser (`browser/pi-browser.ts`): the app's service makes and removes its WebView (a long poll and answers).
        if (first === "phone" && second === "browser" && third === undefined && method === "GET") {
            requireOwner(user);
            const abort = new AbortController();

            request.on("close", () => abort.abort());

            return json(response, 200, await app.browserRequests.after(Number(url.searchParams.get("after") ?? -1), abort.signal));
        }

        if (first === "phone" && second === "browser" && third !== undefined && method === "POST") {
            requireOwner(user);

            try {
                app.browserRequests.answer(third, await readJson<Record<string, unknown>>(request));
            } catch (error) {
                throw error instanceof HttpError ? error : new HttpError(404, error instanceof Error ? error.message : String(error));
            }

            return json(response, 200, { ok: true });
        }

        // Phone control (`phone-control.ts`, PP-141): the app's service reads and acts on the screen (a long poll, answers).
        if (first === "phone" && second === "control" && third === undefined && method === "GET") {
            requireOwner(user);
            const abort = new AbortController();

            request.on("close", () => abort.abort());

            return json(response, 200, await app.phoneControl.requests.after(Number(url.searchParams.get("after") ?? -1), abort.signal));
        }

        if (first === "phone" && second === "control" && third !== undefined && method === "POST") {
            requireOwner(user);

            try {
                // A picture of the screen comes this way: larger than other answers.
                app.phoneControl.requests.answer(third, await readJson<Record<string, unknown>>(request, MAX_RENDER_BODY));
            } catch (error) {
                throw error instanceof HttpError ? error : new HttpError(404, error instanceof Error ? error.message : String(error));
            }

            return json(response, 200, { ok: true });
        }

        // Menu › Phone control: this phone's state, its apps, the Never list (the owner's alone to change), and Stop (the
        // live line's, and the phone's banner and notification, which the app's service sends with the owner's sign-in).
        if (first === "phone-control") {
            requireOwner(user);
            const control = app.phoneControl;
            const unavailable = control.unavailable();

            if (unavailable !== undefined) {
                throw new HttpError(400, unavailable);
            }

            if (second === undefined && method === "GET") {
                const present = control.present();
                let status: unknown = null;
                let problem: string | undefined;

                if (present) {
                    try {
                        status = await control.status();
                    } catch (error) {
                        problem = error instanceof Error ? error.message : String(error);
                    }
                }

                return json(response, 200, { devices: control.devices(), present, status, ...(problem === undefined ? {} : { problem }), sessions: control.view(), never: control.neverList() });
            }

            if (second === "apps" && method === "GET") {
                const apps = await control.apps();

                return json(response, 200, { apps: apps.map((each) => ({ ...each, never: control.neverReason(each.package) ?? null })) });
            }

            if (second === "never" && method === "POST") {
                const body = await readJson<{ add?: { label?: unknown; package?: unknown }; remove?: unknown }>(request);

                try {
                    if (body.add !== undefined) {
                        await control.addNever({ label: String(body.add.label ?? ""), package: String(body.add.package ?? "") });
                    } else if (typeof body.remove === "string") {
                        control.removeNever(body.remove);
                    } else {
                        throw new Error("Give add: { label, package } or remove: package.");
                    }
                } catch (error) {
                    throw new HttpError(400, error instanceof Error ? error.message : String(error));
                }

                return json(response, 200, { never: control.neverList() });
            }

            if (second === "stop" && method === "POST") {
                const body = await readJson<{ device?: unknown; from?: unknown }>(request);
                const device = typeof body.device === "string" ? body.device : "phone";
                const ended = await control.end(device, body.from === "phone" ? "Stop on the phone" : `${user.name} stopped it in the app`);

                return json(response, 200, { ended, sessions: control.view() });
            }
        }

        // Menu › Computer control (PP-178): the machines and their sessions, each machine's desktop setup line and what
        // ocu reads there, the Never list (the owner's alone to change), and Stop.
        if (first === "computer-control") {
            requireOwner(user);
            const control = app.computerControl;
            const unavailable = control.unavailable();

            if (unavailable !== undefined) {
                throw new HttpError(400, unavailable);
            }

            const failing = async <T>(run: () => Promise<T> | T): Promise<T> => {
                try {
                    return await run();
                } catch (error) {
                    throw error instanceof HttpError ? error : new HttpError(400, error instanceof Error ? error.message : String(error));
                }
            };

            if (second === undefined && method === "GET") {
                return json(response, 200, { machines: control.machinesView(), sessions: control.view(), never: control.neverList() });
            }

            if (second === "never" && method === "POST") {
                const body = await readJson<{ add?: unknown; remove?: unknown }>(request);

                await failing(async () => {
                    if (typeof body.add === "string") {
                        await control.addNever(body.add);
                    } else if (typeof body.remove === "string") {
                        control.removeNever(body.remove);
                    } else {
                        throw new Error("Give add: name or remove: name.");
                    }
                });

                return json(response, 200, { never: control.neverList() });
            }

            if (second === "prepare" && method === "POST") {
                const body = await readJson<{ machine?: unknown; prepare?: unknown }>(request);

                const machine = await failing(() => control.ready(String(body.machine ?? "")));

                await failing(() => control.setPrepare(machine.id, String(body.prepare ?? "")));

                return json(response, 200, { machines: control.machinesView() });
            }

            // What ocu reads on a machine's desktop now: its apps, or why it cannot.
            if (second === "check" && method === "POST") {
                const body = await readJson<{ machine?: unknown }>(request);

                try {
                    return json(response, 200, { ok: true, apps: await control.apps(String(body.machine ?? "")) });
                } catch (error) {
                    return json(response, 200, { ok: false, problem: error instanceof Error ? error.message : String(error) });
                }
            }

            if (second === "stop" && method === "POST") {
                const body = await readJson<{ machine?: unknown }>(request);
                const ended = await control.end(String(body.machine ?? ""), `${user.name} stopped it in the app`);

                return json(response, 200, { ended, sessions: control.view() });
            }
        }

        // The Computer panel (PP-178): a session's computer as it shows (pictures while a tab watches), its tabs, taking it
        // over, and the owner's taps and keys then.
        if (first === "computer") {
            requireOwner(user);
            const control = app.computerControl;
            const session = Number(url.searchParams.get("session"));
            const failing = async <T>(run: () => Promise<T> | T): Promise<T> => {
                try {
                    return await run();
                } catch (error) {
                    throw error instanceof HttpError ? error : new HttpError(400, error instanceof Error ? error.message : String(error));
                }
            };

            if (second === undefined && method === "GET") {
                const shown = control.panelOfSession(session);

                return json(response, 200, shown?.panel ?? { session, open: false });
            }

            if (second === "watch" && method === "POST") {
                const body = await readJson<{ connection?: unknown; on?: unknown }>(request);

                app.setComputerWatch(user, String(body.connection ?? ""), session, body.on === true);

                return json(response, 200, control.panelOfSession(session)?.panel ?? { session, open: false });
            }

            if (second === "tab" && method === "POST") {
                const body = await readJson<{ app?: unknown }>(request);

                return json(response, 200, await failing(() => control.setTab(session, String(body.app ?? ""))));
            }

            if (second === "take-over" && method === "POST") {
                const body = await readJson<{ on?: unknown }>(request);

                return json(response, 200, await failing(() => control.takeOver(session, body.on === true)));
            }

            if (second === "input" && method === "POST") {
                const body = await readJson<{ type?: unknown; x?: unknown; y?: unknown; text?: unknown; key?: unknown }>(request);
                const given =
                    body.type === "tap"
                        ? { type: "tap" as const, x: Number(body.x), y: Number(body.y) }
                        : body.type === "text"
                          ? { type: "text" as const, text: String(body.text ?? "") }
                          : { type: "key" as const, key: String(body.key ?? "") };

                return json(response, 200, await failing(() => control.input(session, given)));
            }

            if (second === "stop" && method === "POST") {
                const found = control.panelOfSession(session);
                const ended = found === undefined ? false : await control.end(found.panel.machine, `${user.name} stopped it in the app`);

                return json(response, 200, { ended });
            }
        }

        // The Browser panel: what Pi's browser shows (frames while a tab watches), taking it over, and its input then.
        if (first === "browser") {
            requireOwner(user);

            // Which browser: the session's own (PP-13), at the phone or a machine (`machine:<id>`), as the panel shows it.
            // The run model routes below are the app's, of no session.
            const place = url.searchParams.get("place") ?? "phone";
            const session = Number(url.searchParams.get("session"));
            const browser = () => app.browserAt(place, session);

            if (second === undefined && method === "GET") {
                return json(response, 200, browser().state());
            }

            if (second === "watch" && method === "POST") {
                const body = await readJson<{ connection?: unknown; on?: unknown; width?: unknown; height?: unknown }>(request);
                // How big the tab draws the picture, in device pixels (PP-200): the frames are made no bigger.
                const pixels = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.min(value, 4000) : undefined);
                const width = pixels(body.width);
                const height = pixels(body.height);

                app.setBrowserWatch(user, String(body.connection ?? ""), place, session, body.on === true, width === undefined || height === undefined ? undefined : { width, height });

                return json(response, 200, browser().state());
            }

            // The newest picture after `after`, as a JPEG, for a tab that watches (PP-200): one is waited for up to 2 s, so a
            // tab keeps one request waiting while it draws, and each picture comes as soon as it is there, never more than
            // the tab can draw. Taking it lets Chrome send the next.
            if (second === "frame" && method === "GET") {
                const after = Number(url.searchParams.get("after") ?? 0);
                const frame = await app.browserFrame(user, url.searchParams.get("connection") ?? "", place, session, Number.isFinite(after) ? after : 0, 2000);

                if (frame === undefined) {
                    response.writeHead(204, { "cache-control": "no-store" });
                    response.end();

                    return;
                }

                const bytes = Buffer.from(frame.jpeg, "base64");

                response.writeHead(200, {
                    "content-type": "image/jpeg",
                    "content-length": String(bytes.length),
                    "cache-control": "no-store",
                    "x-frame-seq": String(frame.seq),
                    "x-frame-width": String(frame.width),
                    "x-frame-height": String(frame.height),
                });
                response.end(bytes);

                return;
            }

            // The panel's Retry, when the page's picture does not come (PP-199).
            if (second === "frames" && method === "POST") {
                browser().retryFrames();

                return json(response, 200, browser().state());
            }

            if (second === "take-over" && method === "POST") {
                const body = await readJson<{ on?: unknown }>(request);

                browser().takeOver(body.on === true);

                return json(response, 200, browser().state());
            }

            if (second === "input" && method === "POST") {
                const body = await readJson<{ type?: unknown; x?: unknown; y?: unknown; dx?: unknown; dy?: unknown; text?: unknown; key?: unknown }>(request);
                const number = (value: unknown, name: string) => {
                    if (typeof value !== "number" || !Number.isFinite(value)) {
                        throw new HttpError(400, `${name} must be a number`);
                    }

                    return value;
                };

                // What the person types goes straight to the page: never logged, never kept.
                try {
                    const focus =
                        body.type === "tap"
                            ? await browser().input({ type: "tap", x: number(body.x, "x"), y: number(body.y, "y") })
                            : body.type === "scroll"
                              ? await browser().input({ type: "scroll", x: number(body.x, "x"), y: number(body.y, "y"), dx: body.dx === undefined ? 0 : number(body.dx, "dx"), dy: number(body.dy, "dy") })
                              : body.type === "text" && typeof body.text === "string"
                                ? await browser().input({ type: "text", text: body.text })
                                : body.type === "key" && typeof body.key === "string"
                                  ? await browser().input({ type: "key", key: body.key })
                                  : undefined;

                    if (focus === undefined) {
                        throw new HttpError(400, "Send a tap, a scroll, text, or a key.");
                    }

                    return json(response, 200, { ok: true, ...focus });
                } catch (error) {
                    throw error instanceof HttpError ? error : new HttpError(409, error instanceof Error ? error.message : String(error));
                }
            }

            if (second === "open" && method === "POST") {
                const body = await readJson<{ url?: unknown }>(request);

                try {
                    await browser().navigateFor(browserAddress(String(body.url ?? "")));
                } catch (error) {
                    throw new HttpError(409, error instanceof Error ? error.message : String(error));
                }

                return json(response, 200, browser().state());
            }

            if (second === "tab" && method === "POST") {
                const body = await readJson<{ number?: unknown }>(request);

                try {
                    await browser().showTab(Number(body.number));
                } catch (error) {
                    throw new HttpError(409, error instanceof Error ? error.message : String(error));
                }

                return json(response, 200, browser().state());
            }

            if (second === "size" && method === "POST") {
                const size = (await readJson<{ size?: unknown }>(request)).size;

                if (size !== "phone" && size !== "desktop") {
                    throw new HttpError(400, "size is phone or desktop.");
                }

                await browser().resize(session, size);

                return json(response, 200, browser().state());
            }

            if (second === "close" && method === "POST") {
                await browser().close();

                return json(response, 200, browser().state());
            }

            // The run model `browser_run` decides with (Settings › Browser), and a test of a Jev model: one decision.
            if (second === "run-model" && third === undefined && method === "GET") {
                return json(response, 200, { model: app.config.browserRunModel });
            }

            if (second === "run-model" && third === undefined && method === "PUT") {
                await app.setBrowserRunModel(user, (await readJson<{ model?: unknown }>(request)).model);

                return json(response, 200, { model: app.config.browserRunModel });
            }

            if (second === "run-model" && third === "test" && method === "POST") {
                const model = String((await readJson<{ model?: unknown }>(request)).model ?? "");
                const key = (await app.models.getAuth("openrouter"))?.auth.apiKey;

                if (key === undefined) {
                    throw new HttpError(409, "OpenRouter is not signed in: sign in to it in Settings › Providers.");
                }

                const started = Date.now();

                try {
                    const answer = await testDecision(new JevDecider(key, model));

                    return json(response, 200, { ms: Date.now() - started, ...answer });
                } catch (error) {
                    throw new HttpError(409, error instanceof Error ? error.message : String(error));
                }
            }
        }

        // A session to Pi on a machine and back (`pi-handoff.ts`): where it is there, continue it there, bring it back.
        if (first === "pi-handoff" && second !== undefined && third === undefined && method === "GET") {
            return json(response, 200, await app.piHandoff.status(user, conversationId(second)));
        }

        if (first === "pi-handoff" && second !== undefined && third === "continue" && method === "POST") {
            const body = await readJson<{ place?: unknown }>(request);

            if (body.place !== undefined && typeof body.place !== "string") {
                throw new HttpError(400, "place must be a folder on a machine");
            }

            return json(response, 200, await app.piHandoff.continueInPi(user, conversationId(second), body.place));
        }

        if (first === "pi-handoff" && second !== undefined && third === "bring-back" && method === "POST") {
            const body = await readJson<{ asNew?: unknown }>(request);

            return json(response, 200, await app.piHandoff.bringBack(user, conversationId(second), body.asNew === true));
        }

        // Pi's sessions on a machine (`machines.ts`): listed through its environment; one copied here to continue.
        if (first === "pi-sessions" && second === "machine" && third !== undefined && method === "GET") {
            return json(response, 200, await app.piSessions.listOnMachine(user, third));
        }

        if (first === "pi-sessions" && second === "machine" && third !== undefined && method === "POST") {
            const body = await readJson<{ path?: unknown }>(request);

            return json(response, 200, await app.piSessions.importFromMachine(user, third, body.path));
        }

        if (first === "pi-sessions" && second === "continue" && method === "POST") {
            const body = await readJson<{ path?: unknown; cwd?: unknown }>(request);

            if (typeof body.path !== "string") {
                throw new HttpError(400, "path is required");
            }

            if (body.cwd !== undefined && typeof body.cwd !== "string") {
                throw new HttpError(400, "cwd must be a folder's path");
            }

            return json(
                response,
                200,
                await app.commands.continuePiSession(user, body.path, body.cwd),
            );
        }

        if (first === "sessions" && second === undefined && method === "POST") {
            const body = await readJson<{ cwd?: string; title?: string; worktree?: unknown }>(
                request,
            );

            return json(response, 200, await app.commands.createSession(user, body));
        }

        if (first === "sessions" && second !== undefined && method === "POST") {
            const body = await readJson<{ title?: string; archived?: boolean; settled?: boolean }>(request);

            await app.commands.updateSession(conversationId(second), user, body);

            return json(response, 200, { ok: true });
        }

        if (first === "c" && second !== undefined) {
            const id = conversationId(second);

            app.requireSee(user, id);

            return conversationRoutes(route, id, parts);
        }

        // What an interactive answer's components fetch (`openui.ts`), asked by the app's page for its sandboxed frame.
        if (first === "openui" && second !== undefined && third === undefined && method === "GET") {
            const answer = openUiRoute(second, url.searchParams);

            if (answer === undefined) {
                throw new HttpError(404, "No such route");
            }

            const { status, body } = await answer;

            return json(response, status, body);
        }

        // Web access (`web/access.ts`): the search provider and what each needs; a test search with the one picked.
        // Reaching the phone over Tailscale (`tailnet.ts`): on or off, where it listens, or why it does not.
        if (first === "access" && second === undefined && (method === "GET" || method === "PUT")) {
            requireOwner(user);

            if (app.tailnet === undefined) {
                throw new HttpError(503, "This server is not serving the network.");
            }

            if (method === "GET") {
                return json(response, 200, app.tailnet.status());
            }

            const body = (await readJson(request)) as { tailscale?: unknown };

            if (typeof body.tailscale !== "boolean") {
                throw new HttpError(400, "tailscale is true or false");
            }

            app.config.tailscale = body.tailscale;

            return json(response, 200, await app.tailnet.set(body.tailscale));
        }

        if (first === "web-access" && second === undefined && method === "GET") {
            requireOwner(user);

            return json(response, 200, { provider: app.web.provider ?? null, providers: await app.web.providers() });
        }

        if (first === "web-access" && second === undefined && method === "PUT") {
            requireOwner(user);

            try {
                app.web.set(await readJson<{ provider?: unknown; endpoints?: unknown }>(request));
            } catch (error) {
                throw new HttpError(400, error instanceof Error ? error.message : String(error));
            }

            return json(response, 200, { provider: app.web.provider ?? null, providers: await app.web.providers() });
        }

        if (first === "web-access" && second === "test" && method === "POST") {
            requireOwner(user);
            const body = await readJson<{ provider?: unknown }>(request);
            const started = Date.now();

            try {
                const { provider, response: found } = await app.web.search("Pi coding agent", {
                    numResults: 3,
                    ...(typeof body.provider === "string" ? { provider: body.provider } : {}),
                    signal: AbortSignal.timeout(60_000),
                });

                return json(response, 200, {
                    ok: true,
                    provider: provider.name,
                    ms: Date.now() - started,
                    results: found.results.map(({ title, url }) => ({ title, url })),
                });
            } catch (error) {
                return json(response, 200, { ok: false, ms: Date.now() - started, error: app.secrets.redact(error instanceof Error ? error.message : String(error)) });
            }
        }

        // The owner's secrets (`secrets.ts`): never their values, which go one way, into the store.
        if (first === "secrets" && method === "GET" && second === undefined) {
            requireOwner(user);

            return json(response, 200, { secrets: app.secrets.list() });
        }

        if (first === "secrets" && method === "PUT" && second !== undefined && third === undefined) {
            requireOwner(user);
            const body = await readJson<SecretPatch>(request);

            try {
                return json(response, 200, { secret: app.secrets.set(decodeURIComponent(second), body) });
            } catch (error) {
                throw new HttpError(400, error instanceof Error ? error.message : String(error));
            }
        }

        if (first === "secrets" && method === "DELETE" && second !== undefined && third === undefined) {
            requireOwner(user);

            if (!app.secrets.remove(decodeURIComponent(second))) {
                throw new HttpError(404, "No such secret");
            }

            return json(response, 200, { ok: true });
        }

        // What the owner typed on one of Pi's browser's cards (sign-in, code) or did on the page: into the page, not to Pi.
        if (first === "browser" && second === "asks" && parts.length > 2 && method === "POST") {
            const body = await readJson<{ values?: unknown; remember?: unknown; useSaved?: unknown; done?: unknown }>(request);

            if (!(await app.answerBrowserAsk(parts.slice(2).join("/"), body, user))) {
                throw new HttpError(404, "That request is no longer waiting");
            }

            return json(response, 200, { ok: true });
        }

        // What the person Pi works for typed on an extension's question (`host.ask`): to the extension that asked alone.
        if (first === "asks" && parts.length > 1 && method === "POST") {
            const body = await readJson<{ values?: unknown }>(request);

            if (!(await app.answerAsk(parts.slice(1).join("/"), body.values, user))) {
                throw new HttpError(404, "That request is no longer waiting");
            }

            return json(response, 200, { ok: true });
        }

        // A value typed into `secret_request`'s card. Its id may hold a slash, as an approval's may.
        if (first === "secrets" && second === "requests" && parts.length > 2 && method === "POST") {
            const body = await readJson<{ value?: unknown }>(request);

            if (!(await app.answerSecretRequest(parts.slice(2).join("/"), body.value, user))) {
                throw new HttpError(404, "That request is no longer waiting");
            }

            return json(response, 200, { ok: true });
        }

        if (first === "approvals" && second !== undefined && method === "POST") {
            const body = await readJson<{ allow?: boolean; tools?: unknown }>(request);
            // The machine_add card's ticked tools (PP-177): installed once the machine is connected.
            const tools = Array.isArray(body.tools) ? { tools: body.tools.map(String).join(",") } : undefined;

            // An id may hold a slash, which the path decoded into a part of its own: a codemode script's calls are
            // named `<call>/<n>`.
            if (!(await app.answerApproval(parts.slice(1).join("/"), body.allow === true, user, false, tools))) {
                throw new HttpError(404, "That approval is no longer pending");
            }

            return json(response, 200, { ok: true });
        }

        if (first === "fs" && method === "GET") {
            app.requireSteer(user);

            if (user.sessions !== undefined) {
                throw new HttpError(403, "You were invited to one session.");
            }

            const requested = url.searchParams.get("path") || "~";
            const showHidden = url.searchParams.get("hidden") === "1";

            // A folder on a machine (`places.ts`): listed through its environment, so the picker browses the machine.
            if (isRemote(requested)) {
                const place = parsePlace(requested);
                const machine = app.machines.ready(place.machineId!);
                const home = machine.remote!.home;
                // Its own paths: on Windows, drive paths with forward slashes (`machine-paths.ts`).
                const paths = machinePaths(machine.remote);
                const cwd = await app.workspace.checkPlace(
                    formatPlace({ machineId: machine.id, path: paths.onDrive(paths.expandHome(place.path, home), home) }),
                );
                const path = parsePlace(cwd).path;
                const env = app.places.env(cwd);
                const reader = await env.openDirReader(path, BACKGROUND_CONTEXT);

                // A file with a name Windows reserves (`nul`, `con`, …; a slip of `> nul` in Git Bash makes one) stops
                // pi-env's listing of its folder: say which, and how to delete it.
                const listingFailed = (message: string) => {
                    const reserved = /lstat '.*\\((?:nul|con|prn|aux|com\d|lpt\d)(?:\.[^\\']*)?)'/i.exec(message)?.[1];

                    return new HttpError(
                        502,
                        reserved === undefined
                            ? `Could not list ${path} on ${machine.name}: ${message}`
                            : `Could not list ${path} on ${machine.name}: it holds a file named ${reserved}, a name Windows reserves. Delete it in Git Bash there (it can, where Windows tools cannot): rm -- '${path}/${reserved}'`,
                    );
                };

                if (!reader.ok) {
                    throw listingFailed(reader.error.message);
                }

                const remoteDirs: { name: string; path: string }[] = [];

                try {
                    for (;;) {
                        const page = await reader.value.next(1000, BACKGROUND_CONTEXT);

                        if (!page.ok) {
                            throw listingFailed(page.error.message);
                        }

                        for (const entry of page.value.entries) {
                            // What the machine's system hides: on Windows, its hidden and system folders too (PP-117).
                            if ((showHidden || !paths.hidden(path, entry.name)) && entry.kind === "directory") {
                                remoteDirs.push({ name: entry.name, path: formatPlace({ machineId: machine.id, path: paths.onDrive(paths.normal(entry.path), home) }) });
                            }
                        }

                        if (page.value.done || remoteDirs.length >= 1000) {
                            break;
                        }
                    }
                } finally {
                    await reader.value.close(BACKGROUND_CONTEXT);
                }

                remoteDirs.sort((a, b) => a.name.localeCompare(b.name));
                const parent = paths.dirname(path);

                return json(response, 200, {
                    path: cwd,
                    parent: parent === path ? null : formatPlace({ machineId: machine.id, path: parent }),
                    home: formatPlace({ machineId: machine.id, path: home }),
                    machine: { id: machine.id, name: machine.name },
                    dirs: remoteDirs.slice(0, 1000),
                    recent: [...new Set(app.sessions(user).map((session) => session.cwd))]
                        .filter((each) => isRemote(each) && parsePlace(each).machineId === machine.id)
                        .slice(0, 8),
                });
            }

            const path = app.workspace.checkDirectory(requested);
            const dirs: { name: string; path: string }[] = [];

            for (const entry of readdirSync(path, { withFileTypes: true })) {
                if (!showHidden && entry.name.startsWith(".")) {
                    continue;
                }

                let isDir = entry.isDirectory();

                if (entry.isSymbolicLink()) {
                    try {
                        isDir = statSync(join(path, entry.name)).isDirectory();
                    } catch {
                        isDir = false;
                    }
                }

                if (isDir) {
                    dirs.push({ name: entry.name, path: join(path, entry.name) });
                }
            }

            dirs.sort((a, b) => a.name.localeCompare(b.name));
            const recent = [...new Set(app.sessions(user).map((session) => session.cwd))].slice(
                0,
                8,
            );

            return json(response, 200, {
                path,
                parent: dirname(path) === path ? null : dirname(path),
                home: homedir(),
                dirs: dirs.slice(0, 1000),
                recent,
            });
        }

        // A new folder, from the folder picker: it opens in the picker, ready to use.
        if (first === "fs" && second === undefined && method === "POST") {
            const body = await readJson<{ path?: unknown }>(request);

            if (typeof body.path !== "string") {
                throw new HttpError(400, "Name the folder to make.");
            }

            return json(response, 200, { path: await app.workspace.makePlace(user, body.path) });
        }

        if (first === "settings" && method === "POST") {
            const body = await readJson<{
                approvalRule?: unknown;
                defaultModel?: unknown;
                subagentModels?: unknown;
                sessionSendLimit?: unknown;
                wikiCaptureMinutes?: unknown;
                compactAt?: unknown;
                limitWaitHours?: unknown;
                limitNotice?: unknown;
                assistant?: unknown;
                voice?: unknown;
            }>(request);

            // One at a time: a second that fails must not leave the first changed.
            if (
                [
                    body.approvalRule,
                    body.defaultModel,
                    body.subagentModels,
                    body.sessionSendLimit,
                    body.wikiCaptureMinutes,
                    body.compactAt,
                    body.limitWaitHours,
                    body.limitNotice,
                    body.assistant,
                    body.voice,
                ].filter((value) => value !== undefined).length > 1
            ) {
                throw new HttpError(400, "Change one setting at a time.");
            }

            // The models subagents may run on besides their session's own: the owner's (checked in `app.ts`).
            if (body.subagentModels !== undefined) {
                await app.setSubagentModels(user, body.subagentModels);
            }

            if (body.approvalRule !== undefined) {
                await app.setApprovalRule(user, body.approvalRule);
            }

            if (body.wikiCaptureMinutes !== undefined) {
                await app.setWikiCaptureMinutes(user, body.wikiCaptureMinutes);
            }

            if (body.sessionSendLimit !== undefined) {
                await app.setSessionSendLimit(user, body.sessionSendLimit);
            }

            // When sessions compact by themselves (PP-78).
            if (body.compactAt !== undefined) {
                await app.setCompactAt(user, body.compactAt);
            }

            // How long a run waits for a provider's limit to clear, and whether the phone hears of a long wait (PP-135).
            if (body.limitWaitHours !== undefined) {
                await app.setLimitWaitHours(user, body.limitWaitHours);
            }

            if (body.limitNotice !== undefined) {
                await app.setLimitNotice(user, body.limitNotice);
            }

            // What the phone's assistant sheet does (PP-146): `{ assistant: { send: "auto" } }`, the settings to change.
            if (body.assistant !== undefined) {
                await app.setAssistant(user, body.assistant);
            }

            // Settings › Voice (PP-185): `{ voice: { model: "gpt-realtime-mini" } }`; models, voice and language are checked live.
            if (body.voice !== undefined) {
                await app.setVoice(user, body.voice);
            }

            // Null clears it: new sessions start with the last model picked again.
            if (body.defaultModel !== undefined) {
                await app.setDefaultModel(user, body.defaultModel);
            }

            return json(response, 200, { ok: true });
        }

        // Voice with the owner's ChatGPT sign-in (PP-185): the settings, the model check, minutes, and a call's set-up steps.
        if (first === "voice") {
            requireOwner(user);

            if (second === undefined && method === "GET") {
                return json(response, 200, { settings: app.config.voice, check: app.config.voiceCheck ?? null, voices: VOICES, usage: app.spend.voiceSummary() });
            }

            if (second === "check" && method === "POST") {
                await app.checkVoice(user);

                return json(response, 200, { check: app.config.voiceCheck ?? null });
            }

            if (second === "dictation" && third === undefined && method === "POST") {
                return json(response, 200, await app.voice.dictation(user.id));
            }

            if (second === "dictation" && third !== undefined && parts[3] === "end" && method === "POST") {
                app.voice.dictationEnd(user.id, third);

                return json(response, 200, { ok: true });
            }

            if (second === "calls" && third !== undefined && method === "POST") {
                const call = app.voice.call(user.id, third);

                if (parts[3] === "sdp") {
                    const body = await readJson<{ sdp?: unknown }>(request);

                    return json(response, 200, await app.voice.answer(user.id, third, body.sdp, await app.voicePlan(call.session as unknown as ConversationId)));
                }

                if (parts[3] === "joined") {
                    const body = await readJson<{ rtc?: unknown }>(request);

                    app.voice.joined(user.id, third, body.rtc);

                    return json(response, 200, { ok: true });
                }

                // Codex's own voice: the call's data channel events, which the page passes on (no sideband there).
                if (parts[3] === "events") {
                    app.voiceBridge.fromPage(call, (await readJson<{ events?: unknown }>(request)).events);

                    return json(response, 200, { ok: true });
                }

                // The mic turned off or on, or the call's turn-taking changed (PP-201): `{ muted, by, turns? }`.
                if (parts[3] === "mic") {
                    const kept = app.voice.mic(user.id, third, await readJson<unknown>(request));

                    return json(response, 200, { muted: kept.muted, by: kept.micBy, turns: kept.turns });
                }

                if (parts[3] === "end") {
                    app.voice.end(call.id);

                    return json(response, 200, { ok: true });
                }
            }
        }

        // One model allowed for subagents, or no longer: the rest stay as they are. The owner's (checked in `app.ts`).
        if (first === "subagent-models" && second === undefined && method === "POST") {
            const body = await readJson<{ model?: unknown; allowed?: unknown }>(request);

            return json(response, 200, {
                subagentModels: await app.allowSubagentModel(user, body.model, body.allowed),
            });
        }

        // Routes extension modules add, each checking who may use it (`extension-routes.ts`).
        if (first === "x" && second !== undefined) {
            return extensionRoute(route, parts.slice(1));
        }

        if (first === "extensions" && second === undefined && method === "GET") {
            return json(response, 200, await app.extensions(user));
        }

        // A drop-in uploaded in Settings › Extensions (PP-173): a module (.ts) or a .zip, the file's bytes as the body and
        // its name in `name`. The owner's. What it would replace needs `replace=1`; without it the answer says what.
        if (first === "extensions" && second === "drop-ins" && third === undefined && method === "POST") {
            requireOwner(user);
            const data = await readBody(request, MAX_DROP_IN_BYTES);
            const pkg = packageFromUpload(url.searchParams.get("name") ?? "", data);
            const done = await app.installDropIn(user, pkg, url.searchParams.get("replace") === "1");

            return json(response, 200, { ...done, leftOut: pkg.leftOut, ...(await app.extensions(user)) });
        }

        if (
            first === "extensions" &&
            second !== undefined &&
            third === undefined &&
            method === "POST"
        ) {
            requireOwner(user);
            const body = await readJson<{ enabled?: unknown }>(request);

            if (typeof body.enabled !== "boolean") {
                throw new HttpError(400, "enabled must be true or false");
            }

            await app.setExtensionEnabled(user, second, body.enabled);

            return json(response, 200, await app.extensions(user));
        }

        if (
            first === "extensions" &&
            second !== undefined &&
            third === "reload" &&
            method === "POST"
        ) {
            requireOwner(user);
            await app.reloadExtension(second);

            return json(response, 200, await app.extensions(user));
        }

        if (
            first === "models" &&
            second === "refresh" &&
            third === undefined &&
            method === "POST"
        ) {
            requireOwner(user);

            return json(response, 200, await app.providers.modelRefresh.refresh());
        }

        // The app's SSH keys (`ssh-keys.ts`): the owner's, as they open the machines.
        if (first === "ssh-keys" && method === "GET" && second === undefined) {
            requireOwner(user);

            return json(response, 200, { keys: await app.sshKeys.list() });
        }

        if (first === "ssh-keys" && method === "POST" && second === undefined) {
            requireOwner(user);
            const body = await readJson<{ name?: unknown; privateKey?: unknown }>(request);

            return json(
                response,
                200,
                body.privateKey === undefined
                    ? await app.sshKeys.generate(body.name)
                    : await app.sshKeys.import(body.name, body.privateKey),
            );
        }

        if (first === "ssh-keys" && method === "POST" && second !== undefined && third === "rename") {
            requireOwner(user);
            app.sshKeys.rename(second, (await readJson<{ name?: unknown }>(request)).name);

            return json(response, 200, { ok: true });
        }

        if (first === "ssh-keys" && method === "DELETE" && second !== undefined) {
            requireOwner(user);
            const using = app.machines.usingKey(second);

            if (using.length > 0) {
                throw new HttpError(
                    409,
                    `This key is used by ${using.map((machine) => machine.name).join(", ")}. Give those machines another key first.`,
                );
            }

            await app.sshKeys.remove(second);

            return json(response, 200, { ok: true });
        }

        // Machines (`machines.ts`): the owner's; nothing runs on one without their tap.
        // Whether each set-up machine answers now, and why not (`Places.health`): for the Machines sheet and the picker.
        // The tools pi-phone can install on machines (`machine-tools.ts`), for the list shown before connecting.
        if (first === "machines" && second === "tools" && method === "GET") {
            requireOwner(user);

            return json(response, 200, {
                tools: TOOLS.map(toolOffer),
            });
        }

        if (first === "machines" && second === "health" && method === "GET") {
            requireOwner(user);

            return json(response, 200, { health: await app.places.health(url.searchParams.get("fresh") === "1") });
        }

        // The team server's machines (PP-82) are in the list too, fresh from it as the sheet opens: `team` says whether
        // there are any here, and whether this person manages them.
        if (first === "machines" && method === "GET" && second === undefined) {
            requireOwner(user);
            await app.syncTeamMachines();

            return json(response, 200, { machines: app.machines.list(), team: { available: app.teamMachines.available, manage: app.teamMachines.manage } });
        }

        // A team machine (`team: true`), added on the team server, which makes and keeps its key: its public half comes back.
        if (first === "machines" && method === "POST" && second === undefined) {
            requireOwner(user);

            const body = await readJson<{ team?: unknown; name?: unknown; address?: unknown; keyId?: unknown }>(request);

            if (body.team === true) {
                const made = await app.teamMachines.call<{ machine: { id: string }; publicKey: string }>({ action: "add", name: body.name, address: body.address });

                await app.syncTeamMachines();

                return json(response, 200, { machine: app.machines.get(`team-${made.machine.id}`), publicKey: made.publicKey });
            }

            return json(response, 200, app.machines.add(body));
        }

        // A team machine's changes go to the team server (machines.manage there); then the list again.
        const teamId = second?.startsWith("team-") === true ? second.slice(5) : undefined;

        if (first === "machines" && teamId !== undefined && method === "POST" && (third === undefined || third === "accept" || third === "connect" || third === "folder")) {
            requireOwner(user);

            if (third === undefined) {
                await app.teamMachines.call({ action: "rename", id: teamId, name: (await readJson<{ name?: unknown }>(request)).name });
                await app.syncTeamMachines();

                return json(response, 200, app.machines.get(second!));
            }

            // The host key this person scanned through the team server, for everyone: its fingerprint without "(ED25519)".
            if (third === "accept") {
                const body = await readJson<{ lines?: unknown; fingerprint?: unknown }>(request);

                await app.teamMachines.call({ action: "accept", id: teamId, lines: body.lines, fingerprint: String(body.fingerprint ?? "").split(" ")[0] });
                await app.syncTeamMachines();

                return json(response, 200, app.machines.get(second!));
            }

            // Installed and connected from here, through the team server; what it found is kept there for everyone.
            if (third === "connect") {
                const connected = await app.machines.connect(second!);

                await app.teamMachines.call({ action: "connected", id: teamId, remote: connected.remote, daemon: connected.daemon });
                await app.syncTeamMachines();

                return json(response, 200, connected);
            }

            // This person's own folder there (`~/team/<name>`), made on first use: where the folder picker starts.
            const machine = app.machines.ready(second!);
            const path = machinePaths(machine.remote).join(machine.remote!.home, machine.team!.folder);
            const made = await app.places.env(formatPlace({ machineId: machine.id, path: machine.remote!.home })).createDir(path, { recursive: true }, BACKGROUND_CONTEXT);

            if (!made.ok) {
                throw new HttpError(502, `Could not make ${path} on ${machine.name}: ${made.error.message}`);
            }

            return json(response, 200, { path: formatPlace({ machineId: machine.id, path }) });
        }

        if (first === "machines" && teamId !== undefined && method === "DELETE") {
            requireOwner(user);
            await app.teamMachines.call({ action: "remove", id: teamId });
            await app.syncTeamMachines();

            return json(response, 200, { ok: true });
        }

        if (first === "machines" && second !== undefined && method === "POST") {
            requireOwner(user);

            if (third === undefined) {
                return json(response, 200, await app.machines.edit(second, await readJson(request)));
            }

            if (third === "scan") {
                return json(response, 200, await app.machines.scan(second));
            }

            if (third === "accept") {
                const body = await readJson<{ lines?: unknown; fingerprint?: unknown }>(request);

                return json(response, 200, await app.machines.accept(second, body.lines, body.fingerprint));
            }

            if (third === "forget") {
                await app.machines.forget(second);

                return json(response, 200, { ok: true });
            }

            if (third === "connect") {
                return json(response, 200, await app.machines.connect(second));
            }

            if (third === "detect") {
                return json(response, 200, await app.machines.detect(second));
            }

            // Tools pi-phone installs there (`machine-tools.ts`): what each is on the machine, and installing the ticked.
            if (third === "tools") {
                const body = await readJson<{ install?: unknown }>(request);

                if (body.install === undefined) {
                    return json(response, 200, { tools: await app.machineTools.status(second) });
                }

                if (!Array.isArray(body.install) || !body.install.every((each) => typeof each === "string")) {
                    throw new HttpError(400, "install is a list of tool ids");
                }

                return json(response, 200, await app.machineTools.install(second, body.install as string[]));
            }
        }

        if (first === "machines" && method === "DELETE" && second !== undefined) {
            requireOwner(user);
            await app.machines.remove(second);

            return json(response, 200, { ok: true });
        }

        // GitHub for the app's gh and git: the owner's, as the credentials reach every repository they can.
        if (first === "github" && method === "GET" && second === undefined) {
            requireOwner(user);

            return json(response, 200, await app.github.status());
        }

        if (first === "github" && method === "POST" && second === "login") {
            requireOwner(user);

            return json(response, 200, await app.github.start());
        }

        if (first === "github" && method === "POST" && second === "cancel") {
            requireOwner(user);
            app.github.cancel();

            return json(response, 200, { ok: true });
        }

        if (first === "github" && method === "POST" && second === "logout") {
            requireOwner(user);
            await app.github.logout();

            return json(response, 200, { ok: true });
        }

        // For the owner, each subscription's sign-in is asked afresh first (three seconds at most; a mark found later
        // comes with the models): one that can no longer be renewed shows as needing sign-in. Others see what was last
        // found, so nobody else makes the server ask providers.
        if (first === "providers" && second === undefined && method === "GET") {
            if (user.role === "owner") {
                await app.providers.checkAll(3_000);
                // Team accounts a teammate changed since (PP-74).
                await app.refreshTeamAccounts();
            }

            const own = app.providers.list(user.role === "owner");

            if (!app.teamAccounts.available || user.role !== "owner") {
                return json(response, 200, own);
            }

            // The team's accounts (PP-69), each under its provider like an account of the person's own. Someone who
            // manages them gets Add team account on every provider that can sign in.
            const team = await app.teamAccounts.list();

            return json(response, 200, [
                // A subscription (Claude, ChatGPT, Copilot: the providers that have accounts) is one person's: its form warns.
                ...own.map((provider) =>
                    team.manage && !provider.account && (provider.apiKey || provider.oauth !== null)
                        ? { ...provider, teamAdd: app.accounts.providers().includes(provider.id) ? "subscription" : "key" }
                        : provider,
                ),
                ...team.accounts.map((account) => ({
                    id: account.id,
                    name: `${account.providerName} · Team ${account.name}`,
                    account: { name: account.name, of: account.provider },
                    team: { roles: account.roles, manage: team.manage },
                    configured: account.configured,
                    source: "team server",
                    label: null,
                    apiKey: account.signIn.apiKey,
                    oauth: account.signIn.oauth,
                    models: account.models,
                })),
            ]);
        }

        // The team's provider accounts (PP-69): managed on the gateway, as this person may there.
        if (first === "team-accounts" && second === undefined && method === "POST") {
            requireOwner(user);
            const body = await readJson<{ provider?: unknown; name?: unknown }>(request);

            return json(response, 200, await app.teamAccounts.add(body.provider, body.name));
        }

        if (first === "team-accounts" && second !== undefined && third === undefined && method === "POST") {
            requireOwner(user);
            const body = await readJson<{ name?: unknown }>(request);

            return json(response, 200, await app.teamAccounts.rename(decodeURIComponent(second), body.name));
        }

        if (first === "team-accounts" && second !== undefined && (third === "remove" || third === "logout") && method === "POST") {
            requireOwner(user);
            await (third === "remove" ? app.teamAccounts.remove(decodeURIComponent(second)) : app.teamAccounts.logout(decodeURIComponent(second)));
            await app.syncTeamAccounts();

            return json(response, 200, { ok: true });
        }

        if (first === "team-accounts" && second !== undefined && third === "login" && method === "POST") {
            requireOwner(user);
            const body = await readJson<{ type?: string; name?: string }>(request);
            const id = decodeURIComponent(second);

            return json(response, 200, {
                flowId: await app.teamAccounts.startLogin(id, String(body.name ?? id), body.type === "oauth" ? "oauth" : "api_key", () => void app.syncTeamAccounts()),
            });
        }

        // The subscription accounts' plan limits (`usage-limits.ts`): Providers and the model menu ask `fresh` as they open.
        if (first === "usage-limits" && second === undefined && method === "GET") {
            const fresh = url.searchParams.get("fresh") === "1";

            // The model menu opening: team accounts a teammate signed in or out since show (PP-74).
            if (fresh && user.role === "owner") {
                await app.refreshTeamAccounts();
            }

            // With the team subscriptions this person may use (PP-74), asked of the team server.
            return json(response, 200, { usage: [...(await app.usageLimits.all(fresh)), ...(await app.teamAccounts.usage(fresh))] });
        }

        // More accounts of a subscription provider (`accounts.ts`): the owner's. Each is a provider of its own, signed in
        // with the providers' login route.
        if (first === "accounts" && second === undefined && method === "POST") {
            requireOwner(user);
            const body = await readJson<{ provider?: unknown; name?: unknown }>(request);
            const account = app.accounts.add(body.provider, body.name);

            app.providers.modelsChanged();

            return json(response, 200, { account });
        }

        if (first === "accounts" && second !== undefined && third === undefined && method === "POST") {
            requireOwner(user);
            const body = await readJson<{ name?: unknown }>(request);
            const account = app.accounts.rename(decodeURIComponent(second), body.name);

            app.providers.modelsChanged();

            return json(response, 200, { account });
        }

        if (first === "accounts" && second !== undefined && third === "remove" && method === "POST") {
            requireOwner(user);
            await app.accounts.remove(decodeURIComponent(second));
            app.providers.modelsChanged();

            return json(response, 200, { ok: true });
        }

        if (
            first === "providers" &&
            second !== undefined &&
            third === "login" &&
            method === "POST"
        ) {
            requireOwner(user);
            const body = await readJson<{ type?: string }>(request);

            return json(response, 200, {
                flowId: app.providers.startLogin(
                    user,
                    second,
                    body.type === "oauth" ? "oauth" : "api_key",
                ),
            });
        }

        if (
            first === "providers" &&
            second !== undefined &&
            third === "logout" &&
            method === "POST"
        ) {
            requireOwner(user);
            await app.providers.logout(second);

            return json(response, 200, { ok: true });
        }

        if (first === "auth" && second !== undefined && third === "cancel" && method === "POST") {
            // A team account's sign-in runs on the gateway (PP-69).
            if (app.teamAccounts.owns(second)) {
                await app.teamAccounts.cancel(second);

                return json(response, 200, { ok: true });
            }

            app.providers.cancelLogin(user, second);

            return json(response, 200, { ok: true });
        }

        if (first === "auth" && second !== undefined && third !== undefined && method === "POST") {
            const body = await readJson<{ value?: string; cancel?: boolean }>(request);

            if (app.teamAccounts.owns(second)) {
                await app.teamAccounts.answer(second, third, body.cancel === true ? undefined : String(body.value ?? ""));

                return json(response, 200, { ok: true });
            }

            app.providers.answerLogin(
                user,
                second,
                third,
                body.cancel === true ? undefined : String(body.value ?? ""),
            );

            return json(response, 200, { ok: true });
        }

        if (first === "invite" && second === "cancel" && method === "POST") {
            const body = (await readJson(request)) as { code?: unknown };

            if (typeof body.code !== "string") {
                throw new HttpError(400, "Say which invite.");
            }

            // Only whoever made it ends it; for anyone else it stays as it was, and nothing says whether it exists.
            auth.cancelInvite(body.code, user);

            return json(response, 200, { ok: true });
        }

        if (first === "invite" && second === undefined && method === "POST") {
            const body = (await readJson(request)) as {
                role?: unknown;
                session?: unknown;
                minutes?: unknown;
            };
            const grant = inviteGrant(user, body);
            const invite = auth.createInvite(user, grant, inviteMinutes(body));
            const here = origin(request);
            const loopback = /^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/.test(
                here,
            );
            const wildcard = options.listen.host === "0.0.0.0" || options.listen.host === "::";
            const lan =
                loopback && wildcard
                    ? lanAddresses().map((address) => `http://${address}:${options.listen.port}`)
                    : [];
            // A tunnel the launcher started is the way in for other devices.
            const tunnel = loopback ? app.access?.url : undefined;
            const base = tunnel ?? lan[0] ?? here;
            const link = `${base}/join/${invite.code}`;
            // An invite whose QR code could not be made is never shown: it ends rather than stay live, unseen.
            const svg = await QRCode.toString(link, {
                type: "svg",
                margin: 1,
                color: { dark: "#000000", light: "#ffffff" },
            }).catch((error: unknown) => {
                auth.cancelInvite(invite.code, user);

                throw error;
            });

            return json(response, 200, {
                ...invite,
                grant,
                url: link,
                svg,
                alternatives: (tunnel === undefined ? lan.slice(1) : lan).map(
                    (address) => `${address}/join/${invite.code}`,
                ),
                // Only this device can open a loopback link.
                local: loopback && lan.length === 0 && tunnel === undefined,
                ...(app.access === undefined ? {} : { access: app.access }),
            });
        }

        // Backup and restore (`backup.ts`): the owner's, as the archive has their sign-ins and keys.
        if (first === "backup" && method === "GET") {
            requireOwner(user);
            const made = await makeBackup(app.home, app.dataDir, tmpdir());

            try {
                response.writeHead(200, {
                    "content-type": "application/gzip",
                    "content-length": statSync(made.file).size,
                    "content-disposition": `attachment; filename="${made.name}"`,
                    "cache-control": "no-store",
                });
                await pipeline(createReadStream(made.file), response);
            } finally {
                rmSync(made.file, { force: true });
            }

            return;
        }

        if (first === "restore" && method === "POST") {
            requireOwner(user);

            if (!app.supervised) {
                throw new HttpError(409, "Restoring needs the pi-phone app, which starts the server again.");
            }

            const chunks: Buffer[] = [];
            let size = 0;

            for await (const chunk of request) {
                size += (chunk as Buffer).length;

                if (size > MAX_RESTORE) {
                    throw new HttpError(413, "This backup is too large.");
                }

                chunks.push(chunk as Buffer);
            }

            await stageRestore(app.home, Buffer.concat(chunks), tmpdir());
            json(response, 200, { ok: true });
            // The restored files go in at the next start, before anything opens them.
            setTimeout(() => options.restart(), 100);

            return;
        }

        if (first === "restart" && method === "POST") {
            requireOwner(user);

            if (!app.supervised) {
                throw new HttpError(
                    409,
                    "Restarting from here needs the pi-phone app, which starts the server again.",
                );
            }

            json(response, 200, { ok: true });
            setTimeout(() => options.restart(), 100);

            return;
        }

        throw new HttpError(404, "Unknown API route");
    };
}
