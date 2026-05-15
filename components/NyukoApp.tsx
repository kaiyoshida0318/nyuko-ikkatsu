"use client";

import {
  ChangeEvent,
  DragEvent,
  KeyboardEvent,
  ReactNode,
  useMemo,
  useRef,
  useState,
} from "react";
import { saveAs } from "file-saver";
import { detectFileRole } from "@/lib/fileRoles";
import {
  makeKintoneCsvBlob,
  makeNeCsvBlob,
  makeNyukoXlsxBlob,
  makeZipBlob,
} from "@/lib/formatter";
import { runNyukoProcess } from "@/lib/process";
import type {
  ExtractedRow,
  MatchWarning,
  OtherPackingRow,
  ProcessResult,
  ProductHubRecord,
  ProductHubSettings,
  RowCorrection,
  RowCorrectionMap,
  SelectedFiles,
} from "@/lib/types";

type PreviewTab = "extracted" | "other" | "ne" | "kintone" | "nyuko";

const assetBasePath =
  process.env.NODE_ENV === "production" ? "/nyuko-ikkatsu" : "";
const PRODUCT_HUB_API_URL_STORAGE_KEY = "nyuko-ikkatsu.productHub.apiUrl";
const PRODUCT_HUB_API_KEY_STORAGE_KEY = "nyuko-ikkatsu.productHub.apiKey";

const emptyFiles: SelectedFiles = {
  packingFiles: [],
};

function loadProductHubSettings(): ProductHubSettings {
  if (typeof window === "undefined") return { apiUrl: "", apiKey: "" };
  return {
    apiUrl: window.localStorage.getItem(PRODUCT_HUB_API_URL_STORAGE_KEY) ?? "",
    apiKey: window.localStorage.getItem(PRODUCT_HUB_API_KEY_STORAGE_KEY) ?? "",
  };
}

function formatFileSize(file: File) {
  if (file.size < 1024) return `${file.size} B`;
  if (file.size < 1024 * 1024) return `${(file.size / 1024).toFixed(1)} KB`;
  return `${(file.size / 1024 / 1024).toFixed(1)} MB`;
}

function mergeFiles(
  current: SelectedFiles,
  incomingFiles: File[],
): SelectedFiles {
  const next: SelectedFiles = {
    packingFiles: [...current.packingFiles],
  };

  for (const file of incomingFiles) {
    const role = detectFileRole(file);
    if (role === "packing") {
      const duplicated = next.packingFiles.some(
        (currentFile) =>
          currentFile.name === file.name && currentFile.size === file.size,
      );
      if (!duplicated) next.packingFiles.push(file);
    }
  }

  return next;
}

function ProductHubSettingsPanel({
  settings,
  onChange,
}: {
  settings: ProductHubSettings;
  onChange: (settings: ProductHubSettings) => void;
}) {
  const isReady = Boolean(settings.apiUrl.trim() && settings.apiKey.trim());

  function updateSetting(key: keyof ProductHubSettings, value: string) {
    const next = { ...settings, [key]: value };
    onChange(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(PRODUCT_HUB_API_URL_STORAGE_KEY, next.apiUrl);
      window.localStorage.setItem(PRODUCT_HUB_API_KEY_STORAGE_KEY, next.apiKey);
    }
  }

  return (
    <div
      className="product-hub-settings"
      role="region"
      aria-label="商品DB連携設定"
    >
      <div className="product-hub-settings-head">
        <div>
          <p className="eyebrow">PRODUCT DB</p>
          <h2>商品DB連携</h2>
          <p>配送依頼書の商品コードだけを Supabase products から直接取得します。</p>
        </div>
        <span
          className={`status-badge ${isReady ? "status-badge--good" : "status-badge--warn"}`}
        >
          {isReady ? "設定済み" : "未設定"}
        </span>
      </div>

      <div className="settings-grid settings-grid--header">
        <label className="setting-field">
          <span>Supabase URL</span>
          <input
            type="url"
            value={settings.apiUrl}
            onChange={(event) => updateSetting("apiUrl", event.target.value)}
            placeholder="https://PROJECT_REF.supabase.co"
          />
        </label>
        <label className="setting-field">
          <span>SUPABASE ANON KEY</span>
          <input
            type="password"
            value={settings.apiKey}
            onChange={(event) => updateSetting("apiKey", event.target.value)}
            placeholder="SUPABASE_ANON_KEY"
          />
        </label>
      </div>

      <p className="settings-note settings-note--compact">
        Supabase URLとanon keyだけ保存します。商品情報・オーダー状況は処理時にだけ取得します。
      </p>
    </div>
  );
}

