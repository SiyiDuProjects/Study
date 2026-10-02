# Inbox send/reply release — 2026-09-07

Authorized scope: the user explicitly requested composing and sending messages to named teachers, and replying to Inbox messages. No production test message is authorized or sent by this release.

## Contract and review

- `send_message`: one numeric recipient verified against the selected course's teachers, a subject, body, and UUID request ID.
- `reply_message`: one numeric recipient verified against the selected conversation's participants, body, and UUID request ID. Reads explicitly retain `auto_mark_as_read=false`.
- Both advertise write/open-world/non-idempotent annotations and require `canvas.read canvas.messages.write`. Existing read tokens can discover tools but cannot invoke either write. Authorization UI names sending permission explicitly.
- The deployment switch `CANVAS_MESSAGES_ENABLED` defaults to false. PATs stay in Core and POST only to the fixed Hanyang host. No redirects or POST retries. No attachments, forwarding, broadcasts, reply-all, or other Canvas writes.
- Migration 7 adds a delivery ledger. An atomic claim prevents concurrent duplicate sends; successful retries return the original receipt. Pending/unknown outcomes require checking Sent before any new request. The ledger stores a fingerprint and receipt, never message body or PAT.
- Validation uses mocked provider calls for successful sends, recipient rejection, reply targeting, transport uncertainty, redirects, malformed responses, persisted retry behavior, annotations, and HTTP scope enforcement. Actual recipient delivery remains untested until a real user-directed message.

## Release and rollback

Back up production configuration, source, and SQLite before the separate Inbox deployment. Build a candidate from the deployed source plus this release delta. Start candidate and rollback images with copied databases and check health before activation. Keep the pre-Inbox image and config. The additive ledger is compatible with the preceding service; rollback does not replace the live database or lose intervening records.

Refresh the installed local plugin and reconnect Hanyang Study in the client to grant `canvas.messages.write`. Existing conversation tool snapshots do not gain new tools automatically.
