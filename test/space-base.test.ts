// The app under a base path (PP-54): with the gateway's `/space/<key>/` the page's <base href> is that and it offers no
// install; otherwise (your own pi-phone, the phone) it stays "/". Its policy lets the page set its own base, and the
// page's own paths are relative, so they resolve under it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { test } from "node:test";
import { serveApp } from "../src/server/http/assets.ts";

function page(base?: string): { body: string; policy: string } {
    let body = "";
    let headers: Record<string, string> = {};
    const response = {
        writeHead: (_status: number, given: Record<string, string>) => {
            headers = given;
        },
        end: (given: string) => {
            body = given;
        },
    } as unknown as ServerResponse;

    serveApp(response, base);

    return { body, policy: headers["content-security-policy"] ?? "" };
}

test("the page's base: a shared space's under the gateway, '/' otherwise", () => {
    const own = page();

    assert.match(own.body, /<base href="\/" \/>/);
    assert.match(own.body, /<link rel="manifest"/);
    assert.match(own.policy, /base-uri 'self'/);

    const space = page("/space/04656eb7cba9cf09cd17a8e1/");

    assert.match(space.body, /<base href="\/space\/04656eb7cba9cf09cd17a8e1\/" \/>/);
    assert.doesNotMatch(space.body, /rel="manifest"/, "no install of the sharer's app");

    for (const wrong of ["/elsewhere/", "https://evil.example/", "/space/x/", "/space/../"]) {
        assert.match(page(wrong).body, /<base href="\/" \/>/, wrong);
    }
});

test("the page's own paths are relative, so they resolve under its base", () => {
    // Import-map addresses must start with ./ (a bare "vendor/x.mjs" is invalid there and blocks the module).
    const html0 = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
    const map = JSON.parse(/<script type="importmap">([\s\S]*?)<\/script>/.exec(html0)![1]!) as { imports: Record<string, string> };

    assert.ok(Object.values(map.imports).every((address) => address.startsWith("./")), JSON.stringify(map.imports));

    const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
    const own = [...html.matchAll(/(?:href|src)="([^"]+)"|"(\/vendor\/[^"]+)"|url\("([^"]+)"\)/g)].map((match) => match[1] ?? match[2] ?? match[3]);

    assert.ok(own.length > 5);
    assert.deepEqual(
        own.filter((path) => path!.startsWith("/") && path !== "/"),
        [],
        "nothing from the root",
    );
});