function Pill({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "good" | "warn" | "danger";
}) {
  return <span className={`pill pill--${tone}`}>{children}</span>;
}

function EmptyText({ children }: { children: ReactNode }) {
  return <p className="empty-text">{children}</p>;
}

type EditableExtractedRow = {
  row: ExtractedRow;
  warningLabels: string[];
};

function getWarningLabel(type: MatchWarning["type"]) {
  if (type === "no_product") return "商品DB未登録";
  if (type === "no_key") return "キー未一致";
  return "数量不一致";
}

function buildEditableRows(result: ProcessResult): EditableExtractedRow[] {
  const rowMap = new Map(result.extracted.map((row) => [row.rowId, row]));
  const labels = new Map<string, Set<string>>();

  function add(rowId: string, label: string) {
    if (!rowMap.has(rowId)) return;
    const current = labels.get(rowId) ?? new Set<string>();
    current.add(label);
    labels.set(rowId, current);
  }

  for (const warning of result.matchResult.warnings) {
    const label = getWarningLabel(warning.type);

    if (warning.rowId) {
      add(warning.rowId, label);
      continue;
    }

    if (warning.type === "no_product") {
      for (const row of result.extracted) {
        if (row.productCode === warning.productCode) add(row.rowId, label);
      }
      continue;
    }

    for (const row of result.extracted) {
      if (
        row.productCode === warning.productCode &&
        (!warning.key || row.key === warning.key)
      ) {
        add(row.rowId, label);
      }
    }
  }

  return result.extracted
    .map((row) => ({
      row,
      warningLabels: [...(labels.get(row.rowId) ?? new Set<string>())],
    }))
    .sort(
      (a, b) =>
        b.warningLabels.length - a.warningLabels.length ||
        a.row.productCodeLc.localeCompare(b.row.productCodeLc) ||
        a.row.key.localeCompare(b.row.key),
    );
}

function getCorrectionValue(
  correction: RowCorrection | undefined,
  key: Exclude<keyof RowCorrection, "deleted">,
  fallback: string,
) {
  const value = correction?.[key];
  return value === undefined ? fallback : value;
}

function getProductDbKeys(record: ProductHubRecord | undefined) {
  if (!record) return [];
  return record.orders
    .map((order, index) =>
      order ? { label: `オーダー${index + 1}`, value: order } : null,
    )
    .filter((item): item is { label: string; value: string } =>
      Boolean(item),
    );
}

const OTHER_CATEGORY_OPTIONS = ["新商品", "試し買い", "備品"] as const;

