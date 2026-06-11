import JSZip from 'jszip'
import * as XLSX from 'xlsx'
import { makeCp932Blob } from './encoding'
import { NeUpdateRow, NyukoListRow, OtherPackingRow, ProcessResult } from './types'

const NYUKO_HEADERS = ['階数', '棚-段', 'シール', '商品コード', '商品名', '入庫数', '備考'] as const
const OTHER_HEADERS = ['分類', '品名', '梱包数', '備考', ''] as const
const NYUKO_COLUMN_COUNT = NYUKO_HEADERS.length

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

function getFloorSortKey(floor: unknown): { group: number; value: number; text: string } {
  const text = String(floor ?? '').trim()
  if (!text) return { group: 1, value: Number.POSITIVE_INFINITY, text: '' }

  const normalized = text.toUpperCase().replace(/\s+/g, '')
  const basementMatch = normalized.match(/^B(\d+)/)
  if (basementMatch) return { group: 0, value: -Number(basementMatch[1]), text: normalized }

  const numberMatch = normalized.match(/(\d+)/)
  if (numberMatch) return { group: 0, value: Number(numberMatch[1]), text: normalized }

  return { group: 0, value: Number.POSITIVE_INFINITY, text: normalized }
}

function compareNyukoRows(a: NyukoListRow, b: NyukoListRow): number {
  const floorA = getFloorSortKey(a.階数)
  const floorB = getFloorSortKey(b.階数)

  if (floorA.group !== floorB.group) return floorA.group - floorB.group
  if (floorA.value !== floorB.value) return floorA.value - floorB.value

  const floorTextCompare = floorA.text.localeCompare(floorB.text, 'ja', { numeric: true, sensitivity: 'base' })
  if (floorTextCompare !== 0) return floorTextCompare

  return String(a.商品コード ?? '').localeCompare(String(b.商品コード ?? ''), 'ja', {
    numeric: true,
    sensitivity: 'base',
  })
}

function padSheetRow(row: unknown[]): unknown[] {
  return Array.from({ length: NYUKO_COLUMN_COUNT }, (_, index) => row[index] ?? '')
}

function sanitizeExcelCellValue(value: unknown): unknown {
  if (typeof value !== 'string') return value
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
}

function buildNyukoSheetData(rows: NyukoListRow[], otherRows: OtherPackingRow[]): unknown[][] {
  const sortedRows = [...rows].sort(compareNyukoRows)
  const data: unknown[][] = [
    [...NYUKO_HEADERS],
    ...sortedRows.map((row) => NYUKO_HEADERS.map((header) => row[header])),
  ]

  if (otherRows.length > 0) {
    data.push(Array(NYUKO_COLUMN_COUNT).fill(''))
    data.push(['その他', ...Array(NYUKO_COLUMN_COUNT - 1).fill('')])
    data.push([...OTHER_HEADERS])
    for (const row of otherRows) {
      data.push(padSheetRow([
        row.category,
        row.itemName,
        row.packingQuantity ?? '',
        row.note,
        '',
      ]))
    }
  }

  return data.map((row) => padSheetRow(row).map(sanitizeExcelCellValue))
}

