import { breakdownTotal, materialRuleKey } from "./costing";
import type {
  CostResult,
  CostRules,
  MaterialRule,
  NeStockBefore,
} from "./costTypes";
import { supabase } from "./supabaseClient";

// 原価計算のマスタ（入数・共有資材ルール）と便の登録（Supabase）

function requireClient() {
  if (!supabase) throw new Error("Supabaseが未設定です。");
  return supabase;
}

function describe(error: { message?: string; code?: string; hint?: string } | null): string {
  if (!error) return "";
  const missingTable =
    error.code === "42P01" || error.code === "PGRST205" || error.code === "PGRST202" ||
    /does not exist|Could not find/i.test(error.message ?? "");
  if (missingTable) {
    return "原価用のテーブルまたは関数がSupabaseにありません。supabase/cost_lots.sql をSQL Editorで実行してください。";
  }
  return [error.message, error.hint].filter(Boolean).join(" / ");
}

export async function fetchCostRules(): Promise<CostRules> {
  const client = requireClient();
  const [units, materials] = await Promise.all([
    client.from("cost_unit_rules").select("product_code_lc,product_code,pieces_per_unit"),
    client.from("cost_material_rules").select("order_no,item_no,allocations,ignore,note"),
  ]);
  if (units.error) throw new Error(describe(units.error));
  if (materials.error) throw new Error(describe(materials.error));

  const rules: CostRules = { unitRules: {}, materialRules: {} };
  for (const row of units.data ?? []) {
    const value = Number(row.pieces_per_unit);
    if (row.product_code_lc && value > 0) rules.unitRules[String(row.product_code_lc)] = value;
  }
  for (const row of materials.data ?? []) {
    const allocations = Array.isArray(row.allocations)
      ? (row.allocations as Array<{ productCode?: string; qtyPerUnit?: number }>)
          .map((a) => ({ productCode: String(a.productCode ?? "").trim(), qtyPerUnit: Number(a.qtyPerUnit) }))
          .filter((a) => a.productCode && a.qtyPerUnit > 0)
      : [];
    const rule: MaterialRule = {
      orderNo: String(row.order_no),
      itemNo: String(row.item_no),
      allocations,
      ignore: Boolean(row.ignore),
      note: row.note ?? undefined,
    };
    rules.materialRules[materialRuleKey(rule.orderNo, rule.itemNo)] = rule;
  }
  return rules;
}

export async function saveUnitRule(productCode: string, piecesPerUnit: number): Promise<void> {
  const code = productCode.trim();
  if (!code || !(piecesPerUnit > 0)) throw new Error("入数は1以上の数値で入力してください。");
  const { error } = await requireClient()
    .from("cost_unit_rules")
    .upsert(
      {
        product_code_lc: code.toLowerCase(),
        product_code: code,
        pieces_per_unit: piecesPerUnit,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "product_code_lc" },
    );
  if (error) throw new Error(describe(error));
}

export async function saveMaterialRule(rule: MaterialRule): Promise<void> {
  const { error } = await requireClient()
    .from("cost_material_rules")
    .upsert(
      {
        order_no: rule.orderNo,
        item_no: rule.itemNo,
        allocations: rule.ignore ? [] : rule.allocations,
        ignore: rule.ignore,
        note: rule.note ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "order_no,item_no" },
    );
  if (error) throw new Error(describe(error));
}

export async function deleteMaterialRule(orderNo: string, itemNo: string): Promise<void> {
  const { error } = await requireClient()
    .from("cost_material_rules")
    .delete()
    .eq("order_no", orderNo)
    .eq("item_no", itemNo);
  if (error) throw new Error(describe(error));
}

const round4 = (value: number) => Math.round(value * 10000) / 10000;

export type CostRegistrationPayload = {
  /** receipt：通常の入庫 / backfill：過去の便を原価だけ登録 */
  mode?: "receipt" | "backfill";
  shipments: Array<Record<string, unknown>>;
  lots: Array<{
    product_code: string;
    shipment_id: string;
    qty: number;
    unit_cost: number;
    unit_goods: number;
    unit_option: number;
    unit_domestic: number;
    unit_intl: number;
    unit_other: number;
    needs_review: boolean;
    note: string | null;
    /** backfill のときの登録日（配送依頼書の日付） */
    received_at?: string;
  }>;
  stock: NeStockBefore[];
};

/**
 * NE更新の直前に作る「原価登録の予定」。NEへ送った原価と登録する便がずれないよう、
 * この時点の計算結果を固定して保存する。
 * neCodesLc：NEに在庫を加算するコード（NE更新に含まれないコードは便を登録しない）
 */
