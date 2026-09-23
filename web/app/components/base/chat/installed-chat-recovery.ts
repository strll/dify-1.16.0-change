import type { ChatItemInTree } from './types'

const DATABASE_NAME = 'dify-installed-chat-recovery'
const STORE_NAME = 'snapshots'
const SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000

type RecoverySnapshot = {
  key: string
  appId: string
  conversationId: string
  chatTree: ChatItemInTree[]
  updatedAt: number
}

function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof window === 'undefined' || !('indexedDB' in window)) return Promise.resolve(null)

  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DATABASE_NAME, 1)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(STORE_NAME))
        database.createObjectStore(STORE_NAME, { keyPath: 'key' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function snapshotKey(appId: string, conversationId: string) {
  return `${appId}:${conversationId || '__new__'}`
}

export async function saveInstalledChatRecovery(
  appId: string,
  conversationId: string,
  chatTree: ChatItemInTree[],
) {
  const database = await openDatabase()
  if (!database) return

  const snapshot: RecoverySnapshot = {
    key: snapshotKey(appId, conversationId),
    appId,
    conversationId,
    chatTree,
    updatedAt: Date.now(),
  }
  await new Promise<void>((resolve, reject) => {
    const request = database
      .transaction(STORE_NAME, 'readwrite')
      .objectStore(STORE_NAME)
      .put(snapshot)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  }).finally(() => database.close())
}

export async function loadInstalledChatRecovery(appId: string, conversationId: string) {
  const database = await openDatabase()
  if (!database) return undefined

  const result = await new Promise<RecoverySnapshot | undefined>((resolve, reject) => {
    const request = database
      .transaction(STORE_NAME, 'readonly')
      .objectStore(STORE_NAME)
      .get(snapshotKey(appId, conversationId))
    request.onsuccess = () => resolve(request.result as RecoverySnapshot | undefined)
    request.onerror = () => reject(request.error)
  }).finally(() => database.close())

  if (!result || Date.now() - result.updatedAt > SNAPSHOT_TTL_MS) {
    if (result) await clearInstalledChatRecovery(appId, conversationId)
    return undefined
  }
  return result
}

export async function clearInstalledChatRecovery(appId: string, conversationId: string) {
  const database = await openDatabase()
  if (!database) return

  await new Promise<void>((resolve, reject) => {
    const request = database
      .transaction(STORE_NAME, 'readwrite')
      .objectStore(STORE_NAME)
      .delete(snapshotKey(appId, conversationId))
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  }).finally(() => database.close())
}

export async function promoteInstalledChatRecovery(
  appId: string,
  temporaryConversationId: string,
  conversationId: string,
) {
  if (!temporaryConversationId || temporaryConversationId === conversationId) return
  const snapshot = await loadInstalledChatRecovery(appId, temporaryConversationId)
  if (!snapshot) return
  await saveInstalledChatRecovery(appId, conversationId, snapshot.chatTree)
  await clearInstalledChatRecovery(appId, temporaryConversationId)
}

/** Remove expired snapshots without touching server conversations or user data. */
export async function cleanupExpiredInstalledChatRecovery() {
  const database = await openDatabase()
  if (!database) return

  const snapshots = await new Promise<RecoverySnapshot[]>((resolve, reject) => {
    const request = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll()
    request.onsuccess = () => resolve((request.result as RecoverySnapshot[]) || [])
    request.onerror = () => reject(request.error)
  })
  const expired = snapshots.filter((snapshot) => Date.now() - snapshot.updatedAt > SNAPSHOT_TTL_MS)
  if (expired.length) {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite')
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      const store = transaction.objectStore(STORE_NAME)
      expired.forEach((snapshot) => store.delete(snapshot.key))
    })
  }
  database.close()
}
