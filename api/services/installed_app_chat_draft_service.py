"""Persistence service for in-flight chat drafts on /installed apps.

Drafts are stored server-side so the in-flight workflow / agent state
survives a page reload. Once the underlying conversation is created the
client deletes the draft; the regular conversation-history endpoint takes
over.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.exc import IntegrityError

from extensions.ext_database import db
from libs.datetime_utils import naive_utc_now
from models import InstalledApp, InstalledAppChatDraft


logger = logging.getLogger(__name__)


def _ensure_table_exists() -> None:
    """Auto-create the drafts table when the alembic migration has not run.

    Production deployments run the migration; this fallback is here so the
    feature works on a fresh database without requiring a deploy of the
    migration first.
    """

    try:
        InstalledAppChatDraft.__table__.create(db.engine, checkfirst=True)
    except Exception:
        logger.exception("failed to auto-create installed_app_chat_drafts table")


def upsert_draft(
    *,
    draft_id: str,
    tenant_id: str,
    installed_app_id: str,
    user_id: str,
    conversation_id: str | None,
    workflow_run_id: str | None,
    title: str | None,
    chat_tree: list[Any] | dict[str, Any],
    is_terminal: bool,
) -> InstalledAppChatDraft:
    """Upsert the draft. Idempotent on draft_id (the client-generated UUID)."""

    _ensure_table_exists()

    now = naive_utc_now()
    session = db.session()
    try:
        existing = session.scalar(
            select(InstalledAppChatDraft).where(InstalledAppChatDraft.draft_id == draft_id)
        )
        if existing is not None:
            existing.conversation_id = conversation_id
            existing.workflow_run_id = workflow_run_id
            existing.title = title
            existing.chat_tree_json = chat_tree or []
            existing.is_terminal = is_terminal
            existing.last_message_at = now
            session.commit()
            return existing

        draft = InstalledAppChatDraft(
            draft_id=draft_id,
            tenant_id=tenant_id,
            installed_app_id=installed_app_id,
            user_id=user_id,
            conversation_id=conversation_id,
            workflow_run_id=workflow_run_id,
            title=title,
            chat_tree_json=chat_tree or [],
            is_terminal=is_terminal,
            last_message_at=now,
        )
        session.add(draft)
        try:
            session.commit()
        except IntegrityError:
            session.rollback()
            # Another tab / request inserted the same draft concurrently;
            # update the existing row instead.
            existing = session.scalar(
                select(InstalledAppChatDraft).where(InstalledAppChatDraft.draft_id == draft_id)
            )
            if existing is not None:
                existing.conversation_id = conversation_id
                existing.workflow_run_id = workflow_run_id
                existing.title = title
                existing.chat_tree_json = chat_tree or []
                existing.is_terminal = is_terminal
                existing.last_message_at = now
                session.commit()
                return existing
            raise
        return draft
    finally:
        session.close()


def delete_draft(*, draft_id: str, tenant_id: str, installed_app_id: str) -> bool:
    """Delete a single draft. Returns True if a row was removed."""

    _ensure_table_exists()
    session = db.session()
    try:
        result = session.execute(
            delete(InstalledAppChatDraft).where(
                InstalledAppChatDraft.draft_id == draft_id,
                InstalledAppChatDraft.tenant_id == tenant_id,
                InstalledAppChatDraft.installed_app_id == installed_app_id,
            )
        )
        session.commit()
        return bool(result.rowcount)
    finally:
        session.close()


def list_drafts(
    *,
    tenant_id: str,
    installed_app_id: str,
    user_id: str,
) -> list[InstalledAppChatDraft]:
    """Return all drafts for this (tenant, app, user)."""

    _ensure_table_exists()
    session = db.session()
    try:
        return list(
            session.scalars(
                select(InstalledAppChatDraft)
                .where(
                    InstalledAppChatDraft.tenant_id == tenant_id,
                    InstalledAppChatDraft.installed_app_id == installed_app_id,
                    InstalledAppChatDraft.user_id == user_id,
                )
                .order_by(InstalledAppChatDraft.updated_at.desc())
            ).all()
        )
    finally:
        session.close()


def is_installed_app_owned_by_tenant(installed_app_id: str, tenant_id: str) -> bool:
    """Verify the installed app belongs to the requesting tenant."""

    session = db.session()
    try:
        installed_app = session.scalar(
            select(InstalledApp).where(InstalledApp.id == installed_app_id)
        )
        if installed_app is None:
            return False
        return installed_app.tenant_id == tenant_id
    finally:
        session.close()


def to_dict(draft: InstalledAppChatDraft) -> dict[str, Any]:
    """Serialise a draft for the API response."""

    return {
        "draft_id": draft.draft_id,
        "conversation_id": draft.conversation_id,
        "workflow_run_id": draft.workflow_run_id,
        "title": draft.title,
        "chat_tree": draft.chat_tree_json or [],
        "is_terminal": draft.is_terminal,
        "created_at": _iso(draft.created_at),
        "updated_at": _iso(draft.updated_at),
        "last_message_at": _iso(draft.last_message_at) if draft.last_message_at else None,
    }


def _iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.isoformat() + "Z" if value.tzinfo is None else value.isoformat()