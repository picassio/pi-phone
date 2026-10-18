// Interactive answers: Open Intelligent UI's library (third_party/, MIT) draws OpenUI Lang programs in a sandboxed frame,
// whose data comes through the app. Here: the frame builds; the guide's own examples, a map, a chart, and math render
// with the library (in Node); the frame's page, files, and routes are served as the frame needs them.
import { type App, cleanUp, context, lastText, modelTexts, newSession, openApp, owner, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, before, test } from "node:test";
import { build } from "esbuild";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { buildIntelligentUi, OUT } from "../scripts/intelligent-ui.ts";
import { intelligentUiFile } from "../src/server/http/assets.ts";
import { openUiPage } from "../src/server/http/artifacts.ts";
import { imageSearch, openUiRoute, streetRoute, wiki } from "../src/server/openui.ts";

const guide = readFileSync(join(import.meta.dirname, "..", "third_party", "open-intelligent-ui", "system-prompt.txt"), "utf8");
/** The guide's worked examples, as written there. */
const examples = [...guide.matchAll(/^Example \d+: .*\n\n(root = [^]*?)\n\n/gm)].map((match) => match[1]!);
const MAP = `root = Col([title, map, chart, formula])
title = Title("Two stops in Lisbon", "lg")
map = Map([MapMarker("Belém Tower", 38.6916, -9.2160, "sight", "🏰"), MapMarker("Alfama", 38.7114, -9.1305)], true)
chart = Chart("bar", [{month: "Jan", spend: 120}, {month: "Feb", spend: 90}], "month", ["spend"], "currency", "EUR")
formula = Math("E = mc^2")`;

const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);

    if (role === "user" && text.endsWith("guide")) {
        return fauxAssistantMessage([fauxToolCall("openui_guide", {})], { stopReason: "toolUse" });
    }

    return fauxAssistantMessage([fauxText(role === "toolResult" ? `tool said: ${text.slice(0, 400)}` : "ok")]);
};

let app: App;
let render: (program: string, initialState?: Record<string, unknown>) => { html: string; errors: string[] };
let mount: (
    program: string,
    initialState: Record<string, unknown> | undefined,
    onState: (state: Record<string, unknown>) => void,
) => Promise<{ text: () => string; press: (label: string) => Promise<void>; unmount: () => void }>;
const realFetch = globalThis.fetch;

before(async () => {
    app = await openApp(scriptedModel(route));
    await buildIntelligentUi();

    // The library for Node: stylesheets out, React from node_modules, so the bundle sits where those resolve.
    const bundle = join(import.meta.dirname, "..", "node_modules", ".cache", "pi-phone-tests", `openui-render-${process.pid}.mjs`);

    await build({
        entryPoints: [join(import.meta.dirname, "fixtures", "openui-render.tsx")],
        outfile: bundle,
        bundle: true,
        format: "esm",
        platform: "node",
        jsx: "automatic",
        // Every stylesheet, the packages' too, is nothing in Node.
        plugins: [
            {
                name: "no-css",
                setup(build) {
                    build.onResolve({ filter: /\.css$/ }, (args) => ({ path: args.path, namespace: "no-css" }));
                    build.onLoad({ filter: /.*/, namespace: "no-css" }, () => ({ contents: "", loader: "js" }));
                },
            },
        ],
        external: ["react", "react/*", "react-dom", "react-dom/*", "@openuidev/*", "zod", "zod/*", "maplibre-gl", "lucide-react", "lucide-react/*"],
        define: { "process.env.NEXT_PUBLIC_BASE_PATH": "undefined" },
        logLevel: "error",
        absWorkingDir: join(import.meta.dirname, ".."),
    });
    ({ render, mount } = (await import(bundle)) as { render: typeof render; mount: typeof mount });
});

afterEach(() => {
    globalThis.fetch = realFetch;
});

after(async () => {
    rmSync(join(import.meta.dirname, "..", "node_modules", ".cache", "pi-phone-tests", `openui-render-${process.pid}.mjs`), { force: true });
    await app?.close();
    cleanUp();
});

