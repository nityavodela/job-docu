import { useEffect, useMemo, useState } from 'react'
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

function eventDate(event: LogEvent): string {
  return dateInIndia(new Date(event.occurredAt))
}

function entryDuration(entry: Entry, now: number): number {
  const start = clockMinute(Date.parse(entry.startAt))
  const end = entry.endAt ? clockMinute(Date.parse(entry.endAt)) : clockMinute(now)
  return Math.max(0, end - start)
}

function entryDurationLabel(entry: Entry, now: number): string {
  const duration = entryDuration(entry, now)
  if (duration > 0) return durationLabel(duration)
  const start = clockMinute(Date.parse(entry.startAt))
  const end = entry.endAt ? clockMinute(Date.parse(entry.endAt)) : clockMinute(now)
  return start === end ? '<1m' : durationLabel(duration)
}

function exactDurationSeconds(entry: Entry, now: number): number | undefined {
  if (entry.startedAtExact === undefined) return undefined
  const end = entry.endedAtExact ?? (entry.endAt === null ? now : undefined)
  return end === undefined ? undefined : Math.floor(Math.max(0, end - entry.startedAtExact) / 1000)
}

function mergedDuration(intervals: [number, number][]): number {
  if (!intervals.length) return 0
  intervals.sort((a, b) => a[0] - b[0])
  let total = 0
  let [start, end] = intervals[0]
  for (const [nextStart, nextEnd] of intervals.slice(1)) {
    if (nextStart <= end) end = Math.max(end, nextEnd)
    else {
      total += end - start
      start = nextStart
      end = nextEnd
    }
  }
  return total + end - start
}

function formatDay(date: string): string {
  return format(parseISO(date), 'EEEE, d MMMM yyyy')
}