function OtherRowsTable({
  rows,
  corrections,
  onChange,
  onResetRow,
  onDeleteRow,
  isProcessing,
}: {
  rows: OtherPackingRow[];
  corrections: RowCorrectionMap;
  onChange: (rowId: string, patch: RowCorrection) => void;
  onResetRow: (rowId: string) => void;
  onDeleteRow: (rowId: string) => void;
  isProcessing: boolean;
}) {
  if (rows.length === 0) return null;

  return (
    <div className="other-table-section">
      <div className="other-table-title">
        <div>
          <h3>その他</h3>
          <p>備考に「●商品コード▲mmdd-数量」がない行です。分類・品名・備考を入力して、入庫リストの末尾にその他として追加します。</p>
        </div>
        <Pill tone="warn">{rows.length}行</Pill>
      </div>

      <div className="warning-fix-table-wrap" role="region" aria-label="その他テーブル">
        <table className="warning-fix-table other-fix-table">
          <thead>
            <tr>
              <th>画像</th>
              <th>分類</th>
              <th>品名</th>
              <th>梱包数</th>
              <th>備考</th>
              <th>商品情報</th>
              <th>箱詰め備考</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const correction = corrections[row.rowId];
              const category = getCorrectionValue(correction, "category", row.category);
              const itemName = getCorrectionValue(correction, "itemName", row.itemName);
              const note = getCorrectionValue(correction, "note", row.note);
              const changed =
                category !== row.category ||
                itemName !== row.itemName ||
                note !== row.note;

              return (
                <tr className={`other-fix-row ${changed ? "is-edited" : ""}`} key={row.rowId}>
                  <td className="other-image-cell">
                    {row.image ? (
                      <img src={row.image.dataUrl} alt="その他商品画像" />
                    ) : (
                      <span>画像なし</span>
                    )}
                  </td>
                  <td className="other-edit-cell other-edit-cell--category">
                    <input
                      aria-label="その他の分類"
                      list="other-category-options"
                      type="text"
                      value={category}
                      placeholder="分類"
                      onChange={(event) =>
                        onChange(row.rowId, { category: event.target.value })
                      }
                    />
                  </td>
                  <td className="other-edit-cell other-edit-cell--name">
                    <input
                      aria-label="その他の品名"
                      type="text"
                      value={itemName}
                      placeholder="品名"
                      onChange={(event) =>
                        onChange(row.rowId, { itemName: event.target.value })
                      }
                    />
                  </td>
                  <td className="other-count-cell">
                    {row.packingQuantity ?? "未取得"}
                  </td>
                  <td className="other-edit-cell other-edit-cell--note">
                    <input
                      aria-label="その他の備考"
                      type="text"
                      value={note}
                      placeholder="備考"
                      onChange={(event) =>
                        onChange(row.rowId, { note: event.target.value })
                      }
                    />
                  </td>
                  <td className="other-info-cell">{row.productInfo}</td>
                  <td className="other-note-cell">{row.sourceNote}</td>
                  <td className="warning-action-cell">
                    <div className="warning-action-buttons">
                      <button
                        className="secondary-button warning-reset-button"
                        type="button"
                        onClick={() => onResetRow(row.rowId)}
                        disabled={!changed || isProcessing}
                      >
                        元に戻す
                      </button>
                      <button
                        className="secondary-button warning-delete-button"
                        type="button"
                        onClick={() => onDeleteRow(row.rowId)}
                        disabled={isProcessing}
                      >
                        削除
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <datalist id="other-category-options">
          {OTHER_CATEGORY_OPTIONS.map((option) => (
            <option key={option} value={option} />
          ))}
        </datalist>
      </div>
    </div>
  );
}

function ExtractedRowsEditPanel({
  result,
  corrections,
  onChange,
  onResetRow,
  onDeleteRow,
  onApply,
  isProcessing,
}: {
  result: ProcessResult;
  corrections: RowCorrectionMap;
  onChange: (rowId: string, patch: RowCorrection) => void;
  onResetRow: (rowId: string) => void;
  onDeleteRow: (rowId: string) => void;
  onApply: () => void;
  isProcessing: boolean;
}) {
  const rows = useMemo(() => buildEditableRows(result), [result]);
  const otherRows = result.otherRows;
  const productHubIndex = useMemo(() => {
    const map = new Map<string, ProductHubRecord>();
    for (const record of result.productHubRecords) {
      map.set(record.productCodeLc, record);
    }
    return map;
  }, [result.productHubRecords]);

  if (rows.length === 0 && otherRows.length === 0) return null;

  const warningRowCount = rows.filter((item) => item.warningLabels.length > 0).length;

  return (
    <section className="warning-fix-panel warning-fix-panel--table">
      <div className="section-title-row">
        <div>
          <p className="eyebrow">EDIT</p>
          <h2>商品一覧/修正</h2>
          <p>
            通常商品は上の一覧で修正できます。備考に商品コードキーがない行は下の「その他」に分けて表示します。
          </p>
        </div>
        <Pill tone={warningRowCount > 0 || otherRows.length > 0 ? "warn" : "good"}>
          商品{rows.length}行 / その他{otherRows.length}行 / 警告{warningRowCount}行
        </Pill>
      </div>

      {rows.length > 0 && (
        <div className="warning-fix-table-wrap" role="region" aria-label="商品一覧修正テーブル">
          <table className="warning-fix-table">
            <thead>
              <tr className="warning-fix-group-row">
                <th rowSpan={2}>状態</th>
                <th rowSpan={2}>商品コード</th>
                <th rowSpan={2}>商品DBオーダー状況</th>
                <th className="warning-group-header warning-group-header--delivery" colSpan={3}>
                  配送依頼書
                </th>
                <th className="warning-group-header warning-group-header--manual" colSpan={4}>
                  手動修正
                </th>
                <th rowSpan={2}>操作</th>
              </tr>
              <tr className="warning-fix-column-row">
                <th className="warning-delivery-start">備考</th>
                <th>梱包数</th>
                <th>元ファイル</th>
                <th className="warning-manual-start">商品コード</th>
                <th>オーダー日</th>
                <th>オーダー数</th>
                <th>修正後キー</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ row, warningLabels }) => {
                const hasWarning = warningLabels.length > 0;
                const correction = corrections[row.rowId];
                const productCode = getCorrectionValue(
                  correction,
                  "productCode",
                  row.productCode,
                );
                const mmdd = getCorrectionValue(correction, "mmdd", row.mmdd);
                const quantity = getCorrectionValue(
                  correction,
                  "quantity",
                  String(row.quantity),
                );
                const nextKey = `${mmdd || row.mmdd}-${quantity || row.quantity}`;
                const changed =
                  productCode !== row.productCode ||
                  mmdd !== row.mmdd ||
                  quantity !== String(row.quantity);
                const productRecord =
                  productHubIndex.get(productCode.trim().toLowerCase()) ??
                  productHubIndex.get(row.productCodeLc);
                const productDbKeys = getProductDbKeys(productRecord);

                return (
                  <tr
                    className={`warning-fix-row ${hasWarning ? "has-warning" : ""} ${changed ? "is-edited" : ""}`}
                    key={row.rowId}
                  >
                    <td className="warning-status-cell">
                      <div className={`warning-labels ${hasWarning ? "" : "warning-labels--ok"}`}>
                        {hasWarning ? (
                          warningLabels.map((label) => <span key={label}>{label}</span>)
                        ) : (
                          <span>OK</span>
                        )}
                      </div>
                    </td>
                    <td className="warning-code-cell">
                      <strong>{row.productCode}</strong>
                    </td>
                    <td className="warning-db-keys-cell">
                      {productDbKeys.length > 0 ? (
                        <div className="warning-db-key-list warning-db-key-list--table">
                          {productDbKeys.map((item) => (
                            <span key={`${row.rowId}-${item.label}-${item.value}`}>
                              <small>{item.label}</small>
                              <strong>{item.value}</strong>
                            </span>
                          ))}
                        </div>
                      ) : (
                        <strong className="warning-db-key-empty">
                          {productRecord ? "登録キーなし" : "商品DB未登録"}
                        </strong>
                      )}
                    </td>
                    <td className="warning-delivery-start">{row.sourceKey}</td>
                    <td>
                      {row.packingQuantities.length
                        ? row.packingQuantities.join(" / ")
                        : "未取得"}
                    </td>
                    <td className="warning-source-cell" title={row.sourceFile}>
                      {row.sourceFile}
                    </td>
                    <td className="warning-edit-cell warning-edit-cell--code warning-manual-start">
                      <input
                        aria-label={`${row.productCode} の修正商品コード`}
                        type="text"
                        value={productCode}
                        onChange={(event) =>
                          onChange(row.rowId, { productCode: event.target.value })
                        }
                      />
                    </td>
                    <td className="warning-edit-cell warning-edit-cell--short">
                      <input
                        aria-label={`${row.productCode} のオーダー日`}
                        type="text"
                        inputMode="numeric"
                        maxLength={4}
                        value={mmdd}
                        onChange={(event) =>
                          onChange(row.rowId, { mmdd: event.target.value })
                        }
                      />
                    </td>
                    <td className="warning-edit-cell warning-edit-cell--short">
                      <input
                        aria-label={`${row.productCode} のオーダー数`}
                        type="text"
                        inputMode="numeric"
                        value={quantity}
                        onChange={(event) =>
                          onChange(row.rowId, { quantity: event.target.value })
                        }
                      />
                    </td>
                    <td className="warning-next-key-cell">
                      <strong>{nextKey}</strong>
                    </td>
                    <td className="warning-action-cell">
                      <div className="warning-action-buttons">
                        <button
                          className="secondary-button warning-reset-button"
                          type="button"
                          onClick={() => onResetRow(row.rowId)}
                          disabled={!changed || isProcessing}
                        >
                          元に戻す
                        </button>
                        <button
                          className="secondary-button warning-delete-button"
                          type="button"
                          onClick={() => onDeleteRow(row.rowId)}
                          disabled={isProcessing}
                        >
                          削除
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <OtherRowsTable
        rows={otherRows}
        corrections={corrections}
        onChange={onChange}
        onResetRow={onResetRow}
        onDeleteRow={onDeleteRow}
        isProcessing={isProcessing}
      />

      <div className="warning-fix-actions">
        <button
          className="primary-button"
          type="button"
          onClick={onApply}
          disabled={isProcessing}
        >
          {isProcessing ? "再処理中…" : "修正を反映して再処理"}
        </button>
      </div>
    </section>
  );
}

function PreviewTable({ rows }: { rows: Record<string, unknown>[] }) {
  if (rows.length === 0)
    return <EmptyText>表示するデータがありません。</EmptyText>;
  const headers = Object.keys(rows[0]);
  const visibleRows = rows.slice(0, 200);
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {headers.map((header) => (
              <th key={header}>{header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {visibleRows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {headers.map((header) => (
                <td key={header}>{String(row[header] ?? "")}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > visibleRows.length && (
        <p className="table-note">
          先頭{visibleRows.length}件のみ表示しています。
        </p>
      )}
    </div>
  );
}

function toExtractedPreview(rows: ExtractedRow[]) {
  return rows.map((row) => ({
    商品コード: row.productCode,
    MMDD: row.mmdd,
    読み取り数量: row.quantity,
    消し込みキー: row.key,
    梱包数: row.packingQuantities.length
      ? row.packingQuantities.join(" / ")
      : "",
    数量判定: row.quantityMismatch ? "数量不一致" : "OK",
    元ファイル: row.sourceFile,
    箱詰め備考: row.sourceNote,
  }));
}

function toOtherPreview(rows: OtherPackingRow[]) {
  return rows.map((row) => ({
    画像: row.image ? "画像あり" : "画像なし",
    分類: row.category,
    品名: row.itemName,
    梱包数: row.packingQuantity ?? "",
    備考: row.note,
    商品情報: row.productInfo,
    箱詰め備考: row.sourceNote,
    元ファイル: row.sourceFile,
  }));
}

function tabCount(result: ProcessResult | null, tab: PreviewTab) {
  if (!result) return 0;
  if (tab === "extracted") return result.extracted.length;
  if (tab === "other") return result.otherRows.length;
  if (tab === "ne") return result.neRows.length;
  if (tab === "kintone") return result.kintoneRows.length;
  return result.nyukoRows.length;
}

export default function NyukoApp() {
  const [files, setFiles] = useState<SelectedFiles>(emptyFiles);
  const [unknownFiles, setUnknownFiles] = useState<File[]>([]);
  const [productHubSettings, setProductHubSettings] =
    useState<ProductHubSettings>(loadProductHubSettings);
  const [isDragging, setIsDragging] = useState(false);
  const [isProductHubPanelOpen, setIsProductHubPanelOpen] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ProcessResult | null>(null);
  const [corrections, setCorrections] = useState<RowCorrectionMap>({});
  const [activeTab, setActiveTab] = useState<PreviewTab>("extracted");
  const bulkInputRef = useRef<HTMLInputElement>(null);

  const productHubReady = Boolean(
    productHubSettings.apiUrl.trim() && productHubSettings.apiKey.trim(),
  );
  const canRun =
    files.packingFiles.length > 0 && productHubReady && !isProcessing;
  const selectedFileCount = files.packingFiles.length;

  const summary = useMemo(() => {
    if (!result) return null;
    const noProduct = result.matchResult.warnings.filter(
      (warning) => warning.type === "no_product",
    ).length;
    const noKey = result.matchResult.warnings.filter(
      (warning) => warning.type === "no_key",
    ).length;
    const quantityMismatch = result.matchResult.warnings.filter(
      (warning) => warning.type === "quantity_mismatch",
    ).length;
    return {
      extracted: result.extracted.length,
      ne: result.neRows.length,
      kintone: result.kintoneRows.length,
      nyuko: result.nyukoRows.length,
      other: result.otherRows.length,
      warnings: result.matchResult.warnings.length,
      noProduct,
      noKey,
      quantityMismatch,
    };
  }, [result]);

  function openBulkFilePicker() {
    bulkInputRef.current?.click();
  }

  function handleDropZoneKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openBulkFilePicker();
    }
  }

  function handleDragLeaveInside(
    event: DragEvent<HTMLElement>,
    onLeave: () => void,
  ) {
    const nextTarget = event.relatedTarget as Node | null;
    if (!nextTarget || !event.currentTarget.contains(nextTarget)) {
      onLeave();
    }
  }

  function handleDropZoneDragLeave(event: DragEvent<HTMLDivElement>) {
    handleDragLeaveInside(event, () => setIsDragging(false));
  }

  function acceptFiles(incoming: File[]) {
    setError(null);
    setResult(null);
    setCorrections({});
    setFiles((current) => mergeFiles(current, incoming));
    const unknown = incoming.filter(
      (file) => detectFileRole(file) === "unknown",
    );
    if (unknown.length > 0) {
      setUnknownFiles((current) => [...current, ...unknown]);
    }
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);
    acceptFiles(Array.from(event.dataTransfer.files));
  }

  function handleBulkInput(event: ChangeEvent<HTMLInputElement>) {
    acceptFiles(Array.from(event.target.files ?? []));
    event.target.value = "";
  }

  function removePackingFile(targetIndex: number) {
    setError(null);
    setResult(null);
    setCorrections({});
    setFiles((current) => ({
      packingFiles: current.packingFiles.filter(
        (_, index) => index !== targetIndex,
      ),
    }));
  }

  function removeUnknownFile(targetIndex: number) {
    setUnknownFiles((current) =>
      current.filter((_, index) => index !== targetIndex),
    );
  }

  function updateCorrection(rowId: string, patch: RowCorrection) {
    setCorrections((current) => ({
      ...current,
      [rowId]: {
        ...(current[rowId] ?? {}),
        ...patch,
      },
    }));
  }

  function resetCorrection(rowId: string) {
    setCorrections((current) => {
      const next = { ...current };
      delete next[rowId];
      return next;
    });
  }

  async function deleteRow(rowId: string) {
    const nextCorrections: RowCorrectionMap = {
      ...corrections,
      [rowId]: {
        ...(corrections[rowId] ?? {}),
        deleted: true,
      },
    };
    setCorrections(nextCorrections);
    await runWithCorrections(nextCorrections);
  }

  async function runWithCorrections(nextCorrections: RowCorrectionMap) {
    setIsProcessing(true);
    setError(null);
    setResult(null);
    try {
      const processResult = await runNyukoProcess(
        files,
        productHubSettings,
        nextCorrections,
      );
      setResult(processResult);
      setActiveTab("extracted");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "処理中にエラーが発生しました。",
      );
    } finally {
      setIsProcessing(false);
    }
  }

  async function handleRun() {
    await runWithCorrections(corrections);
  }

  function clearAll() {
    setFiles(emptyFiles);
    setUnknownFiles([]);
    setError(null);
    setResult(null);
    setCorrections({});
  }

  function getEffectiveOtherRows() {
    if (!result) return [];
    return result.otherRows.flatMap((row) => {
      const correction = corrections[row.rowId];
      if (correction?.deleted) return [];
      return [{
        ...row,
        category: correction?.category ?? row.category,
        itemName: correction?.itemName ?? row.itemName,
        note: correction?.note ?? row.note,
      }];
    });
  }

  function downloadNe() {
    if (!result) return;
    saveAs(makeNeCsvBlob(result.neRows), "NE更新.csv");
  }

  function downloadKintone() {
    if (!result) return;
    saveAs(makeKintoneCsvBlob(result.kintoneRows), "kintone更新.csv");
  }

  function downloadNyuko() {
    if (!result) return;
    saveAs(makeNyukoXlsxBlob(result.nyukoRows, getEffectiveOtherRows()), "入庫リスト.xlsx");
  }

  async function downloadZip() {
    if (!result) return;
    const blob = await makeZipBlob({ ...result, otherRows: getEffectiveOtherRows() });
    saveAs(blob, "入庫一括_出力.zip");
  }

  const previewRows: Record<string, unknown>[] = useMemo(() => {
    if (!result) return [];
    if (activeTab === "extracted") return toExtractedPreview(result.extracted);
    if (activeTab === "other") return toOtherPreview(getEffectiveOtherRows());
    if (activeTab === "ne")
      return result.neRows as unknown as Record<string, unknown>[];
    if (activeTab === "kintone")
      return result.kintoneRows as unknown as Record<string, unknown>[];
    return result.nyukoRows as unknown as Record<string, unknown>[];
  }, [activeTab, result, corrections]);

  return (
    <main className="page-shell">
      <header className="app-header" aria-label="入庫一括">
        <div className="app-header-inner">
          <div className="app-header-brand">
            <img
              className="app-symbol"
              src={`${assetBasePath}/symbol.png`}
              alt="入庫一括"
            />
          </div>

          <div className="app-header-actions">
            <button
              className={`product-hub-toggle ${productHubReady ? "product-hub-toggle--ready" : "product-hub-toggle--unset"}`}
              type="button"
              onClick={() => setIsProductHubPanelOpen((current) => !current)}
              aria-expanded={isProductHubPanelOpen}
            >
              <span className="product-hub-toggle-dot" />
              <span className="product-hub-toggle-label">商品DB</span>
              <strong>{productHubReady ? "接続済み" : "未設定"}</strong>
            </button>
          </div>

          {isProductHubPanelOpen && (
            <ProductHubSettingsPanel
              settings={productHubSettings}
              onChange={setProductHubSettings}
            />
          )}
        </div>
      </header>

      <section
        className={`drop-zone ${isDragging ? "is-dragging" : ""} ${selectedFileCount > 0 ? "has-files" : ""}`}
        role="button"
        tabIndex={0}
        aria-label="ラクマート配送依頼書を選択またはドロップ"
        onClick={openBulkFilePicker}
        onKeyDown={handleDropZoneKeyDown}
        onDragEnter={() => setIsDragging(true)}
        onDragOver={(event) => {
          event.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={handleDropZoneDragLeave}
        onDrop={handleDrop}
      >
        <input
          ref={bulkInputRef}
          className="drop-zone-input"
          type="file"
          multiple
          accept=".xlsx"
          onClick={(event) => event.stopPropagation()}
          onChange={handleBulkInput}
        />
        <div className="drop-zone-main">
          <div className="drop-visual" aria-hidden="true">
            <span className="drop-visual-ring" />
            <span className="drop-icon">↓</span>
          </div>
          <div className="drop-copy">
            <p className="eyebrow">UPLOAD</p>
            <h2>
              {isDragging
                ? "ここにドロップして追加"
                : "ラクマート配送依頼書をドロップor選択"}
            </h2>
            <div className="drop-hints" aria-hidden="true">
              <span>P~.xlsx 複数可</span>
              <span>商品情報は自動取得</span>
              <span>オーダー状況も自動取得</span>
            </div>
          </div>
        </div>
        <div className="drop-zone-side">
          <span className="drop-selected-count">
            {selectedFileCount > 0
              ? `${selectedFileCount}ファイル選択中`
              : "未選択"}
          </span>
          <span className="upload-button upload-button--fake">
            ファイルを選択
          </span>
        </div>
      </section>

      {unknownFiles.length > 0 && (
        <section className="notice notice--warn">
          <strong>未判定ファイルがあります</strong>
          <span>
            現在読み込めるのはラクマート配送依頼書の .xlsx
            のみです。商品情報CSV・オーダー状況CSVは不要です。
          </span>
          <ul className="unknown-file-list">
            {unknownFiles.map((file, index) => (
              <li key={`${file.name}-${file.size}-${index}`}>
                <span>{file.name}</span>
                <button
                  className="file-remove-button file-remove-button--light"
                  type="button"
                  onClick={() => removeUnknownFile(index)}
                >
                  削除
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className={`action-panel ${selectedFileCount > 0 ? "action-panel--has-selection" : ""}`}>
        <div className="action-panel-main">
          <p className="eyebrow">RUN</p>
          <h2>処理実行</h2>
          <div className="action-selection-status" aria-live="polite">
            <span>対象ファイル</span>
            <strong>
              {selectedFileCount > 0
                ? `${selectedFileCount}ファイル`
                : "ファイル未選択"}
            </strong>
          </div>

          {files.packingFiles.length > 0 && (
            <ul className="file-list action-file-list" aria-label="処理対象ファイル">
              {files.packingFiles.map((file, index) => (
                <li key={`${file.name}-${file.size}-${index}`}>
                  <div className="file-row-main">
                    <span>{file.name}</span>
                    <small>{formatFileSize(file)}</small>
                  </div>
                  <button
                    className="file-remove-button"
                    type="button"
                    onClick={() => removePackingFile(index)}
                    aria-label={`${file.name}を削除`}
                  >
                    削除
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="action-buttons">
          <button
            className="secondary-button"
            type="button"
            onClick={clearAll}
            disabled={selectedFileCount === 0 && unknownFiles.length === 0 && !result}
          >
            選択中をクリア
          </button>
          <button
            className="primary-button"
            type="button"
            onClick={handleRun}
            disabled={!canRun}
          >
            {isProcessing ? "商品DB取得中…" : "処理実行"}
          </button>
        </div>
      </section>

      {!productHubReady && (
        <section className="notice notice--warn">
          <strong>商品DB連携が未設定です</strong>
          <span>
            ヘッダー右側の「商品DB」から API URL と READ API KEY
            を入力すると処理できます。
          </span>
        </section>
      )}

      {error && (
        <section className="notice notice--danger">
          <strong>エラー</strong>
          <span>{error}</span>
        </section>
      )}

      {summary && (
        <section className="summary-grid">
          <div>
            <span>抽出</span>
            <strong>{summary.extracted}</strong>
          </div>
          <div>
            <span>NE更新</span>
            <strong>{summary.ne}</strong>
          </div>
          <div>
            <span>kintone更新</span>
            <strong>{summary.kintone}</strong>
          </div>
          <div>
            <span>入庫リスト</span>
            <strong>{summary.nyuko}</strong>
          </div>
          <div className={summary.other ? "summary-warn" : ""}>
            <span>その他</span>
            <strong>{summary.other}</strong>
          </div>
          <div className={summary.warnings ? "summary-warn" : "summary-good"}>
            <span>警告</span>
            <strong>{summary.warnings}</strong>
          </div>
        </section>
      )}

      {result && (
        <ExtractedRowsEditPanel
          result={result}
          corrections={corrections}
          onChange={updateCorrection}
          onResetRow={resetCorrection}
          onDeleteRow={deleteRow}
          onApply={handleRun}
          isProcessing={isProcessing}
        />
      )}

      {result && (
        <section className="download-panel">
          <div>
            <p className="eyebrow">DOWNLOAD</p>
            <h2>出力ファイル</h2>
          </div>
          <div className="download-buttons">
            <button type="button" onClick={downloadNe}>
              NE更新.csv
            </button>
            <button type="button" onClick={downloadKintone}>
              kintone更新.csv
            </button>
            <button type="button" onClick={downloadNyuko}>
              入庫リスト.xlsx
            </button>
            <button type="button" className="zip-button" onClick={downloadZip}>
              ZIP一括
            </button>
          </div>
        </section>
      )}

      {result && (
        <section className="preview-panel">
          <div className="section-title-row">
            <div>
              <p className="eyebrow">PREVIEW</p>
              <h2>プレビュー</h2>
            </div>
          </div>
          <div className="tab-row">
            {(
              [
                ["extracted", "抽出結果"],
                ["other", "その他"],
                ["ne", "NE更新"],
                ["kintone", "kintone更新"],
                ["nyuko", "入庫リスト"],
              ] as const
            ).map(([tab, label]) => (
              <button
                key={tab}
                type="button"
                className={activeTab === tab ? "active" : ""}
                onClick={() => setActiveTab(tab)}
              >
                {label}
                <span>{tabCount(result, tab)}</span>
              </button>
            ))}
          </div>
          <PreviewTable rows={previewRows} />
        </section>
      )}
    </main>
  );
}
