// 原価計算（便ごとの原価・先入先出）で使う型。

export type CostToken = {
  productCode: string;
  productCodeLc: string;
  mmdd: string;
  quantity: number;
  /** parser.ts の ExtractedRow.rowId と同じ形式（修正後の行を引くためのキー） */
  rowId: string;
};

export type CostLineBox = { boxNo: number; qty: number };

export type CostLine = {
  /** 配送依頼書NO（シート内の行番号） */
  lineNo: number;
  orderNo: string;
  itemNo: string;
  productInfo: string;
  purchaseQty: number;
  shipQty: number;
  unitPriceCny: number;
  domesticCny: number;
  optionCny: number;
  note: string;
  tokens: CostToken[];
  boxes: CostLineBox[];
};

export type CostBox = { boxNo: number; chargeableKg: number };

/** 配送依頼書1ファイル（=1便）から読み取った原価計算の元データ */
export type ShipmentCostSource = {
  shipmentId: string;
  sourceFile: string;
  rate: number;
  intlFreightJpy: number;
  agencyFeeJpy: number;
  otherFeeJpy: number;
  boxes: CostBox[];
  lines: CostLine[];
  parseWarnings: string[];
};

export type MaterialAllocation = { productCode: string; qtyPerUnit: number };

/** 商品コードのない行（共有資材）の割当ルール。注文番号+商品番号で保存する */
export type MaterialRule = {
  orderNo: string;
  itemNo: string;
  allocations: MaterialAllocation[];
  ignore: boolean;
  note?: string;
};

export type CostRules = {
  /** 1行に複数コードがある行で使う「1単位あたりの個数（入数）」。キーは商品コード小文字 */
  unitRules: Record<string, number>;
  /** キーは materialRuleKey(orderNo, itemNo) */
  materialRules: Record<string, MaterialRule>;
};

export type CostBreakdown = {
  goods: number;
  option: number;
  domestic: number;
  intl: number;
  other: number;
};

export type CostIssueKind =
  | "missing_unit_rule"
  | "unit_mismatch"
  | "unassigned_material"
  | "material_mismatch"
  | "material_no_target"
  | "deleted_line"
  | "no_units"
  | "no_cost_data"
  | "intl_fallback"
  | "quantity_mismatch"
  | "parse";

export type CostIssue = {
  level: "error" | "warning";
  kind: CostIssueKind;
  shipmentId: string;
  message: string;
  productCodes: string[];
  line?: CostLine;
  /** 共有資材の候補（同じ便の備考で注文番号が言及されているコード） */
  suggestedCodes?: string[];
  /** 共有資材の割当先候補（同じ便で入庫するコード） */
  candidateCodes?: string[];
  amountJpy?: number;
};

export type CodeCost = {
  shipmentId: string;
  sourceFile: string;
  productCode: string;
  productCodeLc: string;
  units: number;
  total: CostBreakdown;
  totalJpy: number;
  unitCost: number;
  unitBreakdown: CostBreakdown;
  status: "ok" | "warning" | "error";
  messages: string[];
};

export type ShipmentCostSummary = {
  shipmentId: string;
  sourceFile: string;
  rate: number;
  goodsCny: number;
  domesticCny: number;
  optionCny: number;
  intlFreightJpy: number;
  otherFeeJpy: number;
  chargeableKg: number;
  intlMethod: "box" | "value";
  totalJpy: number;
  allocatedJpy: number;
  ignoredJpy: number;
  unallocatedJpy: number;
};

export type NeGenkaRow = {
  productCode: string;
  shipmentId: string;
  unitCost: number;
  genkaTnk: number;
};

export type CostResult = {
  shipments: ShipmentCostSummary[];
  codes: CodeCost[];
  issues: CostIssue[];
  neGenka: NeGenkaRow[];
};

/** NEのフリー在庫ではなく「在庫数」と原価。reflect-nyuko がアップロード直前に取得して返す */
export type NeStockBefore = {
  product_code: string;
  stock_quantity: number | null;
  cost_price: number | null;
  found: boolean;
};
