export type FileRole = 'packing' | 'orders' | 'master' | 'unknown'

export type SelectedFiles = {
  packingFiles: File[]
  orderFile: File | null
  masterFile: File | null
}

export type ExtractedRow = {
  productCode: string
  productCodeLc: string
  mmdd: string
  quantity: number
  key: string
  sourceNote: string
  sourceFile: string
}

export type OrderRecord = {
  productCode: string
  productCodeLc: string
  productName: string
  orders: (string | null)[]
  rms: (string | null)[]
  raw: Record<string, string | null>
}

export type MasterRecord = {
  productCode: string
  productCodeLc: string
  productName: string
  floor: string
}

export type WarningType = 'no_product' | 'no_key'

export type MatchWarning = {
  type: WarningType
  productCode: string
  key?: string
  deliveredKeys: string[]
  currentOrders?: string[]
  message: string
}

export type MatchedProduct = {
  productCode: string
  productCodeLc: string
  deliveredKeys: string[]
  incomingQuantity: number
  remainingPairs: { order: string; rm: string | null }[]
}

export type MatchResult = {
  matched: MatchedProduct[]
  warnings: MatchWarning[]
}

export type NeUpdateRow = {
  syohin_code: string
  zaiko_su: number
  kataban: string
}

export type KintoneUpdateRow = {
  商品番号: string
  オーダー1: string
  RM1: string
  オーダー2: string
  RM2: string
  オーダー3: string
  RM3: string
  オーダー4: string
  RM4: string
  オーダー5: string
  RM5: string
}

export type NyukoListRow = {
  商品コード: string
  商品名: string
  入庫数: number
  階数: string
  備考: string
}

export type ProcessResult = {
  extracted: ExtractedRow[]
  matchResult: MatchResult
  neRows: NeUpdateRow[]
  kintoneRows: KintoneUpdateRow[]
  nyukoRows: NyukoListRow[]
}

export const ORDER_COLS = ['オーダー1', 'オーダー2', 'オーダー3', 'オーダー4', 'オーダー5'] as const
export const RM_COLS = ['RM1', 'RM2', 'RM3', 'RM4', 'RM5'] as const
