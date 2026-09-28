"""add installed_app_chat_drafts table for in-flight chat persistence

Revision ID: c1d2e3f4a5b6
Revises: 7a1c2d9e4b60
Create Date: 2026-09-24 12:00:00.000000

"""
import sqlalchemy as sa
from alembic import op

import models.types
from models import InstalledAppChatDraft


def _is_pg(conn) -> bool:
    return conn.dialect.name == "postgresql"


# revision identifiers, used by Alembic.
revision = "c1d2e3f4a5b6"
down_revision = "7a1c2d9e4b60"
branch_labels = None
depends_on = None


def upgrade():
    conn = op.get_bind()

    if _is_pg(conn):
        json_type = models.types.AdjustedJSON(astext_type=models.types.LongText())
    else:
        json_type = models.types.LongText()

    op.create_table(
        "installed_app_chat_drafts",
        sa.Column("draft_id", sa.String(length=255), primary_key=True),
        sa.Column("tenant_id", models.types.StringUUID(), nullable=False),
        sa.Column("installed_app_id", models.types.StringUUID(), nullable=False),
        sa.Column("user_id", models.types.StringUUID(), nullable=False),
        sa.Column("conversation_id", models.types.StringUUID(), nullable=True),
        sa.Column("workflow_run_id", models.types.StringUUID(), nullable=True),
        sa.Column("title", models.types.LongText(), nullable=True),
        sa.Column("chat_tree_json", json_type, nullable=False),
        sa.Column("is_terminal", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("last_message_at", sa.DateTime(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.func.current_timestamp(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.func.current_timestamp(),
        ),
        sa.UniqueConstraint("draft_id", name="installed_app_chat_drafts_draft_id_unique"),
    )
    op.create_index(
        "installed_app_chat_drafts_app_user_idx",
        "installed_app_chat_drafts",
        ["installed_app_id", "tenant_id", "user_id"],
    )


def downgrade():
    op.drop_index("installed_app_chat_drafts_app_user_idx", table_name="installed_app_chat_drafts")
    op.drop_table("installed_app_chat_drafts")
