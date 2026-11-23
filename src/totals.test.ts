import { describe, expect, it } from 'vitest'
import type { Entry, EntryType } from './model'
import { calculateDayTotals } from './totals'

const minute = 60_000
const dayStart = Date.UTC(2026, 10, 23)
const dayEnd = dayStart + 24 * 60 * minute
const at = (hours: number, minutes: number) =>
  dayStart + (hours * 60 + minutes) * minute

function entry(type: EntryType, start: number, end: number | null, id: string): Entry {
  return {
    id,
    kind: 'entry',
    date: '2026-11-23',
    startAt: new Date(start).toISOString(),
    endAt: end === null ? null : new Date(end).toISOString(),
    type,
    withWho: '',
    forWhat: '',
    createdAt: new Date(start).toISOString(),
    updatedAt: new Date(start).toISOString(),
    deleted: false,
  }
}

function totals(entries: Entry[], now = dayStart): ReturnType<typeof calculateDayTotals> {
  return calculateDayTotals(entries, dayStart, dayEnd, now)
}

describe('calculateDayTotals', () => {
  it('counts overlapping Work and Meeting as their interval union (case A)', () => {
    expect(totals([
      entry('Work', at(10, 0), at(11, 0), 'work'),
      entry('Meeting', at(10, 30), at(10, 45), 'meeting'),
    ]).totalMinutes).toBe(60)
  })

  it('merges partly overlapping intervals (case B)', () => {
    expect(totals([
      entry('Work', at(10, 0), at(10, 30), 'first'),
      entry('Meeting', at(10, 20), at(10, 50), 'second'),
    ]).totalMinutes).toBe(50)
  })

  it('counts adjacent intervals once (case C)', () => {
    expect(totals([
      entry('Work', at(10, 0), at(10, 30), 'first'),
      entry('Meeting', at(10, 30), at(11, 0), 'second'),
    ]).totalMinutes).toBe(60)
  })

  it('merges chained overlaps (case D)', () => {
    expect(totals([
      entry('Work', at(10, 0), at(10, 30), 'first'),
      entry('Meeting', at(10, 20), at(10, 50), 'second'),
      entry('Replies', at(10, 40), at(11, 10), 'third'),
    ]).totalMinutes).toBe(70)
  })

  it('counts overlapping breaks as a break union without double-counting total (case E)', () => {
    const result = totals([
      entry('Work', at(11, 0), at(13, 0), 'work'),
      entry('Break', at(12, 0), at(12, 30), 'break'),
    ])
    expect(result.totalMinutes).toBe(120)
    expect(result.breakMinutes).toBe(30)
    expect(result.byType.Work).toBe(120)
    expect(result.byType.Break).toBe(30)
  })

  it('unions overlapping Break, Washroom and Lunch intervals', () => {
    const result = totals([
      entry('Break', at(12, 0), at(12, 20), 'break'),
      entry('Lunch', at(12, 10), at(12, 30), 'lunch'),
      entry('Washroom', at(12, 15), at(12, 25), 'washroom'),
    ])
    expect(result.totalMinutes).toBe(30)
    expect(result.breakMinutes).toBe(30)
    expect(result.byType.Washroom).toBe(10)
  })

  it('ends a running interval at the current clock minute (case F)', () => {
    expect(totals([entry('Work', at(9, 0), null, 'running')], at(9, 45)).totalMinutes).toBe(45)
  })

  it('counts a same-minute interval as zero (case G)', () => {
    expect(totals([entry('Work', at(10, 0), at(10, 0), 'short')]).totalMinutes).toBe(0)
  })

  it('clips an overnight interval to the requested day', () => {
    const previousDayStart = dayStart - 24 * 60 * minute
    const overnight = entry('Work', dayStart - 30 * minute, dayStart + 30 * minute, 'overnight')
    expect(calculateDayTotals([overnight], dayStart, dayEnd, dayStart).totalMinutes).toBe(30)
    expect(calculateDayTotals([overnight], previousDayStart, dayStart, dayStart).totalMinutes).toBe(30)
  })
})
