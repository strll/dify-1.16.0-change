# Current Dify 1.16.0 Customization State

## Product Scope

This repository is an upstream Dify **1.16.0** base with a local
customization layer. The intended changes are limited to:

1. User and workspace administration.
2. `/installed` Web App multi-conversation and workflow recovery behavior.
3. Deployment packaging for the customized web and API images.

No historical Dify database data should be deleted. The customization does not
introduce a database schema change. Do not backport a full module from Dify
1.16.1 or 1.17.x: compare the 1.16.0 implementation and make a minimal,
signature-compatible change instead.

## User and Workspace Administration

The custom administration flow provides user/workspace assignment management,
including manual and batch assignment. Workspace ID is optional:

- Show a shortened workspace ID beside the workspace name in the assignment
  table. The details action displays full workspace ID, account ID, and other
  available assignment details.
- Manual assignment accepts a workspace name and optional workspace ID. If an
  ID is supplied, resolve and assign by ID.
- The batch Excel template and importer accept the optional workspace ID
  column. Existing name-only input remains valid.
- User-management labels must follow the application language setting for
  Chinese and English. Do not translate role values as part of this requirement.
- Shared frontend error parsing must turn failed HTTP responses into useful
  server messages instead of rendering `[object Response]`, without replacing
  more specific existing error handling.

### Transaction Requirements

Workspace creation and assignment must use one clear transaction boundary per
user/workspace row. If a database operation fails, exit/rollback that
transaction before any further database work. A failure for one batch row must
not affect other rows.

The response and final database state must agree:

- success means workspace and membership are committed;
- failure leaves no partial workspace or membership, unless an explicitly
  designed idempotent already-exists result applies;
- repeated workspace/member inputs return a clear duplicate result, never
  `Can't operate on closed transaction inside context manager`.

For `tenant_account_joins.current`, perform any current-workspace switch in one
explicit transaction: clear other joins and set the selected join. Never do
this after a failed transaction.

### Membership Removal Rule

The only protected case is removal of a membership whose role is `owner`.
Reject that operation. Do **not** block a user merely because it is the account
currently used to make the request. A tenant with no owner may still remove a
non-owner membership; do not fail because an owner lookup is empty.

## Installed Web App Conversations

This behavior is specifically for the `/installed` surface.

### Required User Behavior

- A user can open and switch among any number of new conversation drafts.
  The product does not impose a limit; three drafts were only a test case.
- New drafts appear as localized `New conversation` / `新对话`, with a numeric
  suffix when several exist. They are switchable before a message is sent.
- The history list refreshes after creating or deleting conversations and
  synchronizes that refresh across browser tabs.
- When the first message receives the real server `conversation_id`, replace
  the local draft identity and refresh/update the sidebar item with the server
  conversation title. Do not retain both a draft and its server conversation.
- Empty drafts are not retained after a browser refresh. Only a server-backed
  conversation is recoverable after refresh or browser close.
- Switching away while a workflow is running must not stop it. Returning to a
  conversation, or refreshing its URL, restores the same visible messages and
  workflow progress as when the user left it.
- When several workflows are running at browser close, reopen only the
  conversation specified by the current URL. Other conversations remain
  reachable from history.
- Once a workflow reaches a terminal state, clear only its browser-local
  recovery cache. Do not remove normal server conversation history.
- Deleting the active history item clears the active selection and visible
  chat state. It must not automatically create a new draft.

### Key Owners

Inspect these before modifying installed-chat behavior:

- `web/app/components/base/chat/chat-with-history/chat-wrapper.tsx`
  supplies installed app context, including `appId`, so recovery is enabled on
  the installed route.
- `web/app/components/base/chat/chat-with-history/hooks.tsx`
  owns draft IDs, sidebar state, history refresh, deletion behavior, and
  cross-tab synchronization. Draft cleanup must use the precise session ID.
- `web/app/components/base/chat/chat/hooks.ts`
  owns message tree persistence, real conversation ID handoff, recovery merge
  behavior, and terminal-state cache cleanup.
- `web/app/components/base/chat/chat-with-history/conversation-sync.ts`
  is the cross-tab synchronization helper. Treat it as feature-local state
  coordination, not a replacement for server history.

The implementation uses the existing backend response and recovery interfaces;
it must not invent a server conversation ID before the backend returns one.
Snapshots need a stable active session key until that handoff occurs, then must
move to the real conversation identity. When merging recovered UI state with a
server terminal state, the server terminal state wins.

## Tests

For the latest installed-chat deletion/recovery work, run from `web/`:

```powershell
.\node_modules\.bin\vp.cmd test run `
  app/components/base/chat/chat-with-history/__tests__/hooks.spec.tsx `
  app/components/base/chat/chat-with-history/__tests__/chat-wrapper.spec.tsx `
  app/components/base/chat/chat/__tests__/hooks.spec.tsx `
  --reporter=dot
```

The latest focused run passed **229 tests**. Previous tests cover the real
conversation ID handoff, precise draft removal, active-session persistence,
server-terminal recovery merging, and deletion without replacement draft.

For new behavior, add scenarios beyond a two-way happy/failure split. At a
minimum include independent conversations A, B, and C where appropriate, a
switch during execution, refresh after server ID arrival, terminal cleanup, and
cross-tab create/delete synchronization. Run the nearest repository-standard
format/type checks when the affected module requires them.

## Docker Contract

The verified local images are:

| Service group | Image tag | Image ID |
| --- | --- | --- |
| `web` | `dify-web-custom:1.16.0-sessionfix4` | `sha256:525daa959dfba1825199eb1740e356bc72d3539ea9439c62de65509495be2098` |
| `api`, `worker`, `worker_beat`, `api_websocket` | `dify-api-custom:1.16.0-sessionfix3` | `sha256:b6eb6f9b11b8edd1734eed96aaf7f22dc987cacce9cd49adf3e83c1ab9f98ca2` |

The image-only override is:

`docker/docker-compose.custom-1.16.0.yaml`

The browser-facing Nginx topology is unchanged:

- `/` forwards to `web:3000`;
- `/console/api`, `/api`, `/v1`, and `/files` forward to `api:5001`;
- SSO-specific paths continue to use the existing external SSO upstream.

Keep `CONSOLE_API_URL` and `APP_API_URL` empty when using the relative Nginx
model. An empty value means use the current browser origin and proxy path; it
does not disable API access.

For a backend rebuild, redeploy all four backend services with the same tag.
For a frontend rebuild, redeploy `web` and restart Nginx if its current
configuration needs to reload. Do not replace `db`, `redis`, `weaviate`,
`plugin_daemon`, sandbox services, or SSO merely to test these changes.

## Packaging

The delivery directory is intentionally separate from source and contains:

```text
dify-1.16.0-delivery-YYYYMMDD/
  images/
    dify-api-custom-<tag>.tar
    dify-web-custom-<tag>.tar
  deployment/docker-compose.custom-1.16.0.yaml
  README.md
  AGENT_HANDOFF.md
  SHA256SUMS.txt
```

Export frontend and backend images separately with `docker save`. Check each
archive's `manifest.json` and SHA-256 before handing it off. The deployment
README must state image tags, `docker load` commands, combined Compose usage,
and the prohibition on `down -v`.
