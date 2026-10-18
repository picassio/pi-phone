# Open Intelligent UI, in pi-phone

The component library of [thesysdev/open-intelligent-ui](https://github.com/thesysdev/open-intelligent-ui) (MIT, see
`LICENSE`), from commit `0321343` ("Add MIT license (#45)"). pi-phone builds it with `scripts/intelligent-ui.ts` into
the frame that draws interactive answers (OpenUI Lang 1.0): `web/vendor/intelligent-ui/`, built in CI, not committed.

Kept from `src/lib`: `library.ts`, `actions.ts`, `base-path.ts`, `components/`, `functions/` (without its tests).
Left out: the chat shell's storage, the demo data tools, devtools, the prompt options (the prompt is prebuilt:
`system-prompt.txt`, from `src/generated/`), and the server-only origin check.

pi-phone's changes, each marked `pi-phone:` in the code:
- `library.ts`: no re-export of the prompt options, which are left out.
- `components/map/basemap.ts`: MapLibre's worker is fetched and started from a Blob URL, as the frame has an opaque
  origin.

Everything else is as it was. The components fetch `/api/wiki`, `/api/image-search`, and `/api/street-route`; in
pi-phone the frame answers those through the app (`web/openui.js`, `src/server/openui.ts`).
