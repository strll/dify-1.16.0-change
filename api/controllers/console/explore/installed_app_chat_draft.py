from flask_restx import Resource
from werkzeug.exceptions import Forbidden, NotFound

from controllers.common.schema import (
    register_response_schema_models,
    register_schema_models,
)
from controllers.console import console_ns
from controllers.console.wraps import (
    account_initialization_required,
    with_current_tenant_id,
    with_current_user,
)
from libs.login import login_required
from services.installed_app_chat_draft_service import (
    delete_draft,
    is_installed_app_owned_by_tenant,
    list_drafts,
    to_dict,
    upsert_draft,
)

from .installed_app_chat_draft_schema import (
    ChatDraftItem,
    ChatDraftListResponse,
    ChatDraftUpsertPayload,
    SimpleOkResponse,
)


_register_payload_models = (
    ChatDraftUpsertPayload,
)
_register_response_models = (
    ChatDraftItem,
    ChatDraftListResponse,
    SimpleOkResponse,
)
register_schema_models(console_ns, *_register_payload_models)
register_response_schema_models(console_ns, *_register_response_models)


@console_ns.route("/installed-apps/<uuid:installed_app_id>/chat-drafts")
class InstalledAppChatDraftCollectionApi(Resource):
    method_decorators = [
        login_required,
        account_initialization_required,
    ]

    @with_current_user
    @with_current_tenant_id
    @console_ns.expect(console_ns.models[ChatDraftUpsertPayload.__name__])
    @console_ns.response(
        200,
        "Draft upserted",
        console_ns.models[SimpleOkResponse.__name__],
    )
    def post(self, current_tenant_id: str, current_user, installed_app_id: str):
        """Upsert an in-flight chat draft."""

        payload = ChatDraftUpsertPayload.model_validate(console_ns.payload or {})
        if not is_installed_app_owned_by_tenant(installed_app_id, current_tenant_id):
            raise NotFound("Installed app not found")
        upsert_draft(
            draft_id=payload.draft_id,
            tenant_id=current_tenant_id,
            installed_app_id=installed_app_id,
            user_id=str(current_user.id),
            conversation_id=payload.conversation_id,
            workflow_run_id=payload.workflow_run_id,
            title=payload.title,
            chat_tree=payload.chat_tree,
            is_terminal=payload.is_terminal,
        )
        return {"result": "success"}

    @with_current_user
    @with_current_tenant_id
    @console_ns.response(
        200,
        "Drafts listed",
        console_ns.models[ChatDraftListResponse.__name__],
    )
    def get(self, current_tenant_id: str, current_user, installed_app_id: str):
        """List drafts belonging to the current user for this installed app."""

        if not is_installed_app_owned_by_tenant(installed_app_id, current_tenant_id):
            raise NotFound("Installed app not found")
        drafts = list_drafts(
            tenant_id=current_tenant_id,
            installed_app_id=installed_app_id,
            user_id=str(current_user.id),
        )
        return {"data": [to_dict(draft) for draft in drafts]}


@console_ns.route("/installed-apps/<uuid:installed_app_id>/chat-drafts/<string:draft_id>")
class InstalledAppChatDraftItemApi(Resource):
    method_decorators = [
        login_required,
        account_initialization_required,
    ]

    @with_current_tenant_id
    @console_ns.response(
        200,
        "Draft deleted",
        console_ns.models[SimpleOkResponse.__name__],
    )
    def delete(self, current_tenant_id: str, installed_app_id: str, draft_id: str):
        """Delete a single draft."""

        if not is_installed_app_owned_by_tenant(installed_app_id, current_tenant_id):
            raise NotFound("Installed app not found")
        delete_draft(
            draft_id=draft_id,
            tenant_id=current_tenant_id,
            installed_app_id=installed_app_id,
        )
        return {"result": "success"}
