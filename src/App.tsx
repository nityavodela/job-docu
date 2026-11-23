import { useEffect, useMemo, useRef, useState } from 'react'
import { liveQuery } from 'dexie'
import { addDays, format, parseISO } from 'date-fns'
import {
  ENTRY_TYPES,
  EVENT_TYPES,
  type Entry,
  type EntryType,
  type EventType,
  type LogEvent,
  type LogRecord,
  getRecords,
  makeBackup,
  newId,
  restoreBackup,
  saveRecord,
  softDeleteRecord,
} from './db'
import {
  getSyncToken,
  localWriteCompleted,
  saveSyncToken,
  startSyncLifecycle,
  subscribeToSyncStatus,
  testSyncConnection,
  type SyncSnapshot,
} from './sync'
import { getLocalNames, getNameOptions, rememberName, splitNames } from './names'
import { calculateDayTotals } from './totals'

const TIME_ZONE = 'Asia/Kolkata'
const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})
const timeFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

function dateInIndia(value: Date): string {
  const parts = dayFormatter.formatToParts(value)
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')}`
}

function timeInIndia(value: Date | string): string {
  return timeFormatter.format(typeof value === 'string' ? new Date(value) : value)
}

function indiaTimeToIso(date: string, time: string): string {
  const [year, month, day] = date.split('-').map(Number)
  const [hour, minute] = time.split(':').map(Number)
  return new Date(Date.UTC(year, month - 1, day, hour, minute) - 330 * 60_000).toISOString()
}

function currentMinute(): Date {
  const now = new Date()
  now.setSeconds(0, 0)
  return now
}

function clockMinute(value: number): number {
  return Math.floor(value / 60_000) * 60_000
}

function dayRange(date: string): [number, number] {
  const nextDate = format(addDays(parseISO(date), 1), 'yyyy-MM-dd')
  return [
    Date.parse(indiaTimeToIso(date, '00:00')),
    Date.parse(indiaTimeToIso(nextDate, '00:00')),
  ]
}

function durationLabel(milliseconds: number): string {
  const minutes = Math.max(0, Math.floor(milliseconds / 60_000))
  const hours = Math.floor(minutes / 60)
  const remaining = minutes % 60
  return hours ? `${hours}h ${remaining}m` : `${remaining}m`
}

function minutesLabel(minutes: number): string {
  return durationLabel(minutes * 60_000)
}

function entryTypeLabel(type: EntryType): string {
  return type === 'Doubts/Queries' ? 'Doubts / Queries' : type
}

function entryMarkClass(type: EntryType): string {
  return `mark-${type.toLowerCase().replace('/', '-')}`
}

function eventDate(event: LogEvent): string {
  return dateInIndia(new Date(event.occurredAt))
}

function entryDuration(entry: Entry, now: number): number {
  const start = clockMinute(Date.parse(entry.startAt))
  const end = entry.endAt ? clockMinute(Date.parse(entry.endAt)) : clockMinute(now)
  return Math.max(0, end - start)
}

function formatDurationForDisplay(entry: Entry, now: number): string {
  const start = clockMinute(Date.parse(entry.startAt))
  const end = entry.endAt ? clockMinute(Date.parse(entry.endAt)) : clockMinute(now)
  if (start === end) return '<1m'
  return durationLabel(Math.max(0, end - start))
}

function exactDurationSeconds(entry: Entry, now: number): number | undefined {
  if (entry.startedAtExact === undefined) return undefined
  const end = entry.endedAtExact ?? (entry.endAt === null ? now : undefined)
  return end === undefined ? undefined : Math.floor(Math.max(0, end - entry.startedAtExact) / 1000)
}

function formatDay(date: string): string {
  return format(parseISO(date), 'EEEE, d MMMM yyyy')
}

