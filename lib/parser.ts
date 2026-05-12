import Papa from "papaparse";
import * as XLSX from "xlsx";
import { readTextFlexible } from "./encoding";
import {
  ExtractedRow,
  MasterRecord,
  OrderRecord,
  ORDER_COLS,
  RM_COLS,
} from "./types";

const NOTE_PATTERN = /●([^▲\s]+)▲(\d{4})-(\d+)/g;

function normalizeCell(value: unknown): string | null {
  const text = String(value ?? "").trim();
  if (!text || text === "■" || text === "nan" || text === "None") return null;
  return text;
}

function normalizeNumber(value: unknown): number | null {
  const text = String(value ?? "")
    .replace(/,/g, "")
    .trim();
  if (!text || text === "■" || text === "nan" || text === "None") return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function parseCsvText(text: string): Record<string, string | null>[] {
  const result = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (header) => header.trim(),
  });

  if (result.errors.length > 0) {
    const first = result.errors[0];
    throw new Error(`CSVを読み取れませんでした: ${first.message}`);
  }

  return result.data.map((row) => {
    const normalized: Record<string, string | null> = {};
    for (const [key, value] of Object.entries(row)) {
      normalized[String(key).trim()] = normalizeCell(value);
    }
    return normalized;
  });
}

type PackingAccumulator = {
  productCode: string;
  productCodeLc: string;
  mmdd: string;
  quantity: number;
  key: string;
  sourceNote: string;
  sourceFile: string;
  packedGroups: Map<string, number>;
};

function getColumnIndex(row: unknown[], headerName: string): number {
  return row.findIndex((cell) => String(cell ?? "").trim() === headerName);
}

export async function parsePackingFiles(
  files: File[],
): Promise<ExtractedRow[]> {
  const unique = new Map<string, PackingAccumulator>();

  for (const file of files) {
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: "array" });
    const sheet = workbook.Sheets["梱包リスト"];
    if (!sheet) {
      throw new Error(`${file.name}: 「梱包リスト」シートが見つかりません。`);
    }

    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      raw: false,
      defval: "",
      blankrows: false,
    });

    let headerRowIndex = -1;
    let noteColIndex = -1;
    let packingColIndex = -1;
    let orderNoColIndex = -1;
    let itemNoColIndex = -1;
    const scanLimit = Math.min(20, rows.length);

    for (let rowIndex = 0; rowIndex < scanLimit; rowIndex += 1) {
      const row = rows[rowIndex] ?? [];
      const foundCol = getColumnIndex(row, "箱詰め備考");
      if (foundCol >= 0) {
        headerRowIndex = rowIndex;
        noteColIndex = foundCol;
        packingColIndex = getColumnIndex(row, "梱包数");
        orderNoColIndex = getColumnIndex(row, "注文番号");
        itemNoColIndex = getColumnIndex(row, "商品番号");
        break;
      }
    }

    if (headerRowIndex < 0 || noteColIndex < 0) {
      throw new Error(`${file.name}: 「箱詰め備考」列が見つかりません。`);
    }

    for (
      let rowIndex = headerRowIndex + 1;
      rowIndex < rows.length;
      rowIndex += 1
    ) {
      const row = rows[rowIndex] ?? [];
      const note = String(row[noteColIndex] ?? "").trim();
      if (!note) continue;

      const packingQuantity =
        packingColIndex >= 0 ? normalizeNumber(row[packingColIndex]) : null;
      const orderNo =
        orderNoColIndex >= 0 ? String(row[orderNoColIndex] ?? "").trim() : "";
      const itemNo =
        itemNoColIndex >= 0 ? String(row[itemNoColIndex] ?? "").trim() : "";
      const packedGroupKey = `${orderNo || "order"}__${itemNo || `row${rowIndex}`}`;

      NOTE_PATTERN.lastIndex = 0;
      for (const match of note.matchAll(NOTE_PATTERN)) {
        const productCode = match[1].trim();
        const mmdd = match[2];
        const quantity = Number(match[3]);
        if (!productCode || !Number.isFinite(quantity)) continue;

        const productCodeLc = productCode.toLowerCase();
        const key = `${mmdd}-${quantity}`;
        const uniqueKey = `${productCodeLc}__${mmdd}__${quantity}`;
        const current = unique.get(uniqueKey) ?? {
          productCode,
          productCodeLc,
          mmdd,
          quantity,
          key,
          sourceNote: note,
          sourceFile: file.name,
          packedGroups: new Map<string, number>(),
        };

        if (packingQuantity !== null) {
          current.packedGroups.set(
            packedGroupKey,
            (current.packedGroups.get(packedGroupKey) ?? 0) + packingQuantity,
          );
        }

        unique.set(uniqueKey, current);
      }
    }
  }

  const extracted = [...unique.values()]
    .map((row) => {
      const packingQuantities = [
        ...new Set([...row.packedGroups.values()]),
      ].sort((a, b) => a - b);
      const quantityMismatch =
        packingQuantities.length > 0 &&
        !packingQuantities.includes(row.quantity);
      const rowId = `${row.productCodeLc}__${row.mmdd}__${row.quantity}`;

      return {
        rowId,
        productCode: row.productCode,
        productCodeLc: row.productCodeLc,
        mmdd: row.mmdd,
        quantity: row.quantity,
        key: row.key,
        packingQuantities,
        quantityMismatch,
        sourceNote: row.sourceNote,
        sourceFile: row.sourceFile,
      };
    })
    .sort((a, b) => {
      const codeCompare = a.productCodeLc.localeCompare(b.productCodeLc);
      if (codeCompare !== 0) return codeCompare;
      const mmddCompare = a.mmdd.localeCompare(b.mmdd);
      if (mmddCompare !== 0) return mmddCompare;
      return a.quantity - b.quantity;
    });

  if (extracted.length === 0) {
    throw new Error("P~.xlsx から入庫データを1件も抽出できませんでした。");
  }

  return extracted;
}

