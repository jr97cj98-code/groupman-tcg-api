# Security reports

Use GitHub's **Security** tab to report a leaked credential, privacy problem, or
authentication bypass privately. Replace real names, URLs, IDs, and credentials
with examples.

Do not post these in a public issue:

- setup keys, group IDs, invites, or member tokens;
- Worker URLs or D1 database IDs;
- database exports, logs, or screenshots containing private data.

If an invite leaks, create a new one from the host's RuneLite client. If a
member token leaks, remove that member and let them join again.

If the host token or a database export leaks, take the Worker offline and move
the group to a new deployment. If an unused setup key leaks, replace the
encrypted `SETUP_KEY` secret before creating the group.
