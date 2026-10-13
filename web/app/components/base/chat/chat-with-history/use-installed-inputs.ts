import { useCallback, useRef, useState } from 'react'

type Inputs = Record<string, unknown>

// This owner lives as long as the installed chat, independently of its visible form.
export const useInstalledInputs = (sessionId: string, initialInputs: Inputs) => {
  const [inputsBySession, setInputsBySession] = useState<Record<string, Inputs>>({})
  const inputsRef = useRef<Record<string, Inputs>>({})
  const aliasesRef = useRef<Record<string, string>>({})
  const changeInput = useCallback(
    (variable: string, value: unknown) => {
      // Upload callbacks can arrive after switching or promoting the originating draft.
      const owner = aliasesRef.current[sessionId] ?? sessionId
      const inputs = { ...(inputsRef.current[owner] ?? initialInputs), [variable]: value }
      inputsRef.current = { ...inputsRef.current, [owner]: inputs }
      setInputsBySession(inputsRef.current)
    },
    [sessionId, initialInputs],
  )
  const promoteInputs = useCallback((draftId: string, conversationId: string) => {
    if (draftId === conversationId) return
    aliasesRef.current[draftId] = conversationId
    const inputs = inputsRef.current[draftId]
    if (!inputs) return
    const next = { ...inputsRef.current, [conversationId]: inputs }
    delete next[draftId]
    inputsRef.current = next
    setInputsBySession(next)
  }, [])
  return { inputs: inputsBySession[sessionId] ?? initialInputs, changeInput, promoteInputs }
}
