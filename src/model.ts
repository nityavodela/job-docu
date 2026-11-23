export const ENTRY_TYPES = [
  'Work',
  'Meeting',
  'Doubts/Queries',
  'Replies',
  'Break',
  'Washroom',
  'Lunch',
] as const
export const EVENT_TYPES = [
  'Clock in',
  'Clock out',
  'Login: Home',
  'Logout: Home',
  'System restart',
  'Connection lost',
  'Reconnected',
] as const

export type EntryType = (typeof ENTRY_TYPES)[number]
export type EventType = (typeof EVENT_TYPES)[number]
export type SyncStatus = 'pending' | 'synced'

export interface BaseRecord {
  id: string
  createdAt: string
  createdAtExact?: number
  updatedAt: string
  deleted: boolean
  syncStatus?: SyncStatus
  syncPendingSince?: number
}

export interface Entry extends BaseRecord {
  kind: 'entry'
  date: string
  startAt: string
  endAt: string | null
  type: EntryType
  withWho: string | null
  forWhat: string
  startedAtExact?: number
  endedAtExact?: number
}

export interface LogEvent extends BaseRecord {
  kind: 'event'
  occurredAt: string
  type: EventType
}

export type LogRecord = Entry | LogEvent
