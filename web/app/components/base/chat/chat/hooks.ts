import type { ChatConfig, ChatItem, ChatItemInTree, Inputs } from '../types'
import type { InputForm, ThoughtItem } from './type'
import type AudioPlayer from '@/app/components/base/audio-btn/audio'
import type { FileEntity } from '@/app/components/base/file-uploader/types'
import type { Annotation } from '@/models/log'
import type { IOnDataMoreInfo, IOtherOptions } from '@/service/base'
import type { VisionFile } from '@/types/app'
import type { FileResponse, ReasoningChunkResponse } from '@/types/workflow'
import { toast } from '@langgenius/dify-ui/toast'
import { uniqBy } from 'es-toolkit/compat'
import { noop } from 'es-toolkit/function'
import { produce, setAutoFreeze } from 'immer'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { v4 as uuidV4 } from 'uuid'
import { AudioPlayerManager } from '@/app/components/base/audio-btn/audio.player.manager'
import { enrichSubmittedHumanInputFormData } from '@/app/components/base/chat/chat/answer/human-input-content/submitted-utils'
import {
  getProcessedFiles,
  getProcessedFilesFromResponse,
} from '@/app/components/base/file-uploader/utils'
import { isInstalledAppPath } from '@/app/components/explore/installed-app/routes'
import { addFileInfos, sortAgentSorts } from '@/app/components/tools/utils'
import { NodeRunningStatus, WorkflowRunningStatus } from '@/app/components/workflow/types'
import useTimestamp from '@/hooks/use-timestamp'
import { useParams, usePathname } from '@/next/navigation'
import { sseGet, ssePost } from '@/service/base'
import { TransferMethod } from '@/types/app'
import {
  cleanupExpiredInstalledChatRecovery,
  clearInstalledChatRecovery,
  loadInstalledChatRecovery,
  saveInstalledChatRecovery,
} from '../installed-chat-recovery'
import { getThreadMessages } from '../utils'
import { getProcessedInputs, processOpeningStatement } from './utils'

type GetAbortController = (abortController: AbortController) => void
type HistoryMessageFile = Partial<FileResponse> & {
  id?: string
  belongs_to?: string
}
type HistoryConversationMessage = {
  id: string
  answer?: string
  message?: { role: string; text: string; files?: FileEntity[] }[]
  message_files?: HistoryMessageFile[]
  agent_thoughts?: ThoughtItem[] | null
  retriever_resources?: ChatItem['citation']
  metadata?: {
    reasoning?: ChatItem['reasoningContent']
  }
  created_at?: number
  answer_tokens?: number
  message_tokens?: number
  provider_response_latency?: number
  workflow_run_id?: string
  feedback?: ChatItem['feedback']
  inputs?: unknown
  query?: string
}
type ConversationMessagesResponse = {
  data: HistoryConversationMessage[]
}

function mergeRecoveredChatTree(
  serverTree: ChatItemInTree[],
  recoveredTree: ChatItemInTree[],
): ChatItemInTree[] {
  const recoveredById = new Map<string, ChatItemInTree>()
  const indexRecovered = (nodes: ChatItemInTree[]) => {
    nodes.forEach((node) => {
      recoveredById.set(node.id, node)
      if (node.children) indexRecovered(node.children)
    })
  }
  indexRecovered(recoveredTree)

  const isTerminal = (status?: string) =>
    status === 'succeeded' || status === 'failed' || status === 'stopped'

  const mergeNode = (serverNode: ChatItemInTree): ChatItemInTree => {
    const recoveredNode = recoveredById.get(serverNode.id)
    if (!recoveredNode) return serverNode
    const serverChildren = serverNode.children || []
    const recoveredChildren = recoveredNode.children || []
    const serverChildIds = new Set(serverChildren.map((child) => child.id))
    // Server history has no workflowProcess for in-flight workflows; the
    // local snapshot is the only source of truth until the server finalizes
    // the run. Once the server reports a terminal status, prefer it so the
    // completed history is not overwritten by stale "running" snapshots.
    const mergedWorkflowProcess = isTerminal(serverNode.workflowProcess?.status)
      ? serverNode.workflowProcess
      : recoveredNode.workflowProcess || serverNode.workflowProcess
    return {
      ...serverNode,
      ...recoveredNode,
      // A locally captured stream can contain an empty placeholder while the
      // server already has the final answer. Keep whichever content is useful.
      content: recoveredNode.content || serverNode.content,
      reasoningContent: recoveredNode.reasoningContent || serverNode.reasoningContent,
      agent_thoughts: recoveredNode.agent_thoughts || serverNode.agent_thoughts,
      workflowProcess: mergedWorkflowProcess,
      workflow_run_id: recoveredNode.workflow_run_id || serverNode.workflow_run_id,
      task_id: recoveredNode.task_id || serverNode.task_id,
      children: [
        ...serverChildren.map(mergeNode),
        ...recoveredChildren.filter((child) => !serverChildIds.has(child.id)),
      ],
    }
  }

  const serverIds = new Set(serverTree.map((node) => node.id))
  return [
    ...serverTree.map(mergeNode),
    ...recoveredTree.filter((node) => !serverIds.has(node.id)),
  ]
}
type SendCallback = {
  onConversationStarted?: (conversationId: string, sessionId?: string) => void
  onGetConversationMessages?: (
    conversationId: string,
    getAbortController: GetAbortController,
  ) => Promise<unknown>
  onGetSuggestedQuestions?: (
    responseItemId: string,
    getAbortController: GetAbortController,
  ) => Promise<unknown>
  onConversationComplete?: (conversationId: string, workflowRunId?: string, sessionId?: string) => void
  onUnhandledEvent?: IOtherOptions['onUnhandledEvent']
  onSendSettled?: (hasError?: boolean) => void
  isPublicAPI?: boolean
}

type UseChatOptions = {
  isNewAgent?: boolean
  timezone?: string
  /** Stable installed-app session identity used to keep concurrent chats isolated. */
  sessionId?: string
}

function mergeStreamingThought(currentThought: ThoughtItem, nextThought: ThoughtItem): ThoughtItem {
  return {
    ...nextThought,
    message_files: nextThought.message_files?.length
      ? nextThought.message_files
      : currentThought.message_files,
  }
}

function appendAgentResponseMessagePart(responseItem: ChatItemInTree, message: string) {
  if (!responseItem.agent_response_parts) responseItem.agent_response_parts = []

  const lastPart = responseItem.agent_response_parts.at(-1)
  if (lastPart?.type === 'message') {
    lastPart.content += message
  } else {
    responseItem.agent_response_parts.push({
      type: 'message',
      content: message,
    })
  }
}

function upsertAgentResponseThoughtPart(responseItem: ChatItemInTree, thought: ThoughtItem) {
  if (!responseItem.agent_response_parts) responseItem.agent_response_parts = []

  const partIndex = responseItem.agent_response_parts.findIndex(
    (part) => part.type === 'thought' && part.thought.id === thought.id,
  )
  if (partIndex > -1) {
    responseItem.agent_response_parts[partIndex] = {
      type: 'thought',
      thought,
    }
    return
  }

  responseItem.agent_response_parts.push({
    type: 'thought',
    thought,
  })
}

function getHistoryAgentThoughts(responseItem: HistoryConversationMessage) {
  if (!Array.isArray(responseItem.agent_thoughts)) return []

  const messageFiles: VisionFile[] =
    responseItem.message_files?.map((file) => ({
      id: file.id,
      type: file.type || '',
      transfer_method: file.transfer_method || TransferMethod.remote_url,
      url: file.url || '',
      upload_file_id: file.upload_file_id || '',
      belongs_to: file.belongs_to,
    })) || []

  return addFileInfos(sortAgentSorts(responseItem.agent_thoughts), messageFiles)
}

function toHistoryFileResponse(file: HistoryMessageFile): FileResponse {
  return {
    related_id: file.related_id || file.id || '',
    extension: file.extension || '',
    filename: file.filename || '',
    size: file.size || 0,
    mime_type: file.mime_type || file.type || '',
    transfer_method: file.transfer_method || TransferMethod.remote_url,
    type: file.type || '',
    url: file.url || '',
    upload_file_id: file.upload_file_id || '',
    remote_url: file.remote_url || '',
  }
}

function getHistoryAnswerFiles(responseItem: HistoryConversationMessage) {
  const answerFiles =
    responseItem.message_files?.filter((file) => file.belongs_to === 'assistant') || []

  return getProcessedFilesFromResponse(
    answerFiles.map((file) =>
      toHistoryFileResponse({
        ...file,
        related_id: file.related_id || file.id || '',
        upload_file_id: file.upload_file_id || '',
      }),
    ),
  )
}

function isHistoryConversationMessage(value: unknown): value is HistoryConversationMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string'
  )
}

function getConversationMessagesData(response: unknown): ConversationMessagesResponse['data'] {
  if (typeof response !== 'object' || response === null) return []

  const data = (response as { data?: unknown }).data
  return Array.isArray(data) ? data.filter(isHistoryConversationMessage) : []
}

