import { buildKintoneRows, buildNeRows, buildNyukoRows, matchAndConsume } from './matcher'
import { parsePackingFiles } from './parser'
import { fetchProductHubRecords } from './productHub'
import type { MasterRecord, OrderRecord, ProcessResult, ProductHubSettings, SelectedFiles } from './types'

export async function runNyukoProcess(files: SelectedFiles, productHubSettings: ProductHubSettings): Promise<ProcessResult> {
  if (files.packingFiles.length === 0) {
    throw new Error('ラクマート配送依頼書 P~.xlsx を選択してください。')
  }

  const extracted = await parsePackingFiles(files.packingFiles)
  const productCodes = [...new Set(extracted.map((row) => row.productCode))]
  const productRecords = await fetchProductHubRecords(productHubSettings, productCodes)

  const orders: OrderRecord[] = productRecords.map((record) => ({
    productCode: record.productCode,
    productCodeLc: record.productCodeLc,
    productName: record.productName,
    orders: record.orders,
    rms: record.rms,
  }))

  const masters: MasterRecord[] = productRecords.map((record) => ({
    productCode: record.productCode,
    productCodeLc: record.productCodeLc,
    productName: record.productName,
    floor: record.floor,
  }))

  const matchResult = matchAndConsume(extracted, orders)
  const neRows = buildNeRows(matchResult)
  const kintoneRows = buildKintoneRows(matchResult)
  const nyukoRows = buildNyukoRows(extracted, masters)

  return {
    extracted,
    matchResult,
    neRows,
    kintoneRows,
    nyukoRows,
  }
}
