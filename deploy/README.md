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
  passkeys. Inside the app, the rail's **People & account** (and ⋯ › Your account) opens these pages in the main panel,
  with the rail and sessions kept, in the app's theme; the `/auth/…` pages stay for signing in and direct links. A new
  invite's link shows under its form, copied.
- **Custom roles** (`/auth/roles`): a role is a set of permissions from a catalogue, plus the memory and CPUs of its people's
  pi-phones, the models they may use, and a monthly spend limit. Owner is built in. Admin, Member and Viewer are seeded,
  and you edit, add and delete roles.
  - **The gateway** checks its own permissions: inviting, managing people, editing roles, and the audit log.
  - **Each pi-phone** gets its role's policy before it serves anything. Pi's browser, web access and machines are off
    without their permissions. Secrets, the terminal, provider sign-in, settings and extensions are refused. Only the
    role's models are offered, and its spend cap stops new messages.
  - **A role without "a pi-phone of their own"** (Viewer) sees only the gateway's pages.
  - **The audit log** (`/auth/audit`) records invites, joins, role changes, resets, disabling or removing people, and
    sign-ins that failed or were blocked (the email tried and the address).
- **Idle pi-phones stop** (the Server page, `/auth/server`, for roles with "server settings"):
  - A person's container stops after 30 minutes unused (you set the minutes; 0 never stops), unless a page of it is open
    or Pi is at work there (writing, tools, subagents, scheduled messages).
  - Their next visit starts it again in a few seconds. Calls waiting for approval don't keep it up; they wait across the stop.
  - **Always on** (a switch per person on the People page): their pi-phone is never stopped when idle, and starts by
    itself if it was stopped, so scheduled messages run without a visit.
- **Sharing sessions** (⋯ › Share this session, in a person's pi-phone; "Share a chat session" in their role):
  - **Levels:** each teammate gets **Can write** (send messages and steer Pi, on the sharer's providers and money;
    read the session's files and changes) or **Can watch** (the chat only).
  - **Opening it:** teammates find it under **Shared with me** (the gateway's page and the pi-phone menu) and open it
    at `/space/<key>/<write|watch>/`. The gateway forwards that to the sharer's pi-phone as a scoped account made for
    them there, limited to the shared sessions.
  - **Limits:** a teammate never writes files, runs shell commands, uses the terminal, or allows Pi's calls. Pi uses
    the sharer's machines and secrets for their messages only where the share allows it; a session on a machine
    needs that.
  - **Ending it:** unsharing, disabling the sharer, or removing either account ends access at once.
  - **Continue in mine** copies a shared session into the teammate's own pi-phone, on their own providers.
  - **Audit log:** share, unshare and continue are recorded.
- **Team accounts** (Providers › Add team account, in a pi-phone of someone with `providers.manage`):
  - A provider's API key or subscription sign-in, set up once for the team; several per provider ("Work", "Research").
  - The sign-in runs on the gateway, its steps shown in the person's Providers sheet; the key or token is kept only in the
    gateway's `team-providers/auth.json` (mode 600, in the gateway's volume and its backups), never in a person's pi-phone.
  - Adding a subscription warns that it is licensed to one person. Added, signed in, renamed, signed out and removed
    accounts are in the Audit log.
  - **Using them:** the Roles page lists the team accounts a role's people may use (the owner's role: all). Their models
    show in those people's model menus; each call goes from their pi-phone to the gateway's internal port
    (`/internal/llm/stream`), which checks the role (the account and the role's model list) every time, answers with
    the account's sign-in, and streams the answer back. Stop and Interrupt end the call there too.
  - **Spend:** each answer's cost is counted on the gateway per person, account and month (`pp_team_spend`). A role's
    **team spend limit** (dollars a month each; empty for none) refuses further calls once reached, apart from the
    role's own spend limit, which leaves team spend out. The Server page's "Team accounts' spend" lists this month's,
    by person and account, against their role's limit.
  - **Subscriptions:** a team Claude, Codex or Copilot sign-in's plan limits are asked on the gateway with its own
    sign-in (kept a minute, asked again after an answer) and shown as usage bars to everyone who may use it. Claude
    requests get the Claude Code billing patch on the gateway, with the caller's setting (Settings › Claude Code billing).
  - **Pi's tools:** `team_providers` lists them (signed in or not, which roles use them, plan usage);
    `team_provider_add`, `team_provider_access` (the roles that may use one) and `team_provider_remove` ask the person
    on a card and show as "Pi for" them in the Audit log. `team_role_save` keeps a role's team accounts and team spend
    limit unless given. Never through Pi: keys and sign-ins.
- **Team machines** (Machines › Add team machine, in a pi-phone of someone with `machines.manage`):
  - A computer the team's sessions work on, reached from the gateway's network (its container must reach the machine's
    SSH port). The gateway makes an ed25519 key for it, kept only in its volume (`team-machines/<id>.key`, mode 600);
    the manager puts the public half in the machine's `authorized_keys` and accepts its host key, scanned by the gateway.
  - **Using them:** the Roles page lists the team machines a role's people may use (the owner's role: all). A person's
    pi-phone reaches one through the gateway (`/internal/team-machines/<id>/connect`, a pipe to the machine's SSH port)
    with an agent that holds no key: the gateway signs only the sign-in to that machine (`SSH_MSG_USERAUTH_REQUEST`,
    naming its accepted host key), and checks the role at every connection. Taking a machine off a role, or removing
    it, closes open pipes at once.
  - Everyone uses the machine's one account; each starts in `~/team/<their name>`. Added, accepted, renamed and removed
    machines, and role changes, are in the Audit log.
  - **Pi's tools:** `team_machines` lists them (address, host key accepted, set up, which roles use them, one's own
    folder); `team_machine_add` (answers the public half), `team_machine_access` (the roles that may use one) and
    `team_machine_remove` ask the person on a card and show as "Pi for" them in the Audit log. `team_role_save` keeps
    a role's team machines. Never through Pi: the key, and accepting a host key.
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
- **Push notifications** instead, in each person's browsers (Menu › Notifications): each pi-phone makes its own VAPID
  key pair (`/data/pocket/web-push.json`, mode 600) and sends to the push services itself (outbound HTTPS from its
  container); nothing to configure. Browsers need the HTTPS address; an iPhone needs pi-phone on its Home Screen.
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
- **Back up:** ⋯ › Backup › Back up (on the phone it is ⋯ › This phone). Or copy the `pi-phone-data` volume while it is stopped.
- **Restart:** the app's own restart (Pi's `app_action server.restart`, after your OK) exits the server; Docker starts it
  again (`restart: unless-stopped`).

