import {
  getPendingRecords,
  getPendingSummary,
  getSyncCursor,
  isLogRecord,
  markRecordsSynced,
  mergePulledRecords,
  setSyncCursor,
  type LogRecord,
} from './db'

const TOKEN_KEY = 'personal-work-log-sync-token'
const SYNC_INTERVAL = 3 * 60_000
const MAX_BACKOFF = 5 * 60_000

export type SyncState = 'not-configured' | 'synced' | 'pending' | 'offline' | 'error'

export interface SyncSnapshot {
  state: SyncState
  pendingCount: number
  hasLongPending: boolean
}

interface RemoteRecord {
  record: LogRecord
  serverUpdatedAt: number
}

let snapshot: SyncSnapshot = { state: 'not-configured', pendingCount: 0, hasLongPending: false }
let lastError = false
let running = false
let runAgain = false
let attempts = 0
let debounceTimer: number | undefined
let retryTimer: number | undefined
let intervalTimer: number | undefined
let lifecycleStarted = false
const listeners = new Set<(value: SyncSnapshot) => void>()

export function getSyncToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? ''
}

export function saveSyncToken(token: string): void {
  const value = token.trim()
  if (value) localStorage.setItem(TOKEN_KEY, value)
  else localStorage.removeItem(TOKEN_KEY)
  lastError = false
  attempts = 0
  if (retryTimer !== undefined) window.clearTimeout(retryTimer)
  retryTimer = undefined
  void refreshSnapshot()
  scheduleSync(0)
}

export function subscribeToSyncStatus(listener: (value: SyncSnapshot) => void): () => void {
  listeners.add(listener)
  listener(snapshot)
  void refreshSnapshot()
  return () => listeners.delete(listener)
}

function emit(value: SyncSnapshot): void {
  snapshot = value
  for (const listener of listeners) listener(value)
}

async function refreshSnapshot(): Promise<void> {
  try {
    const token = getSyncToken()
    const { count, oldestPendingSince } = await getPendingSummary()
    const state: SyncState = !token
      ? 'not-configured'
      : !navigator.onLine
        ? 'offline'
        : lastError
          ? 'error'
          : count
            ? 'pending'
            : 'synced'
    emit({
      state,
      pendingCount: count,
      hasLongPending: Boolean(token && oldestPendingSince !== undefined && Date.now() - oldestPendingSince > 6 * 60 * 60_000),
    })
  } catch {
    lastError = true
    emit({ state: 'error', pendingCount: snapshot.pendingCount, hasLongPending: false })
  }
}

function scheduleSync(delay = 500): void {
  void refreshSnapshot()
  let token: string
  try {
    token = getSyncToken()
  } catch {
    lastError = true
    void refreshSnapshot()
    return
  }
  if (!token || !navigator.onLine || retryTimer !== undefined) return
  if (running) {
    runAgain = true
    return
  }
  if (debounceTimer !== undefined) window.clearTimeout(debounceTimer)
  debounceTimer = window.setTimeout(() => {
    debounceTimer = undefined
    void syncNow()
  }, delay)
}

export function localWriteCompleted(): void {
  scheduleSync()
}

async function authorizedFetch(path: string, token: string, init?: RequestInit): Promise<Response> {
  let response: Response
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), 30_000)
  try {
    response = await fetch(path, {
      ...init,
      signal: controller.signal,
      headers: {
        ...init?.headers,
        Authorization: `Bearer ${token}`,
      },
    })
  } catch {
    throw new Error('Could not reach the sync server.')
  } finally {
    window.clearTimeout(timeout)
  }
  if (response.status === 401) throw new Error('Sync authorization failed. Check the token.')
  if (!response.ok) throw new Error(`Sync server error (${response.status}).`)
  return response
}

function getRemoteRecord(value: unknown): RemoteRecord {
  if (!value || typeof value !== 'object') throw new Error('Invalid sync response.')
  const row = value as Record<string, unknown>
  const serverUpdatedAt = row.serverUpdatedAt
  const rawRecord = row.kind === 'entry'
    ? {
        id: row.id,
        kind: row.kind,
        date: row.date,
        startAt: row.startAt,
        endAt: row.endAt,
        type: row.type,
        withWho: typeof row.withWho === 'string' ? row.withWho : null,
        forWhat: typeof row.forWhat === 'string' ? row.forWhat : '',
        ...(typeof row.startedAtExact === 'number' ? { startedAtExact: row.startedAtExact } : {}),
        ...(typeof row.endedAtExact === 'number' ? { endedAtExact: row.endedAtExact } : {}),
        createdAt: row.createdAt,
        ...(typeof row.createdAtExact === 'number' ? { createdAtExact: row.createdAtExact } : {}),
        updatedAt: row.updatedAt,
        deleted: row.deleted,
      }
    : {
        id: row.id,
        kind: row.kind,
        occurredAt: row.occurredAt,
        type: row.type,
        createdAt: row.createdAt,
        ...(typeof row.createdAtExact === 'number' ? { createdAtExact: row.createdAtExact } : {}),
        updatedAt: row.updatedAt,
        deleted: row.deleted,
      }
  if (!Number.isSafeInteger(serverUpdatedAt) || !isLogRecord(rawRecord)) {
    throw new Error('Invalid sync response.')
  }
  return {
    record: { ...rawRecord, syncStatus: 'synced' } as LogRecord,
    serverUpdatedAt: serverUpdatedAt as number,
  }
}

