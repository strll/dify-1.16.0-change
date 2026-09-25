---
name: dify-1160-customization
description: Maintain or extend this repository's Dify 1.16.0 custom user-management and installed Web App conversation behavior, including its Docker delivery contract. Use for regressions or enhancements in those custom areas, not for unrelated upstream Dify work.
---

# Dify 1.16.0 Customization

Use this skill when working on the local customization layer for Dify 1.16.0.
The customization must remain a narrow extension of upstream behavior: preserve
unrelated Dify modules, do not add a database schema migration for these
features, and do not copy implementation files from a different Dify release.

Read [current-customization.md](references/current-customization.md) before
changing a covered area. It records product requirements, ownership boundaries,
the current image contract, and verification history.

## First Checks

1. Read the root `AGENTS.md` and the nearest scoped `AGENTS.md` before editing.
1. Inspect `git status` before making changes. Build contexts and generated
   files may be untracked; do not delete, package, or commit them blindly.
1. Confirm the requested behavior is within either the user/workspace
   administration feature or the `/installed` Web App feature. For other Dify
   work, follow the upstream module's normal conventions instead.
1. Search for the existing owner before adding state, routes, storage, or APIs.

## Implementation Boundaries

- Keep installed-chat behavior scoped to `/installed`. Do not change standard
  Web App, embedded chat, or other Dify chat surfaces without separate intent
  and regression coverage.
- The installed-chat recovery mechanism is browser-local IndexedDB plus
  existing Dify server recovery behavior. Do not add database tables or make
  a client-generated UUID masquerade as a server `conversation_id`.
- Keep user-visible frontend strings in the existing Chinese and English i18n
  catalogs. Roles deliberately retain their current role labels.
- Workspace assignment can use a workspace name or optional workspace ID.
  Preserve transaction isolation and API signatures compatible with 1.16.0.
- Membership removal is governed by the **target membership**: reject removal
  of an `owner`; allow removing any non-owner, including the acting account and
  a non-owner in a legacy workspace with no owner.

## Verification

Write or update focused tests for each changed behavior. For installed-chat
work, run the focused Vitest suites documented in the reference. Build the web
image after frontend changes; build one backend image and apply it consistently
to `api`, `worker`, `worker_beat`, and `api_websocket` after backend changes.

Use the Nginx-relative frontend API model. Do not hard-code an API hostname.
During local or server deployment, do not use `docker compose down -v` and do
not replace unrelated infrastructure services.

## Delivery

When producing a deployable delivery, export frontend and backend images as
separate tar archives. Include an image-only Compose override, checksum file,
deployment README, and an updated agent handoff. Verify image tags and archive
contents before delivery.
