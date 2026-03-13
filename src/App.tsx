import { KeyboardEvent, useEffect, useState } from 'react'
import './App.css'

type SyncStatus = 'PendingCreate' | 'PendingUpdate' | 'PendingDelete' | 'Synced' | 'Failed'
type SyncRunStatus = 'Running' | 'Succeeded' | 'Failed' | 'PartialSuccess'
type SyncTriggerType = 'Manual' | 'Hangfire'

type SyncMetadata = {
  syncStatus: SyncStatus
  lastModifiedAtUtc: string
  lastSyncedAtUtc: string | null
  lastSyncError: string | null
  externalId: number | null
}

type TodoItem = {
  id: number
  text: string
  isCompleted: boolean
  isDeleted: boolean
  todoListId: number
  sync: SyncMetadata
}

type TodoList = {
  id: number
  name: string
  isDeleted: boolean
  sync: SyncMetadata
  items: TodoItem[]
}

type SyncRun = {
  id: number
  startedAtUtc: string
  finishedAtUtc: string | null
  status: SyncRunStatus
  triggeredBy: SyncTriggerType
  createdCount: number
  updatedCount: number
  deletedCount: number
  failedCount: number
  skippedCount: number
  errorSummary: string | null
}

type SyncStatusResponse = {
  lastRun: SyncRun | null
  pendingListCount: number
  pendingItemCount: number
  failedListCount: number
  failedItemCount: number
}

const pollMs = 5000
const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '')