function App() {
  const [records, setRecords] = useState<LogRecord[] | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [selectedDate, setSelectedDate] = useState(() => dateInIndia(new Date()))
  const [now, setNow] = useState(() => currentMinute().getTime())
  const [editor, setEditor] = useState<{ entry?: Entry; endOnly?: boolean } | null>(null)
  const [storageStatus, setStorageStatus] = useState('Checking…')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [darkMode, setDarkMode] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [actionPanel, setActionPanel] = useState<'start' | 'events' | null>(null)
  const [startType, setStartType] = useState<EntryType>('Work')
  const [startNames, setStartNames] = useState<string[]>([])
  const [startForWhat, setStartForWhat] = useState('')
  const [localNames, setLocalNames] = useState<string[]>(getLocalNames)
  const [syncSnapshot, setSyncSnapshot] = useState<SyncSnapshot>({
    state: 'not-configured',
    pendingCount: 0,
    hasLongPending: false,
  })

  useEffect(() => {
    const subscription = liveQuery(() => getRecords()).subscribe({
      next: (loadedRecords) => {
        setRecords(loadedRecords)
        setLoadFailed(false)
      },
      error: (cause: unknown) => {
        setLoadFailed(true)
        setError(`Could not load saved data: ${String(cause)}`)
      },
    })
    let timer: number
    const refreshAtNextMinute = () => {
      setNow(currentMinute().getTime())
      timer = window.setTimeout(
        refreshAtNextMinute,
        60_000 - (Date.now() % 60_000),
      )
    }
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') {
        window.clearTimeout(timer)
        refreshAtNextMinute()
      }
    }
    refreshAtNextMinute()
    document.addEventListener('visibilitychange', refreshWhenVisible)
    void navigator.storage?.persist?.().then((granted) => {
      setStorageStatus(granted ? 'Persistent storage enabled' : 'Storage may be cleared by your browser')
    }).catch((cause: unknown) => {
      setStorageStatus('Persistent storage unavailable')
      setError(`Could not request persistent storage: ${String(cause)}`)
    })
    if (!navigator.storage?.persist) setStorageStatus('Persistent storage unavailable')
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
      subscription.unsubscribe()
    }
  }, [])

  useEffect(() => {
    const unsubscribe = subscribeToSyncStatus(setSyncSnapshot)
    const stopLifecycle = startSyncLifecycle()
    return () => {
      unsubscribe()
      stopLifecycle()
    }
  }, [])

  const [dayStart, dayEnd] = dayRange(selectedDate)
  const todayDate = dateInIndia(new Date(now))
  const isToday = selectedDate === todayDate
  const isPast = selectedDate < todayDate
  const isFuture = selectedDate > todayDate
  const previousToday = useRef(todayDate)
  useEffect(() => {
    if (previousToday.current === todayDate) return
    const oldToday = previousToday.current
    previousToday.current = todayDate
    if (selectedDate === oldToday) {
      setSelectedDate(todayDate)
      setEditor(null)
      setActionPanel(null)
    }
  }, [selectedDate, todayDate])
  const loadedRecords = records ?? []
  const dayRecords = useMemo(() => loadedRecords.filter((record) => {
    if (record.deleted) return false
    if (record.kind === 'event') return eventDate(record) === selectedDate
    if (record.endAt === null && selectedDate === todayDate && record.date <= todayDate) return true
    const start = clockMinute(Date.parse(record.startAt))
    const end = record.endAt ? clockMinute(Date.parse(record.endAt)) : clockMinute(now)
    return start < dayEnd && end > dayStart
  }), [loadedRecords, selectedDate, dayStart, dayEnd, now, todayDate])

  const entries = dayRecords.filter((record): record is Entry => record.kind === 'entry')
  const events = dayRecords.filter((record): record is LogEvent => record.kind === 'event')
  const nameOptions = useMemo(
    () => getNameOptions(loadedRecords, localNames),
    [loadedRecords, localNames],
  )
  const createdAtExact = (record: LogRecord) => {
    if (record.createdAtExact !== undefined) return record.createdAtExact
    const exactStart = record.kind === 'entry' ? record.startedAtExact : undefined
    const updatedAt = Date.parse(record.updatedAt)
    return exactStart ?? (Number.isFinite(updatedAt) ? updatedAt : 0)
  }
  const sortedRecords = [...dayRecords].sort((a, b) => {
    const aTime = a.kind === 'entry' ? a.startAt : a.occurredAt
    const bTime = b.kind === 'entry' ? b.startAt : b.occurredAt
    return Date.parse(bTime) - Date.parse(aTime) ||
      createdAtExact(b) - createdAtExact(a) ||
      b.id.localeCompare(a.id)
  })
  const timeOrderedRecords = [...sortedRecords].reverse()
  const runningEntries = isToday
    ? sortedRecords.filter((record): record is Entry =>
      record.kind === 'entry' && record.endAt === null && record.date === todayDate)
    : []
  const leftRunningEntries = isToday
    ? sortedRecords.filter((record): record is Entry =>
      record.kind === 'entry' && record.endAt === null && record.date < todayDate)
    : []
  const dailyListRecords = sortedRecords.filter((record) => record.kind !== 'entry' || record.endAt !== null)
  const totals = calculateDayTotals(entries, dayStart, dayEnd, now)
  const reportItems = dayRecords.map((record) => {
    if (record.kind === 'event') {
      return { record, start: Date.parse(record.occurredAt), end: undefined as number | undefined, duration: '' }
    }
    const start = Math.max(dayStart, clockMinute(Date.parse(record.startAt)))
    const end = Math.min(
      dayEnd,
      clockMinute(record.endAt ? Date.parse(record.endAt) : now),
    )
    const duration = end === start ? '<1m' : minutesLabel(Math.max(0, end - start) / 60_000)
    return { record, start, end, duration }
  }).sort((left, right) => left.start - right.start ||
    createdAtExact(left.record) - createdAtExact(right.record) ||
    left.record.id.localeCompare(right.record.id))

  const clockIn = events.filter((event) => event.type === 'Clock in')
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))[0]
  const clockOut = events.filter((event) => event.type === 'Clock out')
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))[0]
  const restartCount = events.filter((event) => event.type === 'System restart').length
  const dropCount = events.filter((event) => event.type === 'Connection lost').length

  function addLocalName(rawName: string): string {
    const name = rememberName(rawName, nameOptions)
    setLocalNames((current) => [...current, name])
    return name
  }

  async function persist(record: LogRecord, message = '') {
    try {
      await saveRecord(record)
      localWriteCompleted()
      setError('')
      setNotice(message)
      if (message) window.setTimeout(() => setNotice(''), 2500)
    } catch (cause) {
      setError(`Could not save your change: ${String(cause)}`)
    }
  }

  function startEntry(type: EntryType, details: { withWho: string | null; forWhat: string } = { withWho: null, forWhat: '' }) {
    const startedAtExact = Date.now()
    const stamp = new Date(startedAtExact)
    stamp.setSeconds(0, 0)
    const iso = stamp.toISOString()
    void persist({
      id: newId(),
      kind: 'entry',
      createdAtExact: startedAtExact,
      date: dateInIndia(stamp),
      startAt: iso,
      endAt: null,
      type,
      withWho: details.withWho,
      forWhat: details.forWhat,
      startedAtExact,
      createdAt: iso,
      updatedAt: iso,
      deleted: false,
    }, `${type} started`)
  }

  function addEvent(type: EventType) {
    const createdAtExact = Date.now()
    const stamp = new Date(createdAtExact)
    stamp.setSeconds(0, 0)
    const iso = stamp.toISOString()
    const event: LogEvent = {
      id: newId(),
      kind: 'event',
      createdAtExact,
      occurredAt: iso,
      type,
      createdAt: iso,
      updatedAt: iso,
      deleted: false,
    }
    void persist(event, `${type} logged`)
    setActionPanel(null)
  }

  function stopEntry(entry: Entry) {
    const endedAtExact = Date.now()
    const stamp = new Date(endedAtExact)
    stamp.setSeconds(0, 0)
    void persist({ ...entry, endAt: stamp.toISOString(), endedAtExact, updatedAt: stamp.toISOString() }, `${entry.type} stopped`)
  }

  function stopAll() {
    const running = runningEntries
    if (!running.length) return
    const endedAtExact = Date.now()
    const stamp = new Date(endedAtExact)
    stamp.setSeconds(0, 0)
    const iso = stamp.toISOString()
    void Promise.all(running.map((entry) => saveRecord({ ...entry, endAt: iso, endedAtExact, updatedAt: iso })))
      .then(() => {
        localWriteCompleted()
        setError('')
        setNotice(`${running.length} running ${running.length === 1 ? 'entry' : 'entries'} stopped`)
      })
      .catch((cause: unknown) => setError(`Could not stop all entries: ${String(cause)}`))
  }

  function stopAtEndOfStartDay(entry: Entry) {
    const endAt = new Date(dayRange(entry.date)[1] - 60_000)
    const iso = endAt.toISOString()
    const entryWithoutExactTimes = { ...entry }
    delete entryWithoutExactTimes.startedAtExact
    delete entryWithoutExactTimes.endedAtExact
    void persist({
      ...entryWithoutExactTimes,
      endAt: iso,
      updatedAt: new Date().toISOString(),
    }, `${entry.type} stopped at 23:59 on ${entry.date}`)
  }

  async function handleSaveEntry(data: Omit<Entry, 'id' | 'kind' | 'createdAt' | 'updatedAt' | 'deleted'>, previous?: Entry) {
    const stamp = currentMinute().toISOString()
    const previousCreatedAtExact = previous?.createdAtExact
      ?? previous?.startedAtExact
      ?? (previous ? Date.parse(previous.updatedAt) : undefined)
    const entry: Entry = {
      ...data,
      id: previous?.id ?? newId(),
      kind: 'entry',
      createdAtExact: previous
        ? (Number.isFinite(previousCreatedAtExact) ? previousCreatedAtExact : Date.now())
        : Date.now(),
      createdAt: previous?.createdAt ?? stamp,
      updatedAt: stamp,
      deleted: false,
    }
    await persist(entry, previous ? 'Entry updated' : 'Past entry added')
    setEditor(null)
  }

  async function handleDeleteEntry(entry: Entry) {
    try {
      await softDeleteRecord(entry)
      localWriteCompleted()
      setEditor(null)
      setError('')
    } catch (cause) {
      setError(`Could not delete the entry: ${String(cause)}`)
    }
  }

  async function copyForExcel() {
    const rows = [
      ['Date', 'Start', 'End', 'Type', 'With who', 'For what', 'Minutes', 'Seconds'],
      ...timeOrderedRecords.map((record) => record.kind === 'entry'
        ? [
            record.date,
            timeInIndia(record.startAt),
            record.endAt ? timeInIndia(record.endAt) : 'Running',
            entryTypeLabel(record.type),
            record.withWho ?? '',
            record.forWhat,
            String(Math.floor(entryDuration(record, now) / 60_000)),
            record.startedAtExact !== undefined && record.endedAtExact !== undefined
              ? String((record.endedAtExact - record.startedAtExact) / 1000)
              : '',
          ]
        : [selectedDate, timeInIndia(record.occurredAt), '', record.type, '', '', '', '']),
    ]
    try {
      await navigator.clipboard.writeText(rows.map((row) => row.map((field) => field.replace(/[\t\r\n]/g, ' ')).join('\t')).join('\n'))
      setNotice('Copied for Excel')
      window.setTimeout(() => setNotice(''), 2500)
    } catch (cause) {
      setError(`Could not copy to clipboard: ${String(cause)}`)
    }
  }

  async function copyReport() {
    const typeLines = ENTRY_TYPES
      .map((type) => `${entryTypeLabel(type)}: ${minutesLabel(totals.byType[type])}`)
    const lines = [
      `Work log — ${formatDay(selectedDate)}`,
      `Clock in: ${clockIn ? timeInIndia(clockIn.occurredAt) : '—'}`,
      `Clock out: ${clockOut ? timeInIndia(clockOut.occurredAt) : '—'}`,
      `Total time: ${minutesLabel(totals.totalMinutes)}`,
      `Break time: ${minutesLabel(totals.breakMinutes)}`,
      `Restarts: ${restartCount}`,
      `Connection drops: ${dropCount}`,
      '',
      'Per-type totals',
      ...typeLines,
      '',
      'Timeline',
      ...reportItems.map(({ record, start, end, duration }) => {
        if (record.kind === 'event') return `${timeInIndia(new Date(start))}  ${record.type}`
        const rangeEnd = end === undefined
          ? ''
          : `–${timeInIndia(new Date(Math.min(end, dayEnd - 60_000)))}`
        const details = [record.withWho, record.forWhat].filter(Boolean).join(' — ')
        return `${timeInIndia(new Date(start))}${rangeEnd}  ${duration}  ${entryTypeLabel(record.type)}${details ? `  ${details}` : ''}`
      }),
    ]
    try {
      await navigator.clipboard.writeText(lines.join('\n'))
      setNotice('Report copied')
      window.setTimeout(() => setNotice(''), 2500)
    } catch (cause) {
      setError(`Could not copy report: ${String(cause)}`)
    }
  }

  async function downloadBackup() {
    try {
      const contents = await makeBackup()
      const url = URL.createObjectURL(new Blob([contents], { type: 'application/json' }))
      const link = document.createElement('a')
      link.href = url
      link.download = `work-log-${dateInIndia(new Date())}.json`
      link.click()
      URL.revokeObjectURL(url)
      setNotice('Backup downloaded')
      window.setTimeout(() => setNotice(''), 2500)
    } catch (cause) {
      setError(`Could not create backup: ${String(cause)}`)
    }
  }

  async function handleRestore(file?: File) {
    if (!file) return
    try {
      const added = await restoreBackup(await file.text())
      localWriteCompleted()
      setError('')
      setNotice(`Restore complete: ${added} new ${added === 1 ? 'record' : 'records'} added`)
      window.setTimeout(() => setNotice(''), 3500)
    } catch (cause) {
      setError(`Could not restore backup: ${String(cause)}`)
    }
  }

  function moveDay(amount: number) {
    const nextDate = format(addDays(parseISO(selectedDate), amount), 'yyyy-MM-dd')
    if (nextDate > todayDate) return
    setSelectedDate(nextDate)
    setEditor(null)
    setActionPanel(null)
  }

  function startSelectedEntry(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    startEntry(startType, {
      withWho: ['Meeting', 'Doubts/Queries', 'Replies'].includes(startType) ? startNames.join(', ') || null : null,
      forWhat: startForWhat.trim(),
    })
    setStartNames([])
    setStartForWhat('')
    setActionPanel(null)
  }

  return (
    <main className="app-shell" data-theme={darkMode ? 'dark' : 'light'}>
      <header className="topbar">
        <div>
          <p className="eyebrow">PERSONAL · OFFLINE</p>
          <h1>Work log</h1>
        </div>
        {!isFuture && (
          <button className="theme-toggle" onClick={() => setDarkMode((value) => !value)} aria-label="Toggle light and dark mode">
            {darkMode ? '☀ Light' : '☾ Dark'}
          </button>
        )}
      </header>

      {isFuture ? (
        <section className="future-empty" aria-label="Future date unavailable">
          <h2>{formatDay(selectedDate)}</h2>
          <p>Future days are not available.</p>
        </section>
      ) : (
        <>
          <section className="day-picker" aria-label="Choose a day">
            <button className="icon-button" onClick={() => moveDay(-1)} aria-label="Previous day">‹</button>
            <label>
              <span className="day-label">{formatDay(selectedDate)}</span>
              <input
                type="date"
                value={selectedDate}
                max={todayDate}
                onChange={(event) => {
                  if (/^\d{4}-\d{2}-\d{2}$/.test(event.target.value) && event.target.value <= todayDate) {
                    setSelectedDate(event.target.value)
                    setEditor(null)
                    setActionPanel(null)
                  }
                }}
              />
            </label>
            <button className="icon-button" onClick={() => moveDay(1)} aria-label="Next day" disabled={isToday}>›</button>
          </section>

          {isPast ? (
            <section className="report-view" aria-label="Daily report">
              <div className="report-heading">
                <div><p className="eyebrow">READ-ONLY REPORT</p><h2>{formatDay(selectedDate)}</h2></div>
                {records !== null && <div className="report-actions">
                  <button className="secondary-button" onClick={() => void copyReport()}>Copy report</button>
                  <button className="secondary-button" onClick={() => void copyForExcel()}>Copy for Excel</button>
                </div>}
              </div>
              {records === null ? (
                <div className="loading-state" role="status">{loadFailed ? 'Saved entries could not be loaded.' : 'Loading saved entries…'}</div>
              ) : (
                <>
              <section className="report-summary" aria-label="Daily summary">
                <div><span>Clock in</span><strong>{clockIn ? timeInIndia(clockIn.occurredAt) : '—'}</strong></div>
                <div><span>Clock out</span><strong>{clockOut ? timeInIndia(clockOut.occurredAt) : '—'}</strong></div>
                <div><span>Total time</span><strong>{minutesLabel(totals.totalMinutes)}</strong></div>
                <div><span>Break time</span><strong>{minutesLabel(totals.breakMinutes)}</strong></div>
                <div><span>Restarts</span><strong>{restartCount}</strong></div>
                <div><span>Connection drops</span><strong>{dropCount}</strong></div>
              </section>
              <section className="type-totals" aria-label="Per-type totals">
                <h3>Per-type totals</h3>
                <div className="type-total-grid">
                  {ENTRY_TYPES.map((type) => (
                    <div key={type}><span>{entryTypeLabel(type)}</span><strong>{minutesLabel(totals.byType[type])}</strong></div>
                  ))}
                </div>
              </section>
              <section className="report-timeline" aria-label="Chronological timeline">
                <h3>Timeline</h3>
                {reportItems.length ? (
                  <div className="record-list">
                    {reportItems.map(({ record, start, end, duration }) => record.kind === 'event' ? (
                      <article key={record.id} className="timeline-row event-record">
                        <time>{timeInIndia(new Date(start))}</time><strong>{record.type}</strong>
                      </article>
                    ) : (
                      <article key={record.id} className="timeline-row">
                        <span className={`record-mark ${entryMarkClass(record.type)}`} />
                        <div className="timeline-entry">
                          <span className="timeline-time">{timeInIndia(new Date(start))}–{end === undefined ? '' : timeInIndia(new Date(Math.min(end, dayEnd - 60_000)))}</span>
                          <strong>{entryTypeLabel(record.type)} · {duration}</strong>
                          {(record.withWho || record.forWhat) && <small>{[record.withWho, record.forWhat].filter(Boolean).join(' · ')}</small>}
                        </div>
                      </article>
                    ))}
                  </div>
                ) : (
                  <div className="empty-state"><strong>No entries for this day</strong></div>
                )}
              </section>
                </>
              )}
            </section>
          ) : (
            <>
              {leftRunningEntries.length > 0 && (
                <section className="left-running-section" aria-label="Entries left running from earlier days">
                  <h2>Left running from earlier days</h2>
                  <div className="record-list">
                    {leftRunningEntries.map((entry) => (
                      <article key={entry.id} className="left-running-record">
                        <div>
                          <strong>{entryTypeLabel(entry.type)}</strong>
                          <span>Left running from {entry.date}</span>
                        </div>
                        <button className="secondary-button" onClick={() => stopAtEndOfStartDay(entry)}>
                          Stop at 23:59 on {entry.date}
                        </button>
                        <button className="primary-button" onClick={() => setEditor({ entry, endOnly: true })}>Set end time</button>
                      </article>
                    ))}
                  </div>
                </section>
              )}

              {runningEntries.length > 0 && (
                <section className="running-section" aria-label="Running entries">
                  <div className="running-heading">
                    <h2>Running · {runningEntries.length}</h2>
                    <button className="stop-all" onClick={stopAll}>Stop all</button>
                  </div>
                  <div className="record-list">
                    {runningEntries.map((entry) => (
                      <EntryListRow
                        key={entry.id}
                        entry={entry}
                        now={now}
                        onEdit={() => setEditor({ entry })}
                        onStop={() => stopEntry(entry)}
                      />
                    ))}
                  </div>
                </section>
              )}

              <section className="totals-card">
                <div className="total-line">
                  <span>Total logged</span>
                  <strong>{minutesLabel(totals.totalMinutes)}</strong>
                  <small>Overlapping time counted once</small>
                </div>
                <div className="report-summary compact-summary">
                  <div><span>Break time</span><strong>{minutesLabel(totals.breakMinutes)}</strong></div>
                  <div><span>Clock in</span><strong>{clockIn ? timeInIndia(clockIn.occurredAt) : '—'}</strong></div>
                  <div><span>Clock out</span><strong>{clockOut ? timeInIndia(clockOut.occurredAt) : '—'}</strong></div>
                  <div><span>Restarts</span><strong>{restartCount}</strong></div>
                  <div><span>Connection drops</span><strong>{dropCount}</strong></div>
                </div>
                <div className="type-total-grid compact-type-totals">
                  {ENTRY_TYPES.map((type) => (
                    <div key={type}><span>{entryTypeLabel(type)}</span><strong>{minutesLabel(totals.byType[type])}</strong></div>
                  ))}
                </div>
              </section>

              <section className="log-section">
                <div className="section-heading">
                  <div><p className="eyebrow">{dayRecords.length} RECORD{dayRecords.length === 1 ? '' : 'S'}</p><h2>Daily log</h2></div>
                  <button className="text-button" onClick={() => setEditor({})}>＋ Add past entry</button>
                </div>
                {records === null ? (
                  <div className="loading-state" role="status">{loadFailed ? 'Saved entries could not be loaded.' : 'Loading saved entries…'}</div>
                ) : dailyListRecords.length === 0 && dayRecords.length === 0 ? (
                  <div className="empty-state"><span>◷</span><strong>No entries yet</strong><p>Start tracking or add something you forgot.</p></div>
                ) : dailyListRecords.length === 0 ? (
                  <p className="list-note">Running entries are shown above.</p>
                ) : (
                  <div className="record-list">
                    {dailyListRecords.map((record) => record.kind === 'entry' ? (
                      <EntryListRow
                        key={record.id}
                        entry={record}
                        now={now}
                        editable={record.date === todayDate}
                        onEdit={() => setEditor({ entry: record })}
                      />
                    ) : (
                      <article key={record.id} className="record event-record">
                        <span className="event-mark">•</span><strong>{record.type}</strong><time>{timeInIndia(record.occurredAt)}</time>
                      </article>
                    ))}
                  </div>
                )}
              </section>
            </>
          )}
        </>
      )}

      {isToday && <section className="tools-section">
        <div className="section-heading"><div><p className="eyebrow">YOUR DATA</p><h2>Export & backup</h2></div></div>
        <div className="tools-grid">
          <button className="secondary-button" onClick={() => void copyForExcel()}>Copy for Excel</button>
          <button className="secondary-button" onClick={() => void downloadBackup()}>Download backup</button>
          <label className="secondary-button restore-button">
            Restore backup
            <input type="file" accept="application/json,.json" onChange={(event) => {
              void handleRestore(event.target.files?.[0])
              event.target.value = ''
            }} />
          </label>
        </div>
        <p className="storage-status"><span className="status-dot" />{storageStatus}</p>
        <p className="sync-status" role="status">{syncStatusLabel(syncSnapshot)}</p>
        {syncSnapshot.hasLongPending && (
          <p className="sync-warning" role="alert">Some entries have been unsynced for more than 6 hours.</p>
        )}
        <button className="secondary-button settings-toggle" onClick={() => setSettingsOpen((open) => !open)}>
          {settingsOpen ? 'Close sync settings' : 'Sync settings'}
        </button>
        {settingsOpen && <SyncSettings onClose={() => setSettingsOpen(false)} />}
      </section>}

      <footer>Saved on this device · Timezone: Asia/Kolkata</footer>

      {(error || notice) && !isFuture && (
        <div className={`toast ${error ? 'toast-error' : ''}`} role={error ? 'alert' : 'status'}>
          <span>{error || notice}</span><button onClick={() => { setError(''); setNotice('') }} aria-label="Dismiss message">×</button>
        </div>
      )}

      {editor !== null && isToday && (
        <EntryEditor
          entry={editor.entry}
          endOnly={editor.endOnly}
          selectedDate={selectedDate}
          today={todayDate}
          now={now}
          nameOptions={nameOptions}
          onAddName={addLocalName}
          onClose={() => setEditor(null)}
          onSave={handleSaveEntry}
          onDelete={handleDeleteEntry}
        />
      )}

      {actionPanel && isToday && (
        <section className={`compact-action-panel ${actionPanel === 'events' ? 'events-panel' : ''}`} aria-label={actionPanel === 'start' ? 'Start an entry' : 'Log an event'}>
          <div className="panel-heading">
            <strong>{actionPanel === 'start' ? 'Start an entry' : 'Log an event'}</strong>
            <button className="icon-button panel-close" onClick={() => setActionPanel(null)} aria-label="Close action panel">×</button>
          </div>
          {actionPanel === 'start' ? (
            <form className="start-panel-form" onSubmit={startSelectedEntry}>
              <div className="type-chips" aria-label="Entry type">
                {ENTRY_TYPES.map((type) => (
                  <button
                    key={type}
                    type="button"
                    className={`type-chip ${entryMarkClass(type)} ${startType === type ? 'is-selected' : ''}`}
                    aria-pressed={startType === type}
                    onClick={() => {
                      setStartType(type)
                      if (type === 'Work' || ['Break', 'Washroom', 'Lunch'].includes(type)) setStartNames([])
                    }}
                  >{entryTypeLabel(type)}</button>
                ))}
              </div>
              {['Meeting', 'Doubts/Queries', 'Replies'].includes(startType) && (
                <NameSelector selected={startNames} options={nameOptions} onChange={setStartNames} onAddName={addLocalName} />
              )}
              {!['Break', 'Washroom', 'Lunch'].includes(startType) && (
                <label className="field">For what
                  <input value={startForWhat} onChange={(event) => setStartForWhat(event.target.value)} />
                </label>
              )}
              <button type="submit" className="primary-button panel-start">Start</button>
            </form>
          ) : (
            <div className="event-grid">
              {EVENT_TYPES.map((type) => (
                <button key={type} className="event-button" onClick={() => addEvent(type)}>{type}</button>
              ))}
            </div>
          )}
        </section>
      )}

      {isToday && <nav className="bottom-action-bar" aria-label="Quick actions">
        <button className="bar-action" aria-expanded={actionPanel === 'start'} onClick={() => setActionPanel((panel) => panel === 'start' ? null : 'start')}>Start</button>
        <button className="bar-action quick-break" onClick={() => { startEntry('Break'); setActionPanel(null) }}>Break</button>
        <button className="bar-action quick-washroom" onClick={() => { startEntry('Washroom'); setActionPanel(null) }}>Washroom</button>
        <button className="bar-action quick-lunch" onClick={() => { startEntry('Lunch'); setActionPanel(null) }}>Lunch</button>
        <button className="bar-action" aria-expanded={actionPanel === 'events'} onClick={() => setActionPanel((panel) => panel === 'events' ? null : 'events')}>Events</button>
      </nav>}
    </main>
  )
}

