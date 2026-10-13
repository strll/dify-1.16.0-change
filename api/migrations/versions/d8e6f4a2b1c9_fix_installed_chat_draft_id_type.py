"""Use string IDs for installed chat drafts created by the browser.

Revision ID: d8e6f4a2b1c9
Revises: c1d2e3f4a5b6

The original PostgreSQL migration created a UUID column, while browser draft
IDs contain a ``draft:`` prefix. Existing rows can be converted without loss.
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "d8e6f4a2b1c9"
down_revision = "c1d2e3f4a5b6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    connection = op.get_bind()
    if connection.dialect.name != "postgresql":
        return

    columns = sa.inspect(connection).get_columns("installed_app_chat_drafts")
    draft_id_type = next(column["type"] for column in columns if column["name"] == "draft_id")
    if isinstance(draft_id_type, postgresql.UUID):
        op.alter_column(
            "installed_app_chat_drafts",
            "draft_id",
            existing_type=draft_id_type,
            type_=sa.String(length=128),
            existing_nullable=False,
            postgresql_using="draft_id::text",
        )


def downgrade() -> None:
    # Browser draft IDs cannot be represented as UUIDs; keep the compatible string column.
    pass
