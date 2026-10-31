# pi-codex-imagegen (ported)

Source: [IgorWarzocha/howaboua-pi-stuff](https://github.com/IgorWarzocha/howaboua-pi-stuff), package
`packages/pi-codex-imagegen` (version 0.0.12), by Igor Warzocha, under the MIT license in [LICENSE](LICENSE).

What pi-phone took, ported to `src/server/image-gen.ts` (the ChatGPT route of `image_generate`, PP-275):

- the Codex images endpoint, `POST <chatgpt.com/backend-api/codex>/images/generations` and `/images/edits` (from
  `src/execute.ts`);
- the request body: `prompt`, `model` (`gpt-image-2.5`), `background`, `quality: "auto"`, `size: "auto"`, and for an edit
  up to five `images` as `{ image_url: <data URL> }` (from `src/request.ts` and `src/contract.ts`);
- the headers: `Authorization`, `ChatGPT-Account-ID`, `originator: codex_cli_rs`, `User-Agent`, `version` (from
  `src/codex-runtime/headers.ts`);
- the answer, `{ data: [{ b64_json }] }` (from `src/execute.ts`).

Not taken: its Pi extension, Code Mode and Notebook Mode wiring, provider aliases (`pi-codex-tools.json`), the
Cloudflare cookie store and proxy transport, and its rendering. pi-phone reads the ChatGPT sign-in itself, saves the
pictures in the session's `images/` and shows them in its own chat.
