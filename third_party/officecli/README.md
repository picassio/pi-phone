# OfficeCLI's skills, for pi-phone

From [OfficeCLI](https://github.com/iOfficeAI/OfficeCLI) (Apache-2.0, see `LICENSE` and `NOTICE`), as in the fork
[picassio/OfficeCLI](https://github.com/picassio/OfficeCLI) at commit `61a1844e6ec3ddd0208f3e38be469a04ec089cd6`: the
commit its Android release `android-v1.0.157` was built from (upstream OfficeCLI 1.0.157, plus the fork's Android
workflow only).

- `skills/`: upstream's `skills/` folder, whole. pi-phone offers these to Pi as skills (`src/server/officecli.ts`): Pi
  sees each one's name and description, and reads it when a task needs it.
- The binary is not here: `scripts/officecli.ts` fetches the fork's release asset at build time, checked against its
  sha256, into `native/android-arm64/officecli/` (not in git).

## pi-phone's change

Each skill's install section (a `curl ... install.sh | bash` or PowerShell installer, and links to the releases) is
replaced, marked `<!-- pi-phone: changed ... -->`, by a note that `officecli` is installed by pi-phone (with the app on the phone, in `~/.pi/mobile/tools` on a machine) and must never be
installed or updated: on the phone the installer has no build to fetch, and `officecli install` writes into other
agents' config folders. Nothing else is changed.

To update: build a new Android release on the fork, copy upstream's `skills/` at that commit here, make the same change,
and update the tag, sha256, and commit in `scripts/officecli.ts` and this file.
