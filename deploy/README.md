# pi-phone on a server

The server edition runs the same app as the phone, in Docker, behind Caddy for HTTPS. Today it is one person's (the
owner, who signs in with the owner token). Accounts for a team, roles, and a container per person come next (board epic
PP-19).

What changes from the phone:

- **Pi's browser** and **`screenshot`** use a headless Chrome inside the container (Chrome headless shell, pinned).
- **OfficeCLI, ripgrep, fd, git, gh and ssh** are in the image.
- **Phone-only parts are off:** app updates (pull a new image instead), Downloads to the phone, Android notifications,
  and Tailscale serving (Caddy serves it).
- **Everything is under `/data`, a volume:**
  - the app's data in `/data/pocket`;
  - the home folder Pi works in, `/data/home`, with sessions starting in `/data/home/work`;
  - Pi's provider sign-ins, SSH keys, the wiki, and the browser's sign-ins.

## Run it

You need Docker with Compose on a Linux machine (x64 or arm64), and a name for it that your devices trust over HTTPS.

1. Clone this repository on the machine: the image is built there (`docker compose ... --build`).
2. Pick the name and the certificate:
   - **A public name** (`pi.example.com`, pointing at the machine, with ports 80 and 443 open): `PI_HOST=pi.example.com`.
     Caddy gets a Let's Encrypt certificate by itself.
   - **A Tailscale name** (`devbox.your-tailnet.ts.net`): install Tailscale on the machine and sign it in, turn on HTTPS
     certificates in the Tailscale admin console (DNS › HTTPS Certificates), then `PI_HOST=devbox.your-tailnet.ts.net`.
     Caddy asks the machine's Tailscale for the certificate (the compose file mounts its socket).
   - **Only on your network, for a try:** `PI_HOST=192.168.1.61 PI_TLS=internal`. Caddy uses its own CA, which browsers
     warn about until you trust it.
3. Start it:

   ```bash
   cd deploy
   PI_HOST=devbox.your-tailnet.ts.net docker compose up -d --build
   ```

   Add `DEBIAN_MIRROR=http://debian.xtdv.net/debian` (or another mirror near you) when deb.debian.org is slow from there.

4. Find your sign-in link (the owner's: keep it private) and open it once per browser:

   ```bash
   docker compose logs pi-phone | grep login
   ```

   Swap its `http://127.0.0.1:8787` for `https://<PI_HOST>`.
5. In the app: ⋯ › Providers, sign in to a model provider.

Then use it as the README's "Use it" says. Pi can change settings for you on a card, as on the phone.

## Update, back up, restart

- **Update:** `git pull` in the clone, then `docker compose up -d --build` (with the same `PI_HOST`). Sessions resume where
  they stopped.
- **Back up:** ⋯ › This phone › Back up, as on the phone. Or copy the `pi-phone-data` volume while it is stopped.
- **Restart:** the app's own restart (Pi's `app_action server.restart`, after your OK) exits the server; Docker starts it
  again (`restart: unless-stopped`).

## Smoke test

After a build, `deploy/smoke.sh pi-phone-server:local` checks the image in a fresh container: it serves, carries its
tools, and Pi's browser and screenshots work in it. CI doesn't build the image; it runs the server's tests, Chrome's
included.
