import type { PagesFunction } from '@cloudflare/workers-types'
import type { Environment } from './_shared'

async function matchesToken(provided: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder()
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(provided)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ])
  const providedBytes = new Uint8Array(providedHash)
  const expectedBytes = new Uint8Array(expectedHash)
  let difference = 0
  for (let index = 0; index < expectedBytes.length; index += 1) {
    difference |= providedBytes[index] ^ expectedBytes[index]
  }
  return difference === 0
}

export const onRequest: PagesFunction<Environment> = async ({ request, env, next }) => {
  const authorization = request.headers.get('Authorization') ?? ''
  const match = /^Bearer ([^\s]+)$/.exec(authorization)
  if (!env.SYNC_TOKEN || !match || !(await matchesToken(match[1], env.SYNC_TOKEN))) {
    return new Response('Unauthorized', { status: 401 })
  }

  const origin = request.headers.get('Origin')
  const fetchSite = request.headers.get('Sec-Fetch-Site')
  if (
    (origin !== null && origin !== new URL(request.url).origin) ||
    (fetchSite !== null && fetchSite !== 'same-origin' && fetchSite !== 'none')
  ) {
    return new Response('Forbidden', { status: 403 })
  }

  return next()
}
