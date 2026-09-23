"""CLI commands for granting the feature to selected super administrators."""

import click

from extensions.ext_database import db

from .storage import audit, ensure_tables, grant_permission, revoke_permission


@click.command("user-management-permission", help="Grant or revoke incremental user-management access.")
@click.argument("action", type=click.Choice(["grant", "revoke"]))
@click.argument("email")
def user_management_permission(action: str, email: str) -> None:
    ensure_tables()
    session = db.session()
    try:
        if action == "grant":
            grant_permission(email, "cli", session=session)
        else:
            revoke_permission(email, session=session)
        audit("cli", f"permission_{action}", target_email=email, session=session)
        session.commit()
        click.echo(f"{action}ed user-management permission for {email.strip().lower()}")
    finally:
        session.close()
