import type { FileEntity } from './types'
import { createContext, use, useEffect, useRef } from 'react'
import { create, useStore as useZustandStore } from 'zustand'

type Shape = {
  files: FileEntity[]
  setFiles: (files: FileEntity[]) => void
}

export const createFileStore = (
  value: FileEntity[] = [],
  onChange?: (files: FileEntity[]) => void,
) => {
  return create<Shape>((set) => ({
    files: value ? [...value] : [],
    setFiles: (files) => {
      set({ files })
      onChange?.(files)
    },
  }))
}

type FileStore = ReturnType<typeof createFileStore>
export const FileContext = createContext<FileStore | null>(null)

export function useStore<T>(selector: (state: Shape) => T): T {
  const store = use(FileContext)
  if (!store) throw new Error('Missing FileContext.Provider in the tree')

  return useZustandStore(store, selector)
}

export const useFileStore = () => {
  return use(FileContext)!
}

type FileProviderProps = {
  children: React.ReactNode
  value?: FileEntity[]
  onChange?: (files: FileEntity[]) => void
  syncValue?: boolean
}
export const FileContextProvider = ({
  children,
  value,
  onChange,
  syncValue = false,
}: FileProviderProps) => {
  const storeRef = useRef<FileStore | undefined>(undefined)
  // A local selection/upload can be followed by a render with the previous
  // conversation value. Do not let that stale value erase the in-flight file.
  const localMutationRef = useRef(false)

  if (!storeRef.current) {
    storeRef.current = createFileStore(value, (files) => {
      localMutationRef.current = true
      onChange?.(files)
    })
  }
  useEffect(() => {
    if (!syncValue) return

    const nextFiles = value ? [...value] : []
    const currentFiles = storeRef.current!.getState().files
    const sameFiles =
      currentFiles.length === nextFiles.length &&
      currentFiles.every(
        (file, index) =>
          file.id === nextFiles[index]?.id && file.uploadedId === nextFiles[index]?.uploadedId,
      )

    // Once the parent has observed the local mutation, normal hydration may
    // resume. Until then, keep the local list visible even if the parent is
    // still rendering an older/null input snapshot. This also covers the
    // short window after upload success (when uploadedId is already present).
    if (localMutationRef.current && !sameFiles) return
    if (sameFiles) localMutationRef.current = false
    storeRef.current!.setState({ files: nextFiles })
  }, [syncValue, value])

  return <FileContext.Provider value={storeRef.current}>{children}</FileContext.Provider>
}
