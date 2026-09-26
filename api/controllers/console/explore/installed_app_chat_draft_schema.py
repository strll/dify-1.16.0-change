from typing import Any

from pydantic import BaseModel, Field


# ----- Request ----------------------------------------------------------------


class ChatDraftUpsertPayload(BaseModel):
    draft_id: str = Field(description="Client-generated draft UUID (primary key)")
    conversation_id: str | None = Field(default=None, description="Alias to a real conversation id once the stream returns it")
    workflow_run_id: str | None = Field(default=None, description="Workflow run id for SSE resubscription after reload")
    title: str | None = Field(default=None, description="Draft title shown in the sidebar")
    chat_tree: list = Field(default_factory=list, description="ChatItemInTree[] snapshot for this draft")
    is_terminal: bool = Field(default=False, description="True once the workflow has reached a terminal status")


# ----- Response ---------------------------------------------------------------


class ChatDraftItem(BaseModel):
    draft_id: str
    conversation_id: str | None = None
    workflow_run_id: str | None = None
    title: str | None = None
    chat_tree: list[Any] = Field(default_factory=list)
    is_terminal: bool = False
    created_at: str
    updated_at: str
    last_message_at: str | None = None


class ChatDraftListResponse(BaseModel):
    data: list[ChatDraftItem] = Field(default_factory=list)


class SimpleOkResponse(BaseModel):
    result: str = "success"