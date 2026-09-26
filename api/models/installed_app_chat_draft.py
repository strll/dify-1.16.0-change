from datetime import datetime

import sqlalchemy as sa
from sqlalchemy.orm import Mapped, mapped_column

from .base import Base
from .types import AdjustedJSON, LongText, StringUUID


class InstalledAppChatDraft(Base):
    """In-flight chat state for a draft placeholder on /installed apps.

    A draft is created the moment the user clicks "开启新对话". It survives
    page reloads and SSE reconnects until the server promotes it to a real
    conversation, at which point the row is deleted and the user resumes
    against the regular conversation history endpoint.
    """

    __tablename__ = "installed_app_chat_drafts"
    __table_args__ = (
        sa.Index(
            "installed_app_chat_drafts_app_user_idx",
            "installed_app_id",
            "tenant_id",
            "user_id",
        ),
    )

    # The client-generated draft id (e.g. "draft:<uuid>") is the primary key so
    # upserts are idempotent and the client can pick it back up after a
    # reload without us assigning anything server-side.
    draft_id: Mapped[str] = mapped_column(
        sa.String(128),
        primary_key=True,
    )

    tenant_id: Mapped[str] = mapped_column(StringUUID, nullable=False)
    installed_app_id: Mapped[str] = mapped_column(StringUUID, nullable=False)
    user_id: Mapped[str] = mapped_column(StringUUID, nullable=False)
    # Optional alias to a real conversation id once the stream returns one.
    conversation_id: Mapped[str | None] = mapped_column(StringUUID, nullable=True, default=None)
    # Optional workflow_run_id so the client can re-subscribe to SSE for an
    # in-flight workflow after a page reload.
    workflow_run_id: Mapped[str | None] = mapped_column(StringUUID, nullable=True, default=None)
    title: Mapped[str | None] = mapped_column(LongText, nullable=True, default=None)
    # LongText on MySQL/SQLite, JSONB on Postgres. The shape mirrors the
    # ChatItemInTree[] tree the client already has in memory; storing the
    # whole tree avoids losing in-flight workflow state across reloads.
    chat_tree_json: Mapped[list | dict] = mapped_column(AdjustedJSON(astext_type=LongText), nullable=False, default=list)
    # true once the workflow / streaming message has reached a terminal
    # status. The service layer uses this to clean up completed drafts on
    # the next list call.
    is_terminal: Mapped[bool] = mapped_column(
        sa.Boolean, nullable=False, server_default=sa.text("false"), default=False
    )
    last_message_at: Mapped[datetime | None] = mapped_column(sa.DateTime, nullable=True, default=None)
    created_at: Mapped[datetime] = mapped_column(
        sa.DateTime,
        nullable=False,
        server_default=sa.func.current_timestamp(),
    )
    updated_at: Mapped[datetime] = mapped_column(
        sa.DateTime,
        nullable=False,
        server_default=sa.func.current_timestamp(),
        onupdate=sa.func.current_timestamp(),
    )