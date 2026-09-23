"""Console APIs for bulk invitations and cross-workspace assignment.

This is intentionally additive: existing member/workspace controllers are not
changed.  The module delegates actual membership writes to TenantService and
RegisterService and only owns import orchestration and its audit trail.
"""

from __future__ import annotations

import io
from http import HTTPStatus
from typing import Any, Literal
from uuid import uuid4

from flask import jsonify, request, send_file
from flask_restx import Resource
from openpyxl import Workbook, load_workbook
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import and_, select
from sqlalchemy.orm import Session
from werkzeug.exceptions import BadRequest, Forbidden, NotFound

from controllers.common.session import with_session
from controllers.console import console_ns
from controllers.console.wraps import account_initialization_required, setup_required, with_current_user
from extensions.ext_database import db
from core.db.session_factory import session_factory
from libs.helper import EmailStr
from libs.login import login_required
from models.account import Account, AccountStatus, Tenant, TenantAccountJoin, TenantAccountRole
from services.account_service import RegisterService, TenantService
from services.errors.account import AccountAlreadyInTenantError, NoPermissionError
from tasks.mail_invite_member_task import send_invite_member_mail_task

from .storage import (
    account_for_email,
    audit,
    has_permission,
    normalize_email,
    workspace_assignments,
)


class ImportRow(BaseModel):
    email: EmailStr
    role: str = "normal"
    workspace_name: str | None = None
    workspace_id: str | None = None

    @field_validator("role")
    @classmethod
    def validate_role(cls, role: str) -> str:
        if not TenantAccountRole.is_valid_role(role):
            raise ValueError("role must be owner, admin, editor, normal, or dataset_operator")
        return role

    @field_validator("workspace_name")
    @classmethod
    def normalize_workspace(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        return value or None

    @field_validator("workspace_id")
    @classmethod
    def normalize_workspace_id(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        return value or None


class ImportConfirmPayload(BaseModel):
    rows: list[ImportRow] = Field(min_length=1)
    operation: Literal["invite", "assign"]


def _require_access(current_user: Account) -> None:
    if not has_permission(current_user.email, session=db.session()):
        raise Forbidden("User-management permission is required.")


def _reconcile_pending(session: Session) -> None:
    """Apply preallocations as soon as an invited email creates an account."""
    pending = session.execute(
        select(workspace_assignments).where(workspace_assignments.c.status == "pending")
    ).mappings().all()
    for item in pending:
        # TenantService commits internally in Dify 1.16.0.  Therefore a
        # reconciliation must not run inside a SAVEPOINT owned by another
        # request transaction; use a short-lived session for this item.
        item_session = session_factory.create_session()
        try:
            account = account_for_email(item["email"], session=item_session)
            tenant = item_session.get(Tenant, item["workspace_id"]) if item["workspace_id"] else None
            if account is None or tenant is None:
                item_session.close()
                continue
            existing = item_session.scalar(
                select(TenantAccountJoin).where(
                    TenantAccountJoin.tenant_id == tenant.id,
                    TenantAccountJoin.account_id == account.id,
                )
            )
            if existing is None:
                TenantService.create_tenant_member(
                    tenant,
                    account,
                    session=item_session,
                    role=item["role"],
                )
            item_session.execute(
                workspace_assignments.update()
                .where(workspace_assignments.c.id == item["id"])
                .values(status="assigned", error=None)
            )
            item_session.commit()
        except Exception as exc:
            # A workspace may have acquired an owner since the preallocation
            # was created.  Keep the row visible and explain why it was not
            # reconciled instead of failing every assignments request.
            item_session.rollback()
            item_session.execute(
                workspace_assignments.update()
                .where(workspace_assignments.c.id == item["id"])
                .values(status="failed", error=str(exc))
            )
            item_session.commit()
        finally:
            item_session.close()


def _invite_with_global_access(
    tenant: Tenant,
    email: str,
    role: str,
    inviter: Account,
    *,
    language: str | None,
    session: Session,
) -> str:
    """Invite through low-level services for a globally authorized operator.

    RegisterService.invite_new_member intentionally enforces the operator's
    native workspace role.  The user-management permission is global, so this
    fallback performs the same account/member/token flow after that check has
    been rejected, without changing Dify's existing service implementation.
    """
    normalized_email = normalize_email(email)
    account = account_for_email(normalized_email, session=session)
    requires_setup = False
    if account is None:
        account = RegisterService.register(
            email=normalized_email,
            name=normalized_email.split("@", 1)[0],
            language=language,
            status=AccountStatus.PENDING,
            is_setup=True,
            session=session,
        )
        TenantService.create_tenant_member(
            tenant, account, session, role
        )
        requires_setup = True
    else:
        membership = session.scalar(
            select(TenantAccountJoin).where(
                TenantAccountJoin.tenant_id == tenant.id,
                TenantAccountJoin.account_id == account.id,
            )
        )
        if membership is not None and account.status != AccountStatus.PENDING:
            raise AccountAlreadyInTenantError("Account already in tenant.")
        if membership is None:
            TenantService.create_tenant_member(
                tenant, account, session, role
            )
        requires_setup = account.status == AccountStatus.PENDING

    token = RegisterService.generate_invite_token(tenant, account, role, requires_setup=requires_setup)
    send_invite_member_mail_task.delay(
        language=account.interface_language or language or "en-US",
        to=account.email,
        token=token,
        inviter_name=inviter.name,
        workspace_name=tenant.name,
    )
    return token


def _header_map(values: list[Any]) -> dict[str, int]:
    aliases = {
        "email": {"email", "邮箱", "用户邮箱", "邮件地址"},
        "role": {"role", "角色", "工作空间角色"},
        "workspace_name": {"workspace_name", "workspace", "工作空间", "工作空间名称"},
        "workspace_id": {"workspace_id", "workspace id", "工作空间id", "工作空间 ID", "工作空间编号"},
    }
    normalized = {str(v or "").strip().lower(): index for index, v in enumerate(values)}
    result: dict[str, int] = {}
    for field, names in aliases.items():
        for name in names:
            if name.lower() in normalized:
                result[field] = normalized[name.lower()]
                break
    return result


def parse_excel(
    file_storage, *, operation: Literal["invite", "assign"] = "assign"
) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
    filename = (file_storage.filename or "").lower()
    if not filename.endswith((".xlsx", ".xlsm")):
        raise BadRequest("Only .xlsx and .xlsm files are supported.")
    try:
        workbook = load_workbook(file_storage.stream, read_only=True, data_only=True)
        sheet = workbook.active
        rows = sheet.iter_rows(values_only=True)
        header = next(rows, None)
        if not header:
            raise BadRequest("The Excel file is empty.")
        indexes = _header_map(list(header))
        if "email" not in indexes:
            raise BadRequest("Excel must contain an email/邮箱 column.")
        if operation == "assign" and "workspace_name" not in indexes and "workspace_id" not in indexes:
            raise BadRequest("工作空间分配 Excel 必须包含工作空间名称或工作空间 ID 列，请下载并使用分配模板。")
        parsed: list[dict[str, str]] = []
        errors: list[dict[str, str]] = []
        seen: set[tuple[str, str | None]] = set()
        for values in rows:
            raw_email = str(values[indexes["email"]] or "").strip()
            raw_role = str(values[indexes.get("role", -1)] or "normal").strip().lower()
            raw_workspace = (
                str(values[indexes["workspace_name"]] or "").strip() if "workspace_name" in indexes else None
            )
            raw_workspace_id = (
                str(values[indexes["workspace_id"]] or "").strip() if "workspace_id" in indexes else None
            )
            if not raw_email:
                continue
            key = (normalize_email(raw_email), raw_workspace_id or raw_workspace)
            if key in seen:
                errors.append(
                    {
                        "email": raw_email,
                        "role": raw_role,
                        "workspace_name": raw_workspace or "",
                        "workspace_id": raw_workspace_id or "",
                        "reason": "重复邮箱",
                    }
                )
                continue
            seen.add(key)
            try:
                item = ImportRow(
                    email=raw_email,
                    role=raw_role,
                    workspace_name=raw_workspace,
                    workspace_id=raw_workspace_id,
                )
                parsed.append(item.model_dump(mode="json"))
            except Exception as exc:
                errors.append(
                    {
                        "email": raw_email,
                        "role": raw_role,
                        "workspace_name": raw_workspace or "",
                        "workspace_id": raw_workspace_id or "",
                        "reason": str(exc),
                    }
                )
        return parsed, errors
    except BadRequest:
        raise
    except Exception as exc:
        raise BadRequest(f"Unable to read Excel: {exc}") from exc


def _write_xlsx(rows: list[dict[str, Any]]) -> io.BytesIO:
    output = io.BytesIO()
    workbook = Workbook()
    sheet = workbook.active
    sheet.append(["email", "role", "workspace_name", "workspace_id", "reason"])
    for row in rows:
        sheet.append(
            [
                row.get("email", ""),
                row.get("role", ""),
                row.get("workspace_name", ""),
                row.get("workspace_id", ""),
                row.get("reason", ""),
            ]
        )
    workbook.save(output)
    output.seek(0)
    return output


def _template_xlsx(operation: Literal["invite", "assign"]) -> io.BytesIO:
    """Build a small, ready-to-fill workbook for the selected operation."""
    output = io.BytesIO()
    workbook = Workbook()
    sheet = workbook.active
    if operation == "invite":
        sheet.append(["邮箱", "角色"])
        sheet.append(["example@example.com", "normal"])
    else:
        sheet.append(["用户邮箱", "工作空间名称", "工作空间 ID", "工作空间角色"])
        sheet.append(["example@example.com", "销售团队", "", "normal"])
    workbook.save(output)
    output.seek(0)
    return output


@console_ns.route("/user-management/access")
class UserManagementAccessApi(Resource):
    @setup_required
    @login_required
    @account_initialization_required
    @with_current_user
    def get(self, current_user: Account):
        session = db.session()
        _reconcile_pending(session)
        session.commit()
        return {"enabled": has_permission(current_user.email, session=session)}, HTTPStatus.OK


@console_ns.route("/user-management/import/preview")
class UserManagementImportPreviewApi(Resource):
    @setup_required
    @login_required
    @account_initialization_required
    @with_current_user
    def post(self, current_user: Account):
        _require_access(current_user)
        upload = request.files.get("file")
        if upload is None:
            raise BadRequest("file is required")
        operation = request.form.get("operation", "assign")
        if operation not in {"invite", "assign"}:
            raise BadRequest("Invalid operation")
        rows, errors = parse_excel(upload, operation=operation)
        audit(
            current_user.email,
            "import_preview",
            session=db.session(),
            details={"count": len(rows), "errors": len(errors)},
        )
        db.session.commit()
        return {"rows": rows, "errors": errors, "total": len(rows) + len(errors)}, HTTPStatus.OK


@console_ns.route("/user-management/import/confirm")
class UserManagementImportConfirmApi(Resource):
    @setup_required
    @login_required
    @account_initialization_required
    @with_current_user
    @with_session
    def post(self, session: Session, current_user: Account):
        if not has_permission(current_user.email, session=session):
            raise Forbidden("User-management permission is required.")
        _reconcile_pending(session)
        payload = ImportConfirmPayload.model_validate(request.get_json(silent=True) or console_ns.payload or {})
        results: list[dict[str, Any]] = []
        for row in payload.rows:
            row_session = session_factory.create_session()
            try:
                # Dify 1.16.0 services commit internally.  Process each row
                # in its own Session instead of wrapping those services in a
                # SAVEPOINT, whose transaction would be closed by commit().
                if payload.operation == "invite":
                    if not current_user.current_tenant:
                        raise BadRequest("No current workspace")
                    try:
                        token = RegisterService.invite_new_member(
                            tenant=current_user.current_tenant,
                            email=str(row.email),
                            language=current_user.interface_language,
                            role=row.role,
                            inviter=current_user,
                            session=row_session,
                        )
                    except NoPermissionError:
                        token = _invite_with_global_access(
                            current_user.current_tenant,
                            str(row.email),
                            row.role,
                            current_user,
                            language=current_user.interface_language,
                            session=row_session,
                        )
                    result = {"status": "success", "email": str(row.email), "role": row.role, "invite_token": token}
                else:
                    result = _assign_row(row, current_user, session=row_session)
                row_session.commit()
            except Exception as exc:
                # Roll back before recording the failure.  Reusing a failed
                # transaction here is the direct cause of the old error.
                row_session.rollback()
                result = {
                    "status": "failed",
                    "email": str(row.email),
                    "role": row.role,
                    "workspace_name": row.workspace_name or "",
                    "workspace_id": row.workspace_id or "",
                    "reason": str(exc),
                }
            finally:
                row_session.close()
            results.append(result)
        audit(current_user.email, f"import_{payload.operation}", session=session, details={"count": len(results)})
        session.commit()
        return {"results": results}, HTTPStatus.OK


def _assign_row(row: ImportRow, current_user: Account, *, session: Session) -> dict[str, Any]:
    if not row.workspace_name and not row.workspace_id:
        raise BadRequest("workspace_name or workspace_id is required for assignment")
    email = normalize_email(str(row.email))
    account = account_for_email(email, session=session)
    if row.workspace_id:
        tenant = session.get(Tenant, row.workspace_id)
        if tenant is None:
            raise BadRequest("工作空间 ID 不存在")
        if row.workspace_name and row.workspace_name != tenant.name:
            raise BadRequest("工作空间名称与 ID 不匹配")
        workspace_name = tenant.name
    else:
        # Workspace names are intentionally case-sensitive as requested.
        tenant = session.scalar(
            select(Tenant).where(Tenant.name == row.workspace_name).order_by(Tenant.created_at.asc()).limit(1)
        )
        if tenant is None:
            tenant = TenantService.create_tenant(row.workspace_name, is_from_dashboard=True, session=session)
        workspace_name = tenant.name
    if row.role == TenantAccountRole.OWNER.value:
        owner_exists = session.scalar(
            select(TenantAccountJoin.id).where(
                TenantAccountJoin.tenant_id == tenant.id,
                TenantAccountJoin.role == TenantAccountRole.OWNER,
            )
        )
        pending_owner_exists = session.scalar(
            select(workspace_assignments.c.id).where(
                workspace_assignments.c.workspace_id == str(tenant.id),
                workspace_assignments.c.role == TenantAccountRole.OWNER.value,
                workspace_assignments.c.status == "pending",
            )
        )
        if owner_exists or pending_owner_exists:
            raise BadRequest("工作空间已有 Owner，不能重复指定")
    if account is None:
        existing_pending = session.execute(
            select(workspace_assignments.c.id).where(
                workspace_assignments.c.email == email,
                workspace_assignments.c.workspace_name == workspace_name,
            )
        ).scalar_one_or_none()
        if existing_pending:
            session.execute(
                workspace_assignments.update()
                .where(workspace_assignments.c.id == existing_pending)
                .values(role=row.role, status="pending", error=None)
            )
        else:
            session.execute(
                workspace_assignments.insert().values(
                    id=str(uuid4()),
                    email=email,
                    workspace_name=workspace_name,
                    workspace_id=str(tenant.id),
                    role=row.role,
                    status="pending",
                    created_by_email=current_user.email,
                )
            )
        return {
            "status": "pending",
            "email": email,
            "workspace_name": workspace_name,
            "workspace_id": str(tenant.id),
            "role": row.role,
            "reason": "用户尚未注册，已预分配",
        }
    existing = session.scalar(
        select(TenantAccountJoin).where(
            and_(TenantAccountJoin.tenant_id == tenant.id, TenantAccountJoin.account_id == account.id)
        )
    )
    if existing:
        if row.role == TenantAccountRole.OWNER.value:
            owner_exists = session.scalar(
                select(TenantAccountJoin.id).where(
                    TenantAccountJoin.tenant_id == tenant.id,
                    TenantAccountJoin.role == TenantAccountRole.OWNER,
                    TenantAccountJoin.account_id != account.id,
                )
            )
            if owner_exists:
                raise BadRequest("工作空间已有 Owner，不能重复指定")
        existing_role = existing.role.value if hasattr(existing.role, "value") else str(existing.role)
        if existing_role != row.role:
            existing.role = TenantAccountRole(row.role)
            status = "updated"
        else:
            status = "already_assigned"
    else:
        TenantService.create_tenant_member(
            tenant, account, session=session, role=row.role
        )
        status = "assigned"
    existing_assignment = session.execute(
        select(workspace_assignments.c.id).where(
            workspace_assignments.c.email == email,
            workspace_assignments.c.workspace_name == workspace_name,
        )
    ).scalar_one_or_none()
    if existing_assignment is None:
        session.execute(
            workspace_assignments.insert().values(
                id=str(uuid4()),
                email=email,
                workspace_name=workspace_name,
                workspace_id=str(tenant.id),
                role=row.role,
                status="assigned",
                created_by_email=current_user.email,
            )
        )
    audit(
        current_user.email,
        "workspace_assign",
        session=session,
        target_email=email,
        workspace_name=workspace_name,
        details={"role": row.role},
    )
    return {
        "status": status,
        "email": email,
        "workspace_name": workspace_name,
        "role": row.role,
        "workspace_id": str(tenant.id),
    }


@console_ns.route("/user-management/assignments")
class UserManagementAssignmentsApi(Resource):
    @setup_required
    @login_required
    @account_initialization_required
    @with_current_user
    @with_session(write=False)
    def get(self, session: Session, current_user: Account):
        if not has_permission(current_user.email, session=session):
            raise Forbidden("User-management permission is required.")
        _reconcile_pending(session)
        email = normalize_email(request.args.get("email", ""))
        workspace_name = request.args.get("workspace_name", "").strip()
        try:
            page = max(int(request.args.get("page", "1")), 1)
            limit = min(max(int(request.args.get("limit", "50")), 1), 500)
        except ValueError as exc:
            raise BadRequest("page and limit must be integers") from exc
        query = select(workspace_assignments).order_by(workspace_assignments.c.created_at.desc())
        if email:
            query = query.where(workspace_assignments.c.email.contains(email))
        if workspace_name:
            query = query.where(workspace_assignments.c.workspace_name.contains(workspace_name))
        rows = []
        for row in session.execute(query).mappings().all():
            # SQLAlchemy may expose ``quoted_name``/Column keys here.  Cast
            # keys explicitly because Dify's orjson provider only accepts
            # string dictionary keys.
            assignment_id = row[workspace_assignments.c.id]
            item = {str(key): value for key, value in row.items()}
            item["id"] = str(assignment_id)
            item["assignment_id"] = str(assignment_id)
            if item.get("workspace_id"):
                item["workspace_id"] = str(item["workspace_id"])
            account = account_for_email(item["email"], session=session)
            if account is not None:
                item["account_id"] = str(account.id)
                item["user_id"] = str(account.id)
                tenant = session.get(Tenant, item["workspace_id"]) if item.get("workspace_id") else None
                membership = None
                if tenant is not None:
                    membership = session.scalar(
                        select(TenantAccountJoin).where(
                            TenantAccountJoin.tenant_id == tenant.id,
                            TenantAccountJoin.account_id == account.id,
                        )
                    )
                if membership is not None:
                    item["current"] = bool(membership.current)
                    item["last_opened_at"] = (
                        membership.last_opened_at.isoformat() if membership.last_opened_at else None
                    )
            rows.append(item)
        # Include live memberships as well as preallocation records so both
        # user-centric and workspace-centric views are complete.
        live_stmt = (
            select(
                Account.id,
                Account.email,
                Tenant.name,
                Tenant.id,
                TenantAccountJoin.id,
                TenantAccountJoin.role,
                TenantAccountJoin.current,
                TenantAccountJoin.last_opened_at,
            )
            .join(TenantAccountJoin, TenantAccountJoin.account_id == Account.id)
            .join(Tenant, Tenant.id == TenantAccountJoin.tenant_id)
        )
        for account_id, account_email, tenant_name, tenant_id, join_id, role, current, last_opened_at in session.execute(
            live_stmt
        ).all():
            if email and email not in normalize_email(account_email):
                continue
            if workspace_name and workspace_name not in tenant_name:
                continue
            if not any(
                item.get("email") == normalize_email(account_email) and item.get("workspace_name") == tenant_name
                for item in rows
            ):
                rows.append(
                    {
                        "email": normalize_email(account_email),
                        "account_id": str(account_id),
                        "user_id": str(account_id),
                        "workspace_name": tenant_name,
                        "workspace_id": str(tenant_id),
                        "assignment_id": str(join_id),
                        "role": role.value if hasattr(role, "value") else str(role),
                        "current": bool(current),
                        "last_opened_at": last_opened_at.isoformat() if last_opened_at else None,
                        "status": "assigned",
                    }
                )
        total = len(rows)
        start = (page - 1) * limit
        return jsonify(
            {
                "items": rows[start : start + limit],
                "total": total,
                "page": page,
                "limit": limit,
                "has_more": start + limit < total,
            }
        )


class UserManagementAssignmentMutationApi(Resource):
    @setup_required
    @login_required
    @account_initialization_required
    @with_current_user
    @with_session
    def put(self, session: Session, current_user: Account, assignment_id: str):
        if not has_permission(current_user.email, session=session):
            raise Forbidden("User-management permission is required.")
        # ``Namespace.payload`` can be empty when the route has no explicit
        # Flask-RESTX parser.  Fall back to Flask's JSON reader so browser
        # PUT requests are handled consistently in development and Docker.
        payload = request.get_json(silent=True) or console_ns.payload or {}
        role = str(payload.get("role", "")).lower()
        if not TenantAccountRole.is_valid_role(role):
            raise BadRequest("Invalid role")
        assignment = (
            session.execute(select(workspace_assignments).where(workspace_assignments.c.id == assignment_id))
            .mappings()
            .first()
        )
        # Rows created before this extension may only exist in the native
        # membership table.  Accept both our assignment id and a
        # TenantAccountJoin id so every row shown by the list is editable.
        membership = None
        if assignment:
            tenant = session.get(Tenant, assignment["workspace_id"])
            account = account_for_email(assignment["email"], session=session)
        else:
            membership = session.get(TenantAccountJoin, assignment_id)
            if membership is None:
                raise NotFound()
            tenant = session.get(Tenant, membership.tenant_id)
            account = session.get(Account, membership.account_id)
            if tenant is None or account is None:
                raise NotFound()
            assignment = {
                "id": assignment_id,
                "email": account.email,
                "workspace_id": str(tenant.id),
                "workspace_name": tenant.name,
            }
        if tenant is None:
            raise BadRequest("Workspace is missing")
        # Preallocated users may not have an Account yet.  Their role can
        # still be edited while the assignment remains pending.
        if account is None:
            session.execute(
                workspace_assignments.update()
                .where(workspace_assignments.c.id == assignment_id)
                .values(role=role, status="pending", error=None)
            )
            audit(
                current_user.email,
                "workspace_role_update",
                session=session,
                target_email=assignment["email"],
                workspace_name=assignment["workspace_name"],
                details={"role": role, "status": "pending"},
            )
            return {"result": "success", "status": "pending"}, HTTPStatus.OK
        membership = membership or session.scalar(
            select(TenantAccountJoin).where(
                TenantAccountJoin.tenant_id == tenant.id, TenantAccountJoin.account_id == account.id
            )
        )
        if role == TenantAccountRole.OWNER.value:
            owner_exists = session.scalar(
                select(TenantAccountJoin.id).where(
                    TenantAccountJoin.tenant_id == tenant.id,
                    TenantAccountJoin.role == TenantAccountRole.OWNER,
                    TenantAccountJoin.account_id != account.id,
                )
            )
            if owner_exists:
                raise BadRequest("工作空间已有 Owner，不能重复指定")
        if membership is None:
            TenantService.create_tenant_member(
                tenant, account, session=session, role=role
            )
        else:
            membership.role = TenantAccountRole(role)
        session.execute(
            workspace_assignments.update()
            .where(workspace_assignments.c.id == assignment_id)
            .values(role=role, status="assigned", error=None)
        )
        audit(
            current_user.email,
            "workspace_role_update",
            session=session,
            target_email=assignment["email"],
            workspace_name=assignment["workspace_name"],
            details={"role": role},
        )
        return {"result": "success"}, HTTPStatus.OK

    @setup_required
    @login_required
    @account_initialization_required
    @with_current_user
    @with_session
    def delete(self, session: Session, current_user: Account, assignment_id: str):
        if not has_permission(current_user.email, session=session):
            raise Forbidden("User-management permission is required.")
        assignment = (
            session.execute(select(workspace_assignments).where(workspace_assignments.c.id == assignment_id))
            .mappings()
            .first()
        )
        if assignment:
            tenant = session.get(Tenant, assignment["workspace_id"])
            account = account_for_email(assignment["email"], session=session)
        else:
            membership = session.get(TenantAccountJoin, assignment_id)
            if membership is None:
                raise NotFound()
            tenant = session.get(Tenant, membership.tenant_id)
            account = session.get(Account, membership.account_id)
            assignment = {
                "id": assignment_id,
                "email": account.email if account else "",
                "workspace_name": tenant.name if tenant else "",
            }
        if tenant is not None and account is not None:
            try:
                TenantService.remove_member_from_tenant(tenant, account, current_user, session=session)
            except NoPermissionError:
                # The dedicated user-management permission is global, while
                # Dify's native service only allows workspace admins to
                # remove members.  For a globally authorized operator,
                # remove the membership directly after retaining the native
                # self-removal and sole-owner safeguards.
                if membership_role := session.scalar(
                    select(TenantAccountJoin.role).where(
                        TenantAccountJoin.tenant_id == tenant.id,
                        TenantAccountJoin.account_id == account.id,
                    )
                ):
                    if membership_role == TenantAccountRole.OWNER:
                        other_owner = session.scalar(
                            select(TenantAccountJoin.id).where(
                                TenantAccountJoin.tenant_id == tenant.id,
                                TenantAccountJoin.role == TenantAccountRole.OWNER,
                                TenantAccountJoin.account_id != account.id,
                            )
                        )
                        if other_owner is None:
                            raise BadRequest("不能移除工作空间唯一的 Owner")
                    session.execute(
                        TenantAccountJoin.__table__.delete().where(
                            TenantAccountJoin.tenant_id == tenant.id,
                            TenantAccountJoin.account_id == account.id,
                        )
                    )
        if assignment.get("id"):
            session.execute(workspace_assignments.delete().where(workspace_assignments.c.id == assignment_id))
        audit(
            current_user.email,
            "workspace_unassign",
            session=session,
            target_email=assignment["email"],
            workspace_name=assignment["workspace_name"],
        )
        return {"result": "success"}, HTTPStatus.OK


console_ns.add_resource(UserManagementAssignmentMutationApi, "/user-management/assignments/<string:assignment_id>")


@console_ns.route("/user-management/templates/<string:operation>")
class UserManagementTemplateApi(Resource):
    @setup_required
    @login_required
    @account_initialization_required
    @with_current_user
    def get(self, current_user: Account, operation: str):
        _require_access(current_user)
        if operation not in {"invite", "assign"}:
            raise NotFound()
        filename = "member-invite-template.xlsx" if operation == "invite" else "workspace-assignment-template.xlsx"
        return send_file(
            _template_xlsx(operation),
            as_attachment=True,
            download_name=filename,
            mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )


@console_ns.route("/user-management/assignments/export")
class UserManagementAssignmentsExportApi(Resource):
    @setup_required
    @login_required
    @account_initialization_required
    @with_current_user
    def get(self, current_user: Account):
        if not has_permission(current_user.email, session=db.session()):
            raise Forbidden("User-management permission is required.")
        session = db.session()
        rows = []
        for row in session.execute(select(workspace_assignments)).mappings().all():
            item = {str(key): value for key, value in row.items()}
            item["id"] = str(row[workspace_assignments.c.id])
            rows.append(item)
        live_stmt = (
            select(Account.id, Account.email, Tenant.name, Tenant.id, TenantAccountJoin.id, TenantAccountJoin.role)
            .join(TenantAccountJoin, TenantAccountJoin.account_id == Account.id)
            .join(Tenant, Tenant.id == TenantAccountJoin.tenant_id)
        )
        for account_id, account_email, tenant_name, tenant_id, join_id, role in session.execute(live_stmt).all():
            normalized = normalize_email(account_email)
            if not any(item.get("email") == normalized and item.get("workspace_name") == tenant_name for item in rows):
                rows.append(
                    {
                        "id": str(join_id),
                        "email": normalized,
                        "account_id": str(account_id),
                        "user_id": str(account_id),
                        "workspace_name": tenant_name,
                        "workspace_id": str(tenant_id),
                        "role": role.value if hasattr(role, "value") else str(role),
                        "status": "assigned",
                    }
                )
        return send_file(
            _write_xlsx(rows),
            as_attachment=True,
            download_name="workspace-assignments.xlsx",
            mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )


@console_ns.route("/user-management/import/failed-export")
class UserManagementFailedExportApi(Resource):
    @setup_required
    @login_required
    @account_initialization_required
    @with_current_user
    def post(self, current_user: Account):
        _require_access(current_user)
        payload = request.get_json(silent=True) or {}
        rows = payload.get("rows")
        if not isinstance(rows, list):
            raise BadRequest("rows must be a list")
        return send_file(
            _write_xlsx(rows),
            as_attachment=True,
            download_name="failed-imports.xlsx",
            mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )
