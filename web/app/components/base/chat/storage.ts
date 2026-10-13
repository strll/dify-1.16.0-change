import { createLocalStorageState } from 'foxact/create-local-storage-state'
import { createStorageStateFactory } from 'foxact/create-storage-state-factory'
import { CONVERSATION_ID_INFO } from './constants'

const [useConversationIdInfo, _useConversationIdInfoValue, _useSetConversationIdInfo] =
  createLocalStorageState<Record<string, Record<string, string>>>(CONVERSATION_ID_INFO, {})

// Keep installed-app selection state isolated per browser tab.
const [useInstalledConversationIdInfo] = createStorageStateFactory('sessionStorage')<
  Record<string, Record<string, string>>
>(CONVERSATION_ID_INFO, {})

const [
  useWebAppSidebarCollapseState,
  _useWebAppSidebarCollapseStateValue,
  _useSetWebAppSidebarCollapseState,
] = createLocalStorageState<string>('webappSidebarCollapse', undefined, { raw: true })

export { useConversationIdInfo, useInstalledConversationIdInfo, useWebAppSidebarCollapseState }
