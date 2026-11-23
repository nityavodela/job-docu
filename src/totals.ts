import { ENTRY_TYPES, type Entry, type EntryType } from './model'

export interface DayTotals {
  totalMinutes: number
  breakMinutes: number
  byType: Record<EntryType, number>
}

type Interval = [number, number]

function clockMinute(timestamp: number): number {
  return Math.floor(timestamp / 60_000) * 60_000
}

function unionMinutes(intervals: Interval[]): number {
  if (!intervals.length) return 0
  intervals.sort((left, right) => left[0] - right[0])
  let total = 0
  let [start, end] = intervals[0]
  for (const [nextStart, nextEnd] of intervals.slice(1)) {
    if (nextStart <= end) {
      end = Math.max(end, nextEnd)
    } else {
      total += end - start
      start = nextStart
      end = nextEnd
    }
  }
  return Math.floor((total + end - start) / 60_000)
}

export function calculateDayTotals(
  entries: readonly Entry[],
  dayStart: number,
  dayEnd: number,
  now: number,
): DayTotals {
  const intervalsByType = Object.fromEntries(
    ENTRY_TYPES.map((type) => [type, [] as Interval[]]),
  ) as Record<EntryType, Interval[]>

  for (const entry of entries) {
    const start = Math.max(dayStart, clockMinute(Date.parse(entry.startAt)))
    const end = Math.min(
      dayEnd,
      clockMinute(entry.endAt ? Date.parse(entry.endAt) : now),
    )
    if (end > start) intervalsByType[entry.type].push([start, end])
  }

  const allIntervals = ENTRY_TYPES.flatMap((type) => intervalsByType[type])
  const restIntervals = (['Break', 'Washroom', 'Lunch'] as const)
    .flatMap((type) => intervalsByType[type])

  return {
    totalMinutes: unionMinutes(allIntervals),
    breakMinutes: unionMinutes(restIntervals),
    byType: Object.fromEntries(
      ENTRY_TYPES.map((type) => [type, unionMinutes(intervalsByType[type])]),
    ) as Record<EntryType, number>,
  }
}
