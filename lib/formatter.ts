import JSZip from 'jszip'
import * as XLSX from 'xlsx'
import { makeCp932Blob } from './encoding'
import { KintoneUpdateRow, NeUpdateRow, NyukoListRow, OtherPackingRow, ProcessResult } from './types'

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

function buildNyukoSheetData(rows: NyukoListRow[], otherRows: OtherPackingRow[]): unknown[][] {
  const headers = ['商品コード', '商品名', '入庫数', '階数', '備考']
  const data: unknown[][] = [
    headers,
    ...rows.map((row) => headers.map((header) => row[header as keyof NyukoListRow])),
  ]

  if (otherRows.length > 0) {
    data.push([])
    data.push(['その他'])
    data.push(['分類', '品名', '梱包数', '備考'])
    for (const row of otherRows) {
      data.push([
        row.category,
        row.itemName,
        row.packingQuantity ?? '',
        row.note,
      ])
    }
  }

  return data
}

export function makeNyukoXlsxBlob(rows: NyukoListRow[], otherRows: OtherPackingRow[] = []): Blob {
  const data = buildNyukoSheetData(rows, otherRows)
  const worksheet = XLSX.utils.aoa_to_sheet(data)
  worksheet['!cols'] = [
    { wch: 22 },
    { wch: 35 },
    { wch: 8 },
    { wch: 12 },
    { wch: 45 },
  ]

  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, worksheet, '入庫リスト')
  const arrayBuffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer
  return new Blob([arrayBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
}

function dataUrlToBase64(dataUrl: string): string {
  const commaIndex = dataUrl.indexOf(',')
  return commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : dataUrl
}

export async function makeZipBlob(result: ProcessResult): Promise<Blob> {
  const zip = new JSZip()
  zip.file('NE更新.csv', makeNeCsvBlob(result.neRows))
  zip.file('kintone更新.csv', makeKintoneCsvBlob(result.kintoneRows))
  zip.file('入庫リスト.xlsx', makeNyukoXlsxBlob(result.nyukoRows, result.otherRows))

  result.otherRows.forEach((row, index) => {
    if (!row.image) return
    const extension = row.image.mimeType === 'image/jpeg' ? 'jpg' : row.image.mimeType === 'image/webp' ? 'webp' : 'png'
    const fileName = `${String(index + 1).padStart(3, '0')}_${row.sourceFile.replace(/[^a-zA-Z0-9._-]/g, '_')}_${row.sourceRowNumber}.${extension}`
    zip.file(`その他画像/${fileName}`, dataUrlToBase64(row.image.dataUrl), { base64: true })
  })

  return zip.generateAsync({ type: 'blob' })
}
