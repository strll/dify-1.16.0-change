"""Storage and policy helpers for the incremental user management feature.

The tables are deliberately owned by this package.  They are created lazily by
the extension at startup so installing the feature does not require a migration
in existing community deployments.
"""

from __future__ import annotations

import json
from datetime import datetime
from uuid import uuid4

import sqlalchemy as sa
from sqlalchemy import select
from sqlalchemy.orm import Session

from extensions.ext_database import db
from models.account import Account

metadata = sa.MetaData()

user_management_permissions = sa.Table(
    "user_management_permissions",
    metadata,
    sa.Column("id", sa.String(36), primary_key=True),
    sa.Column("email", sa.String(255), nullable=False, unique=True, index=True),
    sa.Column("enabled", sa.Boolean, nullable=False, server_default=sa.text("true")),
    sa.Column("granted_by_email", sa.String(255), nullable=True),
    sa.Column("created_at", sa.DateTime, nullable=False, server_default=sa.func.current_timestamp()),
    sa.Column("updated_at", sa.DateTime, nullable=False, server_default=sa.func.current_timestamp()),
)

workspace_assignments = sa.Table(
    "user_management_workspace_assignments",
    metadata,
    sa.Column("id", sa.String(36), primary_key=True),
    sa.Column("email", sa.String(255), nullable=False, index=True),
    sa.Column("workspace_name", sa.String(255), nullable=False),
    sa.Column("workspace_id", sa.String(36), nullable=True, index=True),
    sa.Column("role", sa.String(32), nullable=False, server_default="normal"),
    sa.Column("status", sa.String(32), nullable=False, server_default="pending"),
    sa.Column("error", sa.Text, nullable=True),
    sa.Column("created_by_email", sa.String(255), nullable=False),
    sa.Column("created_at", sa.DateTime, nullable=False, server_default=sa.func.current_timestamp()),
    sa.Column("updated_at", sa.DateTime, nullable=False, server_default=sa.func.current_timestamp()),
    sa.UniqueConstraint("email", "workspace_name", name="uq_um_assignment_email_workspace"),
)

user_management_audit_logs = sa.Table(
    "user_management_audit_logs",
    metadata,
    sa.Column("id", sa.String(36), primary_key=True),
    sa.Column("actor_email", sa.String(255), nullable=False, index=True),
    sa.Column("action", sa.String(64), nullable=False, index=True),
    sa.Column("target_email", sa.String(255), nullable=True),
    sa.Column("workspace_name", sa.String(255), nullable=True),
    sa.Column("details", sa.Text, nullable=True),
    sa.Column("created_at", sa.DateTime, nullable=False, server_default=sa.func.current_timestamp()),
)


def ensure_tables() -> None:
    """Create feature tables if this is the first startup after installation."""
    # API and worker containers start concurrently. Serialize PostgreSQL's
    # check/create sequence so two containers cannot race through checkfirst.
    if db.engine.dialect.name == "postgresql":
        with db.engine.begin() as connection:
            connection.execute(sa.text("SELECT pg_advisory_xact_lock(817263541)"))
            metadata.create_all(bind=connection, checkfirst=True)
    else:
        metadata.create_all(bind=db.engine, checkfirst=True)


def normalize_email(value: str) -> str:
    return value.strip().lower()


def has_permission(email: str, *, session: Session) -> bool:
    row = session.execute(
        select(user_management_permissions.c.enabled).where(
            user_management_permissions.c.email == normalize_email(email),
            user_management_permissions.c.enabled.is_(True),
        )
    ).scalar_one_or_none()
    return row is True


def grant_permission(email: str, granted_by_email: str | None, *, session: Session) -> None:
    normalized = normalize_email(email)
    existing = session.execute(
        select(user_management_permissions.c.id).where(user_management_permissions.c.email == normalized)
    ).scalar_one_or_none()
    values = {"email": normalized, "enabled": True, "granted_by_email": granted_by_email}
    if existing:
        session.execute(
            user_management_permissions.update()
            .where(user_management_permissions.c.id == existing)
            .values(**values, updated_at=datetime.utcnow())
        )
    else:
        session.execute(user_management_permissions.insert().values(id=str(uuid4()), **values))


def revoke_permission(email: str, *, session: Session) -> None:
    session.execute(
        user_management_permissions.update()
        .where(user_management_permissions.c.email == normalize_email(email))
        .values(enabled=False, updated_at=datetime.utcnow())
    )


def audit(
    actor_email: str,
    action: str,
    *,
    session: Session,
    target_email: str | None = None,
    workspace_name: str | None = None,
    details: dict | None = None,
) -> None:
    session.execute(
        user_management_audit_logs.insert().values(
            id=str(uuid4()),
            actor_email=normalize_email(actor_email),
            action=action,
            target_email=normalize_email(target_email) if target_email else None,
            workspace_name=workspace_name,
            details=json.dumps(details or {}, ensure_ascii=False),
        )
    )


def account_for_email(email: str, *, session: Session) -> Account | None:
    normalized = normalize_email(email)
    return session.scalar(
        sa.select(Account).where(sa.func.lower(Account.email) == normalized)
    )