export const useChat = (
  config?: ChatConfig,
  formSettings?: {
    inputs: Inputs
    inputsForm: InputForm[]
  },
  prevChatTree?: ChatItemInTree[],
  stopChat?: (taskId: string) => void,
  clearChatList?: boolean,
  clearChatListCallback?: (state: boolean) => void,
  initialConversationId?: string,
  options: UseChatOptions = {},
) => {
  const { t } = useTranslation()
  const { formatTime } = useTimestamp({ timezone: options.timezone })
  const conversationIdRef = useRef(initialConversationId ?? '')
  const initialConversationIdRef = useRef(initialConversationId ?? '')
  const hasStopRespondedRef = useRef(false)
  const [isResponding, setIsResponding] = useState(false)
  const isRespondingRef = useRef(false)
  const taskIdRef = useRef('')
  const pausedStateRef = useRef(false)
  const [suggestedQuestions, setSuggestedQuestions] = useState<string[]>([])
  const conversationMessagesAbortControllerRef = useRef<AbortController | null>(null)
  const suggestedQuestionsAbortControllerRef = useRef<AbortController | null>(null)
  const workflowEventsAbortControllerRef = useRef<AbortController | null>(null)
  const params = useParams()
  const pathname = usePathname()

  const sessionKey = options.sessionId ?? initialConversationId ?? ''
  const [chatTree, setChatTree] = useState<ChatItemInTree[]>(prevChatTree || [])
  const chatTreeRef = useRef<ChatItemInTree[]>(chatTree)
  const [targetMessageId, setTargetMessageId] = useState<string>()
  const activeSessionKeyRef = useRef(sessionKey)
  const chatTreesBySessionRef = useRef(new Map<string, ChatItemInTree[]>([[sessionKey, prevChatTree || []]]))
  const respondingSessionsRef = useRef(new Map<string, boolean>())
  const taskIdsBySessionRef = useRef(new Map<string, string>())
  const sessionAliasesRef = useRef(new Map<string, string>())
  const responseSessionKeysRef = useRef(new WeakMap<object, string>())
  const recoveryWriteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Draft sessions are intentionally memory-only; only server conversation IDs are recoverable after reload.
  const recoverySessionIdRef = useRef(initialConversationId ?? '')
  const installedRecoveryEnabled = isInstalledAppPath(pathname) && Boolean(config?.appId)

  const persistInstalledChatTree = useCallback(
    (nextTree: ChatItemInTree[]) => {
      if (!installedRecoveryEnabled || !config?.appId) return
      if (recoveryWriteTimerRef.current) clearTimeout(recoveryWriteTimerRef.current)
      recoveryWriteTimerRef.current = setTimeout(() => {
        recoveryWriteTimerRef.current = null
        // Snapshot must be keyed by the conversation the tree actually
        // belongs to. recoverySessionIdRef can lag behind when the user
        // switches between concurrent chats; activeSessionKeyRef always tracks
        // the session currently held in chatTreeRef.
        const activeKey = activeSessionKeyRef.current
        if (!activeKey) return
        const resolvedAlias = sessionAliasesRef.current.get(activeKey)
        const conversationId = activeKey.startsWith('draft:')
          ? (resolvedAlias || '')
          : activeKey
        if (!conversationId) return
        const terminal = nextTree.some((item) =>
          ['succeeded', 'failed', 'stopped'].includes(item.workflowProcess?.status || ''),
        )
        const operation = terminal
          ? clearInstalledChatRecovery(config.appId!, conversationId)
          : saveInstalledChatRecovery(config.appId!, conversationId, nextTree)
        void operation.catch(() => undefined)
      }, 200)
    },
    [config?.appId, installedRecoveryEnabled],
  )

  useEffect(() => {
    if (!installedRecoveryEnabled || !config?.appId) return
    void cleanupExpiredInstalledChatRecovery().catch(() => undefined)
    const recoveryConversationId = sessionKey.startsWith('draft:') ? '' : sessionKey
    if (!recoveryConversationId) return
    void loadInstalledChatRecovery(config.appId, recoveryConversationId)
      .then((snapshot) => {
        if (!snapshot || activeSessionKeyRef.current !== sessionKey) return
        const currentTree = chatTreesBySessionRef.current.get(sessionKey) || []
        const mergedTree = mergeRecoveredChatTree(currentTree, snapshot.chatTree)
        chatTreesBySessionRef.current.set(sessionKey, mergedTree)
        chatTreeRef.current = mergedTree
        setChatTree(mergedTree)
      })
      .catch(() => undefined)
  }, [config?.appId, installedRecoveryEnabled, sessionKey])

  useEffect(() => {
    const previousSessionKey = activeSessionKeyRef.current
    if (previousSessionKey === sessionKey) {
      if (prevChatTree?.length) {
        const currentTree = chatTreesBySessionRef.current.get(sessionKey) || []
        const mergedTree = mergeRecoveredChatTree(prevChatTree, currentTree)
        chatTreesBySessionRef.current.set(sessionKey, mergedTree)
        chatTreeRef.current = mergedTree
        setChatTree(mergedTree)
      }
      return
    }

    chatTreesBySessionRef.current.set(previousSessionKey, chatTreeRef.current)
    const nextTree = chatTreesBySessionRef.current.get(sessionKey) || prevChatTree || []
    activeSessionKeyRef.current = sessionKey
    chatTreesBySessionRef.current.set(sessionKey, nextTree)
    chatTreeRef.current = nextTree
    // oxlint-disable-next-line eslint-react/set-state-in-effect -- switch the visible session tree.
    setChatTree(nextTree)
    // oxlint-disable-next-line eslint-react/set-state-in-effect -- reset suggestions for the selected session.
    setSuggestedQuestions([])
    // oxlint-disable-next-line eslint-react/set-state-in-effect -- reset thread selection for the selected session.
    setTargetMessageId(undefined)
    recoverySessionIdRef.current = sessionKey.startsWith('draft:') ? '' : sessionKey
    conversationIdRef.current = initialConversationId ?? ''
    taskIdRef.current = taskIdsBySessionRef.current.get(sessionKey) || ''
    setIsResponding(Boolean(respondingSessionsRef.current.get(sessionKey)))
    isRespondingRef.current = Boolean(respondingSessionsRef.current.get(sessionKey))
  }, [initialConversationId, prevChatTree, sessionKey])

  useEffect(() => {
    persistInstalledChatTree(chatTree)
  }, [chatTree, persistInstalledChatTree])

  useEffect(() => {
    return () => {
      if (recoveryWriteTimerRef.current) clearTimeout(recoveryWriteTimerRef.current)
    }
  }, [])
  const threadMessages = useMemo(
    () => getThreadMessages(chatTree, targetMessageId),
    [chatTree, targetMessageId],
  )

  const getIntroduction = useCallback(
    (str: string) => {
      return processOpeningStatement(
        str,
        formSettings?.inputs || {},
        formSettings?.inputsForm || [],
      )
    },
    [formSettings?.inputs, formSettings?.inputsForm],
  )

  const processedOpeningContent = config?.opening_statement
    ? getIntroduction(config.opening_statement)
    : undefined
  const processedSuggestionsKey = config?.suggested_questions
    ? JSON.stringify(config.suggested_questions.map((q) => getIntroduction(q)))
    : undefined

  const openingStatementItem = useMemo<ChatItemInTree | null>(() => {
    if (!processedOpeningContent) return null
    return {
      id: 'opening-statement',
      content: processedOpeningContent,
      isAnswer: true,
      isOpeningStatement: true,
      suggestedQuestions: processedSuggestionsKey
        ? (JSON.parse(processedSuggestionsKey) as string[])
        : undefined,
    }
  }, [processedOpeningContent, processedSuggestionsKey])

  const threadOpener = useMemo(
    () => threadMessages.find((item) => item.isOpeningStatement) ?? null,
    [threadMessages],
  )

  const mergedOpeningItem = useMemo<ChatItemInTree | null>(() => {
    if (!threadOpener || !openingStatementItem) return null
    return {
      ...threadOpener,
      content: openingStatementItem.content,
      suggestedQuestions: openingStatementItem.suggestedQuestions,
    }
  }, [threadOpener, openingStatementItem])

  /** Final chat list that will be rendered */
  const chatList = useMemo(() => {
    const ret = [...threadMessages]
    if (openingStatementItem) {
      const index = threadMessages.findIndex((item) => item.isOpeningStatement)
      if (index > -1 && mergedOpeningItem) ret[index] = mergedOpeningItem
      else if (index === -1) ret.unshift(openingStatementItem)
    }
    return ret
  }, [threadMessages, openingStatementItem, mergedOpeningItem])

  useEffect(() => {
    setAutoFreeze(false)
    return () => {
      setAutoFreeze(true)
    }
  }, [])

  useEffect(() => {
    const nextConversationId = initialConversationId ?? ''
    initialConversationIdRef.current = nextConversationId
    conversationIdRef.current = nextConversationId
    if (nextConversationId) recoverySessionIdRef.current = nextConversationId
  }, [initialConversationId])

  /** Find the target node by bfs and then operate on it */
  const produceChatTreeNode = useCallback(
    (targetId: string, operation: (node: ChatItemInTree) => void, tree = chatTreeRef.current) => {
      return produce(tree, (draft) => {
        const queue: ChatItemInTree[] = [...draft]
        while (queue.length > 0) {
          const current = queue.shift()!
          if (current.id === targetId) {
            operation(current)
            break
          }
          if (current.children) queue.push(...current.children)
        }
      })
    },
    [],
  )

  type UpdateChatTreeNode = {
    (id: string, fields: Partial<ChatItemInTree>): void
    (id: string, update: (node: ChatItemInTree) => void): void
    (id: string, fields: Partial<ChatItemInTree>, sessionKey: string): void
    (id: string, update: (node: ChatItemInTree) => void, sessionKey: string): void
  }

  const updateChatTreeNode: UpdateChatTreeNode = useCallback(
    (
      id: string,
      fieldsOrUpdate: Partial<ChatItemInTree> | ((node: ChatItemInTree) => void),
      targetSessionKey?: string,
    ) => {
      let sessionKey = targetSessionKey || activeSessionKeyRef.current
      // Resume callbacks can arrive after the user switches chats. When the
      // caller has no explicit session, locate the response node in the
      // per-session trees before falling back to the active session.
      if (installedRecoveryEnabled && !targetSessionKey) {
        const containsNode = (tree: ChatItemInTree[]) => {
          const queue = [...tree]
          while (queue.length) {
            const node = queue.shift()!
            if (node.id === id) return true
            if (node.children) queue.push(...node.children)
          }
          return false
        }
        for (const [candidateKey, candidateTree] of chatTreesBySessionRef.current) {
          if (containsNode(candidateTree)) {
            sessionKey = candidateKey
            break
          }
        }
      }
      const currentTree = installedRecoveryEnabled
        ? chatTreesBySessionRef.current.get(sessionKey) || []
        : chatTreeRef.current
      const nextState = produceChatTreeNode(id, (node) => {
        if (typeof fieldsOrUpdate === 'function') {
          fieldsOrUpdate(node)
        } else {
          Object.keys(fieldsOrUpdate).forEach((key) => {
            ;(node as any)[key] = (fieldsOrUpdate as any)[key]
          })
        }
      }, currentTree)
      if (installedRecoveryEnabled) chatTreesBySessionRef.current.set(sessionKey, nextState)
      if (!installedRecoveryEnabled || sessionKey === activeSessionKeyRef.current) {
        setChatTree(nextState)
        chatTreeRef.current = nextState
        persistInstalledChatTree(nextState)
      }
    },
    [installedRecoveryEnabled, persistInstalledChatTree, produceChatTreeNode],
  )

  const handleResponding = useCallback((isResponding: boolean, targetSessionKey = activeSessionKeyRef.current) => {
    respondingSessionsRef.current.set(targetSessionKey, isResponding)
    if (targetSessionKey !== activeSessionKeyRef.current) return
    setIsResponding(isResponding)
    isRespondingRef.current = isResponding
  }, [])

  const handleStop = useCallback(() => {
    hasStopRespondedRef.current = true
    handleResponding(false)
    const activeTaskId = taskIdsBySessionRef.current.get(activeSessionKeyRef.current) || taskIdRef.current
    if (stopChat && activeTaskId && !pausedStateRef.current) stopChat(activeTaskId)
    if (conversationMessagesAbortControllerRef.current)
      conversationMessagesAbortControllerRef.current.abort()
    if (suggestedQuestionsAbortControllerRef.current)
      suggestedQuestionsAbortControllerRef.current.abort()
    if (workflowEventsAbortControllerRef.current) workflowEventsAbortControllerRef.current.abort()
    // Clear the snapshot for the session the user explicitly stopped. Using
    // activeSessionKeyRef rather than recoverySessionIdRef avoids wiping the
    // snapshot of a sibling conversation when the user has switched away.
    if (installedRecoveryEnabled && config?.appId)
      void clearInstalledChatRecovery(
        config.appId,
        activeSessionKeyRef.current || recoverySessionIdRef.current,
      ).catch(() => undefined)
  }, [config?.appId, handleResponding, installedRecoveryEnabled, stopChat])

  const handleRestart = useCallback(
    (cb?: any) => {
      conversationIdRef.current = initialConversationIdRef.current
      taskIdRef.current = ''
      handleStop()
      chatTreesBySessionRef.current.set(activeSessionKeyRef.current, [])
      // oxlint-disable-next-line eslint-react/set-state-in-effect -- clear the non-installed chat surface.
      setChatTree([])
      chatTreeRef.current = []
      setSuggestedQuestions([])
      cb?.()
    },
    [handleStop],
  )

  const createAudioPlayerManager = useCallback(() => {
    let ttsUrl = ''
    let ttsIsPublic = false
    if (params.token) {
      ttsUrl = '/text-to-audio'
      ttsIsPublic = true
    } else if (params.appId) {
      if (isInstalledAppPath(pathname)) ttsUrl = `/installed-apps/${params.appId}/text-to-audio`
      else ttsUrl = `/apps/${params.appId}/text-to-audio`
    }

    let player: AudioPlayer | null = null
    const getOrCreatePlayer = () => {
      if (!player)
        player = AudioPlayerManager.getInstance().getAudioPlayer(
          ttsUrl,
          ttsIsPublic,
          uuidV4(),
          'none',
          'none',
          noop,
        )

      return player
    }

    return getOrCreatePlayer
  }, [params.token, params.appId, pathname])

  const handleResume = useCallback(
    async (
      messageId: string,
      workflowRunId: string,
      {
        onGetSuggestedQuestions,
        onConversationStarted,
        onConversationComplete,
        onSendSettled,
        isPublicAPI,
      }: SendCallback,
    ) => {
      const getOrCreatePlayer = createAudioPlayerManager()
      const resumeSessionKey = activeSessionKeyRef.current
      let hasSettled = false
      const settleSend = (hasError?: boolean) => {
        if (hasSettled) return

        hasSettled = true
        onSendSettled?.(hasError)
      }
      // Re-subscribe to workflow events for the specific message
      const url = `/workflow/${workflowRunId}/events?include_state_snapshot=true`

      const otherOptions: IOtherOptions = {
        isPublicAPI,
        getAbortController: (abortController) => {
          workflowEventsAbortControllerRef.current = abortController
        },
        onData: (
          message: string,
          isFirstMessage: boolean,
          { event, conversationId: newConversationId, messageId, taskId }: IOnDataMoreInfo,
        ) => {
          updateChatTreeNode(messageId, (responseItem) => {
            const agentThoughts = responseItem.agent_thoughts ?? []
            const isNewAgentMessage =
              options.isNewAgent && (event === 'agent_message' || event === 'message')
            if (isNewAgentMessage) {
              appendAgentResponseMessagePart(responseItem, message)
            } else if (!agentThoughts.length || options.isNewAgent) {
              responseItem.content = responseItem.content + message
            } else {
              const lastThought = agentThoughts[agentThoughts.length - 1]
              if (lastThought) lastThought.thought = lastThought.thought + message
            }
            if (messageId) responseItem.id = messageId
          })

          if (isFirstMessage && newConversationId) {
            conversationIdRef.current = newConversationId
            if (installedRecoveryEnabled) recoverySessionIdRef.current = newConversationId
            // Forward the session the resumption belongs to so the caller can
            // route cleanup to the correct draft.
            onConversationStarted?.(newConversationId, resumeSessionKey)
          }

          if (taskId) {
            taskIdRef.current = taskId
            taskIdsBySessionRef.current.set(resumeSessionKey, taskId)
          }
        },
        onReasoning: ({ data: reasoningData }: ReasoningChunkResponse) => {
          const { message_id, reasoning, node_id, is_final } = reasoningData
          updateChatTreeNode(message_id, (responseItem) => {
            const reasoningContent =
              responseItem.reasoningContent || (responseItem.reasoningContent = {})
            const key = node_id || '_'
            if (reasoning) reasoningContent[key] = (reasoningContent[key] || '') + reasoning
            if (is_final) responseItem.reasoningFinished = true
          })
        },
        async onCompleted(hasError?: boolean) {
          handleResponding(false, resumeSessionKey)

          try {
            if (hasError) return

            if (onConversationComplete) {
              if (installedRecoveryEnabled)
                onConversationComplete(conversationIdRef.current, workflowRunId, resumeSessionKey)
              else onConversationComplete(conversationIdRef.current, workflowRunId)
            }

            if (
              config?.suggested_questions_after_answer?.enabled &&
              !hasStopRespondedRef.current &&
              onGetSuggestedQuestions
            ) {
              try {
                const { data }: any = await onGetSuggestedQuestions(
                  messageId,
                  (newAbortController) =>
                    (suggestedQuestionsAbortControllerRef.current = newAbortController),
                )
                setSuggestedQuestions(data)
              } catch {
                setSuggestedQuestions([])
              }
            }
          } finally {
            settleSend(hasError)
          }
        },
        onFile(file) {
          // Convert simple file type to MIME type for non-agent mode
          // Backend sends: { id, type: "image", belongs_to, url }
          // Frontend expects: { id, type: "image/png", transferMethod, url, uploadedId, supportFileType, name, size }

          // Determine file type for MIME conversion
          const fileType = (file as { type?: string }).type || 'image'

          // If file already has transferMethod, use it as base and ensure all required fields exist
          // Otherwise, create a new complete file object
          const baseFile = 'transferMethod' in file ? (file as Partial<FileEntity>) : null

          const convertedFile: FileEntity = {
            id: baseFile?.id || (file as { id: string }).id,
            type:
              baseFile?.type ||
              (fileType === 'image'
                ? 'image/png'
                : fileType === 'video'
                  ? 'video/mp4'
                  : fileType === 'audio'
                    ? 'audio/mpeg'
                    : 'application/octet-stream'),
            transferMethod:
              (baseFile?.transferMethod as FileEntity['transferMethod']) ||
              (fileType === 'image' ? 'remote_url' : 'local_file'),
            uploadedId: baseFile?.uploadedId || (file as { id: string }).id,
            supportFileType:
              baseFile?.supportFileType ||
              (fileType === 'image'
                ? 'image'
                : fileType === 'video'
                  ? 'video'
                  : fileType === 'audio'
                    ? 'audio'
                    : 'document'),
            progress: baseFile?.progress ?? 100,
            name:
              baseFile?.name ||
              `generated_${fileType}.${fileType === 'image' ? 'png' : fileType === 'video' ? 'mp4' : fileType === 'audio' ? 'mp3' : 'bin'}`,
            url: baseFile?.url || (file as { url?: string }).url,
            size: baseFile?.size ?? 0, // Generated files don't have a known size
          }
          updateChatTreeNode(messageId, (responseItem) => {
            const lastThought =
              responseItem.agent_thoughts?.[responseItem.agent_thoughts?.length - 1]
            if (lastThought) {
              responseItem.agent_thoughts!.at(-1)!.message_files = [
                ...(lastThought as any).message_files,
                convertedFile,
              ]
            } else {
              const currentFiles = (responseItem.message_files as FileEntity[] | undefined) ?? []
              responseItem.message_files = [...currentFiles, convertedFile]
            }
          })
        },
        onThought(thought) {
          updateChatTreeNode(messageId, (responseItem) => {
            if (thought.message_id) responseItem.id = thought.message_id
            if (thought.conversation_id) responseItem.conversationId = thought.conversation_id

            if (!responseItem.agent_thoughts) responseItem.agent_thoughts = []

            if (responseItem.agent_thoughts.length === 0) {
              responseItem.agent_thoughts.push(thought)
            } else {
              const lastThought = responseItem.agent_thoughts.at(-1)
              if (lastThought?.id === thought.id) {
                responseItem.agent_thoughts[responseItem.agent_thoughts.length - 1] =
                  mergeStreamingThought(lastThought, thought)
              } else {
                responseItem.agent_thoughts.push(thought)
              }
            }
            if (options.isNewAgent) {
              const currentThought =
                responseItem.agent_thoughts.find((item) => item.id === thought.id) ?? thought
              upsertAgentResponseThoughtPart(responseItem, currentThought)
            }
          })
        },
        onMessageEnd: (messageEnd) => {
          const messageEndConversationId = (messageEnd as unknown as { conversation_id?: string })
            .conversation_id
          if (options.isNewAgent && messageEndConversationId)
            conversationIdRef.current = messageEndConversationId
          updateChatTreeNode(messageId, (responseItem) => {
            if (messageEnd.metadata?.annotation_reply) {
              responseItem.annotation = {
                id: messageEnd.metadata.annotation_reply.id,
                authorName: messageEnd.metadata.annotation_reply.account.name,
              }
              return
            }
            responseItem.citation = messageEnd.metadata?.retriever_resources || []
            const processedFilesFromResponse = getProcessedFilesFromResponse(messageEnd.files || [])
            responseItem.allFiles = uniqBy(
              [...(responseItem.allFiles || []), ...(processedFilesFromResponse || [])],
              'id',
            )
          })
        },
        onMessageReplace: (messageReplace) => {
          updateChatTreeNode(messageId, (responseItem) => {
            responseItem.content = messageReplace.answer
          })
        },
        onError() {
          handleResponding(false, resumeSessionKey)
          settleSend(true)
        },
        onWorkflowStarted: ({ workflow_run_id, task_id }) => {
          handleResponding(true, resumeSessionKey)
          hasStopRespondedRef.current = false
          updateChatTreeNode(messageId, (responseItem) => {
            if (responseItem.workflowProcess && responseItem.workflowProcess.tracing.length > 0) {
              responseItem.workflowProcess = {
                ...responseItem.workflowProcess,
                status: WorkflowRunningStatus.Running,
                error: undefined,
              }
            } else {
              taskIdRef.current = task_id
              taskIdsBySessionRef.current.set(resumeSessionKey, task_id)
              responseItem.workflow_run_id = workflow_run_id
              responseItem.workflowProcess = {
                status: WorkflowRunningStatus.Running,
                tracing: [],
              }
            }
          })
        },
        onWorkflowFinished: ({ data: workflowFinishedData }) => {
          updateChatTreeNode(messageId, (responseItem) => {
            if (responseItem.workflowProcess) {
              responseItem.workflowProcess = {
                ...responseItem.workflowProcess,
                status: workflowFinishedData.status as WorkflowRunningStatus,
                error: workflowFinishedData.error,
              }
            }
          })
        },
        onIterationStart: ({ data: iterationStartedData }) => {
          updateChatTreeNode(messageId, (responseItem) => {
            if (!responseItem.workflowProcess) return
            if (!responseItem.workflowProcess.tracing) responseItem.workflowProcess.tracing = []
            responseItem.workflowProcess.tracing.push({
              ...iterationStartedData,
              status: WorkflowRunningStatus.Running,
            })
          })
        },
        onIterationFinish: ({ data: iterationFinishedData }) => {
          updateChatTreeNode(messageId, (responseItem) => {
            if (!responseItem.workflowProcess?.tracing) return
            const tracing = responseItem.workflowProcess.tracing
            const iterationIndex = tracing.findIndex(
              (item) =>
                item.node_id === iterationFinishedData.node_id &&
                (item.execution_metadata?.parallel_id ===
                  iterationFinishedData.execution_metadata?.parallel_id ||
                  item.parallel_id === iterationFinishedData.execution_metadata?.parallel_id),
            )!
            if (iterationIndex > -1) {
              tracing[iterationIndex] = {
                ...tracing[iterationIndex],
                ...iterationFinishedData,
                status: WorkflowRunningStatus.Succeeded,
              }
            }
          })
        },
        onNodeStarted: ({ data: nodeStartedData }) => {
          updateChatTreeNode(messageId, (responseItem) => {
            if (!responseItem.workflowProcess) return
            if (!responseItem.workflowProcess.tracing) responseItem.workflowProcess.tracing = []

            const currentIndex = responseItem.workflowProcess.tracing.findIndex(
              (item) => item.node_id === nodeStartedData.node_id,
            )
            // if the node is already started, update the node
            if (currentIndex > -1) {
              responseItem.workflowProcess.tracing[currentIndex] = {
                ...nodeStartedData,
                status: NodeRunningStatus.Running,
              }
            } else {
              if (nodeStartedData.iteration_id) return

              responseItem.workflowProcess.tracing.push({
                ...nodeStartedData,
                status: WorkflowRunningStatus.Running,
              })
            }
          })
        },
        onNodeFinished: ({ data: nodeFinishedData }) => {
          updateChatTreeNode(messageId, (responseItem) => {
            if (!responseItem.workflowProcess?.tracing) return

            if (nodeFinishedData.iteration_id) return

            const currentIndex = responseItem.workflowProcess.tracing.findIndex((item) => {
              if (!item.execution_metadata?.parallel_id) return item.id === nodeFinishedData.id

              return (
                item.id === nodeFinishedData.id &&
                item.execution_metadata?.parallel_id ===
                  nodeFinishedData.execution_metadata?.parallel_id
              )
            })
            if (currentIndex > -1)
              responseItem.workflowProcess.tracing[currentIndex] = nodeFinishedData as any
          })
        },
        onTTSChunk: (messageId: string, audio: string) => {
          if (!audio || audio === '') return
          const audioPlayer = getOrCreatePlayer()
          if (audioPlayer) {
            audioPlayer.playAudioWithAudio(audio, true)
            AudioPlayerManager.getInstance().resetMsgId(messageId)
          }
        },
        onTTSEnd: (messageId: string, audio: string) => {
          const audioPlayer = getOrCreatePlayer()
          if (audioPlayer) audioPlayer.playAudioWithAudio(audio, false)
        },
        onLoopStart: ({ data: loopStartedData }) => {
          updateChatTreeNode(messageId, (responseItem) => {
            if (!responseItem.workflowProcess) return
            if (!responseItem.workflowProcess.tracing) responseItem.workflowProcess.tracing = []
            responseItem.workflowProcess.tracing.push({
              ...loopStartedData,
              status: WorkflowRunningStatus.Running,
            })
          })
        },
        onLoopFinish: ({ data: loopFinishedData }) => {
          updateChatTreeNode(messageId, (responseItem) => {
            if (!responseItem.workflowProcess?.tracing) return
            const tracing = responseItem.workflowProcess.tracing
            const loopIndex = tracing.findIndex(
              (item) =>
                item.node_id === loopFinishedData.node_id &&
                (item.execution_metadata?.parallel_id ===
                  loopFinishedData.execution_metadata?.parallel_id ||
                  item.parallel_id === loopFinishedData.execution_metadata?.parallel_id),
            )!
            if (loopIndex > -1) {
              tracing[loopIndex] = {
                ...tracing[loopIndex],
                ...loopFinishedData,
                status: WorkflowRunningStatus.Succeeded,
              }
            }
          })
        },
        onHumanInputRequired: ({ data: humanInputRequiredData }) => {
          updateChatTreeNode(messageId, (responseItem) => {
            if (!responseItem.humanInputFormDataList) {
              responseItem.humanInputFormDataList = [humanInputRequiredData]
            } else {
              const currentFormIndex = responseItem.humanInputFormDataList.findIndex(
                (item) => item.node_id === humanInputRequiredData.node_id,
              )
              if (currentFormIndex > -1) {
                responseItem.humanInputFormDataList[currentFormIndex] = humanInputRequiredData
              } else {
                responseItem.humanInputFormDataList.push(humanInputRequiredData)
              }
            }
            if (responseItem.workflowProcess?.tracing) {
              const currentTracingIndex = responseItem.workflowProcess.tracing.findIndex(
                (item) => item.node_id === humanInputRequiredData.node_id,
              )
              if (currentTracingIndex > -1)
                responseItem.workflowProcess.tracing[currentTracingIndex]!.status =
                  NodeRunningStatus.Paused
            }
          })
        },
        onHumanInputFormFilled: ({ data: humanInputFilledFormData }) => {
          updateChatTreeNode(messageId, (responseItem) => {
            let requiredFormData:
              | NonNullable<ChatItem['humanInputFormDataList']>[number]
              | undefined
            if (responseItem.humanInputFormDataList?.length) {
              const currentFormIndex = responseItem.humanInputFormDataList.findIndex(
                (item) => item.node_id === humanInputFilledFormData.node_id,
              )
              if (currentFormIndex > -1) {
                requiredFormData = responseItem.humanInputFormDataList[currentFormIndex]
                responseItem.humanInputFormDataList.splice(currentFormIndex, 1)
              }
            }
            const enrichedHumanInputFilledFormData = enrichSubmittedHumanInputFormData(
              humanInputFilledFormData,
              requiredFormData,
            )
            if (!responseItem.humanInputFilledFormDataList) {
              responseItem.humanInputFilledFormDataList = [enrichedHumanInputFilledFormData]
            } else {
              responseItem.humanInputFilledFormDataList.push(enrichedHumanInputFilledFormData)
            }
          })
        },
        onHumanInputFormTimeout: ({ data: humanInputFormTimeoutData }) => {
          updateChatTreeNode(messageId, (responseItem) => {
            if (responseItem.humanInputFormDataList?.length) {
              const currentFormIndex = responseItem.humanInputFormDataList.findIndex(
                (item) => item.node_id === humanInputFormTimeoutData.node_id,
              )
              responseItem.humanInputFormDataList[currentFormIndex]!.expiration_time =
                humanInputFormTimeoutData.expiration_time
            }
          })
        },
        onWorkflowPaused: ({ data: workflowPausedData }) => {
          const resumeUrl = `/workflow/${workflowPausedData.workflow_run_id}/events`
          pausedStateRef.current = true
          sseGet(resumeUrl, {}, otherOptions)
          updateChatTreeNode(messageId, (responseItem) => {
            responseItem.workflowProcess!.status = WorkflowRunningStatus.Paused
          })
        },
      }

      if (workflowEventsAbortControllerRef.current) workflowEventsAbortControllerRef.current.abort()

      sseGet(url, {}, otherOptions)
    },
    [
      updateChatTreeNode,
      handleResponding,
      createAudioPlayerManager,
      config?.suggested_questions_after_answer,
      options.isNewAgent,
      installedRecoveryEnabled,
    ],
  )

  const updateCurrentQAOnTree = useCallback(
    ({
      parentId,
      responseItem,
      placeholderQuestionId,
      questionItem,
    }: {
      parentId?: string
      responseItem: ChatItem
      placeholderQuestionId: string
      questionItem: ChatItem
    }) => {
      const currentQA = { ...questionItem, children: [{ ...responseItem, children: [] }] }
      if (!installedRecoveryEnabled) {
        const currentTree = chatTreeRef.current
        let nextState: ChatItemInTree[]
        const existingRootIndex = currentTree.findIndex((item) =>
          [placeholderQuestionId, questionItem.id].includes(item.id),
        )
        if (!parentId && existingRootIndex === -1) {
          nextState = produce(currentTree, (draft) => {
            draft.push(currentQA)
          })
        } else if (!parentId && existingRootIndex > -1) {
          nextState = produce(currentTree, (draft) => {
            draft[existingRootIndex] = currentQA
          })
        } else {
          nextState = produceChatTreeNode(parentId!, (parentNode) => {
            const questionNodeIndex = parentNode.children!.findIndex((item) =>
              [placeholderQuestionId, questionItem.id].includes(item.id),
            )
            if (questionNodeIndex === -1) parentNode.children!.push(currentQA)
            else parentNode.children![questionNodeIndex] = currentQA
          })
        }
        setChatTree(nextState)
        chatTreeRef.current = nextState
        persistInstalledChatTree(nextState)
        return
      }
      const rawSessionKey = responseSessionKeysRef.current.get(responseItem) || activeSessionKeyRef.current
      const sessionKey = installedRecoveryEnabled
        ? sessionAliasesRef.current.get(rawSessionKey) || rawSessionKey
        : activeSessionKeyRef.current
      const sessionTree = installedRecoveryEnabled
        ? chatTreesBySessionRef.current.get(sessionKey) || []
        : chatTreeRef.current
      let nextState: ChatItemInTree[]
      const existingRootIndex = sessionTree.findIndex((item) =>
        [placeholderQuestionId, questionItem.id].includes(item.id),
      )
      if (!parentId && existingRootIndex === -1) {
        // QA whose parent is not provided is considered as a first message of the conversation,
        // and it should be a root node of the chat tree
        nextState = produce(sessionTree, (draft) => {
          draft.push(currentQA)
        })
      } else if (!parentId && existingRootIndex > -1) {
        nextState = produce(sessionTree, (draft) => {
          draft[existingRootIndex] = currentQA
        })
      } else {
        // find the target QA in the tree and update it; if not found, insert it to its parent node
        nextState = produceChatTreeNode(parentId!, (parentNode) => {
          const questionNodeIndex = parentNode.children!.findIndex((item) =>
            [placeholderQuestionId, questionItem.id].includes(item.id),
          )
          if (questionNodeIndex === -1) parentNode.children!.push(currentQA)
          else parentNode.children![questionNodeIndex] = currentQA
        }, sessionTree)
      }
      if (installedRecoveryEnabled) chatTreesBySessionRef.current.set(sessionKey, nextState)
      const isActiveSession =
        !installedRecoveryEnabled ||
        sessionKey === activeSessionKeyRef.current ||
        rawSessionKey === activeSessionKeyRef.current
      if (installedRecoveryEnabled && rawSessionKey !== sessionKey && rawSessionKey === activeSessionKeyRef.current)
        chatTreesBySessionRef.current.set(rawSessionKey, nextState)
      if (isActiveSession) {
        setChatTree(nextState)
        chatTreeRef.current = nextState
        persistInstalledChatTree(nextState)
      }
    },
    [installedRecoveryEnabled, persistInstalledChatTree, produceChatTreeNode],
  )

  const handleSend = useCallback(
    async (
      url: string,
      data: {
        query: string
        files?: FileEntity[]
        parent_message_id?: string
        [key: string]: any
      },
      {
        onGetConversationMessages,
        onGetSuggestedQuestions,
        onConversationStarted,
        onConversationComplete,
        onUnhandledEvent,
        onSendSettled,
        isPublicAPI,
      }: SendCallback,
    ) => {
      setSuggestedQuestions([])

      if (respondingSessionsRef.current.get(activeSessionKeyRef.current)) {
        toast.info(t(($) => $['errorMessage.waitForResponse'], { ns: 'appDebug' }))
        return false
      }

      const parentMessage = threadMessages.find((item) => item.id === data.parent_message_id)

      const placeholderQuestionId = `question-${Date.now()}`
      const questionItem = {
        id: placeholderQuestionId,
        content: data.query,
        isAnswer: false,
        message_files: data.files,
        parentMessageId: data.parent_message_id,
      }

      const placeholderAnswerId = `answer-placeholder-${Date.now()}`
      const placeholderAnswerItem = {
        id: placeholderAnswerId,
        content: '',
        isAnswer: true,
        parentMessageId: questionItem.id,
        siblingIndex: parentMessage?.children?.length ?? chatTree.length,
      }

      setTargetMessageId(parentMessage?.id)
      updateCurrentQAOnTree({
        parentId: data.parent_message_id,
        responseItem: placeholderAnswerItem,
        placeholderQuestionId,
        questionItem,
      })

      // answer
      const responseItem: ChatItemInTree = {
        id: placeholderAnswerId,
        content: '',
        agent_thoughts: [],
        message_files: [],
        isAnswer: true,
        parentMessageId: questionItem.id,
        siblingIndex: parentMessage?.children?.length ?? chatTree.length,
      }
      responseSessionKeysRef.current.set(responseItem, activeSessionKeyRef.current)
      // Capture the request owner. The active conversation can change while this
      // stream is running, so completion and history hydration must stay scoped
      // to the session that created the response item.
      const responseSessionKey = activeSessionKeyRef.current
      let responseConversationId = conversationIdRef.current

      handleResponding(true, responseSessionKey)
      hasStopRespondedRef.current = false

      const { query, files, inputs, overrideInputsForm, ...restData } = data
      const requestInputsForm = overrideInputsForm ?? formSettings?.inputsForm ?? []
      const bodyParams = {
        response_mode: 'streaming',
        conversation_id: responseConversationId,
        files: getProcessedFiles(files || []),
        query,
        inputs: getProcessedInputs(inputs || {}, requestInputsForm),
        ...restData,
      }
      if (bodyParams?.files?.length) {
        bodyParams.files = bodyParams.files.map((item) => {
          if (item.transfer_method === TransferMethod.local_file) {
            return {
              ...item,
              url: '',
            }
          }
          return item
        })
      }

      let isAgentMode = false
      let hasSetResponseId = false
      let hasSettled = false
      const settleSend = (hasError?: boolean) => {
        if (hasSettled) return

        hasSettled = true
        onSendSettled?.(hasError)
      }

      const getOrCreatePlayer = createAudioPlayerManager()

      const otherOptions: IOtherOptions = {
        isPublicAPI,
        onUnhandledEvent,
        getAbortController: (abortController) => {
          workflowEventsAbortControllerRef.current = abortController
        },
        onData: (
          message: string,
          isFirstMessage: boolean,
          { event, conversationId: newConversationId, messageId, taskId }: any,
        ) => {
          const isNewAgentMessage =
            options.isNewAgent && (event === 'agent_message' || event === 'message')
          if (isNewAgentMessage) {
            appendAgentResponseMessagePart(responseItem, message)
          } else if (!isAgentMode || options.isNewAgent) {
            responseItem.content = responseItem.content + message
          } else {
            const lastThought =
              responseItem.agent_thoughts?.[responseItem.agent_thoughts.length - 1]
            if (lastThought) lastThought.thought = lastThought.thought + message // need immer setAutoFreeze
          }

          if (messageId && !hasSetResponseId) {
            questionItem.id = `question-${messageId}`
            responseItem.id = messageId
            responseItem.parentMessageId = questionItem.id
            hasSetResponseId = true
          }

          if (isFirstMessage && newConversationId) {
            const responseSessionKey = responseSessionKeysRef.current.get(responseItem) || activeSessionKeyRef.current
            const sessionTree = chatTreesBySessionRef.current.get(responseSessionKey)
            // Always relocate the per-session tree and alias the draft to the
            // server id, even when the simplified (webApp) recovery path is
            // active. Keeping the maps populated costs nothing and lets the
            // parent hook identify *which* draft placeholder to remove without
            // depending on whatever the user is currently viewing.
            if (sessionTree && responseSessionKey !== newConversationId) {
              chatTreesBySessionRef.current.set(newConversationId, sessionTree)
              sessionAliasesRef.current.set(responseSessionKey, newConversationId)
            }
            responseConversationId = newConversationId
            if (responseSessionKey === activeSessionKeyRef.current) {
              conversationIdRef.current = newConversationId
              if (installedRecoveryEnabled) recoverySessionIdRef.current = newConversationId
            }
            // Always forward the session the stream was started from so the
            // caller can clean up exactly that placeholder, even when the user
            // has already navigated to a different chat.
            onConversationStarted?.(newConversationId, responseSessionKey)
          }

          taskIdRef.current = taskId
          taskIdsBySessionRef.current.set(responseSessionKey, taskId)
          if (messageId) responseItem.id = messageId

          updateCurrentQAOnTree({
            placeholderQuestionId,
            questionItem,
            responseItem,
            parentId: data.parent_message_id,
          })
        },
        onReasoning: ({ data: reasoningData }: ReasoningChunkResponse) => {
          const { reasoning, node_id, is_final } = reasoningData
          const reasoningContent =
            responseItem.reasoningContent || (responseItem.reasoningContent = {})
          const key = node_id || '_'
          if (reasoning) reasoningContent[key] = (reasoningContent[key] || '') + reasoning
          if (is_final) responseItem.reasoningFinished = true

          updateCurrentQAOnTree({
            placeholderQuestionId,
            questionItem,
            responseItem,
            parentId: data.parent_message_id,
          })
        },
        async onCompleted(hasError?: boolean) {
          handleResponding(false, responseSessionKey)

          try {
            if (hasError) return

            let completedWorkflowRunId = responseItem.workflow_run_id
            const responseTreeSessionKey =
              sessionAliasesRef.current.get(responseSessionKey) || responseSessionKey

            if (
              responseConversationId &&
              !hasStopRespondedRef.current &&
              onGetConversationMessages
            ) {
              const conversationMessagesResponse = await onGetConversationMessages(
                responseConversationId,
                (newAbortController) =>
                  (conversationMessagesAbortControllerRef.current = newAbortController),
              )
              const data = getConversationMessagesData(conversationMessagesResponse)
              const newResponseItem = data.find((item) => item.id === responseItem.id)
              completedWorkflowRunId = newResponseItem?.workflow_run_id ?? completedWorkflowRunId
              if (!newResponseItem) {
                if (installedRecoveryEnabled)
                  return onConversationComplete?.(
                    responseConversationId,
                    completedWorkflowRunId,
                    responseSessionKeysRef.current.get(responseItem),
                  )
                return onConversationComplete?.(responseConversationId, completedWorkflowRunId)
              }

              const historyAgentThoughts = getHistoryAgentThoughts(newResponseItem)
              const lastHistoryAgentThought = historyAgentThoughts.at(-1)
              const historyAnswer = newResponseItem.answer || ''
              const isUseAgentThought =
                !options.isNewAgent && lastHistoryAgentThought?.thought === historyAnswer
              const messageLog = Array.isArray(newResponseItem.message)
                ? newResponseItem.message
                : []
              const answerTokens = newResponseItem.answer_tokens ?? 0
              const messageTokens = newResponseItem.message_tokens ?? 0
              const providerResponseLatency = newResponseItem.provider_response_latency ?? 0
              const historyAnswerFiles = getHistoryAnswerFiles(newResponseItem)
              updateChatTreeNode(responseItem.id, {
                content: isUseAgentThought ? '' : historyAnswer,
                agent_thoughts: historyAgentThoughts,
                agent_response_parts: undefined,
                citation: newResponseItem.retriever_resources,
                reasoningContent: newResponseItem.metadata?.reasoning,
                reasoningFinished: true,
                message_files: historyAnswerFiles,
                allFiles: undefined,
                workflowProcess: undefined,
                workflow_run_id: newResponseItem.workflow_run_id ?? completedWorkflowRunId,
                feedback: newResponseItem.feedback,
                log: [
                  ...messageLog,
                  ...(messageLog.at(-1)?.role !== 'assistant'
                    ? [
                        {
                          role: 'assistant',
                          text: historyAnswer,
                          files: historyAnswerFiles,
                        },
                      ]
                    : []),
                ],
                more: {
                  time: formatTime(newResponseItem.created_at ?? Date.now(), 'hh:mm A'),
                  tokens: answerTokens + messageTokens,
                  latency: providerResponseLatency.toFixed(2),
                  tokens_per_second:
                    providerResponseLatency > 0
                      ? (answerTokens / providerResponseLatency).toFixed(2)
                      : undefined,
                },
                // for agent log
                conversationId: responseConversationId,
                input: {
                  inputs: newResponseItem.inputs,
                  query: newResponseItem.query,
                },
              }, responseTreeSessionKey)
            }

            if (installedRecoveryEnabled)
              onConversationComplete?.(
                responseConversationId,
                completedWorkflowRunId,
                responseSessionKey,
              )
            else onConversationComplete?.(responseConversationId, completedWorkflowRunId)

            if (
              config?.suggested_questions_after_answer?.enabled &&
              !hasStopRespondedRef.current &&
              onGetSuggestedQuestions
            ) {
              try {
                const { data }: any = await onGetSuggestedQuestions(
                  responseItem.id,
                  (newAbortController) =>
                    (suggestedQuestionsAbortControllerRef.current = newAbortController),
                )
                if (responseSessionKey === activeSessionKeyRef.current) setSuggestedQuestions(data)
              } catch {
                if (responseSessionKey === activeSessionKeyRef.current) setSuggestedQuestions([])
              }
            }
          } finally {
            settleSend(hasError)
          }
        },
        onFile(file) {
          // Convert simple file type to MIME type for non-agent mode
          // Backend sends: { id, type: "image", belongs_to, url }
          // Frontend expects: { id, type: "image/png", transferMethod, url, uploadedId, supportFileType, name, size }

          // Determine file type for MIME conversion
          const fileType = (file as { type?: string }).type || 'image'

          // If file already has transferMethod, use it as base and ensure all required fields exist
          // Otherwise, create a new complete file object
          const baseFile = 'transferMethod' in file ? (file as Partial<FileEntity>) : null

          const convertedFile: FileEntity = {
            id: baseFile?.id || (file as { id: string }).id,
            type:
              baseFile?.type ||
              (fileType === 'image'
                ? 'image/png'
                : fileType === 'video'
                  ? 'video/mp4'
                  : fileType === 'audio'
                    ? 'audio/mpeg'
                    : 'application/octet-stream'),
            transferMethod:
              (baseFile?.transferMethod as FileEntity['transferMethod']) ||
              (fileType === 'image' ? 'remote_url' : 'local_file'),
            uploadedId: baseFile?.uploadedId || (file as { id: string }).id,
            supportFileType:
              baseFile?.supportFileType ||
              (fileType === 'image'
                ? 'image'
                : fileType === 'video'
                  ? 'video'
                  : fileType === 'audio'
                    ? 'audio'
                    : 'document'),
            progress: baseFile?.progress ?? 100,
            name:
              baseFile?.name ||
              `generated_${fileType}.${fileType === 'image' ? 'png' : fileType === 'video' ? 'mp4' : fileType === 'audio' ? 'mp3' : 'bin'}`,
            url: baseFile?.url || (file as { url?: string }).url,
            size: baseFile?.size ?? 0, // Generated files don't have a known size
          }

          // For agent mode, add files to the last thought
          const lastThought = responseItem.agent_thoughts?.[responseItem.agent_thoughts?.length - 1]
          if (lastThought) {
            const thought = lastThought as { message_files?: FileEntity[] }
            responseItem.agent_thoughts!.at(-1)!.message_files = [
              ...(thought.message_files ?? []),
              convertedFile,
            ]
          }
          // For non-agent mode, add files directly to responseItem.message_files
          else {
            const currentFiles = (responseItem.message_files as FileEntity[] | undefined) ?? []
            responseItem.message_files = [...currentFiles, convertedFile]
          }

          updateCurrentQAOnTree({
            placeholderQuestionId,
            questionItem,
            responseItem,
            parentId: data.parent_message_id,
          })
        },
        onThought(thought) {
          isAgentMode = true
          const response = responseItem as any
          if (thought.message_id && !hasSetResponseId) response.id = thought.message_id
          if (thought.conversation_id) response.conversationId = thought.conversation_id

          if (response.agent_thoughts.length === 0) {
            response.agent_thoughts.push(thought)
          } else {
            const lastThought = response.agent_thoughts.at(-1)
            // thought changed but still the same thought, so update.
            if (lastThought.id === thought.id) {
              responseItem.agent_thoughts![response.agent_thoughts.length - 1] =
                mergeStreamingThought(lastThought, thought)
            } else {
              responseItem.agent_thoughts!.push(thought)
            }
          }
          if (options.isNewAgent) {
            const currentThought =
              responseItem.agent_thoughts?.find((item) => item.id === thought.id) ?? thought
            upsertAgentResponseThoughtPart(responseItem, currentThought)
          }
          updateCurrentQAOnTree({
            placeholderQuestionId,
            questionItem,
            responseItem,
            parentId: data.parent_message_id,
          })
        },
        onMessageEnd: (messageEnd) => {
          const messageEndConversationId = (messageEnd as unknown as { conversation_id?: string })
            .conversation_id
          if (options.isNewAgent && messageEndConversationId)
            conversationIdRef.current = messageEndConversationId
          if (messageEnd.metadata?.annotation_reply) {
            responseItem.id = messageEnd.id
            responseItem.annotation = {
              id: messageEnd.metadata.annotation_reply.id,
              authorName: messageEnd.metadata.annotation_reply.account.name,
            }
            updateCurrentQAOnTree({
              placeholderQuestionId,
              questionItem,
              responseItem,
              parentId: data.parent_message_id,
            })
            handleResponding(false, responseSessionKey)
            return
          }
          responseItem.citation = messageEnd.metadata?.retriever_resources || []
          const processedFilesFromResponse = getProcessedFilesFromResponse(messageEnd.files || [])
          responseItem.allFiles = uniqBy(
            [...(responseItem.allFiles || []), ...(processedFilesFromResponse || [])],
            'id',
          )

          updateCurrentQAOnTree({
            placeholderQuestionId,
            questionItem,
            responseItem,
            parentId: data.parent_message_id,
          })
        },
        onMessageReplace: (messageReplace) => {
          responseItem.content = messageReplace.answer
        },
        onError() {
          handleResponding(false, responseSessionKey)
          settleSend(true)
          updateCurrentQAOnTree({
            placeholderQuestionId,
            questionItem,
            responseItem,
            parentId: data.parent_message_id,
          })
        },
        onWorkflowStarted: ({ workflow_run_id, task_id, conversation_id, message_id }) => {
          handleResponding(true, responseSessionKey)
          // If there are no streaming messages, we still need to set the conversation_id to avoid create a new conversation when regeneration in chat-flow.
          if (conversation_id) {
            conversationIdRef.current = conversation_id
          }
          if (message_id && !hasSetResponseId) {
            questionItem.id = `question-${message_id}`
            responseItem.id = message_id
            responseItem.parentMessageId = questionItem.id
            hasSetResponseId = true
          }

          if (responseItem.workflowProcess && responseItem.workflowProcess.tracing.length > 0) {
            responseItem.workflowProcess = {
              ...responseItem.workflowProcess,
              status: WorkflowRunningStatus.Running,
              error: undefined,
            }
          } else {
            taskIdRef.current = task_id
            taskIdsBySessionRef.current.set(responseSessionKey, task_id)
            responseItem.workflow_run_id = workflow_run_id
            responseItem.workflowProcess = {
              status: WorkflowRunningStatus.Running,
              tracing: [],
            }
          }
          updateCurrentQAOnTree({
            placeholderQuestionId,
            questionItem,
            responseItem,
            parentId: data.parent_message_id,
          })
        },
        onWorkflowFinished: ({ data: workflowFinishedData }) => {
          if (pausedStateRef.current) pausedStateRef.current = false
          responseItem.workflowProcess = {
            ...responseItem.workflowProcess!,
            status: workflowFinishedData.status as WorkflowRunningStatus,
            error: workflowFinishedData.error,
          }
          updateCurrentQAOnTree({
            placeholderQuestionId,
            questionItem,
            responseItem,
            parentId: data.parent_message_id,
          })
        },
        onIterationStart: ({ data: iterationStartedData }) => {
          responseItem.workflowProcess!.tracing!.push({
            ...iterationStartedData,
            status: WorkflowRunningStatus.Running,
          })
          updateCurrentQAOnTree({
            placeholderQuestionId,
            questionItem,
            responseItem,
            parentId: data.parent_message_id,
          })
        },
        onIterationFinish: ({ data: iterationFinishedData }) => {
          const tracing = responseItem.workflowProcess!.tracing!
          const iterationIndex = tracing.findIndex(
            (item) =>
              item.node_id === iterationFinishedData.node_id &&
              (item.execution_metadata?.parallel_id ===
                iterationFinishedData.execution_metadata?.parallel_id ||
                item.parallel_id === iterationFinishedData.execution_metadata?.parallel_id),
          )!
          tracing[iterationIndex] = {
            ...tracing[iterationIndex],
            ...iterationFinishedData,
            status: WorkflowRunningStatus.Succeeded,
          }

          updateCurrentQAOnTree({
            placeholderQuestionId,
            questionItem,
            responseItem,
            parentId: data.parent_message_id,
          })
        },
        onNodeStarted: ({ data: nodeStartedData }) => {
          if (!responseItem.workflowProcess) return
          if (!responseItem.workflowProcess.tracing) responseItem.workflowProcess.tracing = []

          const currentIndex = responseItem.workflowProcess.tracing.findIndex(
            (item) => item.node_id === nodeStartedData.node_id,
          )
          if (currentIndex > -1) {
            responseItem.workflowProcess.tracing[currentIndex] = {
              ...nodeStartedData,
              status: NodeRunningStatus.Running,
            }
          } else {
            if (nodeStartedData.iteration_id) return

            if (data.loop_id) return

            responseItem.workflowProcess.tracing.push({
              ...nodeStartedData,
              status: WorkflowRunningStatus.Running,
            })
          }
          updateCurrentQAOnTree({
            placeholderQuestionId,
            questionItem,
            responseItem,
            parentId: data.parent_message_id,
          })
        },
        onNodeFinished: ({ data: nodeFinishedData }) => {
          if (nodeFinishedData.iteration_id) return

          if (data.loop_id) return

          const currentIndex = responseItem.workflowProcess!.tracing!.findIndex((item) => {
            if (!item.execution_metadata?.parallel_id) return item.id === nodeFinishedData.id

            return (
              item.id === nodeFinishedData.id &&
              item.execution_metadata?.parallel_id ===
                nodeFinishedData.execution_metadata?.parallel_id
            )
          })
          responseItem.workflowProcess!.tracing[currentIndex] = nodeFinishedData as any

          updateCurrentQAOnTree({
            placeholderQuestionId,
            questionItem,
            responseItem,
            parentId: data.parent_message_id,
          })
        },
        onTTSChunk: (messageId: string, audio: string) => {
          if (!audio || audio === '') return
          const audioPlayer = getOrCreatePlayer()
          if (audioPlayer) {
            audioPlayer.playAudioWithAudio(audio, true)
            AudioPlayerManager.getInstance().resetMsgId(messageId)
          }
        },
        onTTSEnd: (messageId: string, audio: string) => {
          const audioPlayer = getOrCreatePlayer()
          if (audioPlayer) audioPlayer.playAudioWithAudio(audio, false)
        },
        onLoopStart: ({ data: loopStartedData }) => {
          responseItem.workflowProcess!.tracing!.push({
            ...loopStartedData,
            status: WorkflowRunningStatus.Running,
          })
          updateCurrentQAOnTree({
            placeholderQuestionId,
            questionItem,
            responseItem,
            parentId: data.parent_message_id,
          })
        },
        onLoopFinish: ({ data: loopFinishedData }) => {
          const tracing = responseItem.workflowProcess!.tracing!
          const loopIndex = tracing.findIndex(
            (item) =>
              item.node_id === loopFinishedData.node_id &&
              (item.execution_metadata?.parallel_id ===
                loopFinishedData.execution_metadata?.parallel_id ||
                item.parallel_id === loopFinishedData.execution_metadata?.parallel_id),
          )!
          tracing[loopIndex] = {
            ...tracing[loopIndex],
            ...loopFinishedData,
            status: WorkflowRunningStatus.Succeeded,
          }

          updateCurrentQAOnTree({
            placeholderQuestionId,
            questionItem,
            responseItem,
            parentId: data.parent_message_id,
          })
        },
        onHumanInputRequired: ({ data: humanInputRequiredData }) => {
          if (!responseItem.humanInputFormDataList) {
            responseItem.humanInputFormDataList = [humanInputRequiredData]
          } else {
            const currentFormIndex = responseItem.humanInputFormDataList!.findIndex(
              (item) => item.node_id === humanInputRequiredData.node_id,
            )
            if (currentFormIndex > -1) {
              responseItem.humanInputFormDataList[currentFormIndex] = humanInputRequiredData
            } else {
              responseItem.humanInputFormDataList.push(humanInputRequiredData)
            }
          }
          const currentTracingIndex = responseItem.workflowProcess!.tracing!.findIndex(
            (item) => item.node_id === humanInputRequiredData.node_id,
          )
          if (currentTracingIndex > -1) {
            responseItem.workflowProcess!.tracing[currentTracingIndex]!.status =
              NodeRunningStatus.Paused
            updateCurrentQAOnTree({
              placeholderQuestionId,
              questionItem,
              responseItem,
              parentId: data.parent_message_id,
            })
          }
        },
        onHumanInputFormFilled: ({ data: humanInputFilledFormData }) => {
          let requiredFormData: NonNullable<ChatItem['humanInputFormDataList']>[number] | undefined
          if (responseItem.humanInputFormDataList?.length) {
            const currentFormIndex = responseItem.humanInputFormDataList!.findIndex(
              (item) => item.node_id === humanInputFilledFormData.node_id,
            )
            if (currentFormIndex > -1) {
              requiredFormData = responseItem.humanInputFormDataList[currentFormIndex]
              responseItem.humanInputFormDataList.splice(currentFormIndex, 1)
            }
          }
          const enrichedHumanInputFilledFormData = enrichSubmittedHumanInputFormData(
            humanInputFilledFormData,
            requiredFormData,
          )
          if (!responseItem.humanInputFilledFormDataList) {
            responseItem.humanInputFilledFormDataList = [enrichedHumanInputFilledFormData]
          } else {
            responseItem.humanInputFilledFormDataList.push(enrichedHumanInputFilledFormData)
          }
          updateCurrentQAOnTree({
            placeholderQuestionId,
            questionItem,
            responseItem,
            parentId: data.parent_message_id,
          })
        },
        onHumanInputFormTimeout: ({ data: humanInputFormTimeoutData }) => {
          if (responseItem.humanInputFormDataList?.length) {
            const currentFormIndex = responseItem.humanInputFormDataList!.findIndex(
              (item) => item.node_id === humanInputFormTimeoutData.node_id,
            )
            responseItem.humanInputFormDataList[currentFormIndex]!.expiration_time =
              humanInputFormTimeoutData.expiration_time
          }
          updateCurrentQAOnTree({
            placeholderQuestionId,
            questionItem,
            responseItem,
            parentId: data.parent_message_id,
          })
        },
        onWorkflowPaused: ({ data: workflowPausedData }) => {
          const url = `/workflow/${workflowPausedData.workflow_run_id}/events`
          pausedStateRef.current = true
          sseGet(url, {}, otherOptions)
          responseItem.workflowProcess!.status = WorkflowRunningStatus.Paused
          updateCurrentQAOnTree({
            placeholderQuestionId,
            questionItem,
            responseItem,
            parentId: data.parent_message_id,
          })
        },
      }

      // Abort the previous workflow events SSE request
      if (workflowEventsAbortControllerRef.current) workflowEventsAbortControllerRef.current.abort()

      ssePost(
        url,
        {
          body: bodyParams,
        },
        otherOptions,
      )
      return true
    },
    [
      t,
      chatTree.length,
      threadMessages,
      config?.suggested_questions_after_answer,
      updateCurrentQAOnTree,
      updateChatTreeNode,
      handleResponding,
      formatTime,
      createAudioPlayerManager,
      formSettings,
        options.isNewAgent,
        installedRecoveryEnabled,
      ],
  )

  const handleAnnotationEdited = useCallback(
    (query: string, answer: string, index: number) => {
      const targetQuestionId = chatList[index - 1]!.id
      const targetAnswerId = chatList[index]!.id

      updateChatTreeNode(targetQuestionId, {
        content: query,
      })
      updateChatTreeNode(targetAnswerId, {
        content: answer,
        annotation: {
          ...chatList[index]!.annotation,
          logAnnotation: undefined,
        } as any,
      })
    },
    [chatList, updateChatTreeNode],
  )

  const handleAnnotationAdded = useCallback(
    (annotationId: string, authorName: string, query: string, answer: string, index: number) => {
      const targetQuestionId = chatList[index - 1]!.id
      const targetAnswerId = chatList[index]!.id

      updateChatTreeNode(targetQuestionId, {
        content: query,
      })

      updateChatTreeNode(targetAnswerId, {
        content: chatList[index]!.content,
        annotation: {
          id: annotationId,
          authorName,
          logAnnotation: {
            content: answer,
            account: {
              id: '',
              name: authorName,
              email: '',
            },
          },
        } as Annotation,
      })
    },
    [chatList, updateChatTreeNode],
  )

  const handleAnnotationRemoved = useCallback(
    (index: number) => {
      const targetAnswerId = chatList[index]!.id

      updateChatTreeNode(targetAnswerId, {
        content: chatList[index]!.content,
        annotation: {
          ...chatList[index]!.annotation,
          id: '',
        } as Annotation,
      })
    },
    [chatList, updateChatTreeNode],
  )

  const handleSwitchSibling = useCallback(
    (siblingMessageId: string, callbacks: SendCallback) => {
      setTargetMessageId(siblingMessageId)

      // Helper to find message in tree
      const findMessageInTree = (
        nodes: ChatItemInTree[],
        targetId: string,
      ): ChatItemInTree | undefined => {
        for (const node of nodes) {
          if (node.id === targetId) return node
          if (node.children) {
            const found = findMessageInTree(node.children, targetId)
            if (found) return found
          }
        }
        return undefined
      }

      const targetMessage = findMessageInTree(chatTreeRef.current, siblingMessageId)
      if (
        targetMessage?.workflow_run_id &&
        (targetMessage.workflowProcess?.status === WorkflowRunningStatus.Running ||
          targetMessage.workflowProcess?.status === WorkflowRunningStatus.Paused ||
          (targetMessage.humanInputFormDataList && targetMessage.humanInputFormDataList.length > 0))
      ) {
        handleResume(targetMessage.id, targetMessage.workflow_run_id, callbacks)
      }
    },
    [setTargetMessageId, handleResume],
  )

  useEffect(() => {
    if (!clearChatList) return

    if (installedRecoveryEnabled) {
      // Starting another installed-app conversation must not abort the SSE
      // request belonging to the previous conversation.  Reset only the
      // visible tree; the running stream continues and recovery storage keeps
      // its own snapshot for later switching/resume.
      conversationIdRef.current = initialConversationIdRef.current
      taskIdRef.current = ''
      // Session changes are handled by the session-key effect above. Clearing here
      // would erase the previous draft and make switching back lose its messages.
      setSuggestedQuestions([])
      clearChatListCallback?.(false)
      return
    }

    handleRestart(() => clearChatListCallback?.(false))
  }, [
    clearChatList,
    clearChatListCallback,
    handleRestart,
    initialConversationId,
    installedRecoveryEnabled,
  ])

  return {
    chatList,
    setTargetMessageId,
    isResponding,
    setIsResponding,
    handleSend,
    handleResume,
    handleSwitchSibling,
    suggestedQuestions,
    handleRestart,
    handleStop,
    handleAnnotationEdited,
    handleAnnotationAdded,
    handleAnnotationRemoved,
    recoverySessionId: recoverySessionIdRef.current,
  }
}
