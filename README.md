# Group TCG Server

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Sqwiglyy/groupman-tcg-server)

This is the optional private server for the
[Group TCG RuneLite plugin](https://github.com/Sqwiglyy/groupman-tcg). It keeps
group membership, card collections, pack popups, the collection leaderboard,
and Top Trumps in sync.

Solo players do not need it. For multiplayer, one person hosts a Cloudflare
Worker and D1 database, then everyone in the group uses that same Worker URL.
One deployment holds one group with up to 50 active members.

## Quick setup

1. Click **Deploy to Cloudflare** above and sign in when asked.
2. Accept the generated Worker and D1 database names.
3. Create a random setup key with at least 16 characters. Save it in a password
   manager.
4. In the Worker's Cloudflare settings, add an encrypted secret named exactly
   `SETUP_KEY`, then deploy that change.
5. Open `https://YOUR-WORKER.workers.dev/health`. A ready server returns:

   ```json
   {"status":"ok","service":"group-tcg-api","version":4,"setupReady":true}
   ```

6. Copy the root Worker URL without `/health`.
7. In RuneLite, everyone enables **Connect to server** in Group TCG and enters
   that URL.
8. The host chooses **Create group** and enters the setup key once.
9. The host privately shares the group ID and invite code. Friends join, then
   the host checks their RuneScape names before approving them.

Never share the setup key, member token, or database export. Keep the group ID
and invite code inside your group.

## What the server stores

The database stores:

- the RuneScape display name supplied by each player;
- group membership, approval state, role, and solo/shared choice;
- one-way hashes of invites, member tokens, and OSRS TCG copy IDs;
- card names, copies, foils, pull times, shared unlocks, and pack events;
- Top Trumps challenges and results.

It does not accept Jagex passwords, account emails, game sessions, account IDs,
bank PINs, inventory, bank, equipment, stats, XP, world, location, clan data, or
chat messages.

The Cloudflare account owner can access the database and backups. Only invite
people who trust the host. Cloudflare also handles normal connection data such
as IP addresses.

The Worker avoids logging names, credentials, request bodies, and gameplay
data. See [SECURITY.md](SECURITY.md) before reporting anything sensitive.

## How access works

- The setup key protects the first group creation and is not used afterwards.
- New members stay pending until the host approves their displayed name.
- Only the host can approve or remove members and create a new invite.
- Invites expire after 30 days and can be replaced at any time.
- Removing a member blocks future access, but shared unlocks already earned by
  the group remain.
- Top Trumps events are returned only to the two players in that challenge.

Display names help friends recognise each other, but the server cannot prove
who owns a RuneScape character. This is still an honour-mode system.

## Manual deployment

Manual setup requires a Cloudflare account, Node.js 22 or newer, and pnpm:

```powershell
pnpm install
pnpm wrangler login
pnpm wrangler d1 create groupman-tcg --binding DB --update-config
pnpm wrangler secret put SETUP_KEY
pnpm check
pnpm deploy
```

The D1 command adds your database ID to `wrangler.jsonc`. Do not commit that ID
to a reusable public fork.

If you already keep deployment details in the ignored `wrangler.local.jsonc`,
use `pnpm deploy:production` instead. Both deploy commands apply migrations
first.

## Updating and backing up

Before an update, ask players to close RuneLite or temporarily turn off server
sync. Then run:

```powershell
pnpm install
pnpm check
pnpm wrangler d1 export DB --remote --output group-tcg-backup.sql
pnpm deploy
```

Keep the backup outside public repositories and shared folders. If you use
`wrangler.local.jsonc`, add `--config wrangler.local.jsonc` to the export and
run `pnpm deploy:production`.

Deleting a Worker does not always delete its D1 database. To retire a server,
delete the Worker, database, and private backups separately.

## Troubleshooting

- **`setupReady:false`:** add the encrypted `SETUP_KEY` secret and redeploy.
- **`invalid_setup_key`:** the setup key entered in RuneLite does not match the
  Cloudflare secret.
- **`instance_claimed`:** this Worker already has a group. Use its current
  invite or deploy a separate Worker.
- **A player stays pending:** the host must approve their displayed RuneScape
  name in the Group TCG sidebar.
- **`player_already_joined`:** remove the old membership or reconnect with its
  existing RuneLite profile.
- **A teammate cannot sync:** check the Worker URL, host approval, and plugin
  version on both clients.
- **A database error appears on `/health`:** run `pnpm db:migrate:remote`, then
  deploy again.
- **A URL is rejected:** use the HTTPS Worker root with no extra path. Plain
  HTTP is accepted only for local development.

## Local development

```powershell
pnpm install
pnpm db:migrate:local
pnpm check
pnpm dev
```

Open `http://localhost:8787/health` to check the local server.

Before publishing a server change, also verify the deployment bundle:

```powershell
pnpm wrangler deploy --dry-run --outdir dist
```
