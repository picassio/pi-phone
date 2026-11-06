/**
 * Artifacts: HTML pages, Markdown documents, and SVG images the agent publishes for the user to open in the app.
 * Every call with the same id adds a version. The index and the bodies are durable documents committed together with
 * the call, so a replayed call finds the version it already wrote instead of writing another.
 */
import { arr, obj, opt, str, union } from "@earendil-works/pi-schema";
import { literal } from "../tool-schema.ts";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { ArtifactBodyDoc, type ArtifactMeta, ArtifactsDoc, type ArtifactType } from "../docs.ts";
import type { PocketHost } from "../host.ts";
import { describeLayout } from "../layout-check.ts";
import { DEFAULT_WIDTHS } from "../screenshots.ts";

const MAX_BYTES = 2_000_000;
/** The artifact check's wait for each width (PP-421): past it the publish answers without that width's numbers. */
const CHECK_TIMEOUT_MS = 40_000;
/** Artifacts the check renders: those the phone lays out as a page. Markdown is text to read. */
const CHECKED: ReadonlySet<ArtifactType> = new Set(["html", "svg", "openui"]);

/**
 * The "Check artifacts on publish" hook (PP-421, Settings › Hooks): the version just published, rendered at the
 * screenshot widths as the screenshot tool renders it, each width a request of its own so one that is slow costs only
 * its own numbers. What the layout check found, in the screenshot tool's words, without the pictures; a width that
 * could not be rendered says why, and the publish stands.
 */
async function checkArtifact(host: PocketHost, conversation: string, id: string, version: number, timeoutMs: number): Promise<string> {
    const base = host.serverBase();
    const head = 'Layout check (the hook "Check artifacts on publish", Settings › Hooks; screenshot shows the pictures):';

    if (base === undefined) {
        return `${head} not run: this server has no address for the phone to render from.`;
    }

    const url = `${base}/a/${conversation}/${encodeURIComponent(id)}/${version}`;
    const results = await Promise.allSettled(DEFAULT_WIDTHS.map((width) => host.render(url, { widths: [width], fullPage: true, timeoutMs })));
    const whys = results.map((result) => (result.status === "rejected" ? (result.reason instanceof Error ? result.reason.message : String(result.reason)) : undefined));

    // Every width failed alike (no phone renders now): said once.
    if (whys.every((why) => why !== undefined && why === whys[0])) {
        return `${head} not run. ${whys[0]} The artifact is published; look with screenshot once the phone renders.`;
    }

    const lines = results.map((result, index) => {
        const width = DEFAULT_WIDTHS[index]!;

        if (result.status === "rejected") {
            const why = result.reason instanceof Error ? result.reason.message : String(result.reason);

            return `Layout check at ${width} px: not measured. ${why} The artifact is published; look with screenshot.`;
        }

        const layout = result.value[0]?.layout;

        return layout === undefined ? `Layout check at ${width} px: not measured (an older app).` : describeLayout(layout);
    });

    return `${head}\n${lines.join("\n")}`;
}

export function slugify(value: string): string {
    return value
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 64);
}

function applyEdits(
    content: string,
    edits: readonly { oldText: string; newText: string }[],
): string {
    let next = content;

    for (const [index, edit] of edits.entries()) {
        if (edit.oldText === "") {
            throw new Error(`Edit ${index + 1}: oldText is empty.`);
        }

        const first = next.indexOf(edit.oldText);

        if (first === -1) {
            throw new Error(`Edit ${index + 1}: oldText was not found in the latest version.`);
        }

        if (next.indexOf(edit.oldText, first + 1) !== -1) {
            throw new Error(
                `Edit ${index + 1}: oldText matches more than once; include more context.`,
            );
        }

        next = next.slice(0, first) + edit.newText + next.slice(first + edit.oldText.length);
    }

    return next;
}

const GUIDE = `Use the artifact tool for results the user should see rendered rather than read as text: interactive demos, games, visualizations, charts, diagrams, formatted reports. Do not use it for plain answers or for project files (write those with write).
- HTML artifacts open in a sandboxed frame on the user's device (often a phone). They cannot reach this app, its cookies, or the parent page. Make them self-contained, responsive (include a viewport meta tag), and touch-friendly.
- Load libraries from a CDN with full URLs, such as https://esm.sh or https://cdn.jsdelivr.net. For ES modules that import bare specifiers (three.js addons import "three"), add an import map, for example: <script type="importmap">{"imports":{"three":"https://esm.sh/three@0.170.0","three/addons/":"https://esm.sh/three@0.170.0/examples/jsm/"}}</script>
- Show loading and error states inside the page (window.onerror, a visible message), so a broken artifact explains itself.
- Reuse the id to publish a new version. For small fixes, send edits against the latest version instead of the whole content.
- The person can keep an artifact as a page on their rail (app_action pages.keep does it for them, after a card); the page follows its newest version. An artifact's one way into the app, in the viewer and on a page: parent.postMessage({ type: "pi-compose", text }, "*") puts text into the message box of the session they are in, for them to send (in an openui artifact, @ToAssistant does that on a page).`;

