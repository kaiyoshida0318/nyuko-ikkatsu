import JSZip from "jszip";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import { readTextFlexible } from "./encoding";
import {
  ExtractedRow,
  MasterRecord,
  OrderRecord,
  ORDER_COLS,
  OtherPackingRow,
  PackingImage,
  PackingParseResult,
  RM_COLS,
} from "./types";

const NOTE_PATTERN = /●([^▲\s]+)▲(\d{4})-(\d+)/g;
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

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

type Relationship = {
  id: string;
  target: string;
  type: string;
};

function getColumnIndex(row: unknown[], headerName: string): number {
  return row.findIndex((cell) => String(cell ?? "").trim() === headerName);
}

function parseXml(text: string): Document {
  return new DOMParser().parseFromString(text, "application/xml");
}

function elementsByLocalName(parent: ParentNode, localName: string): Element[] {
  return Array.from(parent.querySelectorAll("*")).filter(
    (element) => element.localName === localName,
  );
}

function firstElementByLocalName(
  parent: ParentNode,
  localName: string,
): Element | null {
  return elementsByLocalName(parent, localName)[0] ?? null;
}

function textByLocalName(parent: ParentNode, localName: string): string {
  return firstElementByLocalName(parent, localName)?.textContent ?? "";
}

function normalizeZipPath(path: string): string {
  const parts: string[] = [];
  for (const part of path.replace(/^\/+/, "").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}

function resolveZipPath(fromFilePath: string, target: string): string {
  if (target.startsWith("/")) return normalizeZipPath(target);
  const baseDir = fromFilePath.split("/").slice(0, -1).join("/");
  return normalizeZipPath(`${baseDir}/${target}`);
}

function relsPathFor(filePath: string): string {
  const parts = filePath.split("/");
  const fileName = parts.pop() ?? "";
  return normalizeZipPath(`${parts.join("/")}/_rels/${fileName}.rels`);
}

async function readZipText(zip: JSZip, path: string): Promise<string | null> {
  const file = zip.file(path);
  if (!file) return null;
  return file.async("text");
}

function parseRelationships(xmlText: string | null): Relationship[] {
  if (!xmlText) return [];
  const doc = parseXml(xmlText);
  return elementsByLocalName(doc, "Relationship").map((element) => ({
    id: element.getAttribute("Id") ?? "",
    target: element.getAttribute("Target") ?? "",
    type: element.getAttribute("Type") ?? "",
  }));
}

function getRelationshipById(
  relationships: Relationship[],
  id: string,
): Relationship | undefined {
  return relationships.find((relationship) => relationship.id === id);
}

function getMimeType(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  return "image/png";
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("画像の読み取りに失敗しました。"));
    reader.readAsDataURL(blob);
  });
}

async function getSheetPathByName(
  zip: JSZip,
  sheetName: string,
): Promise<string | null> {
  const workbookXml = await readZipText(zip, "xl/workbook.xml");
  const workbookRelsXml = await readZipText(zip, "xl/_rels/workbook.xml.rels");
  if (!workbookXml || !workbookRelsXml) return null;

  const workbookDoc = parseXml(workbookXml);
  const workbookRels = parseRelationships(workbookRelsXml);
  const sheet = elementsByLocalName(workbookDoc, "sheet").find(
    (element) => element.getAttribute("name") === sheetName,
  );
  if (!sheet) return null;

  const relationshipId =
    sheet.getAttributeNS(REL_NS, "id") ?? sheet.getAttribute("r:id") ?? "";
  const relationship = getRelationshipById(workbookRels, relationshipId);
  if (!relationship?.target) return null;

  return resolveZipPath("xl/workbook.xml", relationship.target);
}