async function pushPending(token: string): Promise<void> {
  while (true) {
    const batch = await getPendingRecords(100)
    if (!batch.length) return
    const response = await authorizedFetch('/api/sync', token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries: batch }),
    })
    const payload: unknown = await response.json()
    if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { acceptedIds?: unknown }).acceptedIds)) {
      throw new Error('Invalid sync confirmation.')
    }
    const acceptedIds = (payload as { acceptedIds: unknown[] }).acceptedIds
    if (
      acceptedIds.length !== batch.length ||
      !batch.every((record) => acceptedIds.includes(record.id))
    ) {
      throw new Error('Sync server did not confirm the entire batch.')
    }
    await markRecordsSynced(batch.map(({ id, updatedAt }) => ({ id, updatedAt })))
    void refreshSnapshot()
  }
}

async function pullChanges(token: string): Promise<void> {
  let cursor = await getSyncCursor()
  while (true) {
    const response = await authorizedFetch(`/api/entries?since=${encodeURIComponent(cursor)}`, token)
    const payload: unknown = await response.json()
    if (!payload || typeof payload !== 'object') throw new Error('Invalid sync response.')
    const page = payload as { entries?: unknown; nextCursor?: unknown; hasMore?: unknown }
    if (
      !Array.isArray(page.entries) ||
      typeof page.hasMore !== 'boolean' ||
      !Number.isSafeInteger(page.nextCursor) ||
      (page.nextCursor as number) < Number(cursor)
    ) {
      throw new Error('Invalid sync response.')
    }
    const remoteRecords = page.entries.map(getRemoteRecord)
    if (remoteRecords.length > 500) throw new Error('Sync server returned too many records.')
    await mergePulledRecords(remoteRecords.map(({ record }) => record))
    const nextCursor = String(page.nextCursor)
    if (nextCursor !== cursor) {
      await setSyncCursor(nextCursor)
      cursor = nextCursor
    }
    if (!page.hasMore) return
    if (!remoteRecords.length || nextCursor === '0') throw new Error('Sync pagination did not advance.')
  }
}

export async function syncNow(): Promise<void> {
  if (running) {
    runAgain = true
    return
  }
  let token: string
  try {
    token = getSyncToken()
  } catch {
    lastError = true
    await refreshSnapshot()
    return
  }
  if (!token || !navigator.onLine) {
    await refreshSnapshot()
    return
  }
  running = true
  try {
    await pushPending(token)
    await pullChanges(token)
    await pushPending(token)
    lastError = false
    attempts = 0
  } catch {
    lastError = true
    attempts += 1
    const delay = Math.min(MAX_BACKOFF, 1_000 * (2 ** Math.min(attempts - 1, 8)))
    retryTimer = window.setTimeout(() => {
      retryTimer = undefined
      void syncNow()
    }, delay)
  } finally {
    running = false
    await refreshSnapshot()
    if (runAgain) {
      runAgain = false
      scheduleSync(0)
    }
  }
}

export async function testSyncConnection(token: string): Promise<void> {
  const value = token.trim()
  if (!value) throw new Error('Enter a sync token first.')
  await authorizedFetch(`/api/entries?since=${Number.MAX_SAFE_INTEGER}`, value)
}

export function startSyncLifecycle(): () => void {
  if (!lifecycleStarted) {
    lifecycleStarted = true
    window.addEventListener('online', onNetworkChange)
    window.addEventListener('offline', onNetworkChange)
    document.addEventListener('visibilitychange', onVisibilityChange)
    intervalTimer = window.setInterval(() => scheduleSync(0), SYNC_INTERVAL)
    scheduleSync(0)
  }
  return () => {
    if (!lifecycleStarted) return
    lifecycleStarted = false
    window.removeEventListener('online', onNetworkChange)
    window.removeEventListener('offline', onNetworkChange)
    document.removeEventListener('visibilitychange', onVisibilityChange)
    if (intervalTimer !== undefined) window.clearInterval(intervalTimer)
    if (debounceTimer !== undefined) window.clearTimeout(debounceTimer)
    if (retryTimer !== undefined) window.clearTimeout(retryTimer)
    intervalTimer = undefined
    debounceTimer = undefined
    retryTimer = undefined
  }
}

function onNetworkChange(): void {
  lastError = false
  scheduleSync(0)
}

function onVisibilityChange(): void {
  if (document.visibilityState === 'visible') scheduleSync(0)
}
