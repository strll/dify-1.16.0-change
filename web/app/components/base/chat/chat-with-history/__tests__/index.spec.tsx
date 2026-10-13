import type { InstalledApp } from '@/models/explore'
import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import ChatWithHistory from '../index'

const state = vi.hoisted(() => ({
  sessionId: 'A',
  loading: false,
  installed: true,
}))

vi.mock('../hooks', () => ({
  useChatWithHistory: () => ({
    appData: { site: { title: 'Chat' } },
    appChatListDataLoading: state.loading,
    chatShouldReloadKey: state.sessionId,
    currentConversationId: state.sessionId,
    isInstalledApp: state.installed,
  }),
}))
vi.mock('@/hooks/use-breakpoints', () => ({
  default: () => 'desktop',
  MediaType: { mobile: 'mobile' },
}))
vi.mock('@/hooks/use-document-title', () => ({ default: vi.fn() }))
vi.mock('../../embedded-chatbot/theme/theme-context', () => ({
  useThemeContext: () => undefined,
}))
vi.mock('../header', () => ({ default: () => null }))
vi.mock('../header-in-mobile', () => ({ default: () => null }))
vi.mock('../sidebar', () => ({ default: () => null }))
vi.mock('../chat-wrapper', () => ({
  default: function ChatSessionLifetimeProbe() {
    // The real wrapper owns live streams and their per-session message trees.
    // Local state here makes accidental unmounts observable at the parent boundary.
    const [value, setValue] = useState('')
    return (
      <input
        aria-label="Live session state"
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
    )
  },
}))

describe('Installed chat component lifetime', () => {
  beforeEach(() => {
    state.sessionId = 'A'
    state.loading = false
    state.installed = true
  })

  it('preserves the stream owner across A B C selection and history loading', () => {
    const info = { id: 'installed-app' } as InstalledApp
    const { rerender } = render(<ChatWithHistory installedAppInfo={info} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Live session state' }), {
      target: { value: 'A has an unfinished question' },
    })
    for (const sessionId of ['B', 'C', 'A']) {
      state.sessionId = sessionId
      state.loading = true
      rerender(<ChatWithHistory installedAppInfo={info} />)
      expect(screen.getByRole('textbox', { name: 'Live session state' })).toHaveValue(
        'A has an unfinished question',
      )
      state.loading = false
      rerender(<ChatWithHistory installedAppInfo={info} />)
      expect(screen.getByRole('textbox', { name: 'Live session state' })).toHaveValue(
        'A has an unfinished question',
      )
    }
  })

  it('keeps the ordinary WebApp reset-on-conversation-change behavior', () => {
    state.installed = false
    const { rerender } = render(<ChatWithHistory />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Live session state' }), {
      target: { value: 'old WebApp state' },
    })
    state.sessionId = 'B'
    rerender(<ChatWithHistory />)
    expect(screen.getByRole('textbox', { name: 'Live session state' })).toHaveValue('')
  })
})