async function getPackingImagesByRow(
  file: File,
  sheetName: string,
): Promise<Map<number, PackingImage>> {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const sheetPath = await getSheetPathByName(zip, sheetName);
  if (!sheetPath) return new Map();

  const sheetRels = parseRelationships(await readZipText(zip, relsPathFor(sheetPath)));
  const drawingRel = sheetRels.find((relationship) =>
    relationship.type.includes("/drawing"),
  );
  if (!drawingRel?.target) return new Map();

  const drawingPath = resolveZipPath(sheetPath, drawingRel.target);
  const drawingXml = await readZipText(zip, drawingPath);
  if (!drawingXml) return new Map();

  const drawingRels = parseRelationships(await readZipText(zip, relsPathFor(drawingPath)));
  const drawingDoc = parseXml(drawingXml);
  const anchors = elementsByLocalName(drawingDoc, "oneCellAnchor").concat(
    elementsByLocalName(drawingDoc, "twoCellAnchor"),
  );
  const imageByRow = new Map<number, PackingImage>();

  for (const anchor of anchors) {
    const from = firstElementByLocalName(anchor, "from");
    if (!from) continue;

    const rowIndex = Number(textByLocalName(from, "row"));
    if (!Number.isFinite(rowIndex)) continue;

    const blip = firstElementByLocalName(anchor, "blip");
    if (!blip) continue;

    const relationshipId =
      blip.getAttributeNS(REL_NS, "embed") ??
      blip.getAttribute("r:embed") ??
      blip.getAttribute("embed") ??
      "";
    const imageRel = getRelationshipById(drawingRels, relationshipId);
    if (!imageRel?.target) continue;

    const imagePath = resolveZipPath(drawingPath, imageRel.target);
    const imageFile = zip.file(imagePath);
    if (!imageFile) continue;

    const mimeType = getMimeType(imagePath);
    const blob = await imageFile.async("blob");
    imageByRow.set(rowIndex, {
      dataUrl: await blobToDataUrl(blob),
      fileName: imagePath.split("/").pop() ?? imagePath,
      mimeType,
    });
  }

  return imageByRow;
}

export async function parsePackingFiles(
  files: File[],
): Promise<PackingParseResult> {
  const unique = new Map<string, PackingAccumulator>();
  const otherRows: OtherPackingRow[] = [];

  for (const file of files) {
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: "array" });
    const sheet = workbook.Sheets["梱包リスト"];
    if (!sheet) {
      throw new Error(`${file.name}: 「梱包リスト」シートが見つかりません。`);
    }

    const imageByRow = await getPackingImagesByRow(file, "梱包リスト");
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
    let productInfoColIndex = -1;
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
        productInfoColIndex = getColumnIndex(row, "商品情報");
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

      const packingQuantity =
        packingColIndex >= 0 ? normalizeNumber(row[packingColIndex]) : null;
      const orderNo =
        orderNoColIndex >= 0 ? String(row[orderNoColIndex] ?? "").trim() : "";
      const itemNo =
        itemNoColIndex >= 0 ? String(row[itemNoColIndex] ?? "").trim() : "";
      const productInfo =
        productInfoColIndex >= 0
          ? String(row[productInfoColIndex] ?? "").trim()
          : "";
      const hasPackingRowData = Boolean(
        note || productInfo || orderNo || itemNo || packingQuantity !== null,
      );
      if (!hasPackingRowData) continue;

      const packedGroupKey = `${orderNo || "order"}__${itemNo || `row${rowIndex}`}`;

      NOTE_PATTERN.lastIndex = 0;
      const matches = [...note.matchAll(NOTE_PATTERN)];
      if (matches.length === 0) {
        otherRows.push({
          rowId: `${file.name}__other__${rowIndex}`,
          sourceFile: file.name,
          sourceRowNumber: rowIndex + 1,
          sourceNote: note,
          productInfo,
          packingQuantity,
          image: imageByRow.get(rowIndex),
          category: "",
          itemName: "",
          note: "",
        });
        continue;
      }

      for (const match of matches) {
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
        sourceKey: row.key,
        packingQuantities,
        // 入庫数・NE zaiko_su・オーダー消し込みは、梱包数ではなく
        // 箱詰め備考の「mmdd-数量」を正として扱う。
        // 梱包数は数量不一致の警告表示用にだけ保持する。
        receivedQuantity: row.quantity,
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

  if (extracted.length === 0 && otherRows.length === 0) {
    throw new Error("P~.xlsx から入庫データを1件も抽出できませんでした。");
  }

  return { extracted, otherRows };
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
        rackNumber: "",
        rackLevel: "",
        stickerColor: "",
      };
    })
    .filter((row) => row.productCode);
}
