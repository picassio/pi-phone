# pi-phone on a server

The server edition runs the same app as the phone, in Docker, behind Caddy for HTTPS, for a **team**
(`deploy/compose.yaml`):

- **Sign-in:** a **gateway** signs people in with better-auth: email and password, a TOTP code as a second step if they
  turn it on, and passkeys. There's no sign-up: the owner's account comes from the setup token, and everyone else's from
  an invite link the owner makes (with a role, used once).
- **A pi-phone each:** each person gets their own pi-phone in a **container of their own**, with their own sessions,
  provider sign-ins, secrets, machines and files. It sits on its own network, which only the gateway shares, with all
  capabilities dropped, no published ports, and memory and CPU caps.
- **Docker:** a **controller** makes these containers. It's the only part that touches Docker, and it has no network: the
  gateway reaches it through a Unix socket with a shared secret.
- **The owner's pages:** the People page (`/auth/people`) has invites, roles, password and 2FA resets, and disabling or
  removing someone (their data is kept). Everyone has an Account page (`/auth/account`) for their password, two-factor and
  passkeys.
- **Custom roles** (`/auth/roles`): a role is a set of permissions from a catalogue, plus the memory and CPUs of its people's
  pi-phones, the models they may use, and a monthly spend limit. Owner is built in. Admin, Member and Viewer are seeded,
  and you edit, add and delete roles.
  - **The gateway** checks its own permissions: inviting, managing people, editing roles, and the audit log.
  - **Each pi-phone** gets its role's policy before it serves anything. Pi's browser, web access and machines are off
    without their permissions. Secrets, the terminal, provider sign-in, settings and extensions are refused. Only the
    role's models are offered, and its spend cap stops new messages.
  - **A role without "a pi-phone of their own"** (Viewer) sees only the gateway's pages.
  - **The audit log** (`/auth/audit`) records invites, joins, role changes, resets, and disabling or removing people.
- **Idle pi-phones stop** (the Server page, `/auth/server`, for roles with "server settings"):
  - A person's container stops after 30 minutes unused (you set the minutes; 0 never stops), unless a page of it is open
    or Pi is at work there (writing, tools, subagents, scheduled messages).
  - Their next visit starts it again in a few seconds. Calls waiting for approval don't keep it up; they wait across the stop.
  - **Always on** (a switch per person on the People page): their pi-phone is never stopped when idle, and starts by
    itself if it was stopped, so scheduled messages run without a visit.
- **Updates roll out by themselves:** after `docker compose ... up -d --build` makes a new image, people's running
  pi-phones are made again from it one at a time, each when Pi isn't at work there. Stopped ones are made again when they
  next start. Their data (the volume) is kept, and an open page reconnects in a few seconds. The Server page shows how
  many are still on an older image.

For one person only, with the owner token and no gateway, use `compose.single.yaml` instead (`-f compose.single.yaml`).

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

4. Get the setup token, which makes the owner's account once (keep it private), then open
   `https://<PI_HOST>/auth/setup` and give it with your name, email and a password:

   ```bash
   docker compose logs gateway | grep "setup token"
   ```

5. On your Account page, turn on two-factor and add a passkey. Then **Open my pi-phone**, and in the app go to
   ⋯ › Providers and sign in to a model provider (each person signs in their own).
6. **People › Make an invite link** for each teammate: they open it, make their account, and get their own pi-phone.

(With `compose.single.yaml`: `docker compose -f compose.single.yaml logs pi-phone | grep login` gives the owner's
sign-in link instead; swap its `http://127.0.0.1:8787` for `https://<PI_HOST>`.)

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
