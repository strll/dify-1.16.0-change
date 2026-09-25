export type ConversationSyncEvent =
  | { type: 'created'; appId: string; conversationId: string }
  | { type: 'deleted'; appId: string; conversationId: string }
  | { type: 'refresh'; appId: string }

const channelName = (appId: string) => `dify-installed-conversations:${appId}`

export const publishConversationSyncEvent = (event: ConversationSyncEvent) => {
  if (typeof window === 'undefined' || !('BroadcastChannel' in window)) return
  const channel = new BroadcastChannel(channelName(event.appId))
  channel.postMessage(event)
  channel.close()
}

export const subscribeConversationSyncEvents = (
  appId: string,
  listener: (event: ConversationSyncEvent) => void,
) => {
  if (typeof window === 'undefined' || !('BroadcastChannel' in window)) return () => undefined
  const channel = new BroadcastChannel(channelName(appId))
  const onMessage = (event: MessageEvent<ConversationSyncEvent>) => listener(event.data)
  channel.addEventListener('message', onMessage)
  return () => {
    channel.removeEventListener('message', onMessage)
    channel.close()
  }
}
