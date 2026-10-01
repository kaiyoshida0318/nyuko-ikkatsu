import * as XLSX from "xlsx";
import type {
  CostBox,
  CostLine,
  CostLineBox,
  CostToken,
  ShipmentCostSource,
} from "./costTypes";

// 原価計算用に「配送依頼書詳細」シートを読む。
// 入庫数・消し込みは従来どおり「梱包リスト」(parser.ts) を正とし、
// ここでは単価・出荷数・国内運賃・オプション費用・所在箱・箱の決済重量・レート・国際運賃だけを読む。

export const COST_SHEET_NAME = "配送依頼書詳細";

const NOTE_PATTERN = /●([^▲\s]+)▲(\d{4})-(\d+)/g;
const BOX_PATTERN = /NO\s*(\d+)\s*[：:]\s*(\d+)/g;

type Cell = string | number | boolean | Date | null | undefined;

function text(value: Cell): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function num(value: Cell): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const parsed = Number(String(value).replace(/,/g, "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function findCell(
  rows: Cell[][],
  label: string,
  fromRow = 0,
  toRow = rows.length,
): { r: number; c: number } | null {
  for (let r = fromRow; r < Math.min(toRow, rows.length); r += 1) {
    const row = rows[r] ?? [];
    for (let c = 0; c < row.length; c += 1) {
      if (text(row[c]) === label) return { r, c };
    }
  }
  return null;
}

function valueRightOf(rows: Cell[][], label: string, fromRow = 0): number | null {
  const pos = findCell(rows, label, fromRow);
  if (!pos) return null;
  return num(rows[pos.r]?.[pos.c + 1]);
}

function valueBelow(rows: Cell[][], label: string, toRow: number): number | null {
  const pos = findCell(rows, label, 0, toRow);
  if (!pos) return null;
  return num(rows[pos.r + 1]?.[pos.c]);
}

export function parseNoteTokens(note: string): CostToken[] {
  NOTE_PATTERN.lastIndex = 0;
  const tokens: CostToken[] = [];
  const seen = new Set<string>();
  for (const match of note.matchAll(NOTE_PATTERN)) {
    const productCode = match[1].trim();
    const mmdd = match[2];
    const quantity = Number(match[3]);
    if (!productCode || !Number.isFinite(quantity)) continue;
    const productCodeLc = productCode.toLowerCase();
    const rowId = `${productCodeLc}__${mmdd}__${quantity}`;
    if (seen.has(rowId)) continue;
    seen.add(rowId);
    tokens.push({ productCode, productCodeLc, mmdd, quantity, rowId });
  }
  return tokens;
}

export function parseBoxes(value: string): CostLineBox[] {
  BOX_PATTERN.lastIndex = 0;
  const boxes: CostLineBox[] = [];
  for (const match of value.matchAll(BOX_PATTERN)) {
    const boxNo = Number(match[1]);
    const qty = Number(match[2]);
    if (Number.isFinite(boxNo) && Number.isFinite(qty) && qty > 0) {
      boxes.push({ boxNo, qty });
    }
  }
  return boxes;
}

export function parseCostSheetRows(
  rows: Cell[][],
  sourceFile: string,
): ShipmentCostSource {
  const warnings: string[] = [];

  // 明細ヘッダー行（「箱詰め備考」と「単価（元）」がある行）
  let headerRow = -1;
  for (let r = 0; r < Math.min(rows.length, 30); r += 1) {
    const cells = (rows[r] ?? []).map(text);
    if (cells.includes("箱詰め備考") && cells.includes("単価（元）")) {
      headerRow = r;
      break;
    }
  }
  if (headerRow < 0) {
    throw new Error(`${sourceFile}: 「${COST_SHEET_NAME}」の明細ヘッダーが見つかりません。`);
  }

  const header = (rows[headerRow] ?? []).map(text);
  const col = (name: string) => header.indexOf(name);
  const cShipment = col("配送依頼書");
  const cLineNo = col("配送依頼書NO");
  const cOrderNo = col("注文番号");
  const cItemNo = col("商品番号");
  const cInfo = col("商品情報");
  const cPurchase = col("購入数");
  const cShip = col("出荷数");
  const cPrice = col("単価（元）");
  const cDomestic = col("国内運賃（元）");
  const cOption = col("オプション費用");
  const cNote = col("箱詰め備考");
  const cBox = col("所在箱");

  for (const [name, index] of [
    ["配送依頼書NO", cLineNo],
    ["出荷数", cShip],
    ["単価（元）", cPrice],
    ["国内運賃（元）", cDomestic],
    ["箱詰め備考", cNote],
  ] as const) {
    if (index < 0) throw new Error(`${sourceFile}: 「${name}」列が見つかりません。`);
  }
  if (cOption < 0) warnings.push("「オプション費用」列が見つからないため、オプション費用は0として計算します。");
  if (cBox < 0) warnings.push("「所在箱」列が見つからないため、国際送料は金額比で配分します。");

  const lines: CostLine[] = [];
  let shipmentId = "";
  let r = headerRow + 1;
  for (; r < rows.length; r += 1) {
    const row = rows[r] ?? [];
    const lineNo = num(row[cLineNo]);
    if (lineNo === null) break;
    if (!shipmentId && cShipment >= 0) shipmentId = text(row[cShipment]);
    const note = text(row[cNote]);
    lines.push({
      lineNo,
      orderNo: cOrderNo >= 0 ? text(row[cOrderNo]) : "",
      itemNo: cItemNo >= 0 ? text(row[cItemNo]) : "",
      productInfo: cInfo >= 0 ? text(row[cInfo]) : "",
      purchaseQty: (cPurchase >= 0 ? num(row[cPurchase]) : null) ?? 0,
      shipQty: num(row[cShip]) ?? 0,
      unitPriceCny: num(row[cPrice]) ?? 0,
      domesticCny: num(row[cDomestic]) ?? 0,
      optionCny: (cOption >= 0 ? num(row[cOption]) : null) ?? 0,
      note,
      tokens: parseNoteTokens(note),
      boxes: cBox >= 0 ? parseBoxes(text(row[cBox])) : [],
    });
  }

  if (!shipmentId) {
    for (const cell of (rows[0] ?? []).map(text)) {
      const match = cell.match(/P\d{10,}-\d+/);
      if (match) {
        shipmentId = match[0];
        break;
      }
    }
  }
  if (!shipmentId) shipmentId = sourceFile.replace(/\.xlsx$/i, "");

  // 上部サマリー（ラベル行の1つ下が値）
  const rate = valueBelow(rows, "配送依頼書レート", headerRow);
  if (rate === null || rate <= 0) {
    throw new Error(`${sourceFile}: 「配送依頼書レート」が読み取れません。`);
  }

  // 下部：箱一覧（箱NO / 決済重量）
  const boxes: CostBox[] = [];
  const boxHeader = findCell(rows, "決済重量（KG）", r);
  if (boxHeader) {
    const boxHeaderCells = (rows[boxHeader.r] ?? []).map(text);
    const cBoxNo = boxHeaderCells.indexOf("箱NO");
    for (let br = boxHeader.r + 1; br < rows.length; br += 1) {
      const row = rows[br] ?? [];
      const boxNo = num(row[cBoxNo >= 0 ? cBoxNo : 0]);
      const kg = num(row[boxHeader.c]);
      if (boxNo === null || kg === null) break;
      boxes.push({ boxNo, chargeableKg: kg });
    }
  }
  if (boxes.length === 0) warnings.push("箱の決済重量が読み取れないため、国際送料は金額比で配分します。");

  const intl = valueRightOf(rows, "国際運賃（円）", r);
  if (intl === null) warnings.push("「国際運賃（円）」が読み取れないため、国際送料は0円として計算します。");

  return {
    shipmentId,
    sourceFile,
    rate,
    intlFreightJpy: intl ?? 0,
    agencyFeeJpy: valueRightOf(rows, "代行手数料（円）", r) ?? 0,
    otherFeeJpy: valueRightOf(rows, "その他（円）", r) ?? 0,
    boxes,
    lines,
    parseWarnings: warnings,
  };
}

export function parseCostWorkbook(
  buffer: ArrayBuffer,
  sourceFile: string,
): ShipmentCostSource | null {
  const workbook = XLSX.read(buffer, { type: "array" });
  const sheet = workbook.Sheets[COST_SHEET_NAME];
  if (!sheet) return null;
  const rows = XLSX.utils.sheet_to_json<Cell[]>(sheet, {
    header: 1,
    raw: true,
    defval: null,
    blankrows: true,
  });
  return parseCostSheetRows(rows, sourceFile);
}

export async function parseCostFiles(files: File[]): Promise<{
  sources: ShipmentCostSource[];
  errors: string[];
}> {
  const sources: ShipmentCostSource[] = [];
  const errors: string[] = [];
  for (const file of files) {
    try {
      const source = parseCostWorkbook(await file.arrayBuffer(), file.name);
      if (source) sources.push(source);
      else errors.push(`${file.name}: 「${COST_SHEET_NAME}」シートがないため原価計算の対象外です。`);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : `${file.name}: 原価データを読み取れませんでした。`);
    }
  }
  return { sources, errors };
}
