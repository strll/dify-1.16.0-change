import { del, get, post } from './base'

export type ChatDraftItem = {
  draft_id: string
  conversation_id: string | null
  workflow_run_id: string | null
  title: string | null
  chat_tree: any[]
  is_terminal: boolean
  created_at: string
  updated_at: string
  last_message_at: string | null
}

export type ChatDraftUpsertPayload = {
  draft_id: string
  conversation_id?: string | null
  workflow_run_id?: string | null
  title?: string | null
  chat_tree?: any[]
  is_terminal?: boolean
}

const baseUrl = (installedAppId: string) =>
  `/installed-apps/${installedAppId}/chat-drafts`

const itemUrl = (installedAppId: string, draftId: string) =>
  `${baseUrl(installedAppId)}/${encodeURIComponent(draftId)}`

export const upsertInstalledAppChatDraft = (
  installedAppId: string,
  payload: ChatDraftUpsertPayload,
) => post<{ result: string }>(baseUrl(installedAppId), { body: payload })

export const listInstalledAppChatDrafts = (installedAppId: string) =>
  get<{ data: ChatDraftItem[] }>(baseUrl(installedAppId))

export const deleteInstalledAppChatDraft = (
  installedAppId: string,
  draftId: string,
) => del<{ result: string }>(itemUrl(installedAppId, draftId))