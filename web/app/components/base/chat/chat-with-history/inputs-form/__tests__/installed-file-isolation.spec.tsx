import type { ChatWithHistoryContextValue } from '../../context'
import type { FileUploaderInAttachmentWrapperProps } from '@/app/components/base/file-uploader/file-uploader-in-attachment'
import type { FileEntity } from '@/app/components/base/file-uploader/types'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createContext, use } from 'react'
import {
  FileContextProvider,
  useFileStore,
  useStore,
} from '@/app/components/base/file-uploader/store'
import { InputVarType } from '@/app/components/workflow/types'
import { TransferMethod } from '@/types/app'
import { getProcessedInputs } from '../../../chat/utils'
import { useInstalledInputs } from '../../use-installed-inputs'
import InputsFormContent from '../content'

const Context = createContext<Partial<ChatWithHistoryContextValue>>({})
vi.mock('../../context', () => ({ useChatWithHistoryContext: () => use(Context) }))
// Use the real upload store; replace only the network/preview-heavy upload UI.
vi.mock('@/app/components/base/file-uploader', () => ({
  FileUploaderInAttachmentWrapper: ({
    value,
    onChange,
    syncValue,
  }: FileUploaderInAttachmentWrapperProps) => (
    <FileContextProvider value={value} onChange={onChange} syncValue={syncValue}>
      <UploadControl />
    </FileContextProvider>
  ),
}))
let completeUpload: () => void
const file: FileEntity = {
  id: 'local-A',
  name: 'A.xlsx',
  size: 10,
  type: 'application/vnd.ms-excel',
  progress: 100,
  transferMethod: TransferMethod.local_file,
  supportFileType: 'document',
  uploadedId: 'uploaded-A',
}
function UploadControl() {
  const store = useFileStore()
  const files = useStore((state) => state.files)
  return (
    <>
      <button onClick={() => store.getState().setFiles([file])}>Upload</button>
      <button
        onClick={() => {
          completeUpload = () => store.getState().setFiles([file])
        }}
      >
        Start slow upload
      </button>
      {files.map((item) => (
        <span key={item.id}>{item.name}</span>
      ))}
    </>
  )
}
function Form({ id, initial = { file: null } }: { id: string; initial?: Record<string, unknown> }) {
  const owner = useInstalledInputs(id, initial)
  return (
    <Context
      value={{
        isInstalledApp: true,
        currentConversationId: id,
        currentConversationInputs: owner.inputs,
        newConversationInputs: owner.inputs,
        handleConversationInputChange: owner.changeInput,
        appParams: { system_parameters: {} } as ChatWithHistoryContextValue['appParams'],
        inputsForms: [{ variable: 'file', label: 'file', type: InputVarType.singleFile }],
      }}
    >
      <InputsFormContent />
      <output aria-label="Request inputs">
        {JSON.stringify(
          getProcessedInputs(owner.inputs, [
            {
              variable: 'file',
              label: 'file',
              type: InputVarType.singleFile,
              required: false,
              hide: false,
            },
          ]),
        )}
      </output>
    </Context>
  )
}

describe('installed file form', () => {
  it('shows a file only in its own A conversation across A B C switches', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<Form id="draft:A" />)
    await user.click(screen.getByRole('button', { name: 'Upload' }))
    expect(screen.getByText('A.xlsx')).toBeInTheDocument()
    expect(screen.getByLabelText('Request inputs')).toHaveTextContent(
      '"upload_file_id":"uploaded-A"',
    )
    rerender(<Form id="draft:B" />)
    expect(screen.queryByText('A.xlsx')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Request inputs')).toHaveTextContent('"file":null')
    rerender(<Form id="draft:C" />)
    expect(screen.queryByText('A.xlsx')).not.toBeInTheDocument()
    rerender(<Form id="draft:A" />)
    expect(screen.getByText('A.xlsx')).toBeInTheDocument()
  })
  it('keeps late completion attached to A after opening B', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<Form id="draft:A" />)
    await user.click(screen.getByRole('button', { name: 'Start slow upload' }))
    rerender(<Form id="draft:B" />)
    act(() => completeUpload())
    expect(screen.queryByText('A.xlsx')).not.toBeInTheDocument()
    rerender(<Form id="draft:A" />)
    expect(screen.getByText('A.xlsx')).toBeInTheDocument()
  })
  it('hydrates a saved file when history arrives after mounting', () => {
    const { rerender } = render(<Form id="real-A" />)
    expect(screen.queryByText('A.xlsx')).not.toBeInTheDocument()
    rerender(<Form id="real-A" initial={{ file }} />)
    expect(screen.getByText('A.xlsx')).toBeInTheDocument()
  })
})