## The team server: back up and restore

The downloads hold everyone's data: their sessions, provider sign-ins and secrets. Only roles with "server settings"
(`server.manage`) get them, which is the owner alone unless you give it to another role.

- **One person:** People › **Download data** gives their pi-phone's `/data` as a `.tar.gz`. It works for stopped
  people too. A running pi-phone's is taken as it is at that moment.
- **The whole server:** Server › **Download a backup** gives one `.tar.gz`. Inside are:
  - `manifest.json`: who is who;
  - `gateway.sqlite`: accounts, roles, settings, each pi-phone's token;
  - `boards/`: shared boards (`pocket.sqlite`), project wikis (`wiki.sqlite`), and team and board documents with their
    images (`documents.sqlite`);
  - `people/<key>.tar` for each person.
- **Restore one person** (their key is in the manifest, or in their container's name `pp-user-<key>`):

  ```sh
  docker rm -f pp-user-<key>
  gunzip -c pi-phone-<name>-<date>.tar.gz | docker run --rm -i --entrypoint sh --user 0 \
    -v pp-data-<key>:/data pi-phone-server:local -c 'find /data -mindepth 1 -delete && tar xf - -C /'
  ```

  Their next visit makes their container again on the restored data.
- **Restore the whole server**, on a host with the stack set up:

  ```sh
  mkdir restore && tar xzf pi-phone-server-<date>.tar.gz -C restore
  docker compose -p pi-phone-team down
  docker run --rm --entrypoint sh --user 0 -v pi-phone-team_gateway-data:/data -v "$PWD/restore":/r:ro \
    pi-phone-server:local -c 'rm -rf /data/gateway.sqlite* /data/boards && cp /r/gateway.sqlite /data/ && mkdir /data/boards &&
      cp /r/boards/*.sqlite /data/boards/ && chown -R 1000:1000 /data/gateway.sqlite /data/boards'
  for f in restore/people/*.tar; do
    k=$(basename "$f" .tar); docker rm -f "pp-user-$k" 2>/dev/null
    docker run --rm -i --entrypoint sh --user 0 -v "pp-data-$k":/data pi-phone-server:local \
      -c 'find /data -mindepth 1 -delete && tar xf - -C /' < "$f"
  done
  docker compose -p pi-phone-team up -d
  ```

## Security

What the team server shows to the network, and how each part is guarded (PP-26).

- **Exposed:** only Caddy's ports 80 (redirects to HTTPS) and 443. Nothing else is published.
- **Inside Docker:**
  - The gateway's public port, **8080**, answers only Caddy (`PP_TRUSTED_PROXY=caddy`). People's containers share a
    network with the gateway, so without this they could call sign-in directly with a made-up address and get around the
    limit on tries.
  - Its internal port, **8081**, is for people's pi-phones. Each call carries that pi-phone's own token.
  - The **controller** has no network at all: the gateway reaches it through a Unix socket with a shared secret.
- **Sign-in:** better-auth, with sessions in an HttpOnly, Secure, SameSite=Lax cookie that lasts 30 days.
  - **Limits:** 10 sign-ins and 10 two-factor codes a minute per address, and 100 requests a minute for the rest.
  - **Audit log:** a failed sign-in records the email tried, how (password, two-factor code, backup code, passkey) and the
    address; a blocked one records the address, once a minute.
  - **Advice:** turn on two-factor or add a passkey for the Owner and anyone who manages people. It isn't enforced.
- **Cross-site requests:**
  - The gateway's own changes (`/auth/gw/*`) are refused unless they come from its own pages (Origin), so a page on
    another machine of the same tailnet can't make them with your cookie.
  - pi-phone's changes need its `X-Pocket` header, and the terminal's WebSocket checks Origin.
- **Headers (Caddy and the apps):**
  - **Caddy:** HSTS, `nosniff`, no referrer, frames only from this site, and camera, microphone and location for this
    site only. The browser still asks before any of them.
  - **The apps:** the gateway's pages send a strict CSP and can't be framed; pi-phone sends its own CSP, and artifacts
    run sandboxed.
- **People's containers:** all Linux capabilities dropped, `no-new-privileges`, memory, CPU and process caps from the
  role, a network and a volume each, no published ports. A pi-phone never sees another's files.

**Routes and who may call them:**

| Route | Who | Checked |
| --- | --- | --- |
| `/auth/api/*` | anyone | better-auth: sign-in, two-factor, passkeys; the limits above; Origin on changes |
| `/auth/gw/state`, `/auth/gw/invite/<code>` | anyone | a used or expired invite is refused; codes are 24 random bytes |
| `/auth/gw/setup` | anyone, once | the setup token (24 random bytes, compared in constant time); refused once an owner exists |
| `/auth/gw/*` (the rest) | signed in | each route's permission from the person's role (People, Roles, Audit, Server, Backup); changes from the gateway's own pages only |
| `/auth/gw/backup`, `/auth/gw/people/<id>/export` | `server.manage` | the Owner only, unless you give it to another role; never through Pi |
| everything else | signed in, with "a pi-phone of their own" | forwarded to the person's own container with its token; account, invite and device routes refused there |
| WebSocket (terminal) | the same | Origin must be this server; never under `/space/` |
| `/space/<key>/<write\|watch>/…` | signed in, with that session shared with them at that level | otherwise 404, whatever exists; forwarded to the sharer's pi-phone with the scoped account's token, never the sharer's own; pi-phone's sign-in routes refused |
| `:8081/internal/boards`, `/internal/docs`, `/internal/team`, `/internal/shares` | a pi-phone of this server | its own token; as its person, by their role; Pi's team calls through an allow list (no passwords, exports, backups or the server key) |

**Limits on what comes in:** the gateway's own routes take a JSON object of 64 KB at most (documents with images: 16 MB);
anything larger gets 413 and anything else 400. A request has 15 minutes to arrive.

**Secrets, and where they live:**
- **Setup token:** in the gateway's log until the owner is set up, and unused after.
- **Controller secret:** `/run/pi-phone/secret` in the `control` volume, readable by the gateway's group only.
- **better-auth's signing secret, and each pi-phone's token:** in `gateway.sqlite`.
- **The server's OpenRouter key** (search in documents): in `gateway.sqlite`. It's never shown again, never in the audit
  log, and never set by Pi.
- **People's provider sign-ins and secrets:** in their own volume.

A backup holds all of these, so keep the file as safe as the server.

## Smoke test

After a build, `deploy/smoke.sh pi-phone-server:local` checks the image in a fresh container: it serves, carries its
tools, and Pi's browser and screenshots work in it. CI doesn't build the image; it runs the server's tests, Chrome's
included.
