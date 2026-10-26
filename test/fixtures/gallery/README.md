# Gallery extensions, as test fixtures

Unchanged copies of the module files pi-pocket's gallery installs, for `test/drop-ins.test.ts` (PP-171). Each folder
keeps its LICENSE (MIT, picassio). They are not type-checked here (`tsconfig.json` leaves this folder out): they import
pi-pocket's `_pocket.d.ts`, which pi-phone does not have.

| Folder | Repository | Commit |
| --- | --- | --- |
| `pi-pocket-secrets` | https://github.com/picassio/pi-pocket-secrets | `f69dce80720d31a91389df97e848d3cc416a3344` |
| `pi-pocket-browser-sign-in` | https://github.com/picassio/pi-pocket-browser-sign-in | `82b838badc897b9ee13443aeca59881e943d706b` |
| `pi-pocket-browser-runs` | https://github.com/picassio/pi-pocket-browser-runs | `ee9fcdfa23403b025705ed9236041a4e40e811e6` |