/** P2026091008463813-2147 → 2026-09-10T08:46:00+09:00 */
export function shipmentDateIso(shipmentId: string): string | undefined {
  const m = shipmentId.match(/^P(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00+09:00` : undefined;
}

export function buildCostRegistrationPayload(
  cost: CostResult,
  neCodesLc: Set<string> | null,
  options: { mode?: "receipt" | "backfill" } = {},
): { payload: Omit<CostRegistrationPayload, "stock">; skippedCodes: string[] } {
  const mode = options.mode ?? "receipt";
  const skipped = new Set<string>();
  const lots: CostRegistrationPayload["lots"] = [];
  for (const code of cost.codes) {
    if (code.units <= 0) continue;
    if (neCodesLc && !neCodesLc.has(code.productCodeLc)) {
      skipped.add(code.productCode);
      continue;
    }
    lots.push({
      product_code: code.productCode,
      shipment_id: code.shipmentId,
      qty: Math.round(code.units),
      unit_cost: round4(code.unitCost),
      unit_goods: round4(code.unitBreakdown.goods),
      unit_option: round4(code.unitBreakdown.option),
      unit_domestic: round4(code.unitBreakdown.domestic),
      unit_intl: round4(code.unitBreakdown.intl),
      unit_other: round4(code.unitBreakdown.other),
      needs_review: code.status === "error",
      note: code.messages.length ? code.messages.join(" / ") : null,
      ...(mode === "backfill" ? { received_at: shipmentDateIso(code.shipmentId) } : {}),
    });
  }
  const shipments = cost.shipments.map((s) => ({
    shipment_id: s.shipmentId,
    source_file: s.sourceFile,
    rate: s.rate,
    goods_cny: round4(s.goodsCny),
    option_cny: round4(s.optionCny),
    domestic_cny: round4(s.domesticCny),
    intl_freight_jpy: s.intlFreightJpy,
    other_fee_jpy: s.otherFeeJpy,
    chargeable_kg: s.chargeableKg,
    intl_method: s.intlMethod,
    total_jpy: round4(s.totalJpy),
    allocated_jpy: round4(s.allocatedJpy),
    ignored_jpy: round4(s.ignoredJpy),
    unallocated_jpy: round4(s.unallocatedJpy),
    detail: {
      codes: cost.codes
        .filter((c) => c.shipmentId === s.shipmentId)
        .map((c) => ({
          product_code: c.productCode,
          units: c.units,
          total_jpy: round4(breakdownTotal(c.total)),
          unit_cost: round4(c.unitCost),
          status: c.status,
          messages: c.messages,
        })),
      issues: cost.issues
        .filter((i) => i.shipmentId === s.shipmentId)
        .map((i) => ({ level: i.level, kind: i.kind, message: i.message })),
    },
  }));
  return { payload: { mode, shipments, lots }, skippedCodes: [...skipped].sort() };
}

export type CostRegistrationResult = {
  ok: boolean;
  mode?: "receipt" | "backfill";
  registered_lots: number;
  skipped_products: number;
  revalued_opening_lots?: number;
  reconciled: Array<{
    product_code: string;
    consumed?: number;
    adjusted?: number;
    opening?: number;
    skipped?: boolean;
  }>;
};

export async function registerCostReceipt(
  payload: CostRegistrationPayload,
): Promise<CostRegistrationResult> {
  const { data, error } = await requireClient().rpc("cost_register_receipt", { p: payload });
  if (error) throw new Error(describe(error));
  return data as CostRegistrationResult;
}

/**
 * 商品ごとに登録済みのいちばん新しい便。NEの原価を、より古い便の値で上書きしないために使う。
 * 戻り値は 商品コード小文字 → 配送依頼書番号
 */
export async function fetchLatestShipments(productCodes: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (productCodes.length === 0) return map;
  const { data, error } = await requireClient().rpc("cost_latest_shipments", { p_codes: productCodes });
  if (error) throw new Error(describe(error));
  for (const row of (data ?? []) as Array<{ product_code_lc: string; shipment_id: string }>) {
    map.set(row.product_code_lc, row.shipment_id);
  }
  return map;
}

/** neGenka のうち、すでにもっと新しい便が登録されている商品を除く */
export async function filterGenkaByLatest<T extends { productCode: string; shipmentId: string }>(rows: T[]): Promise<{
  rows: T[];
  skipped: string[];
}> {
  const latest = await fetchLatestShipments(rows.map((row) => row.productCode));
  const kept: T[] = [];
  const skipped: string[] = [];
  for (const row of rows) {
    const newest = latest.get(row.productCode.toLowerCase());
    if (newest && newest > row.shipmentId) skipped.push(row.productCode);
    else kept.push(row);
  }
  return { rows: kept, skipped };
}
