import {
  buildKintoneRows,
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
  return extracted.map((row) => {
    const correction = corrections[row.rowId];
    if (!correction) return row;

    const productCode = normalizeProductCode(
      correction.productCode ?? "",
      row.productCode,
    );
    const mmdd = normalizeMmdd(correction.mmdd ?? "", row.mmdd);
    const quantity = normalizeQuantity(correction.quantity ?? "", row.quantity);
    const key = `${mmdd}-${quantity}`;
    const quantityMismatch =
      row.packingQuantities.length > 0 &&
      !row.packingQuantities.includes(quantity);

    return {
      ...row,
      productCode,
      productCodeLc: productCode.toLowerCase(),
      mmdd,
      quantity,
      key,
      quantityMismatch,
    };
  });
}

export async function runNyukoProcess(
  files: SelectedFiles,
  productHubSettings: ProductHubSettings,
  corrections: RowCorrectionMap = {},
): Promise<ProcessResult> {
  if (files.packingFiles.length === 0) {
    throw new Error("ラクマート配送依頼書 P~.xlsx を選択してください。");
  }

  const parsedRows = await parsePackingFiles(files.packingFiles);
  const extracted = applyCorrections(parsedRows, corrections);
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
  const kintoneRows = buildKintoneRows(matchResult);
  const nyukoRows = buildNyukoRows(extracted, masters);

  return {
    extracted,
    matchResult,
    neRows,
    kintoneRows,
    nyukoRows,
  };
}