function EntryListRow({ entry, now, onEdit, onStop, editable = true }: {
  entry: Entry
  now: number
  onEdit?: () => void
  onStop?: () => void
  editable?: boolean
}) {
  const content = (
    <>
      <span className={`record-mark ${entryMarkClass(entry.type)}`} />
      <span className="record-info">
        <strong>{entryTypeLabel(entry.type)}</strong>
        <span>{timeInIndia(entry.startAt)} – {entry.endAt ? timeInIndia(entry.endAt) : 'Running now'}</span>
        {(entry.withWho || entry.forWhat) && <small>{[entry.withWho, entry.forWhat].filter(Boolean).join(' · ')}</small>}
      </span>
      <span className="record-duration">{formatDurationForDisplay(entry, now)}</span>
    </>
  )
  return (
    <article className={`record entry-record ${entry.endAt ? '' : 'is-running'}`}>
      {editable
        ? <button className="record-content" onClick={onEdit}>{content}</button>
        : <div className="record-content">{content}</div>}
      {onStop && <button className="stop-button" onClick={onStop}>Stop</button>}
    </article>
  )
}

function NameSelector({ selected, options, onChange, onAddName, disabled = false }: {
  selected: string[]
  options: string[]
  onChange: (names: string[]) => void
  onAddName: (name: string) => string
  disabled?: boolean
}) {
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  const known = new Set(options.map((name) => name.toLocaleLowerCase()))
  const chips = [...selected.filter((name) => !known.has(name.toLocaleLowerCase())), ...options]

  function toggle(name: string) {
    const exists = selected.some((item) => item.toLocaleLowerCase() === name.toLocaleLowerCase())
    onChange(exists
      ? selected.filter((item) => item.toLocaleLowerCase() !== name.toLocaleLowerCase())
      : [...selected, name])
  }

  function addName(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    try {
      const name = onAddName(draft)
      onChange([...selected, name])
      setDraft('')
      setError('')
      setAdding(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not add that name.')
    }
  }

  return (
    <div className="name-selector">
      <div className="name-chips" aria-label="Select names">
        {chips.map((name) => {
          const pressed = selected.some((item) => item.toLocaleLowerCase() === name.toLocaleLowerCase())
          return (
            <button
              key={name.toLocaleLowerCase()}
              type="button"
              className={`name-chip ${pressed ? 'is-selected' : ''}`}
              aria-pressed={pressed}
              disabled={disabled}
              onClick={() => toggle(name)}
            >{name}</button>
          )
        })}
        <button type="button" className="name-chip add-name-button" disabled={disabled} onClick={() => {
          setAdding(true)
          setError('')
        }}>+ Add name</button>
      </div>
      {adding && (
        <form className="add-name-form" onSubmit={addName}>
          <input aria-label="New name" value={draft} onChange={(event) => setDraft(event.target.value)} />
          <button type="submit" className="secondary-button">Add</button>
          <button type="button" className="secondary-button" onClick={() => { setAdding(false); setError('') }}>Cancel</button>
          {error && <p className="form-error" role="alert">{error}</p>}
        </form>
      )}
    </div>
  )
}

function syncStatusLabel(snapshot: SyncSnapshot): string {
  switch (snapshot.state) {
    case 'not-configured': return 'Sync not set up'
    case 'synced': return 'Synced'
    case 'pending': return `Pending (${snapshot.pendingCount})`
    case 'offline': return 'Offline'
    case 'error': return 'Sync error'
  }
}

function SyncSettings({ onClose }: { onClose: () => void }) {
  const [token, setToken] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [testing, setTesting] = useState(false)

  useEffect(() => {
    try {
      setToken(getSyncToken())
    } catch (cause) {
      setError(`Could not read the saved token: ${String(cause)}`)
    }
  }, [])

  function saveToken() {
    try {
      saveSyncToken(token)
      setError('')
      setMessage(token.trim() ? 'Token saved on this device.' : 'Sync token removed.')
    } catch (cause) {
      setError(`Could not save the token on this device: ${String(cause)}`)
    }
  }

  async function testConnection() {
    setTesting(true)
    setMessage('')
    setError('')
    try {
      await testSyncConnection(token)
      setMessage('Connection successful.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Connection test failed.')
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <section className="editor-modal sync-settings-screen" role="dialog" aria-modal="true" aria-labelledby="sync-settings-title">
        <div className="modal-heading">
          <div><p className="eyebrow">ON-DEVICE TOKEN</p><h2 id="sync-settings-title">Sync settings</h2></div>
          <button className="icon-button" onClick={onClose} aria-label="Close settings">×</button>
        </div>
        <div className="sync-settings">
          <label className="field">
            Sync token
            <input
              type="password"
              autoComplete="new-password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder="Stored only on this device"
            />
          </label>
          <div className="sync-settings-actions">
            <button className="secondary-button" onClick={saveToken}>Save token</button>
            <button className="primary-button" onClick={() => void testConnection()} disabled={testing}>
              {testing ? 'Testing…' : 'Test connection'}
            </button>
          </div>
          <p className="sync-message">The token is stored in this browser on this device only.</p>
          {message && <p className="sync-message">{message}</p>}
          {error && <p className="sync-settings-error" role="alert">{error}</p>}
        </div>
      </section>
    </div>
  )
}

interface EntryEditorProps {
  entry?: Entry
  endOnly?: boolean
  selectedDate: string
  today: string
  now: number
  nameOptions: string[]
  onAddName: (name: string) => string
  onClose: () => void
  onSave: (data: Omit<Entry, 'id' | 'kind' | 'createdAt' | 'updatedAt' | 'deleted'>, previous?: Entry) => Promise<void>
  onDelete: (entry: Entry) => Promise<void>
}

function EntryEditor({
  entry,
  endOnly = false,
  selectedDate,
  today,
  now,
  nameOptions,
  onAddName,
  onClose,
  onSave,
  onDelete,
}: EntryEditorProps) {
  const [date, setDate] = useState(entry?.date ?? selectedDate)
  const [endDate, setEndDate] = useState(entry?.endAt
    ? dateInIndia(new Date(entry.endAt))
    : entry && entry.date < today ? today : entry?.date ?? selectedDate)
  const [type, setType] = useState<EntryType>(entry?.type ?? 'Work')
  const currentTime = timeInIndia(new Date(now))
  const [start, setStart] = useState(entry ? timeInIndia(entry.startAt) : currentTime)
  const [end, setEnd] = useState(entry?.endAt ? timeInIndia(entry.endAt) : currentTime)
  const [running, setRunning] = useState(entry?.endAt === null && !endOnly)
  const [selectedNames, setSelectedNames] = useState(splitNames(entry?.withWho ?? ''))
  const [forWhat, setForWhat] = useState(entry?.forWhat ?? '')
  const [exactTimesCleared, setExactTimesCleared] = useState(endOnly)
  const [validationError, setValidationError] = useState('')
  const hasNames = ['Meeting', 'Doubts/Queries', 'Replies'].includes(type)
  const hasDescription = !['Break', 'Washroom', 'Lunch'].includes(type)

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const startAt = endOnly && entry ? entry.startAt : indiaTimeToIso(date, start)
    const endAt = running ? null : indiaTimeToIso(endDate, end)
    if (date > today || endDate > today) {
      setValidationError('Entry times cannot be later than the current day.')
      return
    }
    if (Date.parse(startAt) > now || (endAt && Date.parse(endAt) > now)) {
      setValidationError('Entry times cannot be later than the current minute.')
      return
    }
    if (endAt && Date.parse(startAt) > Date.parse(endAt)) {
      setValidationError('Start time cannot be after end time.')
      return
    }
    setValidationError('')
    await onSave({
      date,
      startAt,
      endAt,
      type,
      withWho: endOnly && entry
        ? entry.withWho
        : hasNames
          ? selectedNames.join(', ') || null
          : null,
      forWhat: endOnly && entry ? entry.forWhat : hasDescription ? forWhat.trim() : '',
      ...(!exactTimesCleared && entry?.startedAtExact !== undefined
        ? { startedAtExact: entry.startedAtExact }
        : {}),
      ...(!exactTimesCleared && running === (entry?.endAt === null) && entry?.endedAtExact !== undefined
        ? { endedAtExact: entry.endedAtExact }
        : {}),
    }, entry)
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <section className="editor-modal" role="dialog" aria-modal="true" aria-labelledby="editor-title">
        <div className="modal-heading">
          <div><p className="eyebrow">{entry ? 'EDIT ENTRY' : 'ADD TO YOUR LOG'}</p><h2 id="editor-title">{endOnly ? 'Set end time' : entry ? 'Edit entry' : 'Add past entry'}</h2></div>
          <button className="icon-button" onClick={onClose} aria-label="Close">×</button>
        </div>
        <form onSubmit={(event) => void submit(event)}>
          {!endOnly && <>
            <label className="field">Start date<input type="date" value={date} min={today} max={today} onChange={(event) => {
              setDate(event.target.value)
              setEndDate((current) => current < event.target.value ? event.target.value : current)
              setExactTimesCleared(true)
            }} required /></label>
            <label className="field">Type<select value={type} onChange={(event) => {
              const nextType = event.target.value as EntryType
              setType(nextType)
              if (nextType === 'Work' || ['Break', 'Washroom', 'Lunch'].includes(nextType)) setSelectedNames([])
            }}>{ENTRY_TYPES.map((item) => <option key={item} value={item}>{entryTypeLabel(item)}</option>)}</select></label>
            <label className="field">Start<input type="time" value={start} max={date === today ? currentTime : undefined} onChange={(event) => {
              setStart(event.target.value)
              setExactTimesCleared(true)
            }} required /></label>
          </>}
          <label className="field">End date<input type="date" value={endDate} min={endOnly ? entry?.date : date} max={today} onChange={(event) => {
            setEndDate(event.target.value)
            setExactTimesCleared(true)
          }} disabled={running} required={!running} /></label>
          <label className="field">End<input type="time" value={end} max={endDate === today ? currentTime : undefined} onChange={(event) => {
            setEnd(event.target.value)
            setExactTimesCleared(true)
          }} disabled={running} required={!running} /></label>
          {!endOnly && entry && <label className="check-field"><input type="checkbox" checked={running} onChange={(event) => setRunning(event.target.checked)} /> Keep running</label>}
          {!endOnly && entry && <p className="helper-text">Duration: {formatDurationForDisplay(entry, now)}</p>}
          {entry && !exactTimesCleared && running === (entry.endAt === null) && exactDurationSeconds(entry, Date.now()) !== undefined && (
            <p className="helper-text">Exact: {exactDurationSeconds(entry, Date.now())}s</p>
          )}
          {!endOnly && hasNames && <NameSelector selected={selectedNames} options={nameOptions} onChange={setSelectedNames} onAddName={onAddName} />}
          {!endOnly && hasDescription && (
            <label className="field">For what<input value={forWhat} onChange={(event) => setForWhat(event.target.value)} placeholder="Optional" /></label>
          )}
          {validationError && <p className="form-error" role="alert">{validationError}</p>}
          <div className="modal-actions">
            {entry && !endOnly && <button type="button" className="delete-button" onClick={() => void onDelete(entry)}>Delete</button>}
            <button type="button" className="secondary-button" onClick={onClose}>Cancel</button>
            <button type="submit" className="primary-button">Save entry</button>
          </div>
        </form>
      </section>
    </div>
  )
}

export default App
