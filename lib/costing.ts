import type {
  CodeCost,
  CostBreakdown,
  CostIssue,
  CostLine,
  CostResult,
  CostRules,
  NeGenkaRow,
  ShipmentCostSource,
  ShipmentCostSummary,
} from "./costTypes";

// 便ごと・商品コードごとの原価を計算する。
//
// 原価 = 単価×出荷数 + オプション費用 + 中国内運賃 + 国際送料 (+ 代行手数料・その他)
//   - 元建ての金額は配送依頼書レートで円換算
//   - 中国内運賃：便全体の合計を商品代金の比率で配分
//   - 国際送料：箱の決済重量で箱ごとに按分し、箱の中は商品代金の比率で配分
//               （箱情報が揃わない便は便全体の商品代金比）
//   - 代行手数料・その他：商品代金の比率で配分
// 入庫数（NEの単位）は梱包リストから抽出・修正済みの receivedQuantity を使う。

export type CostingExtractedRow = {
  rowId: string;
  productCode: string;
  productCodeLc: string;
  receivedQuantity: number;
  quantityMismatch: boolean;
};

export function materialRuleKey(orderNo: string, itemNo: string): string {
  return `${orderNo.trim()}__${itemNo.trim()}`;
}

export function emptyBreakdown(): CostBreakdown {
  return { goods: 0, option: 0, domestic: 0, intl: 0, other: 0 };
}

export function breakdownTotal(b: CostBreakdown): number {
  return b.goods + b.option + b.domestic + b.intl + b.other;
}

function addScaled(target: CostBreakdown, source: CostBreakdown, factor: number) {
  target.goods += source.goods * factor;
  target.option += source.option * factor;
  target.domestic += source.domestic * factor;
  target.intl += source.intl * factor;
  target.other += source.other * factor;
}

function scaled(source: CostBreakdown, factor: number): CostBreakdown {
  const out = emptyBreakdown();
  addScaled(out, source, factor);
  return out;
}

function lineGoodsCny(line: CostLine): number {
  return line.unitPriceCny * line.shipQty;
}

function fmtYen(value: number): string {
  return `${Math.round(value).toLocaleString("ja-JP")}円`;
}

/** 便の各明細行の円建てコスト内訳を計算する */
export function computeLineCosts(source: ShipmentCostSource): {
  lineCosts: Map<number, CostBreakdown>;
  intlMethod: "box" | "value";
  chargeableKg: number;
} {
  const rate = source.rate;
  const shipped = source.lines.filter((line) => line.shipQty > 0);
  const goodsTotalCny = shipped.reduce((sum, line) => sum + lineGoodsCny(line), 0);
  const qtyTotal = shipped.reduce((sum, line) => sum + line.shipQty, 0);
  // 出荷数0の行に国内運賃が載っている場合も便全体のプールに入れる
  const domesticAllCny = source.lines.reduce((sum, line) => sum + line.domesticCny, 0);
  const otherJpy = source.agencyFeeJpy + source.otherFeeJpy;

  const share = (line: CostLine) =>
    goodsTotalCny > 0
      ? lineGoodsCny(line) / goodsTotalCny
      : qtyTotal > 0
        ? line.shipQty / qtyTotal
        : 0;

  const lineCosts = new Map<number, CostBreakdown>();
  for (const line of shipped) {
    lineCosts.set(line.lineNo, {
      goods: lineGoodsCny(line) * rate,
      option: line.optionCny * rate,
      domestic: domesticAllCny * rate * share(line),
      intl: 0,
      other: otherJpy * share(line),
    });
  }

  // 国際送料
  const boxKg = new Map(source.boxes.map((box) => [box.boxNo, box.chargeableKg]));
  const chargeableKg = source.boxes.reduce((sum, box) => sum + box.chargeableKg, 0);
  const canUseBoxes =
    source.intlFreightJpy > 0 &&
    chargeableKg > 0 &&
    shipped.length > 0 &&
    shipped.every(
      (line) =>
        line.boxes.length > 0 && line.boxes.every((box) => boxKg.has(box.boxNo)),
    );

  if (canUseBoxes) {
    const perKg = source.intlFreightJpy / chargeableKg;
    const boxValue = new Map<number, number>();
    const boxQty = new Map<number, number>();
    for (const line of shipped) {
      for (const box of line.boxes) {
        boxValue.set(box.boxNo, (boxValue.get(box.boxNo) ?? 0) + box.qty * line.unitPriceCny);
        boxQty.set(box.boxNo, (boxQty.get(box.boxNo) ?? 0) + box.qty);
      }
    }
    let allocated = 0;
    for (const line of shipped) {
      let intl = 0;
      for (const box of line.boxes) {
        const freight = (boxKg.get(box.boxNo) ?? 0) * perKg;
        const value = boxValue.get(box.boxNo) ?? 0;
        const qty = boxQty.get(box.boxNo) ?? 0;
        const part =
          value > 0
            ? (box.qty * line.unitPriceCny) / value
            : qty > 0
              ? box.qty / qty
              : 0;
        intl += freight * part;
      }
      lineCosts.get(line.lineNo)!.intl = intl;
      allocated += intl;
    }
    // どの明細も入っていない箱があった場合などの残りは金額比で配分
    const leftover = source.intlFreightJpy - allocated;
    if (Math.abs(leftover) > 0.5) {
      for (const line of shipped) lineCosts.get(line.lineNo)!.intl += leftover * share(line);
    }
    return { lineCosts, intlMethod: "box", chargeableKg };
  }

  for (const line of shipped) {
    lineCosts.get(line.lineNo)!.intl = source.intlFreightJpy * share(line);
  }
  return { lineCosts, intlMethod: "value", chargeableKg };
}

