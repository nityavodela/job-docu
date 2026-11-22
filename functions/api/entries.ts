import type { PagesFunction } from '@cloudflare/workers-types'
import { jsonResponse, type Environment } from './_shared'

const PAGE_SIZE = 500

interface EntryRow {
  id: string
  kind: string
  date: string | null
  startAt: string | null
  endAt: string | null
  type: string
  withWho: string | null
  forWhat: string | null
  startedAtExact: number | null
  endedAtExact: number | null
  occurredAt: string | null
  createdAt: string
  updatedAt: string
  deleted: number
  serverUpdatedAt: number
}

export const onRequestGet: PagesFunction<Environment> = async ({ request, env }) => {
  const sinceValue = new URL(request.url).searchParams.get('since') ?? '0'
  if (!/^\d+$/.test(sinceValue) || !Number.isSafeInteger(Number(sinceValue))) {
    return jsonResponse({ error: 'Invalid serverUpdatedAt cursor.' }, 400)
  }
  const cursor = Number(sinceValue)
  try {
    const result = await env.DB.prepare(`
      SELECT id, kind, date, startAt, endAt, type, withWho, forWhat,
        startedAtExact, endedAtExact, occurredAt, createdAt, updatedAt,
        deleted, serverUpdatedAt
      FROM entries
      WHERE serverUpdatedAt > ?
      ORDER BY serverUpdatedAt ASC
      LIMIT ?
    `).bind(cursor, PAGE_SIZE + 1).all<EntryRow>()
    const rows = result.results ?? []
    const hasMore = rows.length > PAGE_SIZE
    const page = rows.slice(0, PAGE_SIZE)
    const nextCursor = page.length ? page[page.length - 1].serverUpdatedAt : cursor
    return jsonResponse({
      entries: page.map((row) => ({ ...row, deleted: row.deleted !== 0 })),
      nextCursor,
      hasMore,
    })
  } catch {
    return jsonResponse({ error: 'Could not read synced entries.' }, 500)
  }
}
