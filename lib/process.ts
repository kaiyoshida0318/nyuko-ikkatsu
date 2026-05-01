import { buildKintoneRows, buildNeRows, buildNyukoRows, matchAndConsume } from './matcher'
import { parseMasterCsv, parseOrderCsv, parsePackingFiles } from './parser'
import type { ProcessResult, SelectedFiles } from './types'

export async function runNyukoProcess(files: SelectedFiles): Promise<ProcessResult> {
  if (files.packingFiles.length === 0) {
    throw new Error('ラクマート配送依頼書 P~.xlsx を選択してください。')
  }
  if (!files.orderFile) {
    throw new Error('オーダー状況CSVを選択してください。')
  }
  if (!files.masterFile) {
    throw new Error('商品情報.csvを選択してください。')
  }

  const [extracted, orders, masters] = await Promise.all([
    parsePackingFiles(files.packingFiles),
    parseOrderCsv(files.orderFile),
    parseMasterCsv(files.masterFile),
  ])

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
