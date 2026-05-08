import {
  ExtractedRow,
  KintoneUpdateRow,
  MasterRecord,
  MatchedProduct,
  MatchResult,
  NeUpdateRow,
  NyukoListRow,
  OrderRecord,
} from './types'

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function orderMatchesKey(orderValue: string, key: string): boolean {
  const pattern = new RegExp(`^${escapeRegExp(key)}(?!\\d)`)
  return pattern.test(orderValue)
}

function groupExtracted(rows: ExtractedRow[]): Map<string, ExtractedRow[]> {
  const grouped = new Map<string, ExtractedRow[]>()
  for (const row of rows) {
    const current = grouped.get(row.productCodeLc) ?? []
    current.push(row)
    grouped.set(row.productCodeLc, current)
  }
  return grouped
}

export function matchAndConsume(extracted: ExtractedRow[], orderRecords: OrderRecord[]): MatchResult {
  const grouped = groupExtracted(extracted)
  const orderIndex = new Map<string, OrderRecord>()

  for (const record of orderRecords) {
    if (!orderIndex.has(record.productCodeLc)) {
      orderIndex.set(record.productCodeLc, record)
    }
  }

  const matched: MatchedProduct[] = []
  const warnings: MatchResult['warnings'] = []

  for (const [productCodeLc, incomingRows] of grouped.entries()) {
    const productCode = incomingRows[0]?.productCode ?? productCodeLc
    const deliveredKeys = incomingRows.map((row) => row.key)
    const incomingQuantity = incomingRows.reduce((sum, row) => sum + row.quantity, 0)
    const record = orderIndex.get(productCodeLc)

    if (!record) {
      warnings.push({
        type: 'no_product',
        productCode,
        deliveredKeys,
        message: `${productCode}: kintoneのオーダー状況CSVに商品がありません。`,
      })
      continue
    }

    const pairs = record.orders.map((order, index) => ({
      order,
      rm: record.rms[index] ?? null,
    }))

    for (const incoming of incomingRows) {
      const hitIndex = pairs.findIndex((pair) => pair.order !== null && orderMatchesKey(pair.order, incoming.key))
      if (hitIndex >= 0) {
        pairs[hitIndex] = { order: null, rm: null }
      } else {
        const currentOrders = pairs.map((pair) => pair.order).filter((value): value is string => Boolean(value))
        warnings.push({
          type: 'no_key',
          productCode,
          key: incoming.key,
          deliveredKeys,
          currentOrders,
          message: `${productCode}: ${incoming.key} がオーダー1〜5に見つかりません。`,
        })
      }
    }

    const remainingPairs = pairs
      .filter((pair): pair is { order: string; rm: string | null } => Boolean(pair.order))
      .map((pair) => ({ order: pair.order, rm: pair.rm }))

    matched.push({
      productCode: record.productCode || productCode,
      productCodeLc,
      deliveredKeys,
      incomingQuantity,
      remainingPairs,
    })
  }

  matched.sort((a, b) => a.productCodeLc.localeCompare(b.productCodeLc))
  return { matched, warnings }
}

export function buildNeRows(matchResult: MatchResult): NeUpdateRow[] {
  return matchResult.matched.map((row) => ({
    syohin_code: row.productCode,
    zaiko_su: row.incomingQuantity,
    kataban: row.remainingPairs.map((pair) => pair.order).join('/'),
  }))
}

export function buildKintoneRows(matchResult: MatchResult): KintoneUpdateRow[] {
  return matchResult.matched.map((row) => {
    const values: KintoneUpdateRow = {
      商品番号: row.productCode,
      オーダー1: '',
      RM1: '',
      オーダー2: '',
      RM2: '',
      オーダー3: '',
      RM3: '',
      オーダー4: '',
      RM4: '',
      オーダー5: '',
      RM5: '',
    }

    for (let i = 0; i < 5; i += 1) {
      const pair = row.remainingPairs[i]
      values[`オーダー${i + 1}` as keyof KintoneUpdateRow] = pair?.order ?? ''
      values[`RM${i + 1}` as keyof KintoneUpdateRow] = pair?.rm ?? ''
    }

    return values
  })
}

function floorSortValue(value: string): [number, string] {
  const matched = value.match(/(\d+)/)
  if (matched) return [Number(matched[1]), value]
  return [999999, value]
}

export function buildNyukoRows(extracted: ExtractedRow[], masters: MasterRecord[]): NyukoListRow[] {
  const masterIndex = new Map<string, MasterRecord>()
  for (const master of masters) {
    if (!masterIndex.has(master.productCodeLc)) masterIndex.set(master.productCodeLc, master)
  }

  const grouped = groupExtracted(extracted)
  const rows: NyukoListRow[] = []

  for (const [productCodeLc, incomingRows] of grouped.entries()) {
    const productCode = incomingRows[0]?.productCode ?? productCodeLc
    const quantity = incomingRows.reduce((sum, row) => sum + row.quantity, 0)
    const master = masterIndex.get(productCodeLc)

    rows.push({
      商品コード: productCode,
      商品名: master?.productName || '(商品情報未登録)',
      入庫数: quantity,
      階数: master?.floor || '',
      備考: master ? '' : '商品情報.csvに該当なし',
    })
  }

  return rows.sort((a, b) => {
    const [aFloor, aFloorText] = floorSortValue(a.階数)
    const [bFloor, bFloorText] = floorSortValue(b.階数)
    if (aFloor !== bFloor) return aFloor - bFloor
    const floorTextCompare = aFloorText.localeCompare(bFloorText)
    if (floorTextCompare !== 0) return floorTextCompare
    return a.商品コード.toLowerCase().localeCompare(b.商品コード.toLowerCase())
  })
}
