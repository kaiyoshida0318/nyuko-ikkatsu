import type { ProductHubRecord, ProductHubSettings } from './types'

type ProductHubApiRow = {
  product_code?: unknown
  product_name?: unknown
  shipping_name?: unknown
  floor?: unknown
  order_memo_1?: unknown
  order_1?: unknown
  rakumart_url_1?: unknown
  rm_1?: unknown
  order_memo_2?: unknown
  order_2?: unknown
  rakumart_url_2?: unknown
  rm_2?: unknown
  order_memo_3?: unknown
  order_3?: unknown
  rakumart_url_3?: unknown
  rm_3?: unknown
  order_memo_4?: unknown
  order_4?: unknown
  rakumart_url_4?: unknown
  rm_4?: unknown
  order_memo_5?: unknown
  order_5?: unknown
  rakumart_url_5?: unknown
  rm_5?: unknown
}

const REQUEST_CHUNK_SIZE = 50
const PRODUCTS_TABLE_NAME = 'products'
const SELECT_COLUMNS = [
  'product_code',
  'product_name',
  'floor',
  'order_memo_1',
  'rakumart_url_1',
  'order_memo_2',
  'rakumart_url_2',
  'order_memo_3',
  'rakumart_url_3',
  'order_memo_4',
  'rakumart_url_4',
  'order_memo_5',
  'rakumart_url_5',
].join(',')

function normalizeCell(value: unknown): string | null {
  const text = String(value ?? '').trim()
  if (!text || text === '■' || text === 'nan' || text === 'None') return null
  return text
}

function normalizeSupabaseUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, '')
  if (!trimmed) return ''

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error('Supabase URLの形式が正しくありません。')
  }

  if (!url.protocol.startsWith('http')) {
    throw new Error('Supabase URLは https:// から始まるURLを入力してください。')
  }

  const path = url.pathname.replace(/\/+$/, '')
  if (path.endsWith(`/rest/v1/${PRODUCTS_TABLE_NAME}`)) {
    return `${url.origin}${path}`
  }
  if (path.endsWith('/rest/v1')) {
    return `${url.origin}${path}/${PRODUCTS_TABLE_NAME}`
  }

  return `${url.origin}/rest/v1/${PRODUCTS_TABLE_NAME}`
}

function escapePostgrestInValue(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function toRecord(row: ProductHubApiRow): ProductHubRecord | null {
  const productCode = normalizeCell(row.product_code) ?? ''
  if (!productCode) return null

  return {
    productCode,
    productCodeLc: productCode.toLowerCase(),
    productName: normalizeCell(row.product_name) ?? normalizeCell(row.shipping_name) ?? '',
    floor: normalizeCell(row.floor) ?? '',
    orders: [
      row.order_memo_1 ?? row.order_1,
      row.order_memo_2 ?? row.order_2,
      row.order_memo_3 ?? row.order_3,
      row.order_memo_4 ?? row.order_4,
      row.order_memo_5 ?? row.order_5,
    ].map(normalizeCell),
    rms: [
      row.rakumart_url_1 ?? row.rm_1,
      row.rakumart_url_2 ?? row.rm_2,
      row.rakumart_url_3 ?? row.rm_3,
      row.rakumart_url_4 ?? row.rm_4,
      row.rakumart_url_5 ?? row.rm_5,
    ].map(normalizeCell),
  }
}

function chunkCodes(codes: string[]): string[][] {
  const chunks: string[][] = []
  for (let i = 0; i < codes.length; i += REQUEST_CHUNK_SIZE) {
    chunks.push(codes.slice(i, i + REQUEST_CHUNK_SIZE))
  }
  return chunks
}

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

export async function fetchProductHubRecords(settings: ProductHubSettings, productCodes: string[]): Promise<ProductHubRecord[]> {
  const apiKey = settings.apiKey.trim()

  if (!settings.apiUrl.trim()) {
    throw new Error('Supabase URLを入力してください。')
  }
  if (!apiKey) {
    throw new Error('Supabase anon keyを入力してください。')
  }

  const endpoint = normalizeSupabaseUrl(settings.apiUrl)
  const uniqueCodes = [
    ...new Set(
      productCodes
        .flatMap((code) => {
          const trimmed = code.trim()
          return trimmed ? [trimmed, trimmed.toLowerCase()] : []
        })
        .filter(Boolean),
    ),
  ]
  if (uniqueCodes.length === 0) return []

  const records: ProductHubRecord[] = []

  for (const chunk of chunkCodes(uniqueCodes)) {
    const url = new URL(endpoint)
    url.searchParams.set('select', SELECT_COLUMNS)
    url.searchParams.set(
      'product_code',
      `in.(${chunk.map(escapePostgrestInValue).join(',')})`,
    )

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        apikey: apiKey,
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
    })

    const responseText = await response.text()

    if (!response.ok) {
      const message = parseErrorMessage(responseText)
      throw new Error(`Supabase productsの取得に失敗しました（${response.status}）: ${message}`)
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(responseText)
    } catch {
      throw new Error('Supabase productsのレスポンスをJSONとして読み取れませんでした。')
    }

    if (!Array.isArray(parsed)) {
      throw new Error('Supabase productsのレスポンス形式が不正です。配列JSONを返す必要があります。')
    }

    for (const row of parsed) {
      const record = toRecord(row as ProductHubApiRow)
      if (record) records.push(record)
    }
  }

  const deduped = new Map<string, ProductHubRecord>()
  for (const record of records) {
    if (!deduped.has(record.productCodeLc)) deduped.set(record.productCodeLc, record)
  }

  return [...deduped.values()]
}
