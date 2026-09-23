'use client'

import { Button } from '@langgenius/dify-ui/button'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Loading from '@/app/components/base/loading'
import { useRouter } from '@/next/navigation'
import { del, get, post, put } from '@/service/base'

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
      setError(String(err))
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
      setError(String(err))
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
      setError(String(err))
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
      setError(String(err))
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
      setError(String(err))
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
      setError(String(err))
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
      setError(String(err))
    } finally {
      setUpdatingAssignment(null)
    }
  }

  return (
    <main className="mx-auto flex h-full w-full max-w-5xl flex-col gap-6 overflow-y-auto p-8">
      <header>
        <h1 className="title-2xl-semi-bold text-text-primary">
          用户管理
        </h1>
        <p className="mt-1 body-sm-regular text-text-tertiary">
          批量邀请成员、预分配工作空间并查看处理结果
        </p>
      </header>
      <section className="rounded-xl border border-divider-subtle bg-background-section p-5">
        <div className="mb-4 flex items-center gap-3">
          <label className="body-sm-medium text-text-secondary" htmlFor="operation">
            操作类型
          </label>
          <select
            id="operation"
            className="rounded-lg border border-divider-regular bg-background-default px-3 py-2"
            value={operation}
            onChange={(event) => setOperation(event.target.value as 'invite' | 'assign')}
          >
            <option value="assign">工作空间分配</option>
            <option value="invite">批量邀请团队成员</option>
          </select>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="secondary" onClick={() => void downloadTemplate()}>
              下载示例 Excel
            </Button>
            <input
              type="file"
              accept=".xlsx,.xlsm"
              disabled={loading}
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) void previewFile(file)
              }}
            />
          </div>
        </div>
        <p className="body-xs-regular text-text-tertiary">
          {operation === 'assign'
            ? 'Excel 列：用户邮箱、工作空间名称、工作空间 ID（可选）、工作空间角色'
            : 'Excel 列：邮箱、角色'}
        </p>
      </section>
      <section className="rounded-xl border border-divider-subtle bg-background-section p-5">
        <h2 className="mb-3 system-md-semibold text-text-secondary">手动分配工作空间</h2>
        <div className="flex flex-wrap gap-3">
          <input
            aria-label="用户邮箱"
            className="min-w-60 rounded-lg border border-divider-regular px-3 py-2"
            placeholder="用户邮箱"
            value={manualEmail}
            onChange={(event) => setManualEmail(event.target.value)}
          />
          <input
            aria-label="工作空间名称"
            className="min-w-60 rounded-lg border border-divider-regular px-3 py-2"
            placeholder="工作空间名称（可选）"
            value={manualWorkspace}
            onChange={(event) => setManualWorkspace(event.target.value)}
          />
          <input
            aria-label="工作空间 ID"
            className="min-w-60 rounded-lg border border-divider-regular px-3 py-2"
            placeholder="工作空间 ID（可选）"
            value={manualWorkspaceId}
            onChange={(event) => setManualWorkspaceId(event.target.value)}
          />
          <select
            aria-label="工作空间角色"
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
            分配
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
              预览：{preview.total} 行，错误 {preview.errors.length} 行
            </div>
            <Button variant="primary" loading={loading} onClick={() => void confirm()}>
              确认导入
            </Button>
          </div>
          <div className="max-h-80 overflow-auto">
            <table className="w-full text-left body-xs-regular">
              <thead>
                <tr>
                  <th className="p-2">邮箱</th>
                  <th className="p-2">工作空间</th>
                  <th className="p-2">工作空间 ID</th>
                  <th className="p-2">角色</th>
                  <th className="p-2">原因</th>
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
            <div className="body-sm-medium text-text-secondary">处理结果：{results.length} 行</div>
            <Button variant="secondary" onClick={() => void downloadFailed()}>
              下载失败记录
            </Button>
          </div>
          <div className="max-h-96 overflow-auto">
            <table className="w-full text-left body-xs-regular">
              <thead>
                <tr>
                  <th className="p-2">邮箱</th>
                  <th className="p-2">工作空间</th>
                  <th className="p-2">状态</th>
                  <th className="p-2">原因</th>
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
          <h2 className="system-md-semibold text-text-secondary">用户与工作空间分配情况</h2>
          <Button variant="secondary" onClick={() => void downloadAssignments()}>
            导出全部
          </Button>
        </div>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <input
            aria-label="搜索用户邮箱"
            className="min-w-60 rounded-lg border border-divider-regular px-3 py-2"
            placeholder="搜索用户邮箱"
            value={emailFilter}
            onChange={(event) => setEmailFilter(event.target.value)}
          />
          <input
            aria-label="搜索工作空间"
            className="min-w-60 rounded-lg border border-divider-regular px-3 py-2"
            placeholder="搜索工作空间"
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
              清除搜索
            </Button>
          )}
          {assignmentsQuery.isFetching && (
            <span className="body-xs-regular text-text-tertiary">正在刷新…</span>
          )}
        </div>
        <div className="max-h-96 overflow-auto">
          <table className="w-full text-left body-xs-regular">
            <thead>
              <tr>
                <th className="p-2">用户邮箱</th>
                <th className="p-2">用户 ID</th>
                <th className="p-2">工作空间</th>
                <th className="p-2">工作空间 ID</th>
                <th className="p-2">角色</th>
                <th className="p-2">状态</th>
                <th className="p-2">操作</th>
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
                      查看详情
                    </Button>
                    <Button
                      variant="secondary"
                      size="small"
                      disabled={!row.assignment_id || updatingAssignment === row.assignment_id}
                      onClick={() => void removeAssignment(row)}
                    >
                      移除
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
                工作空间分配详情
              </h2>
              <button
                type="button"
                className="text-text-tertiary"
                aria-label="关闭详情"
                onClick={() => setSelectedDetails(null)}
              >
                ×
              </button>
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-3 body-sm-regular">
              <dt className="text-text-tertiary">工作空间名称</dt>
              <dd className="text-text-primary">{selectedDetails.workspace_name || '-'}</dd>
              <dt className="text-text-tertiary">工作空间 ID</dt>
              <dd className="font-mono break-all text-text-primary">
                {selectedDetails.workspace_id || '-'}
              </dd>
              <dt className="text-text-tertiary">用户邮箱</dt>
              <dd className="break-all text-text-primary">{selectedDetails.email}</dd>
              <dt className="text-text-tertiary">用户 ID</dt>
              <dd className="font-mono break-all text-text-primary">
                {selectedDetails.user_id || selectedDetails.account_id || '-'}
              </dd>
              <dt className="text-text-tertiary">分配记录 ID</dt>
              <dd className="font-mono break-all text-text-primary">
                {selectedDetails.assignment_id || '-'}
              </dd>
              <dt className="text-text-tertiary">角色</dt>
              <dd className="text-text-primary">{selectedDetails.role}</dd>
              <dt className="text-text-tertiary">当前工作空间</dt>
              <dd className="text-text-primary">{selectedDetails.current ? '是' : '否'}</dd>
              <dt className="text-text-tertiary">状态</dt>
              <dd className="text-text-primary">
                {selectedDetails.reason || selectedDetails.status || 'assigned'}
              </dd>
              <dt className="text-text-tertiary">最后打开时间</dt>
              <dd className="text-text-primary">{selectedDetails.last_opened_at || '-'}</dd>
            </dl>
          </section>
        </div>
      )}
    </main>
  )
}

export default UserManagementPage
