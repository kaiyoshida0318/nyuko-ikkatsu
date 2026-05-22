import type { NeUpdateRow } from './types'

export type NeNyukoReflectResult = {
  ok: true
  dryRun: boolean
  total: number
  uploadRows: number
  zeroKatabanCount: number
  totalZaikoSu: number
  queId?: string | null
  neResult?: string | null
  csvPreview?: string[]
  examples?: Array<{ syohin_code: string; zaiko_su: number; kataban: string }>
  message: string
}

function normalizeWorkerUrl(input: string | undefined): string {
  const trimmed = (input ?? '').trim().replace(/^['"]|['"]$/g, '').replace(/\/+$/, '')
  if (!trimmed) return ''

  try {
    const url = new URL(trimmed)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return ''
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
  } catch {
    return ''
  }
}

export const embeddedNeSyncWorkerUrl = normalizeWorkerUrl(
  process.env.NEXT_PUBLIC_NE_SYNC_WORKER_URL,
)

function parseErrorMessage(responseText: string): string {
  try {
    const parsed = JSON.parse(responseText) as {
      error?: string
      message?: string
      details?: string
      hint?: string
    }
    return [parsed.error, parsed.message, parsed.details, parsed.hint]
      .filter(Boolean)
      .join(' / ') || responseText
  } catch {
    return responseText
  }
}

export function getNeSyncWorkerConfigError(): string | null {
  if (embeddedNeSyncWorkerUrl) return null
  return 'NEXT_PUBLIC_NE_SYNC_WORKER_URL が未設定です。ne-sync-worker のURLをGitHub Secretsまたは.env.localに設定してください。'
}

export async function updateNextEngineByApi(
  accessToken: string,
  rows: NeUpdateRow[],
): Promise<NeNyukoReflectResult> {
  const token = accessToken.trim()
  if (!token) {
    throw new Error('Supabase AuthにログインしてからNE更新を実行してください。')
  }
  if (!embeddedNeSyncWorkerUrl) {
    throw new Error(getNeSyncWorkerConfigError() ?? 'ne-sync-worker URLが未設定です。')
  }
  if (rows.length === 0) {
    return {
      ok: true,
      dryRun: false,
      total: 0,
      uploadRows: 0,
      zeroKatabanCount: 0,
      totalZaikoSu: 0,
      queId: null,
      neResult: null,
      csvPreview: [],
      examples: [],
      message: 'NE更新対象がありません。',
    }
  }

  const response = await fetch(`${embeddedNeSyncWorkerUrl}/api/ne/reflect-nyuko`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ rows }),
  })

  const responseText = await response.text()
  if (!response.ok) {
    const message = parseErrorMessage(responseText)
    throw new Error(`NE API更新に失敗しました（${response.status}）: ${message}`)
  }

  try {
    return JSON.parse(responseText) as NeNyukoReflectResult
  } catch {
    throw new Error('NE API更新結果をJSONとして読み取れませんでした。')
  }
}