export default function createArtifacts(host: PocketHost) {
    const artifact = defineTool({
        name: "artifact",
        description:
            "Publish a viewable artifact (self-contained HTML page, Markdown document, SVG image, or an interactive answer in OpenUI Lang: call openui_guide first) that the user opens in the app's artifact viewer. " +
            "Calling again with the same id publishes a new version. Give either the full content or edits against the latest version.",
        parameters: obj({
            id: str({
                description:
                    "Stable kebab-case id, for example solar-system. Reuse it for new versions.",
            }),
            title: str({ description: "Short human-readable title." }),
            type: opt(union([literal("html"), literal("markdown"), literal("svg"), literal("openui")], {
                    description: "Default html, or the type of the existing artifact.",
                })),
            content: opt(str({ description: "The complete content of the new version." })),
            edits: opt(arr(obj({ oldText: str(), newText: str() }, { open: true }), {
                    description:
                        "Exact, unique replacements applied to the latest version instead of sending content.",
                })),
        }, { open: true }),
        // The commit below is idempotent per call, so a rerun after a crash is harmless.
        replay: "safe",
        execute: async (args, api, context) => {
            const id = slugify(args.id);

            if (id === "") {
                throw new Error("The id must contain letters or digits.");
            }

            const index = (await api.snapshot(ArtifactsDoc, api.conversationId, context)) ?? {
                items: {},
            };
            const previous = Object.hasOwn(index.items, id)
                ? (index.items[id] as ArtifactMeta)
                : undefined;
            // A replay of this very call, not another call of the same task (codemode makes several in one).
            const mine = (version: { taskId: unknown; callId?: string }) =>
                version.taskId === api.taskId && (version.callId ?? api.callId) === api.callId;
            const replayed = previous?.versions.find(mine);
            let version = replayed?.version;

            if (version === undefined) {
                let content: string;

                if (args.content !== undefined) {
                    content = args.content;
                } else if (args.edits !== undefined && args.edits.length > 0) {
                    const latest = previous?.versions.at(-1);

                    if (latest === undefined) {
                        throw new Error(`There is no artifact ${id} to edit yet; send content.`);
                    }

                    const body = await api.snapshot(
                        ArtifactBodyDoc,
                        api.conversationId,
                        `${id}@${latest.version}`,
                        context,
                    );

                    content = applyEdits(body?.content ?? "", args.edits);
                } else {
                    throw new Error("Give either content or edits.");
                }

                if (Buffer.byteLength(content) > MAX_BYTES) {
                    throw new Error(`Artifacts are limited to ${MAX_BYTES} bytes.`);
                }

                const type: ArtifactType = args.type ?? previous?.type ?? "html";

                version = await api.commit(async (tx) => {
                    const doc = await tx.doc(ArtifactsDoc, api.conversationId);
                    const current = Object.hasOwn(doc.items, id) ? doc.items[id] : undefined;
                    const again = current?.versions.find(mine);

                    if (again !== undefined) {
                        return again.version;
                    }

                    const next = (current?.versions.at(-1)?.version ?? 0) + 1;
                    const record = {
                        version: next,
                        taskId: api.taskId,
                        callId: api.callId,
                        size: content.length,
                        createdAt: Date.now(),
                    };

                    if (current === undefined) {
                        doc.items[id] = { title: args.title, type, versions: [record] };
                    } else {
                        current.title = args.title;
                        current.type = type;
                        current.versions.push(record);
                    }

                    const body = await tx.doc(
                        ArtifactBodyDoc,
                        api.conversationId,
                        `${id}@${next}`,
                        { content },
                    );

                    if (body.content !== content) {
                        body.content = content;
                    }

                    return next;
                }, context);
            }

            const published = `Published "${args.title}" as artifact ${id}, version ${version}. The user opens it from the artifact card.`;
            const type = (await api.snapshot(ArtifactsDoc, api.conversationId, context))?.items[id]?.type;
            // The hook (PP-421): the numbers come with the publish, so Pi cannot skip looking at them.
            const checked =
                type !== undefined && CHECKED.has(type) && host.hookOn("artifactCheck")
                    ? await checkArtifact(host, String(api.conversationId), id, version, CHECK_TIMEOUT_MS)
                    : undefined;

            return {
                output: [
                    {
                        type: "text",
                        text: checked === undefined ? published : `${published}\n\n${checked}`,
                    },
                ],
                details: { id, title: args.title, version },
            };
        },
    });

    return defineExtension({
        name: "pocket-artifacts",
        tools: [artifact],
        sections: [section("artifacts", () => GUIDE)],
    });
}