function App() {
  const [records, setRecords] = useState<LogRecord[]>([])
  const [selectedDate, setSelectedDate] = useState(() => dateInIndia(new Date()))
  const [now, setNow] = useState(() => currentMinute().getTime())
  const [editorEntry, setEditorEntry] = useState<Entry | null | undefined>(undefined)
  const [storageStatus, setStorageStatus] = useState('Checking…')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [darkMode, setDarkMode] = useState(false)

  async function reload() {
    setRecords(await getRecords())
  }

  useEffect(() => {
    void reload().catch((cause: unknown) => setError(`Could not load saved data: ${String(cause)}`))
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
    }
  }, [])

  const [dayStart, dayEnd] = dayRange(selectedDate)
  const dayRecords = useMemo(() => records.filter((record) => {
    if (record.deleted) return false
    if (record.kind === 'event') return eventDate(record) === selectedDate
    const start = clockMinute(Date.parse(record.startAt))
    const end = record.endAt ? clockMinute(Date.parse(record.endAt)) : clockMinute(now)
    return start < dayEnd && end > dayStart
  }), [records, selectedDate, dayStart, dayEnd, now])

  const entries = dayRecords.filter((record): record is Entry => record.kind === 'entry')
  const events = dayRecords.filter((record): record is LogEvent => record.kind === 'event')
  const sortedRecords = [...dayRecords].sort((a, b) => {
    const aTime = a.kind === 'entry' ? a.startAt : a.occurredAt
    const bTime = b.kind === 'entry' ? b.startAt : b.occurredAt
    return Date.parse(bTime) - Date.parse(aTime)
  })

  const intervals = entries.map((entry): [number, number] => [
    Math.max(dayStart, clockMinute(Date.parse(entry.startAt))),
    Math.min(dayEnd, entry.endAt ? clockMinute(Date.parse(entry.endAt)) : clockMinute(now)),
  ]).filter(([start, end]) => end > start)
  const totalTime = mergedDuration(intervals)
  const restTime = (['Break', 'Washroom', 'Lunch'] as const).map((type) => ({
    type,
    duration: mergedDuration(entries
      .filter((entry) => entry.type === type)
      .map((entry): [number, number] => {
        const start = Math.max(dayStart, clockMinute(Date.parse(entry.startAt)))
        const end = Math.min(dayEnd, entry.endAt ? clockMinute(Date.parse(entry.endAt)) : clockMinute(now))
        return [start, end]
      })
      .filter(([start, end]) => end > start)),
  }))

  const clockIn = events.filter((event) => event.type === 'Clock in')
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))[0]
  const clockOut = events.filter((event) => event.type === 'Clock out')
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))[0]
  const restartCount = events.filter((event) => event.type === 'System restart').length
  const dropCount = events.filter((event) => event.type === 'Connection lost').length

  async function persist(record: LogRecord, message = '') {
    try {
      await saveRecord(record)
      await reload()
      setError('')
      setNotice(message)
      if (message) window.setTimeout(() => setNotice(''), 2500)
    } catch (cause) {
      setError(`Could not save your change: ${String(cause)}`)
    }
  }

  function startEntry(type: EntryType) {
    const startedAtExact = Date.now()
    const stamp = new Date(startedAtExact)
    stamp.setSeconds(0, 0)
    const iso = stamp.toISOString()
    void persist({
      id: newId(),
      kind: 'entry',
      date: dateInIndia(stamp),
      startAt: iso,
      endAt: null,
      type,
      withWho: '',
      forWhat: '',
      startedAtExact,
      createdAt: iso,
      updatedAt: iso,
      deleted: false,
    }, `${type} started`)
  }

  function addEvent(type: EventType) {
    const iso = currentMinute().toISOString()
    const event: LogEvent = {
      id: newId(),
      kind: 'event',
      occurredAt: iso,
      type,
      createdAt: iso,
      updatedAt: iso,
      deleted: false,
    }
    void persist(event, `${type} logged`)
  }

  function stopEntry(entry: Entry) {
    const endedAtExact = Date.now()
    const stamp = new Date(endedAtExact)
    stamp.setSeconds(0, 0)
    void persist({ ...entry, endAt: stamp.toISOString(), endedAtExact, updatedAt: stamp.toISOString() }, `${entry.type} stopped`)
  }

  function stopAll() {
    const running = entries.filter((entry) => entry.endAt === null)
    if (!running.length) return
    const endedAtExact = Date.now()
    const stamp = new Date(endedAtExact)
    stamp.setSeconds(0, 0)
    const iso = stamp.toISOString()
    void Promise.all(running.map((entry) => saveRecord({ ...entry, endAt: iso, endedAtExact, updatedAt: iso })))
      .then(reload)
      .then(() => {
        setError('')
        setNotice(`${running.length} running ${running.length === 1 ? 'entry' : 'entries'} stopped`)
      })
      .catch((cause: unknown) => setError(`Could not stop all entries: ${String(cause)}`))
  }

  async function handleSaveEntry(data: Omit<Entry, 'id' | 'kind' | 'createdAt' | 'updatedAt' | 'deleted'>, previous?: Entry) {
    const stamp = currentMinute().toISOString()
    const entry: Entry = {
      ...data,
      id: previous?.id ?? newId(),
      kind: 'entry',
      createdAt: previous?.createdAt ?? stamp,
      updatedAt: stamp,
      deleted: false,
    }
    await persist(entry, previous ? 'Entry updated' : 'Past entry added')
    setEditorEntry(undefined)
  }

  async function handleDeleteEntry(entry: Entry) {
    try {
      await softDeleteRecord(entry)
      await reload()
      setEditorEntry(undefined)
      setError('')
    } catch (cause) {
      setError(`Could not delete the entry: ${String(cause)}`)
    }
  }

  async function copyForExcel() {
    const rows = [
      ['Date', 'Start', 'End', 'Type', 'With who', 'For what', 'Minutes', 'Seconds'],
      ...sortedRecords.map((record) => record.kind === 'entry'
        ? [
            record.date,
            timeInIndia(record.startAt),
            record.endAt ? timeInIndia(record.endAt) : 'Running',
            record.type,
            record.withWho,
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
      await reload()
      setError('')
      setNotice(`Restore complete: ${added} new ${added === 1 ? 'record' : 'records'} added`)
      window.setTimeout(() => setNotice(''), 3500)
    } catch (cause) {
      setError(`Could not restore backup: ${String(cause)}`)
    }
  }

  function moveDay(amount: number) {
    setSelectedDate(format(addDays(parseISO(selectedDate), amount), 'yyyy-MM-dd'))
  }

  return (
    <main className="app-shell" data-theme={darkMode ? 'dark' : 'light'}>
      <header className="topbar">
        <div>
          <p className="eyebrow">PERSONAL · OFFLINE</p>
          <h1>Work log</h1>
        </div>
        <button className="theme-toggle" onClick={() => setDarkMode((value) => !value)} aria-label="Toggle light and dark mode">
          {darkMode ? '☀ Light' : '☾ Dark'}
        </button>
      </header>

      <section className="day-picker" aria-label="Choose a day">
        <button className="icon-button" onClick={() => moveDay(-1)} aria-label="Previous day">‹</button>
        <label>
          <span className="day-label">{formatDay(selectedDate)}</span>
          <input type="date" value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)} />
        </label>
        <button className="icon-button" onClick={() => moveDay(1)} aria-label="Next day">›</button>
      </section>

      <section className="totals-card">
        <div className="total-main">
          <span>Total logged</span>
          <strong>{durationLabel(totalTime)}</strong>
          <small>Overlapping time counted once</small>
        </div>
        <div className="rest-totals">
          {restTime.map(({ type, duration }) => (
            <div key={type}><span>{type}</span><strong>{durationLabel(duration)}</strong></div>
          ))}
        </div>
        <p className="summary-line">
          <span>Clock in <strong>{clockIn ? timeInIndia(clockIn.occurredAt) : '—'}</strong></span>
          <span>Clock out <strong>{clockOut ? timeInIndia(clockOut.occurredAt) : '—'}</strong></span>
          <span>Restarts <strong>{restartCount}</strong></span>
          <span>Drops <strong>{dropCount}</strong></span>
        </p>
      </section>

      <section className="actions-section">
        <div className="section-heading">
          <div><p className="eyebrow">TRACK TIME</p><h2>Start an entry</h2></div>
          <button className="stop-all" onClick={stopAll} disabled={!entries.some((entry) => !entry.endAt)}>Stop all</button>
        </div>
        <div className="start-grid">
          {ENTRY_TYPES.map((type) => (
            <button key={type} className={`start-button type-${type.toLowerCase()}`} onClick={() => startEntry(type)}>
              <span className="start-dot" />{type}
            </button>
          ))}
        </div>
        <p className="helper-text">Each start is independent; entries can overlap.</p>
      </section>

      <section className="actions-section">
        <div className="section-heading"><div><p className="eyebrow">QUICK LOG</p><h2>One-tap events</h2></div></div>
        <div className="event-grid">
          {EVENT_TYPES.map((type) => <button key={type} className="event-button" onClick={() => addEvent(type)}>{type}</button>)}
        </div>
      </section>

      <section className="log-section">
        <div className="section-heading">
          <div><p className="eyebrow">{dayRecords.length} RECORD{dayRecords.length === 1 ? '' : 'S'}</p><h2>Daily log</h2></div>
          <button className="text-button" onClick={() => setEditorEntry(null)}>＋ Add past entry</button>
        </div>
        {sortedRecords.length === 0 ? (
          <div className="empty-state"><span>◷</span><strong>No entries yet</strong><p>Start tracking or add something you forgot.</p></div>
        ) : (
          <div className="record-list">
            {sortedRecords.map((record) => record.kind === 'entry' ? (
              <article key={record.id} className={`record entry-record ${record.endAt ? '' : 'is-running'}`}>
                <button className="record-content" onClick={() => setEditorEntry(record)}>
                  <span className={`record-mark mark-${record.type.toLowerCase()}`} />
                  <span className="record-info">
                    <strong>{record.type}</strong>
                    <span>{timeInIndia(record.startAt)} – {record.endAt ? timeInIndia(record.endAt) : 'Running now'}</span>
                    {(record.withWho || record.forWhat) && <small>{[record.withWho, record.forWhat].filter(Boolean).join(' · ')}</small>}
                  </span>
                  <span className="record-duration">{entryDurationLabel(record, now)}</span>
                </button>
                {!record.endAt && <button className="stop-button" onClick={() => stopEntry(record)}>Stop</button>}
              </article>
            ) : (
              <article key={record.id} className="record event-record">
                <span className="event-mark">•</span><strong>{record.type}</strong><time>{timeInIndia(record.occurredAt)}</time>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="tools-section">
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
      </section>

      <footer>Saved on this device · Timezone: Asia/Kolkata</footer>

      {(error || notice) && (
        <div className={`toast ${error ? 'toast-error' : ''}`} role={error ? 'alert' : 'status'}>
          <span>{error || notice}</span><button onClick={() => { setError(''); setNotice('') }} aria-label="Dismiss message">×</button>
        </div>
      )}

      {editorEntry !== undefined && (
        <EntryEditor
          entry={editorEntry ?? undefined}
          selectedDate={selectedDate}
          onClose={() => setEditorEntry(undefined)}
          onSave={handleSaveEntry}
          onDelete={handleDeleteEntry}
        />
      )}
    </main>
  )
}

interface EntryEditorProps {
  entry?: Entry
  selectedDate: string
  onClose: () => void
  onSave: (data: Omit<Entry, 'id' | 'kind' | 'createdAt' | 'updatedAt' | 'deleted'>, previous?: Entry) => Promise<void>
  onDelete: (entry: Entry) => Promise<void>
}

function EntryEditor({ entry, selectedDate, onClose, onSave, onDelete }: EntryEditorProps) {
  const [date, setDate] = useState(entry?.date ?? selectedDate)
  const [type, setType] = useState<EntryType>(entry?.type ?? 'Work')
  const [start, setStart] = useState(entry ? timeInIndia(entry.startAt) : '09:00')
  const [end, setEnd] = useState(entry?.endAt ? timeInIndia(entry.endAt) : '10:00')
  const [running, setRunning] = useState(entry?.endAt === null)
  const [withWho, setWithWho] = useState(entry?.withWho ?? '')
  const [forWhat, setForWhat] = useState(entry?.forWhat ?? '')
  const [exactTimesCleared, setExactTimesCleared] = useState(false)

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const startAt = indiaTimeToIso(date, start)
    let endAt = running ? null : indiaTimeToIso(date, end)
    if (endAt && Date.parse(endAt) < Date.parse(startAt)) {
      const nextDate = format(addDays(parseISO(date), 1), 'yyyy-MM-dd')
      endAt = indiaTimeToIso(nextDate, end)
    }
    await onSave({
      date,
      startAt,
      endAt,
      type,
      withWho: withWho.trim(),
      forWhat: forWhat.trim(),
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
          <div><p className="eyebrow">{entry ? 'EDIT ENTRY' : 'ADD TO YOUR LOG'}</p><h2 id="editor-title">{entry ? 'Edit entry' : 'Add past entry'}</h2></div>
          <button className="icon-button" onClick={onClose} aria-label="Close">×</button>
        </div>
        <form onSubmit={(event) => void submit(event)}>
          <label className="field">Date<input type="date" value={date} onChange={(event) => {
            setDate(event.target.value)
            setExactTimesCleared(true)
          }} required /></label>
          <label className="field">Type<select value={type} onChange={(event) => setType(event.target.value as EntryType)}>{ENTRY_TYPES.map((item) => <option key={item}>{item}</option>)}</select></label>
          <div className="field-row">
            <label className="field">Start<input type="time" value={start} onChange={(event) => {
              setStart(event.target.value)
              setExactTimesCleared(true)
            }} required /></label>
            <label className="field">End<input type="time" value={end} onChange={(event) => {
              setEnd(event.target.value)
              setExactTimesCleared(true)
            }} disabled={running} required={!running} /></label>
          </div>
          {entry && <label className="check-field"><input type="checkbox" checked={running} onChange={(event) => setRunning(event.target.checked)} /> Keep running</label>}
          {entry && !exactTimesCleared && running === (entry.endAt === null) && exactDurationSeconds(entry, Date.now()) !== undefined && (
            <p className="helper-text">Exact: {exactDurationSeconds(entry, Date.now())}s</p>
          )}
          <label className="field">With who<input value={withWho} onChange={(event) => setWithWho(event.target.value)} placeholder="Optional" /></label>
          <label className="field">For what<input value={forWhat} onChange={(event) => setForWhat(event.target.value)} placeholder="Optional" /></label>
          <div className="modal-actions">
            {entry && <button type="button" className="delete-button" onClick={() => void onDelete(entry)}>Delete</button>}
            <button type="button" className="secondary-button" onClick={onClose}>Cancel</button>
            <button type="submit" className="primary-button">Save entry</button>
          </div>
        </form>
      </section>
    </div>
  )
}

export default App
