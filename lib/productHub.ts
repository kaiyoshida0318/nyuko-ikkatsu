import type { ProductHubRecord, ProductHubSettings } from './types'

type ProductHubApiRow = {
  product_code?: unknown
  shipping_name?: unknown
  floor?: unknown
  order_1?: unknown
  rm_1?: unknown
  order_2?: unknown
  rm_2?: unknown
  order_3?: unknown
  rm_3?: unknown
  order_4?: unknown
  rm_4?: unknown
  order_5?: unknown
  rm_5?: unknown
}

const REQUEST_CHUNK_SIZE = 50

function normalizeCell(value: unknown): string | null {
  const text = String(value ?? '').trim()
  if (!text || text === '■' || text === 'nan' || text === 'None') return null
  return text
}

function normalizeApiUrl(apiUrl: string): string {
  const trimmed = apiUrl.trim()
  if (!trimmed) return ''
  return trimmed.replace(/\/+$/, '')
}

function toRecord(row: ProductHubApiRow): ProductHubRecord | null {
  const productCode = normalizeCell(row.product_code) ?? ''
  if (!productCode) return null

  return {
    productCode,
    productCodeLc: productCode.toLowerCase(),
    productName: normalizeCell(row.shipping_name) ?? '',
    floor: normalizeCell(row.floor) ?? '',
    orders: [row.order_1, row.order_2, row.order_3, row.order_4, row.order_5].map(normalizeCell),
    rms: [row.rm_1, row.rm_2, row.rm_3, row.rm_4, row.rm_5].map(normalizeCell),
  }
}

function chunkCodes(codes: string[]): string[][] {
  const chunks: string[][] = []
  for (let i = 0; i < codes.length; i += REQUEST_CHUNK_SIZE) {
    chunks.push(codes.slice(i, i + REQUEST_CHUNK_SIZE))
  }
  return chunks
}

export async function fetchProductHubRecords(settings: ProductHubSettings, productCodes: string[]): Promise<ProductHubRecord[]> {
  const apiUrl = normalizeApiUrl(settings.apiUrl)
  const apiKey = settings.apiKey.trim()

  if (!apiUrl) {
    throw new Error('商品DB API URLを入力してください。')
  }
  if (!apiKey) {
    throw new Error('商品DB APIキーを入力してください。')
  }

  const uniqueCodes = [...new Set(productCodes.map((code) => code.trim()).filter(Boolean))]
  if (uniqueCodes.length === 0) return []

  const records: ProductHubRecord[] = []

  for (const chunk of chunkCodes(uniqueCodes)) {
    let url: URL
    try {
      url = new URL(apiUrl)
    } catch {
      throw new Error('商品DB API URLの形式が正しくありません。')
    }
    url.searchParams.set('codes', chunk.join(','))

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'x-api-key': apiKey,
      },
    })

    const responseText = await response.text()

    if (!response.ok) {
      let message = responseText
      try {
        const parsed = JSON.parse(responseText) as { error?: string; message?: string }
        message = parsed.error || parsed.message || responseText
      } catch {
        // keep raw response text
      }
      throw new Error(`商品DB APIの取得に失敗しました（${response.status}）: ${message}`)
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(responseText)
    } catch {
      throw new Error('商品DB APIのレスポンスをJSONとして読み取れませんでした。')
    }

    if (!Array.isArray(parsed)) {
      throw new Error('商品DB APIのレスポンス形式が不正です。配列JSONを返す必要があります。')
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
