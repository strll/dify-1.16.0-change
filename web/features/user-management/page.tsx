'use client'

import { Button } from '@langgenius/dify-ui/button'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Loading from '@/app/components/base/loading'
import { useRouter } from '@/next/navigation'
import { del, get, post, put } from '@/service/base'
import { parseErrorMessage } from '@/utils/error-parser'

type PreviewRow = {
  email: string
  account_id?: string
  role: string
  workspace_name?: string | null
  workspace_id?: string
  assignment_id?: string
  user_id?: string
  reason?: string
  status?: string
  current?: boolean
  last_opened_at?: string | null
}
type PreviewResponse = { rows: PreviewRow[]; errors: PreviewRow[]; total: number }
type Result = PreviewRow & { status: string; workspace_id?: string }

const abbreviateId = (value?: string) => (value ? `${value.slice(0, 8)}…${value.slice(-4)}` : '-')

const UserManagementPage = () => {
  const { t } = useTranslation()
  const router = useRouter()
  const [operation, setOperation] = useState<'invite' | 'assign'>('assign')
  const [preview, setPreview] = useState<PreviewResponse | null>(null)
  const [results, setResults] = useState<Result[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [manualEmail, setManualEmail] = useState('')
  const [manualWorkspace, setManualWorkspace] = useState('')
  const [manualWorkspaceId, setManualWorkspaceId] = useState('')
  const [manualRole, setManualRole] = useState('normal')
  const [updatingAssignment, setUpdatingAssignment] = useState<string | null>(null)
  const [emailFilter, setEmailFilter] = useState('')
  const [workspaceFilter, setWorkspaceFilter] = useState('')
  const [selectedDetails, setSelectedDetails] = useState<PreviewRow | null>(null)
  const [selectedFileName, setSelectedFileName] = useState('')
  const accessQuery = useQuery({
    queryKey: ['user-management', 'access'],
    queryFn: () => get<{ enabled: boolean }>('/user-management/access', {}, { silent: true }),
    retry: false,
  })
  const assignmentsQuery = useQuery({
    queryKey: ['user-management', 'assignments', emailFilter, workspaceFilter],
    queryFn: () => {
      const params = new URLSearchParams()
      if (emailFilter.trim()) params.set('email', emailFilter.trim())
      if (workspaceFilter.trim()) params.set('workspace_name', workspaceFilter.trim())
      const query = params.toString()
      return get<{ items: PreviewRow[]; total: number }>(
        `/user-management/assignments${query ? `?${query}` : ''}`,
      )
    },
    enabled: accessQuery.data?.enabled === true,
  })
  const isAllowed = accessQuery.isFetched && accessQuery.data?.enabled === true

  useEffect(() => {
    if (accessQuery.isFetched && !isAllowed) router.replace('/')
  }, [accessQuery.isFetched, isAllowed, router])

  if (accessQuery.isLoading) return <Loading type="app" />
  if (!isAllowed) return null

  const previewFile = async (file: File) => {
    setLoading(true)
    setError(null)
    try {
      const form = new FormData()
      form.append('file', file)
      form.append('operation', operation)
      const response = await post<PreviewResponse>(
        '/user-management/import/preview',
        { body: form },
        { bodyStringify: false, deleteContentType: true },
      )
      setPreview(response)
      setResults([])
    } catch (err) {
      setError(await parseErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  const confirm = async () => {
    if (!preview?.rows.length) return
    setLoading(true)
    setError(null)
    try {
      const response = await post<{ results: Result[] }>('/user-management/import/confirm', {
        body: { rows: preview.rows, operation },
      })
      setResults(response.results)
      await assignmentsQuery.refetch()
    } catch (err) {
      setError(await parseErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  const assignManually = async () => {
    if (!manualEmail.trim() || (!manualWorkspace.trim() && !manualWorkspaceId.trim())) return
    setLoading(true)
    try {
      const response = await post<{ results: Result[] }>('/user-management/import/confirm', {
        body: {
          operation: 'assign',
          rows: [
            {
              email: manualEmail.trim(),
              workspace_name: manualWorkspace.trim() || undefined,
              workspace_id: manualWorkspaceId.trim() || undefined,
              role: manualRole,
            },
          ],
        },
      })
      setResults(response.results)
      setManualEmail('')
      setManualWorkspace('')
      setManualWorkspaceId('')
      await assignmentsQuery.refetch()
    } catch (err) {
      setError(await parseErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  const downloadFailed = async () => {
    const failed = [
      ...(preview?.errors.map((item) => ({ ...item, status: 'failed' })) ?? []),
      ...results.filter((item) => item.status === 'failed'),
    ]
    if (!failed.length) return
    const response = await post<Response>(
      '/user-management/import/failed-export',
      { body: { rows: failed } },
      { needAllResponseContent: true },
    )
    if (!response.ok) return
    const blob = await response.blob()
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'failed-imports.xlsx'
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const downloadBlob = async (path: string, filename: string) => {
    const response = await get<Response>(path, {}, { needAllResponseContent: true })
    if (!response.ok) return
    const blob = await response.blob()
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    URL.revokeObjectURL(url)
  }

  const downloadAssignments = async () => {
    try {
      await downloadBlob('/user-management/assignments/export', 'workspace-assignments.xlsx')
    } catch (err) {
      setError(await parseErrorMessage(err))
    }
  }

  const downloadTemplate = async () => {
    try {
      await downloadBlob(
        `/user-management/templates/${operation}`,
        operation === 'invite'
          ? 'member-invite-template.xlsx'
          : 'workspace-assignment-template.xlsx',
      )
    } catch (err) {
      setError(await parseErrorMessage(err))
    }
  }

  const updateAssignment = async (row: PreviewRow, role: string) => {
    if (!row.assignment_id) return
    setUpdatingAssignment(row.assignment_id)
    setError(null)
    try {
      await put(`/user-management/assignments/${encodeURIComponent(row.assignment_id)}`, {
        body: { role },
      })
      await assignmentsQuery.refetch()
    } catch (err) {
      setError(await parseErrorMessage(err))
    } finally {
      setUpdatingAssignment(null)
    }
  }

  const removeAssignment = async (row: PreviewRow) => {
    if (
      !row.assignment_id ||
      !window.confirm(`确定要移除 ${row.email} 在「${row.workspace_name || ''}」中的分配吗？`)
    )
      return
    setUpdatingAssignment(row.assignment_id)
    setError(null)
    try {
      await del(`/user-management/assignments/${encodeURIComponent(row.assignment_id)}`)
      await assignmentsQuery.refetch()
    } catch (err) {
      setError(await parseErrorMessage(err))
    } finally {
      setUpdatingAssignment(null)
    }
  }

  return (
    <main className="mx-auto flex h-full w-full max-w-5xl flex-col gap-6 overflow-y-auto p-8">
      <header>
        <h1 className="title-2xl-semi-bold text-text-primary">{t(($) => $['userManagement.title'], { ns: 'common' })}</h1>
        <p className="mt-1 body-sm-regular text-text-tertiary">
          {t(($) => $['userManagement.description'], { ns: 'common' })}
        </p>
      </header>
      <section className="rounded-xl border border-divider-subtle bg-background-section p-5">
        <div className="mb-4 flex items-center gap-3">
          <label className="body-sm-medium text-text-secondary" htmlFor="operation">
            {t(($) => $['userManagement.operationType'], { ns: 'common' })}
          </label>
          <select
            id="operation"
            className="rounded-lg border border-divider-regular bg-background-default px-3 py-2"
            value={operation}
            onChange={(event) => setOperation(event.target.value as 'invite' | 'assign')}
          >
            <option value="assign">{t(($) => $['userManagement.workspaceAssignment'], { ns: 'common' })}</option>
            <option value="invite">{t(($) => $['userManagement.batchInvite'], { ns: 'common' })}</option>
          </select>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="secondary" onClick={() => void downloadTemplate()}>
              {t(($) => $['userManagement.downloadTemplate'], { ns: 'common' })}
            </Button>
            <label
              className={`inline-flex cursor-pointer items-center gap-2 rounded-lg border border-divider-regular bg-background-default px-3 py-2 text-sm ${loading ? 'cursor-not-allowed opacity-50' : ''}`}
            >
              <span>{t(($) => $['userManagement.chooseFile'], { ns: 'common' })}</span>
              <input
                className="sr-only"
                type="file"
                accept=".xlsx,.xlsm"
                disabled={loading}
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  setSelectedFileName(file?.name || '')
                  if (file) void previewFile(file)
                }}
              />
            </label>
            <span className="max-w-60 truncate text-sm text-text-tertiary">
              {selectedFileName || t(($) => $['userManagement.noFileChosen'], { ns: 'common' })}
            </span>
          </div>
        </div>
        <p className="body-xs-regular text-text-tertiary">
          {operation === 'assign'
            ? t(($) => $['userManagement.excelAssignmentColumns'], { ns: 'common' })
            : t(($) => $['userManagement.excelInviteColumns'], { ns: 'common' })}
        </p>
      </section>
      <section className="rounded-xl border border-divider-subtle bg-background-section p-5">
        <h2 className="mb-3 system-md-semibold text-text-secondary">{t(($) => $['userManagement.manualAssignment'], { ns: 'common' })}</h2>
        <div className="flex flex-wrap gap-3">
          <input
            aria-label={t(($) => $['userManagement.email'], { ns: 'common' })}
            className="min-w-60 rounded-lg border border-divider-regular px-3 py-2"
            placeholder={t(($) => $['userManagement.email'], { ns: 'common' })}
            value={manualEmail}
            onChange={(event) => setManualEmail(event.target.value)}
          />
          <input
            aria-label={t(($) => $['userManagement.workspace'], { ns: 'common' })}
            className="min-w-60 rounded-lg border border-divider-regular px-3 py-2"
            placeholder={t(($) => $['userManagement.workspaceNameOptional'], { ns: 'common' })}
            value={manualWorkspace}
            onChange={(event) => setManualWorkspace(event.target.value)}
          />
          <input
            aria-label={t(($) => $['userManagement.workspaceId'], { ns: 'common' })}
            className="min-w-60 rounded-lg border border-divider-regular px-3 py-2"
            placeholder={t(($) => $['userManagement.workspaceIdOptional'], { ns: 'common' })}
            value={manualWorkspaceId}
            onChange={(event) => setManualWorkspaceId(event.target.value)}
          />
          <select
            aria-label={t(($) => $['userManagement.workspaceRole'], { ns: 'common' })}
            className="rounded-lg border border-divider-regular px-3 py-2"
            value={manualRole}
            onChange={(event) => setManualRole(event.target.value)}
          >
            <option value="normal">normal</option>
            <option value="admin">admin</option>
            <option value="editor">editor</option>
            <option value="dataset_operator">dataset_operator</option>
            <option value="owner">owner</option>
          </select>
          <Button
            variant="secondary"
            loading={loading}
            disabled={!manualWorkspace.trim() && !manualWorkspaceId.trim()}
            onClick={() => void assignManually()}
          >
            {t(($) => $['userManagement.assign'], { ns: 'common' })}
          </Button>
        </div>
      </section>
      {error && (
        <div
          role="alert"
          className="rounded-lg bg-state-destructive-hover p-3 body-sm-regular text-text-destructive"
        >
          {error}
        </div>
      )}
      {preview && (
        <section className="rounded-xl border border-divider-subtle bg-background-section p-5">
          <div className="mb-4 flex items-center justify-between">
            <div className="body-sm-medium text-text-secondary">
              {t(($) => $['userManagement.preview'], { ns: 'common', total: preview.total, errors: preview.errors.length })}
            </div>
            <Button variant="primary" loading={loading} onClick={() => void confirm()}>
              {t(($) => $['userManagement.confirmImport'], { ns: 'common' })}
            </Button>
          </div>
          <div className="max-h-80 overflow-auto">
            <table className="w-full text-left body-xs-regular">
              <thead>
                <tr>
                  <th className="p-2">{t(($) => $['userManagement.email'], { ns: 'common' })}</th>
                  <th className="p-2">{t(($) => $['userManagement.workspace'], { ns: 'common' })}</th>
                  <th className="p-2">{t(($) => $['userManagement.workspaceId'], { ns: 'common' })}</th>
                  <th className="p-2">{t(($) => $['userManagement.role'], { ns: 'common' })}</th>
                  <th className="p-2">{t(($) => $['userManagement.reason'], { ns: 'common' })}</th>
                </tr>
              </thead>
              <tbody>
                {[...preview.rows, ...preview.errors].map((row, index) => (
                  <tr key={`${row.email}-${index}`} className="border-t border-divider-subtle">
                    <td className="p-2">{row.email}</td>
                    <td className="p-2">{row.workspace_name || '-'}</td>
                    <td className="p-2 font-mono">{row.workspace_id || '-'}</td>
                    <td className="p-2">{row.role}</td>
                    <td className="p-2 text-text-destructive">{row.reason || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {results.length > 0 && (
        <section className="rounded-xl border border-divider-subtle bg-background-section p-5">
          <div className="mb-4 flex items-center justify-between">
            <div className="body-sm-medium text-text-secondary">{t(($) => $['userManagement.processingResults'], { ns: 'common', count: results.length })}</div>
            <Button variant="secondary" onClick={() => void downloadFailed()}>
              {t(($) => $['userManagement.downloadFailed'], { ns: 'common' })}
            </Button>
          </div>
          <div className="max-h-96 overflow-auto">
            <table className="w-full text-left body-xs-regular">
              <thead>
                <tr>
                  <th className="p-2">{t(($) => $['userManagement.email'], { ns: 'common' })}</th>
                  <th className="p-2">{t(($) => $['userManagement.workspace'], { ns: 'common' })}</th>
                  <th className="p-2">{t(($) => $['userManagement.reason'], { ns: 'common' })}</th>
                  <th className="p-2">{t(($) => $['userManagement.status'], { ns: 'common' })}</th>
                </tr>
              </thead>
              <tbody>
                {results.map((row, index) => (
                  <tr key={`${row.email}-${index}`} className="border-t border-divider-subtle">
                    <td className="p-2">{row.email}</td>
                    <td className="p-2">{row.workspace_name || '-'}</td>
                    <td className="p-2">{row.status}</td>
                    <td className="p-2">{row.reason || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      <section className="rounded-xl border border-divider-subtle bg-background-section p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="system-md-semibold text-text-secondary">{t(($) => $['userManagement.assignmentStatus'], { ns: 'common' })}</h2>
          <Button variant="secondary" onClick={() => void downloadAssignments()}>
            {t(($) => $['userManagement.exportAll'], { ns: 'common' })}
          </Button>
        </div>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <input
            aria-label={t(($) => $['userManagement.searchEmail'], { ns: 'common' })}
            className="min-w-60 rounded-lg border border-divider-regular px-3 py-2"
            placeholder={t(($) => $['userManagement.searchEmail'], { ns: 'common' })}
            value={emailFilter}
            onChange={(event) => setEmailFilter(event.target.value)}
          />
          <input
            aria-label={t(($) => $['userManagement.searchWorkspace'], { ns: 'common' })}
            className="min-w-60 rounded-lg border border-divider-regular px-3 py-2"
            placeholder={t(($) => $['userManagement.searchWorkspace'], { ns: 'common' })}
            value={workspaceFilter}
            onChange={(event) => setWorkspaceFilter(event.target.value)}
          />
          {(emailFilter || workspaceFilter) && (
            <Button
              variant="secondary"
              onClick={() => {
                setEmailFilter('')
                setWorkspaceFilter('')
              }}
            >
              {t(($) => $['userManagement.clearSearch'], { ns: 'common' })}
            </Button>
          )}
          {assignmentsQuery.isFetching && (
            <span className="body-xs-regular text-text-tertiary">{t(($) => $['userManagement.refreshing'], { ns: 'common' })}</span>
          )}
        </div>
        <div className="max-h-96 overflow-auto">
          <table className="w-full text-left body-xs-regular">
            <thead>
              <tr>
                <th className="p-2">{t(($) => $['userManagement.email'], { ns: 'common' })}</th>
                <th className="p-2">{t(($) => $['userManagement.userId'], { ns: 'common' })}</th>
                <th className="p-2">{t(($) => $['userManagement.workspace'], { ns: 'common' })}</th>
                <th className="p-2">{t(($) => $['userManagement.workspaceId'], { ns: 'common' })}</th>
                <th className="p-2">{t(($) => $['userManagement.role'], { ns: 'common' })}</th>
                <th className="p-2">{t(($) => $['userManagement.status'], { ns: 'common' })}</th>
                <th className="p-2">{t(($) => $['userManagement.actions'], { ns: 'common' })}</th>
              </tr>
            </thead>
            <tbody>
              {(assignmentsQuery.data?.items || []).map((row, index) => (
                <tr
                  key={`${row.assignment_id || row.email}-${row.workspace_name}-${index}`}
                  className="border-t border-divider-subtle"
                >
                  <td className="p-2">{row.email}</td>
                  <td className="p-2" title={row.account_id}>
                    {abbreviateId(row.account_id)}
                  </td>
                  <td className="p-2">{row.workspace_name || '-'}</td>
                  <td className="p-2" title={row.workspace_id}>
                    {abbreviateId(row.workspace_id)}
                  </td>
                  <td className="p-2">
                    <select
                      aria-label={`${row.email} 角色`}
                      className="rounded border border-divider-regular bg-background-default px-2 py-1"
                      value={row.role}
                      disabled={!row.assignment_id || updatingAssignment === row.assignment_id}
                      onChange={(event) => void updateAssignment(row, event.target.value)}
                    >
                      <option value="normal">normal</option>
                      <option value="admin">admin</option>
                      <option value="editor">editor</option>
                      <option value="dataset_operator">dataset_operator</option>
                      <option value="owner">owner</option>
                    </select>
                  </td>
                  <td className="p-2">{row.reason || row.status || 'assigned'}</td>
                  <td className="flex gap-2 p-2">
                    <Button
                      variant="secondary"
                      size="small"
                      onClick={() => setSelectedDetails(row)}
                    >
                      {t(($) => $['userManagement.viewDetails'], { ns: 'common' })}
                    </Button>
                    <Button
                      variant="secondary"
                      size="small"
                      disabled={!row.assignment_id || updatingAssignment === row.assignment_id}
                      onClick={() => void removeAssignment(row)}
                    >
                      {t(($) => $['userManagement.remove'], { ns: 'common' })}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {selectedDetails && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
          role="presentation"
          onClick={() => setSelectedDetails(null)}
        >
          <section
            className="w-full max-w-lg rounded-xl bg-background-default p-6 shadow-xl"
            role="dialog"
            aria-modal="true"
            aria-labelledby="assignment-details-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <h2 id="assignment-details-title" className="system-md-semibold text-text-primary">
                {t(($) => $['userManagement.details'], { ns: 'common' })}
              </h2>
              <button
                type="button"
                className="text-text-tertiary"
                aria-label={t(($) => $['userManagement.closeDetails'], { ns: 'common' })}
                onClick={() => setSelectedDetails(null)}
              >
                ×
              </button>
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-3 body-sm-regular">
              <dt className="text-text-tertiary">{t(($) => $['userManagement.workspaceNameOptional'], { ns: 'common' })}</dt>
              <dd className="text-text-primary">{selectedDetails.workspace_name || '-'}</dd>
              <dt className="text-text-tertiary">{t(($) => $['userManagement.workspaceId'], { ns: 'common' })}</dt>
              <dd className="font-mono break-all text-text-primary">
                {selectedDetails.workspace_id || '-'}
              </dd>
              <dt className="text-text-tertiary">{t(($) => $['userManagement.email'], { ns: 'common' })}</dt>
              <dd className="break-all text-text-primary">{selectedDetails.email}</dd>
              <dt className="text-text-tertiary">{t(($) => $['userManagement.userId'], { ns: 'common' })}</dt>
              <dd className="font-mono break-all text-text-primary">
                {selectedDetails.user_id || selectedDetails.account_id || '-'}
              </dd>
              <dt className="text-text-tertiary">{t(($) => $['userManagement.assignmentId'], { ns: 'common' })}</dt>
              <dd className="font-mono break-all text-text-primary">
                {selectedDetails.assignment_id || '-'}
              </dd>
              <dt className="text-text-tertiary">{t(($) => $['userManagement.role'], { ns: 'common' })}</dt>
              <dd className="text-text-primary">{selectedDetails.role}</dd>
              <dt className="text-text-tertiary">{t(($) => $['userManagement.currentWorkspace'], { ns: 'common' })}</dt>
              <dd className="text-text-primary">{selectedDetails.current ? t(($) => $['userManagement.yes'], { ns: 'common' }) : t(($) => $['userManagement.no'], { ns: 'common' })}</dd>
              <dt className="text-text-tertiary">{t(($) => $['userManagement.status'], { ns: 'common' })}</dt>
              <dd className="text-text-primary">
                {selectedDetails.reason || selectedDetails.status || 'assigned'}
              </dd>
              <dt className="text-text-tertiary">{t(($) => $['userManagement.lastOpened'], { ns: 'common' })}</dt>
              <dd className="text-text-primary">{selectedDetails.last_opened_at || '-'}</dd>
            </dl>
          </section>
        </div>
      )}
    </main>
  )
}

export default UserManagementPage