export async function parseOrderCsv(file: File): Promise<OrderRecord[]> {
  const text = await readTextFlexible(file);
  const rows = parseCsvText(text);

  const required = ["商品番号", ...ORDER_COLS, ...RM_COLS];
  const headers = rows[0] ? Object.keys(rows[0]) : [];
  const missing = required.filter((col) => !headers.includes(col));
  if (missing.length > 0) {
    throw new Error(
      `オーダー状況CSVに必要列がありません: ${missing.join(", ")}`,
    );
  }

  return rows
    .map((row) => {
      const productCode = normalizeCell(row["商品番号"]) ?? "";
      const orders = ORDER_COLS.map((col) => normalizeCell(row[col]));
      const rms = RM_COLS.map((col) => normalizeCell(row[col]));
      return {
        productCode,
        productCodeLc: productCode.toLowerCase(),
        productName: normalizeCell(row["商品名"]) ?? "",
        orders,
        rms,
        raw: row,
      };
    })
    .filter((row) => row.productCode);
}

export async function parseMasterCsv(file: File): Promise<MasterRecord[]> {
  const text = await readTextFlexible(file);
  const rows = parseCsvText(text);

  const required = ["商品番号", "出荷時商品名", "階数"];
  const headers = rows[0] ? Object.keys(rows[0]) : [];
  const missing = required.filter((col) => !headers.includes(col));
  if (missing.length > 0) {
    throw new Error(`商品情報.csv に必要列がありません: ${missing.join(", ")}`);
  }

  return rows
    .map((row) => {
      const productCode = normalizeCell(row["商品番号"]) ?? "";
      return {
        productCode,
        productCodeLc: productCode.toLowerCase(),
        productName: normalizeCell(row["出荷時商品名"]) ?? "",
        floor: normalizeCell(row["階数"]) ?? "",
      };
    })
    .filter((row) => row.productCode);
}