type CodeAccumulator = {
  shipmentId: string;
  sourceFile: string;
  productCode: string;
  productCodeLc: string;
  units: number;
  total: CostBreakdown;
  messages: Set<string>;
  hasError: boolean;
  hasWarning: boolean;
};

export function computeCosts(
  sources: ShipmentCostSource[],
  extractedRows: CostingExtractedRow[],
  rules: CostRules,
): CostResult {
  const issues: CostIssue[] = [];
  const rowById = new Map(extractedRows.map((row) => [row.rowId, row]));
  const orderedSources = [...sources].sort((a, b) => a.shipmentId.localeCompare(b.shipmentId));

  // 1. 同じ行(rowId)が複数便にまたがる場合の入庫数の按分用：便ごとの出荷数
  const piecesByRow = new Map<string, Map<string, number>>();
  for (const source of orderedSources) {
    for (const line of source.lines) {
      if (line.shipQty <= 0) continue;
      for (const token of line.tokens) {
        const byShipment = piecesByRow.get(token.rowId) ?? new Map<string, number>();
        byShipment.set(source.shipmentId, (byShipment.get(source.shipmentId) ?? 0) + line.shipQty);
        piecesByRow.set(token.rowId, byShipment);
      }
    }
  }
  const unitsByRowShipment = new Map<string, number>();
  for (const [rowId, byShipment] of piecesByRow) {
    const row = rowById.get(rowId);
    if (!row) continue;
    const entries = [...byShipment.entries()];
    const totalPieces = entries.reduce((sum, [, pieces]) => sum + pieces, 0);
    // 最大剰余法で整数に配分（合計が入庫数と一致し、負にならない）
    const exact = entries.map(([, pieces]) => (row.receivedQuantity * pieces) / totalPieces);
    const floors = exact.map((value) => Math.floor(value));
    let remainder = row.receivedQuantity - floors.reduce((a, b) => a + b, 0);
    const order = exact
      .map((value, index) => ({ index, frac: value - Math.floor(value) }))
      .sort((a, b) => b.frac - a.frac || a.index - b.index);
    for (const { index } of order) {
      if (remainder <= 0) break;
      floors[index] += 1;
      remainder -= 1;
    }
    entries.forEach(([shipmentId], index) => {
      unitsByRowShipment.set(`${rowId}@@${shipmentId}`, floors[index]);
    });
  }

  const codeMap = new Map<string, CodeAccumulator>();
  const shipments: ShipmentCostSummary[] = [];
  const costedRowIds = new Set<string>();

  for (const source of orderedSources) {
    const { lineCosts, intlMethod, chargeableKg } = computeLineCosts(source);
    for (const warning of source.parseWarnings) {
      issues.push({
        level: "warning",
        kind: "parse",
        shipmentId: source.shipmentId,
        message: warning,
        productCodes: [],
      });
    }
    if (intlMethod === "value" && source.intlFreightJpy > 0) {
      issues.push({
        level: "warning",
        kind: "intl_fallback",
        shipmentId: source.shipmentId,
        message: "所在箱または箱の決済重量が揃っていないため、この便の国際送料は商品代金の比率で配分しました。",
        productCodes: [],
      });
    }

    // この便で入庫するコード（修正後のコード）と入庫数
    const unitsByCode = new Map<string, { productCode: string; units: number }>();
    for (const line of source.lines) {
      if (line.shipQty <= 0) continue;
      for (const token of line.tokens) {
        const row = rowById.get(token.rowId);
        if (!row) continue;
        const key = `${token.rowId}@@${source.shipmentId}`;
        if (!unitsByRowShipment.has(key)) continue;
        const units = unitsByRowShipment.get(key)!;
        unitsByRowShipment.delete(key); // 同じrowIdを複数行で数えない
        costedRowIds.add(token.rowId);
        const current = unitsByCode.get(row.productCodeLc) ?? { productCode: row.productCode, units: 0 };
        current.units += units;
        unitsByCode.set(row.productCodeLc, current);
      }
    }

    const accFor = (codeLc: string): CodeAccumulator => {
      const key = `${source.shipmentId}@@${codeLc}`;
      let acc = codeMap.get(key);
      if (!acc) {
        acc = {
          shipmentId: source.shipmentId,
          sourceFile: source.sourceFile,
          productCode: unitsByCode.get(codeLc)?.productCode ?? codeLc,
          productCodeLc: codeLc,
          units: unitsByCode.get(codeLc)?.units ?? 0,
          total: emptyBreakdown(),
          messages: new Set(),
          hasError: false,
          hasWarning: false,
        };
        codeMap.set(key, acc);
      }
      return acc;
    };
    for (const codeLc of unitsByCode.keys()) accFor(codeLc);

    let totalJpy = 0;
    let allocatedJpy = 0;
    let ignoredJpy = 0;
    let unallocatedJpy = 0;
    let hasUnallocatedError = false;

    for (const line of source.lines) {
      const cost = lineCosts.get(line.lineNo);
      if (!cost) continue;
      const lineTotal = breakdownTotal(cost);
      totalJpy += lineTotal;

      const liveCodes = [
        ...new Set(
          line.tokens
            .map((token) => rowById.get(token.rowId)?.productCodeLc)
            .filter((code): code is string => Boolean(code) && (unitsByCode.get(code!)?.units ?? 0) > 0),
        ),
      ];

      // 商品コードなし → 共有資材ルール
      if (line.tokens.length === 0) {
        const rule = rules.materialRules[materialRuleKey(line.orderNo, line.itemNo)];
        const candidateCodes = [...unitsByCode.keys()]
          .filter((code) => (unitsByCode.get(code)?.units ?? 0) > 0)
          .map((code) => unitsByCode.get(code)!.productCode)
          .sort();
        const suggestedCodes = suggestMaterialTargets(source, line, rowById);

        if (rule?.ignore) {
          ignoredJpy += lineTotal;
          continue;
        }
        if (!rule) {
          unallocatedJpy += lineTotal;
          hasUnallocatedError = true;
          issues.push({
            level: "error",
            kind: "unassigned_material",
            shipmentId: source.shipmentId,
            message: `商品コードのない行（注文${line.orderNo} / 商品番号${line.itemNo}）の${fmtYen(lineTotal)}の割当先が未設定です。`,
            productCodes: [],
            line,
            candidateCodes,
            suggestedCodes,
            amountJpy: lineTotal,
          });
          continue;
        }
        const targets = rule.allocations
          .map((alloc) => ({
            codeLc: alloc.productCode.toLowerCase(),
            qtyPerUnit: alloc.qtyPerUnit,
          }))
          .filter((t) => t.qtyPerUnit > 0 && (unitsByCode.get(t.codeLc)?.units ?? 0) > 0);
        if (targets.length === 0) {
          unallocatedJpy += lineTotal;
          hasUnallocatedError = true;
          issues.push({
            level: "error",
            kind: "material_no_target",
            shipmentId: source.shipmentId,
            message: `共有資材（注文${line.orderNo} / 商品番号${line.itemNo}）の割当先コードがこの便に含まれていません（${fmtYen(lineTotal)}）。割当先を見直すか「原価に含めない」にしてください。`,
            productCodes: rule.allocations.map((a) => a.productCode),
            line,
            candidateCodes,
            suggestedCodes,
            amountJpy: lineTotal,
          });
          continue;
        }
        const weights = targets.map((t) => (unitsByCode.get(t.codeLc)?.units ?? 0) * t.qtyPerUnit);
        const weightTotal = weights.reduce((a, b) => a + b, 0);
        targets.forEach((t, i) => {
          const acc = accFor(t.codeLc);
          addScaled(acc.total, cost, weights[i] / weightTotal);
          acc.messages.add("共有資材を含む");
        });
        allocatedJpy += lineTotal;
        if (Math.round(weightTotal) !== Math.round(line.shipQty)) {
          issues.push({
            level: "warning",
            kind: "material_mismatch",
            shipmentId: source.shipmentId,
            message: `共有資材（注文${line.orderNo} / 商品番号${line.itemNo}）：出荷数${line.shipQty}に対し、割当計算上の使用数は${weightTotal}です。分配の比率だけに使うので計算は続けます。`,
            productCodes: targets.map((t) => unitsByCode.get(t.codeLc)!.productCode),
            line,
          });
        }
        continue;
      }

      if (liveCodes.length === 0) {
        unallocatedJpy += lineTotal;
        issues.push({
          level: "warning",
          kind: "deleted_line",
          shipmentId: source.shipmentId,
          message: `行${line.lineNo}（${line.tokens.map((t) => t.productCode).join(", ")}）は抽出結果で削除または入庫数0のため、${fmtYen(lineTotal)}は原価に入っていません。`,
          productCodes: line.tokens.map((t) => t.productCode),
          line,
          amountJpy: lineTotal,
        });
        continue;
      }

      if (liveCodes.length === 1) {
        addScaled(accFor(liveCodes[0]).total, cost, 1);
        allocatedJpy += lineTotal;
        continue;
      }

      // 1行に複数コード → 入数で按分
      const missing = liveCodes.filter((code) => !(rules.unitRules[code] > 0));
      let weights: number[];
      // 入数が未登録でも、未登録分を「1単位に1個」とみなすと出荷数とぴったり合うなら、それで分ける
      // （例：ケース・やすりの行にS/L両方の●▲がある付属品の行。1セットに1個ずつ使う）
      const assumedOne =
        missing.length > 0 &&
        Math.round(
          liveCodes.reduce(
            (sum, code) => sum + unitsByCode.get(code)!.units * (rules.unitRules[code] > 0 ? rules.unitRules[code] : 1),
            0,
          ),
        ) === Math.round(line.shipQty);
      if (assumedOne) {
        weights = liveCodes.map(
          (code) => unitsByCode.get(code)!.units * (rules.unitRules[code] > 0 ? rules.unitRules[code] : 1),
        );
      } else if (missing.length > 0) {
        weights = liveCodes.map((code) => unitsByCode.get(code)!.units);
        const missingNames = missing.map((code) => unitsByCode.get(code)!.productCode);
        issues.push({
          level: "error",
          kind: "missing_unit_rule",
          shipmentId: source.shipmentId,
          message: `行${line.lineNo}は複数の商品コードをまとめた行です。${missingNames.join(", ")} の入数（1単位あたりの個数）を登録してください。未登録の間は入庫数の比率で仮に分けています。`,
          productCodes: liveCodes.map((code) => unitsByCode.get(code)!.productCode),
          line,
        });
        for (const code of liveCodes) {
          const acc = accFor(code);
          acc.hasError = true;
          acc.messages.add("入数未登録のため仮計算");
        }
      } else {
        weights = liveCodes.map((code) => unitsByCode.get(code)!.units * rules.unitRules[code]);
        const pieces = weights.reduce((a, b) => a + b, 0);
        if (Math.round(pieces) !== Math.round(line.shipQty)) {
          issues.push({
            level: "warning",
            kind: "unit_mismatch",
            shipmentId: source.shipmentId,
            message: `行${line.lineNo}：入庫数×入数の合計（${liveCodes
              .map((code) => `${unitsByCode.get(code)!.productCode} ${unitsByCode.get(code)!.units}×${rules.unitRules[code]}`)
              .join(" + ")} = ${pieces}）が出荷数${line.shipQty}と一致しません。入庫数か入数を確認してください。`,
            productCodes: liveCodes.map((code) => unitsByCode.get(code)!.productCode),
            line,
          });
          for (const code of liveCodes) accFor(code).hasWarning = true;
        }
      }
      const weightTotal = weights.reduce((a, b) => a + b, 0);
      liveCodes.forEach((code, i) => {
        addScaled(accFor(code).total, cost, weightTotal > 0 ? weights[i] / weightTotal : 1 / liveCodes.length);
      });
      allocatedJpy += lineTotal;
    }

    if (hasUnallocatedError) {
      // 割当先が決まっていない費用がある便は、どの商品の原価も確定できない
      for (const acc of codeMap.values()) {
        if (acc.shipmentId !== source.shipmentId) continue;
        acc.hasError = true;
        acc.messages.add("この便に割当先未設定の費用あり");
      }
    }

    shipments.push({
      shipmentId: source.shipmentId,
      sourceFile: source.sourceFile,
      rate: source.rate,
      goodsCny: source.lines.reduce((sum, line) => sum + (line.shipQty > 0 ? lineGoodsCny(line) : 0), 0),
      domesticCny: source.lines.reduce((sum, line) => sum + line.domesticCny, 0),
      optionCny: source.lines.reduce((sum, line) => sum + (line.shipQty > 0 ? line.optionCny : 0), 0),
      intlFreightJpy: source.intlFreightJpy,
      otherFeeJpy: source.agencyFeeJpy + source.otherFeeJpy,
      chargeableKg,
      intlMethod,
      totalJpy,
      allocatedJpy,
      ignoredJpy,
      unallocatedJpy,
    });
  }

  // 梱包数と入庫数が違う行（分納の可能性）
  for (const row of extractedRows) {
    if (row.quantityMismatch && costedRowIds.has(row.rowId)) {
      for (const acc of codeMap.values()) {
        if (acc.productCodeLc === row.productCodeLc) {
          acc.hasWarning = true;
          acc.messages.add("梱包数と入庫数が不一致（分納なら入庫数を修正）");
        }
      }
    }
  }

  // 原価データのないコード（手入力行など）
  const noCost = extractedRows.filter((row) => row.receivedQuantity > 0 && !costedRowIds.has(row.rowId));
  if (noCost.length > 0) {
    issues.push({
      level: "warning",
      kind: "no_cost_data",
      shipmentId: "",
      message: `配送依頼書詳細に該当行がないため原価を計算できないコードがあります：${[...new Set(noCost.map((row) => row.productCode))].join(", ")}。NEの原価は更新せず、便の登録もしません。`,
      productCodes: noCost.map((row) => row.productCode),
    });
  }

  const codes: CodeCost[] = [...codeMap.values()]
    .map((acc) => {
      const totalJpy = breakdownTotal(acc.total);
      const messages = [...acc.messages];
      let hasError = acc.hasError;
      if (acc.units <= 0) {
        hasError = true;
        messages.push("入庫数0");
      }
      const unitCost = acc.units > 0 ? totalJpy / acc.units : 0;
      return {
        shipmentId: acc.shipmentId,
        sourceFile: acc.sourceFile,
        productCode: acc.productCode,
        productCodeLc: acc.productCodeLc,
        units: acc.units,
        total: acc.total,
        totalJpy,
        unitCost,
        unitBreakdown: acc.units > 0 ? scaled(acc.total, 1 / acc.units) : emptyBreakdown(),
        status: hasError ? "error" : acc.hasWarning ? "warning" : "ok",
        messages,
      } satisfies CodeCost;
    })
    .sort(
      (a, b) =>
        a.productCodeLc.localeCompare(b.productCodeLc) || a.shipmentId.localeCompare(b.shipmentId),
    );

  // NEへ書く原価：コードごとに最新の便（配送依頼書番号が最大）の1単位原価
  const latestByCode = new Map<string, CodeCost>();
  for (const code of codes) {
    if (code.units <= 0) continue;
    const current = latestByCode.get(code.productCodeLc);
    if (!current || code.shipmentId > current.shipmentId) latestByCode.set(code.productCodeLc, code);
  }
  const neGenka: NeGenkaRow[] = [...latestByCode.values()]
    .filter((code) => code.status !== "error")
    .map((code) => ({
      productCode: code.productCode,
      shipmentId: code.shipmentId,
      unitCost: code.unitCost,
      genkaTnk: toNeGenka(code.unitCost),
    }));

  return { shipments, codes, issues, neGenka };
}

/** NEの原価単価は整数で送る（小数を送ってアップロード全体が失敗するのを避ける） */
export function toNeGenka(unitCost: number): number {
  return Math.round(unitCost);
}

/** 共有資材の割当先候補：同じ便の備考の中でこの行の注文番号に言及しているコード */
function suggestMaterialTargets(
  source: ShipmentCostSource,
  line: CostLine,
  rowById: Map<string, CostingExtractedRow>,
): string[] {
  if (!line.orderNo) return [];
  const codes = new Set<string>();
  for (const other of source.lines) {
    if (other === line || !other.note.includes(line.orderNo)) continue;
    for (const token of other.tokens) {
      const row = rowById.get(token.rowId);
      if (row) codes.add(row.productCode);
    }
  }
  return [...codes].sort();
}
