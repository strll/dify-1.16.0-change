# Current Dify 1.16.0 Customization State

## Product Scope

This repository is an upstream Dify **1.16.0** base with a local
customization layer. The intended changes are limited to:

1. User and workspace administration.
2. `/installed` Web App multi-conversation and workflow recovery behavior.
3. Deployment packaging for the customized web and API images.

No historical Dify database data should be deleted. The current customization
includes `InstalledAppChatDraft` and two migrations under `api/migrations/versions/`
(`c1d2e3f4a5b6` and `d8e6f4a2b1c9`); disclose these in handoffs. The earlier
no-schema-change requirement does not describe the current implementation.
Do not introduce additional schema changes without explicit approval.
Do not backport a full module from Dify
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

The implementation includes custom `chat-drafts` controllers, a service, and
`web/service/installed-app-chat-drafts.ts` in addition to response/recovery interfaces;
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

An earlier focused run passed **229 tests**; this is historical evidence, not
verification of the current checkout. Re-run relevant tests before reporting
current results. Previous tests cover the real
conversation ID handoff, precise draft removal, active-session persistence,
server-terminal recovery merging, and deletion without replacement draft.

For new behavior, add scenarios beyond a two-way happy/failure split. At a
minimum include independent conversations A, B, and C where appropriate, a
switch during execution, refresh after server ID arrival, terminal cleanup, and
cross-tab create/delete synchronization. Run the nearest repository-standard
format/type checks when the affected module requires them.

## Docker Contract

The last observed local deployment on 2026-10-13 used:

| Service group | Image tag | Image ID |
| --- | --- | --- |
| `web` | `dify-web-custom:1.16.0-filefix32` | `sha256:a9692c5483e70afe5ed31eec5cb28c134c093f1a72ede6aae0f807e9875aaf4b` |
| `api`, `worker`, `worker_beat`, `api_websocket` | `dify-api-custom:1.16.0-fable3` | Re-inspect before delivery |

The local custom Compose file is:

`docker/docker-compose.custom-1.16.0.yaml`

It contains local credentials, backend configuration, and an external local
network. It is not an image-only production override and has no `nginx` service.
Do not copy it wholesale onto a server or run `up web nginx` against it alone.
Use the server's existing Compose file combination and project identity, with
a narrow override changing only `services.web.image` for frontend-only delivery.

The browser-facing Nginx topology is unchanged:

- `/` forwards to `web:3000`;
- `/console/api`, `/api`, `/v1`, and `/files` forward to `api:5001`;
- SSO-specific paths continue to use the existing external SSO upstream.

Keep `CONSOLE_API_URL` and `APP_API_URL` empty when using the relative Nginx
model. An empty value means use the current browser origin and proxy path; it
does not disable API access.

Keep `SERVER_CONSOLE_API_URL=http://api:5001` for internal server-side API access.
The frontend listens on port 3000; its image does not contain Nginx.

For a backend rebuild, redeploy all four backend services with the same tag.
For a frontend-only replacement, use the existing Compose configuration with
`up -d --no-deps --force-recreate web`. Do not restart Nginx by default when the
user requests only a web replacement. Verify HTTP access: if recreation changes
web's IP, a static Nginx upstream may retain the old address. Diagnose a 502 and
request any additional reload/restart authority needed; a graceful reload can
refresh the upstream without restarting the container.
For `host not found in upstream "web"`, first check whether web is running and
shares the Nginx network with alias `web`. On 2026-10-13, starting the stopped web
container restored resolution; its earlier exit code 255 was not explained by
application logs and must not be attributed to a proven code bug.
Do not replace `db`, `redis`, `weaviate`,
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

Only deliver both images when requested. Check that the selected build context
contains current code; existing `.docker-build-context*` directories may be stale.
Prefer reusing an already verified image when no rebuild is requested. Report
the actual exported file path and size after checking it exists.

## Security Review File Handoff

When the user asks only for changed files, copy the current contents of added
and modified paths, preserving repository-relative structure in a separate
folder. Determine the list against this project's original `1.16.0` tag and
include any relevant tracked working-tree changes. Report deleted paths
separately, since they have no current file to copy. Do not generate extra
reports, archives, or patches unless requested.

Exclude node_modules, virtual environments, Docker image archives, build
contexts, runtime volumes, logs, and unrelated untracked delivery files.
Copy source unchanged: this is packaging, not authorization for hardening or
redaction. Flag credentials in included configuration; copying files is not a
security-scan pass. Verify counts and do not overwrite an existing output folder.

At commit `f2b24858cf`, the tag comparison had 73 changed paths: 72 current files
and deleted `web/public/in-site-message/header-bg.svg`. These counts are a dated
reference, not a fixed requirement for later exports. Use a writable approved
destination; do not silently use a different release's source after a permission
failure. Keep local absolute paths and account information out of reusable skill
instructions intended for GitHub.
