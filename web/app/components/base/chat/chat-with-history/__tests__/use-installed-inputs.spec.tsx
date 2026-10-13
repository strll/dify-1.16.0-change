import { act, renderHook } from '@testing-library/react'
import { useInstalledInputs } from '../use-installed-inputs'

describe('installed conversation input ownership', () => {
  it('keeps A B C files separate and restores each selection', () => {
    const defaults = { file: null }
    const { result, rerender } = renderHook(({ id }) => useInstalledInputs(id, defaults), {
      initialProps: { id: 'draft:A' },
    })
    const fileA = { uploadedId: 'file-A', name: 'A.xlsx' }
    act(() => result.current.changeInput('file', fileA))
    rerender({ id: 'draft:B' })
    expect(result.current.inputs.file).toBeNull()
    act(() => result.current.changeInput('file', { uploadedId: 'file-B' }))
    rerender({ id: 'draft:C' })
    expect(result.current.inputs.file).toBeNull()
    rerender({ id: 'draft:A' })
    expect(result.current.inputs.file).toEqual(fileA)
    rerender({ id: 'draft:B' })
    expect(result.current.inputs.file).toEqual({ uploadedId: 'file-B' })
  })

  it('routes late upload completion to A while B is selected', () => {
    const { result, rerender } = renderHook(({ id }) => useInstalledInputs(id, { file: null }), {
      initialProps: { id: 'draft:A' },
    })
    const completeA = result.current.changeInput
    rerender({ id: 'draft:B' })
    act(() => completeA('file', { uploadedId: 'completed-A' }))
    expect(result.current.inputs.file).toBeNull()
    rerender({ id: 'draft:A' })
    expect(result.current.inputs.file).toEqual({ uploadedId: 'completed-A' })
  })

  it('preserves inputs and late callbacks when a draft becomes a real conversation', () => {
    const { result, rerender } = renderHook(({ id }) => useInstalledInputs(id, { file: null }), {
      initialProps: { id: 'draft:A' },
    })
    const completeA = result.current.changeInput
    act(() => result.current.changeInput('file', { uploadedId: 'file-A' }))
    act(() => result.current.promoteInputs('draft:A', 'real-A'))
    rerender({ id: 'real-A' })
    expect(result.current.inputs.file).toEqual({ uploadedId: 'file-A' })
    act(() => completeA('note', 'belongs to A'))
    expect(result.current.inputs.note).toBe('belongs to A')
    rerender({ id: 'draft:B' })
    expect(result.current.inputs).toEqual({ file: null })
  })

  it('does not let a history refetch overwrite edited file inputs', () => {
    const { result, rerender } = renderHook(({ inputs }) => useInstalledInputs('real-A', inputs), {
      initialProps: { inputs: { file: null as unknown } },
    })
    act(() => result.current.changeInput('file', { uploadedId: 'new-file' }))
    rerender({ inputs: { file: { uploadedId: 'old-file' } } })
    expect(result.current.inputs.file).toEqual({ uploadedId: 'new-file' })
  })
})