function withApiBase(input: string) {
  if (/^https?:\/\//i.test(input)) return input
  return `${apiBaseUrl}${input}`
}

async function requestJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(withApiBase(input), {
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
    ...init,
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(errorText || `Request failed with status ${response.status}`)
  }

  if (response.status === 204) {
    return undefined as T
  }

  return response.json() as Promise<T>
}

function formatUtc(value: string | null) {
  if (!value) return 'Never'
  return new Date(value).toLocaleString()
}

function syncStatusLabel(status: SyncStatus) {
  switch (status) {
    case 'Synced':
      return 'Up to date'
    case 'PendingDelete':
      return 'Marked for removal'
    case 'Failed':
      return 'Sync issue'
    default:
      return 'Needs sync'
  }
}

function syncRunLabel(status: SyncRunStatus) {
  switch (status) {
    case 'Succeeded':
      return 'Completed'
    case 'PartialSuccess':
      return 'Completed with issues'
    case 'Running':
      return 'In progress'
    case 'Failed':
      return 'Sync issue'
  }
}

function syncSourceLabel(triggerType: SyncTriggerType) {
  return triggerType === 'Hangfire' ? 'Scheduled' : 'Manual'
}

function statusTone(status: SyncStatus) {
  switch (status) {
    case 'Synced':
      return 'good'
    case 'Failed':
      return 'bad'
    default:
      return 'warn'
  }
}

function runTone(status: SyncRunStatus | null | undefined) {
  switch (status) {
    case 'Succeeded':
      return 'good'
    case 'Failed':
      return 'bad'
    case 'PartialSuccess':
      return 'warn'
    case 'Running':
      return 'info'
    default:
      return 'neutral'
  }
}

function summarizeMessage(message: string | null, entity: 'run' | 'list' | 'item') {
  if (!message) return null

  const normalized = message.toLowerCase()

  if (normalized.includes('an item with the same key has already been added')) {
    return 'Duplicate linked records need review before sync can finish.'
  }

  if (normalized.includes('failed to update todo list')) {
    return entity === 'run'
      ? 'One or more lists could not be updated in the external system.'
      : 'Could not update this list in the external system.'
  }

  if (normalized.includes('failed to update todo item')) {
    return entity === 'run'
      ? 'One or more items could not be updated in the external system.'
      : 'Could not update this item in the external system.'
  }

  if (normalized.includes('failed to create todo list')) {
    return entity === 'run'
      ? 'One or more lists could not be created in the external system.'
      : 'Could not create this list in the external system.'
  }

  if (normalized.includes('failed to delete todo list')) {
    return entity === 'run'
      ? 'One or more lists could not be removed in the external system.'
      : 'Could not remove this list in the external system.'
  }

  if (normalized.includes('failed to delete todo item')) {
    return entity === 'run'
      ? 'One or more items could not be removed in the external system.'
      : 'Could not remove this item in the external system.'
  }

  return message.replace(/\s*Status:\s*\d+\.\s*Body:\s*/gi, '. ').trim()
}

function presentLoadError(message: string | null) {
  if (!message) return null

  if (message.includes('<!DOCTYPE html>')) {
    return 'The API returned an unexpected response. Check the backend logs.'
  }

  if (message.startsWith('Request failed with status')) {
    return 'Could not load the latest data.'
  }

  return summarizeMessage(message, 'run') ?? message
}

function App() {
  const [lists, setLists] = useState<TodoList[]>([])
  const [syncStatus, setSyncStatus] = useState<SyncStatusResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [newListName, setNewListName] = useState('')
  const [newItemTextByList, setNewItemTextByList] = useState<Record<number, string>>({})
  const [editingListId, setEditingListId] = useState<number | null>(null)
  const [editingListName, setEditingListName] = useState('')
  const [editingItemId, setEditingItemId] = useState<number | null>(null)
  const [editingItemText, setEditingItemText] = useState('')
  const [savingTarget, setSavingTarget] = useState<string | null>(null)

  const pendingCount = (syncStatus?.pendingListCount ?? 0) + (syncStatus?.pendingItemCount ?? 0)
  const failedCount = (syncStatus?.failedListCount ?? 0) + (syncStatus?.failedItemCount ?? 0)
  const activeListCount = lists.filter((list) => !list.isDeleted).length
  const activeItemCount = lists.reduce((count, list) => {
    const liveItems = list.items.filter((item) => !item.isDeleted).length
    return count + liveItems
  }, 0)

  async function loadData() {
    try {
      const [listsResponse, syncResponse] = await Promise.all([
        requestJson<TodoList[]>('/api/todolists?includeDeleted=true'),
        requestJson<SyncStatusResponse>('/api/sync/status'),
      ])

      setLists(listsResponse)
      setSyncStatus(syncResponse)
      setError(null)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load data.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadData()
    const timer = window.setInterval(() => {
      void loadData()
    }, pollMs)

    return () => window.clearInterval(timer)
  }, [])



  function beginListEdit(todoList: TodoList) {
    setEditingItemId(null)
    setEditingItemText('')
    setEditingListId(todoList.id)
    setEditingListName(todoList.name)
  }

  function beginItemEdit(item: TodoItem) {
    setEditingListId(null)
    setEditingListName('')
    setEditingItemId(item.id)
    setEditingItemText(item.text)
  }

  function cancelListEdit() {
    setEditingListId(null)
    setEditingListName('')
  }

  function cancelItemEdit() {
    setEditingItemId(null)
    setEditingItemText('')
  }

  async function createList(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const trimmed = newListName.trim()
    if (!trimmed) return

    await requestJson<TodoList>('/api/todolists', {
      method: 'POST',
      body: JSON.stringify({ name: trimmed }),
    })

    setNewListName('')
    await loadData()
  }

  async function saveList(todoList: TodoList) {
    const trimmed = editingListName.trim()
    if (!trimmed) return

    try {
      setSavingTarget(`list-${todoList.id}`)
      await requestJson<TodoList>(`/api/todolists/${todoList.id}`, {
        method: 'PUT',
        body: JSON.stringify({ name: trimmed, isDeleted: todoList.isDeleted }),
      })

      cancelListEdit()
      await loadData()
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save the list.')
    } finally {
      setSavingTarget(null)
    }
  }

  async function createItem(todoListId: number) {
    const trimmed = newItemTextByList[todoListId]?.trim()
    if (!trimmed) return

    await requestJson<TodoItem>('/api/TodoItem', {
      method: 'POST',
      body: JSON.stringify({ text: trimmed, todoListId }),
    })

    setNewItemTextByList((current) => ({ ...current, [todoListId]: '' }))
    await loadData()
  }

  async function saveItem(item: TodoItem) {
    const trimmed = editingItemText.trim()
    if (!trimmed) return

    try {
      setSavingTarget(`item-${item.id}`)
      await requestJson<TodoItem>(`/api/TodoItem/${item.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          text: trimmed,
          isCompleted: item.isCompleted,
          isDeleted: item.isDeleted,
        }),
      })

      cancelItemEdit()
      await loadData()
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save the item.')
    } finally {
      setSavingTarget(null)
    }
  }

  async function toggleItem(item: TodoItem) {
    await requestJson<TodoItem>(`/api/TodoItem/${item.id}`, {
      method: 'PUT',
      body: JSON.stringify({
        text: item.text,
        isCompleted: !item.isCompleted,
        isDeleted: item.isDeleted,
      }),
    })

    await loadData()
  }

  async function deleteItem(item: TodoItem) {
    await requestJson<void>(`/api/TodoItem/${item.id}`, { method: 'DELETE' })
    if (editingItemId === item.id) {
      cancelItemEdit()
    }
    await loadData()
  }

  async function deleteList(todoListId: number) {
    await requestJson<void>(`/api/todolists/${todoListId}`, { method: 'DELETE' })
    if (editingListId === todoListId) {
      cancelListEdit()
    }
    await loadData()
  }

  async function completeAll(todoListId: number) {
    await requestJson(`/api/todolists/${todoListId}/complete-all`, { method: 'POST' })
    await loadData()
  }

  async function runSync() {
    try {
      setSyncing(true)
      await requestJson<SyncRun>('/api/sync/run', { method: 'POST' })
      await loadData()
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : 'Unable to run sync.')
    } finally {
      setSyncing(false)
    }
  }

  function handleListKeyDown(event: KeyboardEvent<HTMLInputElement>, todoList: TodoList) {
    if (event.key === 'Enter') {
      event.preventDefault()
      void saveList(todoList)
    }

    if (event.key === 'Escape') {
      event.preventDefault()
      cancelListEdit()
    }
  }

  function handleItemKeyDown(event: KeyboardEvent<HTMLInputElement>, item: TodoItem) {
    if (event.key === 'Enter') {
      event.preventDefault()
      void saveItem(item)
    }

    if (event.key === 'Escape') {
      event.preventDefault()
      cancelItemEdit()
    }
  }

  return (
    <main className="page-shell">
      <header className="topbar">
        <div className="topbar-copy">
          <p className="section-label">Tasks</p>
          <h1>Task lists</h1>
          <p className="subtle-copy">Review changes and sync issues across active lists.</p>
        </div>

        <div className="topbar-actions">
          <button className="primary-button" onClick={() => void runSync()} disabled={syncing}>
            {syncing ? 'Syncing...' : 'Sync'}
          </button>
          <button className="ghost-button toolbar-button" onClick={() => void loadData()}>
            Refresh data
          </button>
        </div>
      </header>

      {error ? <section className="error-banner">{presentLoadError(error)}</section> : null}

      <section className="summary-grid">
        <article className="summary-card">
          <div className="summary-card-top">
            <div>
              <p className="section-label">Latest sync</p>
              <h2>{syncStatus?.lastRun ? syncRunLabel(syncStatus.lastRun.status) : 'No activity yet'}</h2>
            </div>
            {syncStatus?.lastRun ? (
              <span className={`status-pill ${runTone(syncStatus.lastRun.status)}`}>
                {syncRunLabel(syncStatus.lastRun.status)}
              </span>
            ) : null}
          </div>

          <dl className="summary-meta-grid">
            <div>
              <dt>Source</dt>
              <dd>{syncStatus?.lastRun ? syncSourceLabel(syncStatus.lastRun.triggeredBy) : 'N/A'}</dd>
            </div>
            <div>
              <dt>Started</dt>
              <dd>{formatUtc(syncStatus?.lastRun?.startedAtUtc ?? null)}</dd>
            </div>
            <div>
              <dt>Finished</dt>
              <dd>{formatUtc(syncStatus?.lastRun?.finishedAtUtc ?? null)}</dd>
            </div>
            <div>
              <dt>Changes</dt>
              <dd>
                {syncStatus?.lastRun
                  ? `${syncStatus.lastRun.createdCount} created, ${syncStatus.lastRun.updatedCount} updated`
                  : 'No changes yet'}
              </dd>
            </div>
          </dl>

          <p className={`inline-note ${syncStatus?.lastRun?.errorSummary ? 'inline-note-bad' : 'inline-note-muted'}`}>
            {syncStatus?.lastRun?.errorSummary
              ? summarizeMessage(syncStatus.lastRun.errorSummary, 'run')
              : `Auto-refresh runs every ${pollMs / 1000} seconds.`}
          </p>
        </article>

        <article className="summary-card summary-card-attention">
          <p className="section-label">Needs attention</p>
          <h2>{pendingCount + failedCount}</h2>
          <div className="attention-list">
            <div className="attention-row">
              <span>Waiting to sync</span>
              <strong>{pendingCount}</strong>
            </div>
            <div className="attention-row">
              <span>With issues</span>
              <strong>{failedCount}</strong>
            </div>
          </div>
          <p className="inline-note inline-note-muted">
            {pendingCount + failedCount === 0 ? 'Everything is up to date.' : 'Focus on failed records first, then clear pending work.'}
          </p>
        </article>
      </section>

      <section className="overview-strip">
        <div className="overview-item">
          <span className="section-label">Lists</span>
          <strong>{activeListCount}</strong>
        </div>
        <div className="overview-item">
          <span className="section-label">Items</span>
          <strong>{activeItemCount}</strong>
        </div>
        <div className="overview-item">
          <span className="section-label">Refresh</span>
          <strong>Every {pollMs / 1000}s</strong>
        </div>
      </section>

      <section className="composer-panel">
        <form className="create-form" autoComplete="off" onSubmit={(event) => void createList(event)}>
          <label htmlFor="new-list">New list</label>
          <div className="input-row">
            <input
              id="new-list"
              name="new-list"
              autoComplete="off"
              value={newListName}
              onChange={(event) => setNewListName(event.target.value)}
              placeholder="Quarterly planning"
            />
            <button className="success-button" type="submit">
              Create list
            </button>
          </div>
        </form>
      </section>

      <section className="lists-grid">
        {loading ? <p className="empty-state">Loading lists...</p> : null}
        {!loading && lists.length === 0 ? <p className="empty-state">No lists yet.</p> : null}
        {lists.map((todoList) => {
          const isEditingList = editingListId === todoList.id
          const isSavingList = savingTarget === `list-${todoList.id}`

          return (
            <article key={todoList.id} className={`list-card ${todoList.isDeleted ? 'is-deleted' : ''}`}>
              <header className="list-header">
                <div className="list-header-main">
                  <div className="list-title-row">
                    {isEditingList ? (
                      <div className="inline-edit-row inline-edit-row-list">
                        <input
                          value={editingListName}
                          onChange={(event) => setEditingListName(event.target.value)}
                          onKeyDown={(event) => handleListKeyDown(event, todoList)}
                          autoFocus
                        />
                        <div className="inline-edit-actions">
                          <button className="primary-button inline-action-button" onClick={() => void saveList(todoList)} disabled={isSavingList}>
                            {isSavingList ? 'Saving...' : 'Save'}
                          </button>
                          <button className="ghost-button inline-action-button" onClick={cancelListEdit} disabled={isSavingList}>
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <button
                          className="editable-trigger editable-trigger-title"
                          onClick={() => beginListEdit(todoList)}
                          disabled={todoList.isDeleted}
                        >
                          {todoList.name}
                        </button>
                        <span className={`status-pill ${statusTone(todoList.sync.syncStatus)}`}>
                          {syncStatusLabel(todoList.sync.syncStatus)}
                        </span>
                      </>
                    )}
                  </div>
                  <div className="list-meta-row">
                    <span>List ID {todoList.id}</span>
                    <span>{todoList.sync.externalId ? `Linked #${todoList.sync.externalId}` : 'Not linked yet'}</span>
                  </div>
                </div>

                <div className="card-actions list-actions">
                  <button className="success-button" onClick={() => void completeAll(todoList.id)} disabled={todoList.isDeleted || isEditingList}>
                    Complete all
                  </button>
                  <button className="danger-button" onClick={() => void deleteList(todoList.id)} disabled={isEditingList || todoList.isDeleted}>
                    Delete list
                  </button>
                </div>
              </header>

              <dl className="sync-detail-grid">
                <div>
                  <dt>Updated</dt>
                  <dd>{formatUtc(todoList.sync.lastModifiedAtUtc)}</dd>
                </div>
                <div>
                  <dt>Last sync</dt>
                  <dd>{formatUtc(todoList.sync.lastSyncedAtUtc)}</dd>
                </div>
              </dl>

              {todoList.sync.lastSyncError ? (
                <p className="inline-note inline-note-bad">{summarizeMessage(todoList.sync.lastSyncError, 'list')}</p>
              ) : null}

              <div className="item-stack">
                {todoList.items.map((item) => {
                  const isEditingItem = editingItemId === item.id
                  const isSavingItem = savingTarget === `item-${item.id}`

                  return (
                    <div key={item.id} className={`item-row ${item.isDeleted ? 'is-deleted' : ''}`}>
                      <div className="item-main">
                        <input
                          type="checkbox"
                          checked={item.isCompleted}
                          disabled={item.isDeleted || isEditingItem}
                          onChange={() => void toggleItem(item)}
                        />
                        {isEditingItem ? (
                          <div className="inline-edit-row inline-edit-row-item">
                            <input
                              value={editingItemText}
                              onChange={(event) => setEditingItemText(event.target.value)}
                              onKeyDown={(event) => handleItemKeyDown(event, item)}
                              autoFocus
                            />
                            <div className="inline-edit-actions">
                              <button className="primary-button inline-action-button" onClick={() => void saveItem(item)} disabled={isSavingItem}>
                                {isSavingItem ? 'Saving...' : 'Save'}
                              </button>
                              <button className="ghost-button inline-action-button" onClick={cancelItemEdit} disabled={isSavingItem}>
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <button
                            className={`editable-trigger editable-trigger-item ${item.isCompleted ? 'is-complete' : ''}`}
                            onClick={() => beginItemEdit(item)}
                            disabled={item.isDeleted}
                          >
                            {item.text}
                          </button>
                        )}
                      </div>
                      <div className="item-meta item-actions">
                        <span className={`status-pill ${statusTone(item.sync.syncStatus)}`}>
                          {syncStatusLabel(item.sync.syncStatus)}
                        </span>
                        <button className="ghost-button" onClick={() => void deleteItem(item)} disabled={isEditingItem || item.isDeleted}>
                          Delete
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>

              <div className="input-row compact-row">
                <input
                  name={`new-item-${todoList.id}`}
                  autoComplete="off"
                  value={newItemTextByList[todoList.id] ?? ''}
                  onChange={(event) =>
                    setNewItemTextByList((current) => ({
                      ...current,
                      [todoList.id]: event.target.value,
                    }))
                  }
                  placeholder="Add item"
                  disabled={todoList.isDeleted || isEditingList}
                />
                <button className="success-button" onClick={() => void createItem(todoList.id)} disabled={todoList.isDeleted || isEditingList}>
                  Add item
                </button>
              </div>
            </article>
          )
        })}
      </section>
    </main>
  )
}

export default App





