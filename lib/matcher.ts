import {
  ExtractedRow,
  ProductDbUpdateRow,
  MasterRecord,
  MatchedProduct,
  MatchResult,
  NeUpdateRow,
  NyukoListRow,
  OrderRecord,
} from "./types";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function orderMatchesKey(orderValue: string, key: string): boolean {
  const pattern = new RegExp(`^${escapeRegExp(key)}(?!\\d)`);
  return pattern.test(orderValue);
}


type ParsedOrderKey = {
  mmdd: string;
  quantity: number;
};

function parseLeadingOrderKey(orderValue: string): ParsedOrderKey | null {
  const matched = orderValue.match(/^(\d{4})-(\d+)/);
  if (!matched) return null;
  const quantity = Number(matched[2]);
  if (!Number.isFinite(quantity)) return null;
  return { mmdd: matched[1], quantity };
}

function replaceLeadingOrderQuantity(
  orderValue: string,
  mmdd: string,
  originalQuantity: number,
  remainingQuantity: number,
): string {
  const pattern = new RegExp(
    `^${escapeRegExp(mmdd)}-${escapeRegExp(String(originalQuantity))}(?!\\d)`,
  );
  return orderValue.replace(pattern, `${mmdd}-${remainingQuantity}`);
}

function getReceivedQuantity(row: ExtractedRow): number {
  // セット商品などでは梱包数が実物数、備考数量がNE在庫単位になるため、
  // 出力数量は常に配送依頼書備考の「mmdd-数量」を使う。
  return row.quantity;
}

function groupExtracted(rows: ExtractedRow[]): Map<string, ExtractedRow[]> {
  const grouped = new Map<string, ExtractedRow[]>();
  for (const row of rows) {
    const current = grouped.get(row.productCodeLc) ?? [];
    current.push(row);
    grouped.set(row.productCodeLc, current);
  }
  return grouped;
}

export function matchAndConsume(
  extracted: ExtractedRow[],
  orderRecords: OrderRecord[],
): MatchResult {
  const grouped = groupExtracted(extracted);
  const orderIndex = new Map<string, OrderRecord>();

  for (const record of orderRecords) {
    if (!orderIndex.has(record.productCodeLc)) {
      orderIndex.set(record.productCodeLc, record);
    }
  }

  const matched: MatchedProduct[] = [];
  const warnings: MatchResult["warnings"] = [];

  for (const [productCodeLc, incomingRows] of grouped.entries()) {
    const productCode = incomingRows[0]?.productCode ?? productCodeLc;
    const deliveredKeys = incomingRows.map((row) => row.key);
    const incomingQuantity = incomingRows.reduce(
      (sum, row) => sum + getReceivedQuantity(row),
      0,
    );
    const record = orderIndex.get(productCodeLc);

    for (const incoming of incomingRows) {
      if (incoming.quantityMismatch) {
        warnings.push({
          type: "quantity_mismatch",
          productCode,
          rowId: incoming.rowId,
          key: incoming.key,
          deliveredKeys,
          expectedQuantity: incoming.quantity,
          packingQuantities: incoming.packingQuantities,
          sourceFile: incoming.sourceFile,
          message: `${productCode}: ${incoming.key} の読み取り数量と梱包数が一致しません。NE更新・入庫リストは備考数量を使用します。`,
        });
      }
    }

    if (!record) {
      warnings.push({
        type: "no_product",
        productCode,
        deliveredKeys,
        message: `${productCode}: product-data-hubに商品がありません。`,
      });
      continue;
    }

    const pairs = record.orders.map((order, index) => ({
      order,
      rm: record.rms[index] ?? null,
    }));

    for (const incoming of incomingRows) {
      const receivedQuantity = getReceivedQuantity(incoming);
      let matchedOrderQuantity = incoming.quantity;
      let hitIndex = pairs.findIndex(
        (pair) =>
          pair.order !== null && orderMatchesKey(pair.order, incoming.key),
      );

      if (hitIndex < 0) {
        hitIndex = pairs.findIndex((pair) => {
          if (pair.order === null) return false;
          const parsed = parseLeadingOrderKey(pair.order);
          if (!parsed) return false;
          return (
            parsed.mmdd === incoming.mmdd &&
            parsed.quantity >= receivedQuantity
          );
        });

        if (hitIndex >= 0) {
          const hitPair = pairs[hitIndex];
          const parsed = hitPair.order
            ? parseLeadingOrderKey(hitPair.order)
            : null;
          matchedOrderQuantity = parsed?.quantity ?? incoming.quantity;
        }
      }

      if (hitIndex >= 0) {
        const hitPair = pairs[hitIndex];
        const remainingQuantity = matchedOrderQuantity - receivedQuantity;

        if (hitPair.order !== null && remainingQuantity > 0) {
          pairs[hitIndex] = {
            order: replaceLeadingOrderQuantity(
              hitPair.order,
              incoming.mmdd,
              matchedOrderQuantity,
              remainingQuantity,
            ),
            rm: hitPair.rm,
          };
        } else {
          pairs[hitIndex] = { order: null, rm: null };
        }
      } else {
        const currentOrders = pairs
          .map((pair) => pair.order)
          .filter((value): value is string => Boolean(value));
        warnings.push({
          type: "no_key",
          productCode,
          rowId: incoming.rowId,
          key: incoming.key,
          deliveredKeys,
          currentOrders,
          message: `${productCode}: ${incoming.key} がオーダー1〜5に見つかりません。`,
        });
      }
    }

    const remainingPairs = pairs
      .filter((pair): pair is { order: string; rm: string | null } =>
        Boolean(pair.order),
      )
      .map((pair) => ({ order: pair.order, rm: pair.rm }));

    matched.push({
      productCode: record.productCode || productCode,
      productCodeLc,
      deliveredKeys,
      incomingQuantity,
      remainingPairs,
    });
  }

  matched.sort((a, b) => a.productCodeLc.localeCompare(b.productCodeLc));
  return { matched, warnings };
}

