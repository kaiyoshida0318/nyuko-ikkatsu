import {
  buildProductDbUpdateRows,
  buildNeRows,
  buildNyukoRows,
  matchAndConsume,
} from "./matcher";
import { parsePackingFiles } from "./parser";
import { fetchProductHubRecords } from "./productHub";
import type {
  ExtractedRow,
  MasterRecord,
  OrderRecord,
  OtherPackingRow,
  ProcessResult,
  ProductHubSettings,
  RowCorrectionMap,
  SelectedFiles,
} from "./types";

function normalizeProductCode(value: string, fallback: string): string {
  const text = value.trim();
  return text || fallback;
}

function normalizeMmdd(value: string, fallback: string): string {
  const text = value.replace(/\D/g, "").slice(0, 4);
  return text.length === 4 ? text : fallback;
}

function normalizeQuantity(value: string, fallback: number): number {
  const number = Number(String(value).replace(/,/g, "").trim());
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.trunc(number);
}

function applyCorrections(
  extracted: ExtractedRow[],
  corrections: RowCorrectionMap,
): ExtractedRow[] {
  return extracted.flatMap((row) => {
    const correction = corrections[row.rowId];
    if (!correction) return [row];
    if (correction.deleted) return [];

    const productCode = normalizeProductCode(
      correction.productCode ?? "",
      row.productCode,
    );
    const mmdd = normalizeMmdd(correction.mmdd ?? "", row.mmdd);
    const quantity = normalizeQuantity(correction.quantity ?? "", row.quantity);
    // 手動修正後も、出力数量は梱包数ではなく修正後の備考数量に揃える。
    const receivedQuantity = quantity;
    const key = `${mmdd}-${quantity}`;
    const quantityMismatch =
      row.packingQuantities.length > 0 &&
      !row.packingQuantities.includes(quantity);

    return [{
      ...row,
      productCode,
      productCodeLc: productCode.toLowerCase(),
      mmdd,
      quantity,
      receivedQuantity,
      key,
      quantityMismatch,
    }];
  });
}

function getOptionalCorrectionValue(
  value: string | undefined,
  fallback: string,
): string {
  return value === undefined ? fallback : value;
}

function applyOtherCorrections(
  rows: OtherPackingRow[],
  corrections: RowCorrectionMap,
): OtherPackingRow[] {
  return rows.flatMap((row) => {
    const correction = corrections[row.rowId];
    if (!correction) return [row];
    if (correction.deleted) return [];

    return [{
      ...row,
      category: getOptionalCorrectionValue(correction.category, row.category),
      itemName: getOptionalCorrectionValue(correction.itemName, row.itemName),
      note: getOptionalCorrectionValue(correction.note, row.note),
    }];
  });
}

export async function runNyukoProcess(
  files: SelectedFiles,
  productHubSettings: ProductHubSettings,
  corrections: RowCorrectionMap = {},
  manualRows: ExtractedRow[] = [],
): Promise<ProcessResult> {
  if (files.packingFiles.length === 0) {
    throw new Error("ラクマート配送依頼書 P~.xlsx を選択してください。");
  }

  const parsed = await parsePackingFiles(files.packingFiles);
  const parsedAndManualRows = [...parsed.extracted, ...manualRows];
  const extracted = applyCorrections(parsedAndManualRows, corrections);
  const otherRows = applyOtherCorrections(parsed.otherRows, corrections);
  const productCodes = [...new Set(extracted.map((row) => row.productCode))];
  const productRecords = await fetchProductHubRecords(
    productHubSettings,
    productCodes,
  );

  const orders: OrderRecord[] = productRecords.map((record) => ({
    productCode: record.productCode,
    productCodeLc: record.productCodeLc,
    productName: record.productName,
    orders: record.orders,
    rms: record.rms,
  }));

  const masters: MasterRecord[] = productRecords.map((record) => ({
    productCode: record.productCode,
    productCodeLc: record.productCodeLc,
    productName: record.productName,
    floor: record.floor,
  }));

  const matchResult = matchAndConsume(extracted, orders);
  const neRows = buildNeRows(matchResult);
  const productDbUpdateRows = buildProductDbUpdateRows(matchResult);
  const nyukoRows = buildNyukoRows(extracted, masters);

  return {
    extracted,
    otherRows,
    productHubRecords: productRecords,
    matchResult,
    neRows,
    productDbUpdateRows,
    nyukoRows,
  };
}
