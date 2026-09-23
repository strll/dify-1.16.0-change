"""Startup hook for the incremental user management tables."""

import logging

from dify_app import DifyApp

logger = logging.getLogger(__name__)


def init_app(app: DifyApp) -> None:
    """Create the feature-owned tables on API startup when they are absent."""
    with app.app_context():
        from controllers.console.user_management.storage import ensure_tables

        try:
            ensure_tables()
        except Exception:
            logger.exception("Failed to initialize user-management tables")