export function buildNeRows(matchResult: MatchResult): NeUpdateRow[] {
  return matchResult.matched.map((row) => {
    const remainingKataban = row.remainingPairs.map((pair) => pair.order).join("/");

    return {
      syohin_code: row.productCode,
      zaiko_su: row.incomingQuantity,
      // NEではkataban空欄のCSV更新が「変更なし」扱いになるため、
      // 発注状況が残らないよう、消し込み後に空欄なら明示的に0を入れる。
      kataban: remainingKataban || "0",
    };
  });
}

export function buildProductDbUpdateRows(matchResult: MatchResult): ProductDbUpdateRow[] {
  return matchResult.matched.map((row) => {
    const values: ProductDbUpdateRow = {
      product_code: row.productCode,
      order_memo_1: "",
      rakumart_url_1: "",
      order_memo_2: "",
      rakumart_url_2: "",
      order_memo_3: "",
      rakumart_url_3: "",
      order_memo_4: "",
      rakumart_url_4: "",
      order_memo_5: "",
      rakumart_url_5: "",
    };

    for (let i = 0; i < 5; i += 1) {
      const pair = row.remainingPairs[i];
      values[`order_memo_${i + 1}` as keyof ProductDbUpdateRow] = pair?.order ?? "";
      values[`rakumart_url_${i + 1}` as keyof ProductDbUpdateRow] = pair?.rm ?? "";
    }

    return values;
  });
}



function buildRackDisplay(master: MasterRecord | undefined): string {
  if (!master) return "";
  return [master.rackNumber, master.rackLevel].filter(Boolean).join("-");
}

function floorSortValue(value: string): [number, string] {
  const matched = value.match(/(\d+)/);
  if (matched) return [Number(matched[1]), value];
  return [999999, value];
}

export function buildNyukoRows(
  extracted: ExtractedRow[],
  masters: MasterRecord[],
): NyukoListRow[] {
  const masterIndex = new Map<string, MasterRecord>();
  for (const master of masters) {
    if (!masterIndex.has(master.productCodeLc))
      masterIndex.set(master.productCodeLc, master);
  }

  const grouped = groupExtracted(extracted);
  const rows: NyukoListRow[] = [];

  for (const [productCodeLc, incomingRows] of grouped.entries()) {
    const productCode = incomingRows[0]?.productCode ?? productCodeLc;
    const quantity = incomingRows.reduce(
      (sum, row) => sum + getReceivedQuantity(row),
      0,
    );
    const master = masterIndex.get(productCodeLc);

    rows.push({
      階数: master?.floor || "",
      "棚-段": buildRackDisplay(master),
      シール: master?.stickerColor || "",
      商品コード: productCode,
      商品名: master?.productName || "(商品情報未登録)",
      入庫数: quantity,
      備考: master ? "" : "product-data-hubに商品情報なし",
    });
  }

  return rows.sort((a, b) => {
    const [aFloor, aFloorText] = floorSortValue(a.階数);
    const [bFloor, bFloorText] = floorSortValue(b.階数);
    if (aFloor !== bFloor) return aFloor - bFloor;
    const floorTextCompare = aFloorText.localeCompare(bFloorText);
    if (floorTextCompare !== 0) return floorTextCompare;
    return a.商品コード.toLowerCase().localeCompare(b.商品コード.toLowerCase());
  });
}
