# Changelog

## 0.1.0 - 2026-07-17

- Add a private Cloudflare Worker and D1 server for one Group TCG group.
- Support up to 50 approved members with separate tokens and collection modes.
- Sync shared unlocks, individual card copies, pack events, and Top Trumps.
- Store RuneScape display names so the host can recognise join requests.
- Hash invites, member tokens, and OSRS TCG copy IDs before storage.
- Protect first-time setup with an encrypted `SETUP_KEY` secret.
- Add automatic migrations, tests, backup guidance, and a one-click deployment
  button.
