export type FileRole = "packing" | "unknown";

export type SelectedFiles = {
  packingFiles: File[];
};

export type ProductHubSettings = {
  apiUrl: string;
  apiKey: string;
  accessToken: string;
};

export type ExtractedRow = {
  rowId: string;
  productCode: string;
  productCodeLc: string;
  mmdd: string;
  quantity: number;
  receivedQuantity: number;
  key: string;
  sourceKey: string;
  packingQuantities: number[];
  quantityMismatch: boolean;
  sourceNote: string;
  sourceFile: string;
};

export type PackingImage = {
  dataUrl: string;
  fileName: string;
  mimeType: string;
};

export type OtherPackingRow = {
  rowId: string;
  sourceFile: string;
  sourceRowNumber: number;
  sourceNote: string;
  productInfo: string;
  packingQuantity: number | null;
  image?: PackingImage;
  category: string;
  itemName: string;
  note: string;
};

export type PackingParseResult = {
  extracted: ExtractedRow[];
  otherRows: OtherPackingRow[];
};

export type ProductHubRecord = {
  productCode: string;
  productCodeLc: string;
  productName: string;
  floor: string;
  rackNumber: string;
  rackLevel: string;
  stickerColor: string;
  orders: (string | null)[];
  rms: (string | null)[];
};

export type OrderRecord = {
  productCode: string;
  productCodeLc: string;
  productName: string;
  orders: (string | null)[];
  rms: (string | null)[];
  raw?: Record<string, string | null>;
};

export type MasterRecord = {
  productCode: string;
  productCodeLc: string;
  productName: string;
  floor: string;
  rackNumber: string;
  rackLevel: string;
  stickerColor: string;
};

export type WarningType = "no_product" | "no_key" | "quantity_mismatch";

export type MatchWarning = {
  type: WarningType;
  productCode: string;
  rowId?: string;
  key?: string;
  deliveredKeys: string[];
  expectedQuantity?: number;
  packingQuantities?: number[];
  sourceFile?: string;
  currentOrders?: string[];
  message: string;
};

export type MatchedProduct = {
  productCode: string;
  productCodeLc: string;
  deliveredKeys: string[];
  incomingQuantity: number;
  remainingPairs: { order: string; rm: string | null }[];
};

export type MatchResult = {
  matched: MatchedProduct[];
  warnings: MatchWarning[];
};

export type NeUpdateRow = {
  syohin_code: string;
  zaiko_su: number;
  kataban: string;
};

export type ProductDbUpdateRow = {
  product_code: string;
  order_memo_1: string;
  rakumart_url_1: string;
  order_memo_2: string;
  rakumart_url_2: string;
  order_memo_3: string;
  rakumart_url_3: string;
  order_memo_4: string;
  rakumart_url_4: string;
  order_memo_5: string;
  rakumart_url_5: string;
};

export type NyukoListRow = {
  階数: string;
  "棚-段": string;
  シール: string;
  商品コード: string;
  商品名: string;
  入庫数: number;
  備考: string;
};

export type RowCorrection = {
  productCode?: string;
  mmdd?: string;
  quantity?: string;
  category?: string;
  itemName?: string;
  note?: string;
  deleted?: boolean;
};

export type RowCorrectionMap = Record<string, RowCorrection>;

export type ProcessResult = {
  /**
   * 再処理用の元データ。ブラウザのFileはlocalStorageへ保存できないため、
   * 復元後の「修正を反映して再処理」はこの元データから再計算する。
   * 古い保存データとの互換性のためoptional。
   */
  sourceExtractedRows?: ExtractedRow[];
  sourceOtherRows?: OtherPackingRow[];
  extracted: ExtractedRow[];
  otherRows: OtherPackingRow[];
  productHubRecords: ProductHubRecord[];
  matchResult: MatchResult;
  neRows: NeUpdateRow[];
  productDbUpdateRows: ProductDbUpdateRow[];
  nyukoRows: NyukoListRow[];
};

export const ORDER_MEMO_COLS = [
  "order_memo_1",
  "order_memo_2",
  "order_memo_3",
  "order_memo_4",
  "order_memo_5",
] as const;
export const RAKUMART_URL_COLS = [
  "rakumart_url_1",
  "rakumart_url_2",
  "rakumart_url_3",
  "rakumart_url_4",
  "rakumart_url_5",
] as const;

export const ORDER_COLS = [
  "オーダー1",
  "オーダー2",
  "オーダー3",
  "オーダー4",
  "オーダー5",
] as const;
export const RM_COLS = ["RM1", "RM2", "RM3", "RM4", "RM5"] as const;