function getDisplayWidth(value: unknown): number {
  return String(value ?? '')
    .split(/\r?\n/)
    .reduce((max, line) => {
      let width = 0
      for (const char of line) {
        width += char.charCodeAt(0) <= 0xff ? 1 : 2
      }
      return Math.max(max, width)
    }, 0)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function buildNyukoColumnWidths(data: unknown[][]): XLSX.ColInfo[] {
  const fixedWidths: Record<number, number> = {
    0: 6,
    1: 8,
    2: 7,
    5: 8,
    6: 35,
  }
  const minimums = [6, 8, 7, 22, 36, 8, 35]
  const maximums = [6, 8, 7, 36, 60, 8, 35]

  return minimums.map((minimum, columnIndex) => {
    const fixedWidth = fixedWidths[columnIndex]
    if (fixedWidth !== undefined) return { wch: fixedWidth }

    const maxContentWidth = data.reduce((max, row) => Math.max(max, getDisplayWidth(row[columnIndex])), 0)
    return { wch: clamp(maxContentWidth + 4, minimum, maximums[columnIndex]) }
  })
}

function buildNyukoStylesXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="3">
    <font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>
    <font><sz val="12"/><color rgb="FF111827"/><name val="Meiryo"/><family val="2"/></font>
    <font><b/><sz val="12"/><color rgb="FF111827"/><name val="Meiryo"/><family val="2"/></font>
  </fonts>
  <fills count="3">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFD9D9D9"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border>
      <left style="thin"><color rgb="FFB7B7B7"/></left>
      <right style="thin"><color rgb="FFB7B7B7"/></right>
      <top style="thin"><color rgb="FFB7B7B7"/></top>
      <bottom style="thin"><color rgb="FFB7B7B7"/></bottom>
      <diagonal/>
    </border>
  </borders>
  <cellStyleXfs count="1">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
  </cellStyleXfs>
  <cellXfs count="5">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
  <dxfs count="0"/>
  <tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>
</styleSheet>`
}

function getCellRowNumber(cellRef: string): number {
  const match = cellRef.match(/\d+/)
  return match ? Number(match[0]) : 0
}

function getCellColumn(cellRef: string): string {
  const match = cellRef.match(/[A-Z]+/i)
  return match ? match[0].toUpperCase() : ''
}

function getNyukoStyleIndex(cellRef: string, mainRowCount: number, hasOtherRows: boolean): number {
  const rowNumber = getCellRowNumber(cellRef)
  const column = getCellColumn(cellRef)

  if (rowNumber === 1) return 3

  const mainDataEndRow = mainRowCount + 1
  if (rowNumber >= 2 && rowNumber <= mainDataEndRow) {
    return ['A', 'B', 'C', 'F'].includes(column) ? 2 : 1
  }

  if (!hasOtherRows) return ['A', 'B', 'C', 'F'].includes(column) ? 2 : 1

  const otherTitleRow = mainRowCount + 3
  const otherHeaderRow = mainRowCount + 4

  if (rowNumber === otherTitleRow) return column === 'A' ? 4 : 1
  if (rowNumber === otherHeaderRow) return 3
  if (rowNumber > otherHeaderRow) return column === 'C' ? 2 : 1

  return 1
}

function applyCellStyles(sheetXml: string, mainRowCount: number, hasOtherRows: boolean): string {
  return sheetXml.replace(/<c\b([^>]*\br="([^"]+)"[^>]*?)(\/?)>/g, (match, attributes: string, cellRef: string, selfClosing: string) => {
    const styleIndex = getNyukoStyleIndex(cellRef, mainRowCount, hasOtherRows)
    const cleanedAttributes = attributes.replace(/\s*\/\s*$/, '')
    const styledAttributes = /\bs="\d+"/.test(cleanedAttributes)
      ? cleanedAttributes.replace(/\bs="\d+"/, `s="${styleIndex}"`)
      : `${cleanedAttributes} s="${styleIndex}"`

    return `<c${styledAttributes}${selfClosing ? '/>' : '>'}`
  })
}

function applyRowHeights(sheetXml: string, mainRowCount: number, hasOtherRows: boolean): string {
  const otherTitleRow = mainRowCount + 3
  const otherHeaderRow = mainRowCount + 4

  return sheetXml.replace(/<row\b([^>]*\br="(\d+)"[^>]*?)(\/?)>/g, (match, attributes: string, rowText: string, selfClosing: string) => {
    const rowNumber = Number(rowText)
    const height = rowNumber === 1 || (hasOtherRows && rowNumber === otherHeaderRow) ? 24 : hasOtherRows && rowNumber === otherTitleRow ? 24 : 22
    const withoutHeight = attributes
      .replace(/\s*\/\s*$/, '')
      .replace(/\sht="[^"]*"/g, '')
      .replace(/\scustomHeight="[^"]*"/g, '')
    return `<row${withoutHeight} ht="${height}" customHeight="1"${selfClosing ? '/>' : '>'}`
  })
}

function insertWorksheetChildAfter(xml: string, childXml: string, markerRegex: RegExp): string {
  const match = xml.match(markerRegex)
  if (match?.index !== undefined) {
    const insertPosition = match.index + match[0].length
    return `${xml.slice(0, insertPosition)}${childXml}${xml.slice(insertPosition)}`
  }

  return xml.replace(/(<worksheet[^>]*>)/, `$1${childXml}`)
}

function applySheetView(sheetXml: string): string {
  const sheetViewXml = '<sheetViews><sheetView workbookViewId="0" view="pageBreakPreview"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>'

  if (/<sheetViews>[\s\S]*?<\/sheetViews>/.test(sheetXml)) {
    return sheetXml.replace(/<sheetViews>[\s\S]*?<\/sheetViews>/, sheetViewXml)
  }

  return insertWorksheetChildAfter(sheetXml, sheetViewXml, /<dimension\b[^>]*\/>/)
}

function applySheetPrFitToPage(sheetXml: string): string {
  const pageSetUpPrXml = '<pageSetUpPr fitToPage="1"/>'

  if (/<sheetPr\b[^>]*>[\s\S]*?<\/sheetPr>/.test(sheetXml)) {
    return sheetXml.replace(/<sheetPr\b([^>]*)>([\s\S]*?)<\/sheetPr>/, (_match, attributes: string, innerXml: string) => {
      const cleanedInnerXml = innerXml
        .replace(/<pageSetUpPr\b[^>]*\/>/g, '')
        .replace(/<pageSetUpPr\b[^>]*>[\s\S]*?<\/pageSetUpPr>/g, '')
      return `<sheetPr${attributes}>${cleanedInnerXml}${pageSetUpPrXml}</sheetPr>`
    })
  }

  if (/<sheetPr\b[^>]*\/>/.test(sheetXml)) {
    return sheetXml.replace(/<sheetPr\b([^>]*)\/>/, (_match, attributes: string) => {
      return `<sheetPr${attributes}>${pageSetUpPrXml}</sheetPr>`
    })
  }

  return sheetXml.replace(/(<worksheet\b[^>]*>)/, `$1<sheetPr>${pageSetUpPrXml}</sheetPr>`)
}

function insertBeforeWorksheetTail(xml: string, childXml: string): string {
  const tailMarkerRegex = /<(headerFooter|rowBreaks|colBreaks|customProperties|cellWatches|ignoredErrors|smartTags|drawing|legacyDrawing|legacyDrawingHF|picture|oleObjects|controls|webPublishItems|tableParts|extLst)\b/
  const tailMarker = xml.match(tailMarkerRegex)

  if (tailMarker?.index !== undefined) {
    return `${xml.slice(0, tailMarker.index)}${childXml}${xml.slice(tailMarker.index)}`
  }

  return xml.replace(/<\/worksheet>$/, `${childXml}</worksheet>`)
}

function applyPrintSettings(sheetXml: string): string {
  let xml = applySheetPrFitToPage(sheetXml)

  const printOptions = '<printOptions horizontalCentered="1"/>'
  const pageMargins = '<pageMargins left="0.25" right="0.25" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>'
  const pageSetup = '<pageSetup paperSize="9" orientation="portrait" fitToWidth="1" fitToHeight="0"/>'

  xml = xml
    .replace(/<printOptions\b[^>]*\/>/g, '')
    .replace(/<pageMargins\b[^>]*\/>/g, '')
    .replace(/<pageSetup\b[^>]*\/>/g, '')

  return insertBeforeWorksheetTail(xml, `${printOptions}${pageMargins}${pageSetup}`)
}

async function styleNyukoWorkbook(arrayBuffer: ArrayBuffer, mainRowCount: number, hasOtherRows: boolean): Promise<ArrayBuffer> {
  const zip = await JSZip.loadAsync(arrayBuffer)
  const sheetFile = zip.file('xl/worksheets/sheet1.xml')
  if (!sheetFile) return arrayBuffer

  let sheetXml = await sheetFile.async('string')
  sheetXml = applyCellStyles(sheetXml, mainRowCount, hasOtherRows)
  sheetXml = applyRowHeights(sheetXml, mainRowCount, hasOtherRows)
  sheetXml = applySheetView(sheetXml)
  sheetXml = applyPrintSettings(sheetXml)

  zip.file('xl/styles.xml', buildNyukoStylesXml())
  zip.file('xl/worksheets/sheet1.xml', sheetXml)

  return zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' })
}

export async function makeNyukoXlsxBlob(rows: NyukoListRow[], otherRows: OtherPackingRow[] = []): Promise<Blob> {
  const data = buildNyukoSheetData(rows, otherRows)
  const worksheet = XLSX.utils.aoa_to_sheet(data)
  worksheet['!cols'] = buildNyukoColumnWidths(data)

  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, worksheet, '入庫リスト')
  const arrayBuffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer
  const styledArrayBuffer = await styleNyukoWorkbook(arrayBuffer, rows.length, otherRows.length > 0)

  return new Blob([styledArrayBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
}

function dataUrlToBase64(dataUrl: string): string {
  const commaIndex = dataUrl.indexOf(',')
  return commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : dataUrl
}

export async function makeZipBlob(result: ProcessResult): Promise<Blob> {
  const zip = new JSZip()
  zip.file('NE更新.csv', makeNeCsvBlob(result.neRows))
  zip.file('入庫リスト.xlsx', await makeNyukoXlsxBlob(result.nyukoRows, result.otherRows))

  result.otherRows.forEach((row, index) => {
    if (!row.image) return
    const extension = row.image.mimeType === 'image/jpeg' ? 'jpg' : row.image.mimeType === 'image/webp' ? 'webp' : 'png'
    const fileName = `${String(index + 1).padStart(3, '0')}_${row.sourceFile.replace(/[^a-zA-Z0-9._-]/g, '_')}_${row.sourceRowNumber}.${extension}`
    zip.file(`その他画像/${fileName}`, dataUrlToBase64(row.image.dataUrl), { base64: true })
  })

  return zip.generateAsync({ type: 'blob' })
}
