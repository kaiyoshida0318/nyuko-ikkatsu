import JSZip from 'jszip'
import * as XLSX from 'xlsx'
import { makeCp932Blob } from './encoding'
import { KintoneUpdateRow, NeUpdateRow, NyukoListRow, ProcessResult } from './types'

function csvEscape(value: unknown): string {
  const text = String(value ?? '')
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

function toCsv(headers: string[], rows: Record<string, unknown>[]): string {
  const lines = [headers.map(csvEscape).join(',')]
  for (const row of rows) {
    lines.push(headers.map((header) => csvEscape(row[header])).join(','))
  }
  return lines.join('\r\n') + '\r\n'
}

export function makeNeCsvBlob(rows: NeUpdateRow[]): Blob {
  const csv = toCsv(['syohin_code', 'zaiko_su', 'kataban'], rows as unknown as Record<string, unknown>[])
  return makeCp932Blob(csv)
}

export function makeKintoneCsvBlob(rows: KintoneUpdateRow[]): Blob {
  const headers = ['商品番号', 'オーダー1', 'RM1', 'オーダー2', 'RM2', 'オーダー3', 'RM3', 'オーダー4', 'RM4', 'オーダー5', 'RM5']
  const csv = toCsv(headers, rows as unknown as Record<string, unknown>[])
  return makeCp932Blob(csv)
}

export function makeNyukoXlsxBlob(rows: NyukoListRow[]): Blob {
  const headers = ['商品コード', '商品名', '入庫数', '階数', '備考']
  const data = [headers, ...rows.map((row) => headers.map((header) => row[header as keyof NyukoListRow]))]
  const worksheet = XLSX.utils.aoa_to_sheet(data)
  worksheet['!cols'] = [
    { wch: 22 },
    { wch: 35 },
    { wch: 8 },
    { wch: 8 },
    { wch: 19 },
  ]

  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, worksheet, '入庫リスト')
  const arrayBuffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer
  return new Blob([arrayBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
}

export async function makeZipBlob(result: ProcessResult): Promise<Blob> {
  const zip = new JSZip()
  zip.file('NE更新.csv', makeNeCsvBlob(result.neRows))
  zip.file('kintone更新.csv', makeKintoneCsvBlob(result.kintoneRows))
  zip.file('入庫リスト.xlsx', makeNyukoXlsxBlob(result.nyukoRows))
  return zip.generateAsync({ type: 'blob' })
}