test("the frame builds: its module, styles, fonts, and MapLibre's worker as one module", () => {
    for (const file of ["frame.js", "frame.css", "maplibre-worker.js"]) {
        assert.ok(existsSync(join(OUT, file)) && statSync(join(OUT, file)).size > 1000, file);
    }

    assert.doesNotMatch(readFileSync(join(OUT, "maplibre-worker.js"), "utf8"), /^import |from"\.\//m, "the worker imports nothing: it starts from a Blob URL");
    assert.ok(intelligentUiFile(["frame.js"]) !== undefined);
    assert.equal(intelligentUiFile(["..", "..", "package.json"]), undefined);
    assert.equal(intelligentUiFile(["missing.js"]), undefined);
});

test("the guide's examples, a map, a chart, and math render with the library, without errors", () => {
    assert.equal(examples.length, 3, "the guide's three worked examples");

    for (const program of [...examples, MAP]) {
        const { html, errors } = render(program);

        assert.deepEqual(errors, [], program.slice(0, 60));
        assert.ok(html.length > 200, program.slice(0, 60));
    }

    // Rendered on a server, $state is not filled in yet (React sets it once mounted): the words around it are.
    assert.match(render(examples[0]!).html, /Pasta night for /);
    assert.match(render(examples[2]!).html, /Build a small bookcase/);
    assert.match(render(MAP).html, /Two stops in Lisbon/);
});

test("an answer drawn again with what was kept shows it: a change reaches the app, and comes back", async () => {
    const { parseHTML } = await import("linkedom");
    const page = parseHTML("<!doctype html><html><body></body></html>");
    const globals = ["window", "document", "navigator", "location", "HTMLElement", "Node", "Element", "MouseEvent", "Event", "requestAnimationFrame"] as const;
    // React reads the page's address once loaded; linkedom has none.
    Object.defineProperty(page.window, "location", { value: new URL("http://localhost/"), configurable: true });
    const before = Object.fromEntries(globals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));

    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

    for (const name of globals) {
        const value = name === "requestAnimationFrame" ? (done: () => void) => setTimeout(done, 0) : name === "window" ? page.window : (page as unknown as Record<string, unknown>)[name] ?? (page.window as unknown as Record<string, unknown>)[name];

        Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    }

    try {
        const states: Record<string, unknown>[] = [];
        const fresh = await mount(examples[0]!, undefined, (state) => states.push(state));

        assert.match(fresh.text(), /Pasta night for 4 guests/, "the program's own start");
        await fresh.press("More");
        assert.match(fresh.text(), /Pasta night for 5 guests/);
        assert.equal(states.at(-1)?.$guests, 5, "a change reaches the app");
        fresh.unmount();

        // Drawn again with what the app kept: as it was left.
        const again = await mount(examples[0]!, states.at(-1), () => {});

        assert.match(again.text(), /Pasta night for 5 guests/);
        again.unmount();
    } finally {
        // React's and the components' timers finish on the page before it goes.
        await new Promise((done) => setTimeout(done, 300));

        for (const name of globals) {
            const was = before[name];

            if (was === undefined) {
                delete (globalThis as Record<string, unknown>)[name];
            } else {
                Object.defineProperty(globalThis, name, was);
            }
        }
    }
});

test("what was typed and picked is kept per answer, in the conversation, for those who may steer", async () => {
    const id = await newSession(app);
    const key = "p-abc123-9z";

    assert.equal(await app.answerState(id, key, owner(app)), null);
    await app.saveAnswerState(id, key, owner(app), { $guests: 7, prefs: { pace: { value: "Packed", componentType: "RadioGroup" } } });
    assert.deepEqual(await app.answerState(id, key, owner(app)), { $guests: 7, prefs: { pace: { value: "Packed", componentType: "RadioGroup" } } });
    await app.saveAnswerState(id, key, owner(app), { $guests: 8 });
    assert.deepEqual(await app.answerState(id, key, owner(app)), { $guests: 8 }, "the newest replaces it");

    await assert.rejects(app.answerState(id, "../x", owner(app)), /Not an answer's key/);
    await assert.rejects(app.saveAnswerState(id, key, owner(app), ["not", "an", "object"]), /state is an object/);
    await assert.rejects(app.saveAnswerState(id, key, owner(app), { big: "x".repeat(70 * 1024) }), /too large/);

    const { user: viewer } = app.config.addUser("Watcher", "viewer");

    try {
        assert.deepEqual(await app.answerState(id, key, viewer), { $guests: 8 }, "a viewer sees it");
        await assert.rejects(app.saveAnswerState(id, key, viewer, { $guests: 1 }), /steer|view/i);
    } finally {
        app.config.removeUser(viewer.id);
    }

    // The oldest go once there are too many.
    for (let index = 0; index < 201; index++) {
        await app.saveAnswerState(id, `p-many-${index}`, owner(app), { $n: index });
    }

    assert.equal(await app.answerState(id, key, owner(app)), null, "the oldest is gone");
    assert.deepEqual(await app.answerState(id, "p-many-200", owner(app)), { $n: 200 });
});

test("the frame's page: sandboxed, the program as JSON that cannot end its script, and the bundle's files with CORS", () => {
    const page = openUiPage('root = Col([t])\nt = Title("</script><script>alert(1)</script>")', "A <b>test</b>");

    assert.match(page, /<script type="application\/json" id="program">/);
    assert.doesNotMatch(page, /<\/script><script>alert/, "the program's text cannot close the script");
    assert.match(page, /<title>A &#60;b&#62;test&#60;\/b&#62;<\/title>/);
    assert.match(page, /src="\/vendor\/intelligent-ui\/frame\.js"/);
    assert.doesNotMatch(openUiPage(null), /id="program"/, "without a program, it waits for one");
});

test("the routes the components fetch: Wikipedia photos, image search, street routes, checked and cached", async () => {
    let asked = 0;

    globalThis.fetch = (async (input: string | URL | Request) => {
        asked++;
        const url = String(input instanceof Request ? input.url : input);

        if (url.includes("/page/summary/")) {
            return Response.json({ thumbnail: { source: "https://upload.wikimedia.org/a.jpg" }, coordinates: { lat: 38.69, lon: -9.21 } });
        }

        if (url.includes("/page/media-list/")) {
            return Response.json({ items: [{ type: "image", srcset: [{ src: "//upload.wikimedia.org/b.jpg" }] }, { type: "image", srcset: [{ src: "//upload.wikimedia.org/logo.svg" }] }] });
        }

        if (url.includes("router.project-osrm.org")) {
            return Response.json({ code: "Ok", routes: [{ geometry: { coordinates: [[-9.2, 38.6], [-9.1, 38.7]] } }] });
        }

        return new Response("no", { status: 500 });
    }) as typeof fetch;

    assert.deepEqual(await wiki("Belém Tower"), { status: 200, body: { lat: 38.69, lng: -9.21, photos: ["https://upload.wikimedia.org/a.jpg", "https://upload.wikimedia.org/b.jpg"] } });
    const before = asked;

    await wiki("Belém Tower");
    assert.equal(asked, before, "cached");
    assert.equal((await wiki("")).status, 400);
    assert.deepEqual(await streetRoute("-9.2,38.6;-9.1,38.7"), { status: 200, body: { points: [[38.6, -9.2], [38.7, -9.1]] } });
    assert.equal((await streetRoute("1,2")).status, 400, "two stops at least");
    assert.equal((await imageSearch("x")).status, 400);
    assert.equal((await imageSearch("pena palace")).status, 502, "a failing source says so");
    assert.equal(openUiRoute("other", new URLSearchParams()), undefined);
});

test("the guide comes on request, with how it applies here; the prompt says when to use it", async () => {
    const id = await newSession(app);
    const { submissionId } = await app.commands.submit(id, owner(app), { text: "guide", requestId: crypto.randomUUID() });

    await (await app.harness.submission(submissionId, context))!.wait(context);
    await app.harness.waitForIdle(context);
    const answer = (await modelTexts(app, id)).at(-1)!;

    assert.match(answer, /OpenUI Lang in pi-phone/);
    assert.match(answer, /fenced code block whose language is openui/);
});
