"use client";

import {
  ChangeEvent,
  DragEvent,
  FormEvent,
  KeyboardEvent,
  ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { saveAs } from "file-saver";
import { detectFileRole } from "@/lib/fileRoles";
import {
  makeNyukoXlsxBlob,
  makeZipBlob,
} from "@/lib/formatter";
import { NeReauthRequiredError, updateNextEngineByApi } from "@/lib/neSyncWorker";
import { runNyukoProcess } from "@/lib/process";
import { updateProductHubOrders } from "@/lib/productHub";
import {
  embeddedSupabaseAnonKey,
  embeddedSupabaseUrl,
  getSupabaseConfigError,
  NYUKO_AUTH_STORAGE_KEY,
  supabase,
} from "@/lib/supabaseClient";
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

type PreviewTab = "extracted" | "other" | "ne" | "productDb" | "nyuko";
type ReflectStatus = "pending" | "exported" | "updating" | "done" | "error";
type ReflectStatusMap = { ne: ReflectStatus; productDb: ReflectStatus; nyuko: ReflectStatus };
type UiTheme = "light" | "dark";

type SecretQuestionResponse = {
  ok?: boolean;
  question?: string;
  displayName?: string;
  error?: string;
};

type SecretLoginResponse = {
  ok?: boolean;
  email?: string;
  user?: {
    id?: string;
    email?: string;
  };
  session?: {
    access_token?: string;
    refresh_token?: string;
  };
  error?: string;
};

const UI_THEME_STORAGE_KEY = "nyuko-ikkatsu-ui-theme";

function getInitialUiTheme(): UiTheme {
  if (typeof window === "undefined") return "light";
  return window.localStorage.getItem(UI_THEME_STORAGE_KEY) === "dark" ? "dark" : "light";
}

const initialReflectStatus: ReflectStatusMap = {
  ne: "pending",
  productDb: "pending",
  nyuko: "pending",
};

function buildInitialReflectStatus(result: ProcessResult): ReflectStatusMap {
  return {
    productDb: result.productDbUpdateRows.length === 0 ? "done" : "pending",
    ne: result.neRows.length === 0 ? "done" : "pending",
    nyuko: "pending",
  };
}

const assetBasePath =
  process.env.NODE_ENV === "production" ? "/nyuko-ikkatsu" : "";
const AUTH_API_BASE_URL = String(process.env.NEXT_PUBLIC_AUTH_API_BASE_URL ?? "").replace(/\/+$/, "");
const emptyFiles: SelectedFiles = {
  packingFiles: [],
};

function buildProductHubSettings(accessToken = ""): ProductHubSettings {
  return {
    apiUrl: embeddedSupabaseUrl,
    apiKey: embeddedSupabaseAnonKey,
    accessToken,
  };
}


function clearNyukoSupabaseAuthStorage() {
  if (typeof window === "undefined") return;

  // 商品DBと同じSupabaseプロジェクトを使っていても、
  // 入庫一括専用のstorageKeyだけを消す。
  // sb-xxxxx-auth-token などの共通キーは商品DB側のログインに使われる可能性があるため触らない。
  for (const storage of [window.localStorage, window.sessionStorage]) {
    storage.removeItem(NYUKO_AUTH_STORAGE_KEY);
  }
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
  userEmail,
}: {
  settings: ProductHubSettings;
  userEmail: string;
}) {
  const hasUrl = Boolean(settings.apiUrl.trim());
  const hasAnonKey = Boolean(settings.apiKey.trim());
  const hasAccessToken = Boolean(settings.accessToken.trim());
  const isReady = hasUrl && hasAnonKey && hasAccessToken;

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
          <p>Supabase Authでログイン中のアカウントを使って products を取得・更新します。</p>
        </div>
        <span
          className={`status-badge ${isReady ? "status-badge--good" : "status-badge--warn"}`}
        >
          {isReady ? "接続済み" : "未接続"}
        </span>
      </div>

      <div className="product-hub-status-grid">
        <div className={`product-hub-status-item ${hasUrl ? "is-good" : "is-warn"}`}>
          <span>Supabase URL</span>
          <strong>{hasUrl ? "埋め込み済み" : "未設定"}</strong>
        </div>
        <div className={`product-hub-status-item ${hasAnonKey ? "is-good" : "is-warn"}`}>
          <span>ANON KEY</span>
          <strong>{hasAnonKey ? "埋め込み済み" : "未設定"}</strong>
        </div>
        <div className={`product-hub-status-item ${hasAccessToken ? "is-good" : "is-warn"}`}>
          <span>ログイン</span>
          <strong>{hasAccessToken ? userEmail || "ログイン済み" : "未ログイン"}</strong>
        </div>
      </div>

      <p className="settings-note settings-note--compact">
        URLとanon keyはビルド時の環境変数から読み込みます。ブラウザ上での手入力は不要です。
      </p>
    </div>
  );
}

function AuthShell({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <main className="auth-shell">
      <section className="auth-card auth-card--simple">
        <div className="auth-brand auth-brand--simple">
          <img src={`${assetBasePath}/symbol.png`} alt="入庫一括" />
        </div>
        {children}
      </section>
    </main>
  );
}

function LoginPanel() {
  const [answer, setAnswer] = useState("");
  const [question, setQuestion] = useState("秘密の質問");
  const [displayName, setDisplayName] = useState("秘密の質問ログイン");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    async function fetchQuestion() {
      if (!AUTH_API_BASE_URL) return;

      try {
        const response = await fetch(`${AUTH_API_BASE_URL}/api/auth/question`, {
          method: "GET",
          cache: "no-store",
        });
        const payload = (await response.json().catch(() => ({}))) as SecretQuestionResponse;
        if (!isMounted) return;
        if (response.ok && payload.ok) {
          setQuestion(payload.question || "秘密の質問");
          setDisplayName(payload.displayName || "秘密の質問ログイン");
        }
      } catch {
        if (isMounted) setQuestion("秘密の質問");
      }
    }

    fetchQuestion();

    return () => {
      isMounted = false;
    };
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoginError(null);

    if (!supabase) {
      setLoginError("Supabase設定が未設定です。");
      return;
    }
    if (!AUTH_API_BASE_URL) {
      setLoginError("ログインAPIが未設定です。NEXT_PUBLIC_AUTH_API_BASE_URLを設定してください。");
      return;
    }
    if (!answer.trim()) {
      setLoginError("回答を入力してください。");
      return;
    }

    setIsSubmitting(true);
    try {
      const response = await fetch(`${AUTH_API_BASE_URL}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer: answer.trim() }),
      });
      const payload = (await response.json().catch(() => ({}))) as SecretLoginResponse;

      if (!response.ok || !payload.ok || !payload.session?.access_token || !payload.session.refresh_token) {
        throw new Error(payload.error || "ログインに失敗しました。");
      }

      const { error } = await supabase.auth.setSession({
        access_token: payload.session.access_token,
        refresh_token: payload.session.refresh_token,
      });
      if (error) throw error;
      setAnswer("");
    } catch (err) {
      const message = err instanceof Error ? err.message : "ログインに失敗しました。";
      setLoginError(
        message === "Failed to fetch"
          ? "ログインAPIに接続できませんでした。NEXT_PUBLIC_AUTH_API_BASE_URL と Worker のCORS設定を確認してください。"
          : message,
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <AuthShell>
      <form className="auth-form auth-form--simple" onSubmit={handleSubmit}>
        <label className="auth-question-field">
          <span className="auth-question-text">{question}</span>
          <input
            type="password"
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            autoComplete="current-password"
            placeholder="回答を入力"
            required
          />
        </label>

        {loginError && <p className="auth-error">{loginError}</p>}

        <button className="primary-button auth-submit" type="submit" disabled={isSubmitting}>
          {isSubmitting ? "ログイン中…" : "ログイン"}
        </button>
      </form>
    </AuthShell>
  );
}

function ConfigErrorPanel({ message }: { message: string }) {
  return (
    <AuthShell>
      <div className="auth-copy">
        <h2>Supabase設定が未設定です</h2>
        <p>{message}</p>
      </div>
      <div className="auth-env-box">
        <code>NEXT_PUBLIC_SUPABASE_URL</code>
        <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code>
      </div>
    </AuthShell>
  );
}


function SettingsPanel({
  theme,
  onChangeTheme,
}: {
  theme: UiTheme;
  onChangeTheme: (theme: UiTheme) => void;
}) {
  return (
    <div className="settings-menu" role="dialog" aria-label="設定">
      <div className="settings-menu-head">
        <div>
          <p className="eyebrow">SETTINGS</p>
          <h2>設定</h2>
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-section-copy">
          <strong>表示モード</strong>
          <span>作業場所の明るさに合わせて切り替えできます。</span>
        </div>
        <div className="theme-segment" role="group" aria-label="表示モード">
          <button
            className={theme === "light" ? "is-active" : ""}
            type="button"
            onClick={() => onChangeTheme("light")}
            aria-pressed={theme === "light"}
          >
            ライト
          </button>
          <button
            className={theme === "dark" ? "is-active" : ""}
            type="button"
            onClick={() => onChangeTheme("dark")}
            aria-pressed={theme === "dark"}
          >
            ダーク
          </button>
        </div>
      </div>
    </div>
  );
}

function GearIcon() {
  return (
    <svg
      aria-hidden="true"
      className="settings-icon"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path
        d="M19.1 13.2c.08-.4.12-.8.12-1.2s-.04-.8-.12-1.2l2.03-1.58-1.92-3.32-2.4.96a7.85 7.85 0 0 0-2.08-1.2L14.4 3h-3.84l-.36 2.66c-.74.28-1.43.68-2.04 1.2l-2.38-.96-1.92 3.32 2.02 1.58A6.44 6.44 0 0 0 5.76 12c0 .4.04.8.12 1.2l-2.02 1.58 1.92 3.32 2.38-.96c.61.52 1.3.92 2.04 1.2l.36 2.66h3.84l.33-2.66a7.85 7.85 0 0 0 2.08-1.2l2.4.96 1.92-3.32-2.03-1.58Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
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

type ManualExtractedRowDraft = {
  productCode: string;
  mmdd: string;
  quantity: string;
};

const emptyManualDraft: ManualExtractedRowDraft = {
  productCode: "",
  mmdd: "",
  quantity: "",
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
  onAddManualRow,
  onApply,
  isProcessing,
}: {
  result: ProcessResult;
  corrections: RowCorrectionMap;
  onChange: (rowId: string, patch: RowCorrection) => void;
  onResetRow: (rowId: string) => void;
  onDeleteRow: (rowId: string) => void;
  onAddManualRow: (draft: ManualExtractedRowDraft) => void;
  onApply: () => void;
  isProcessing: boolean;
}) {
  const rows = useMemo(
    () => buildEditableRows(result).filter(({ row }) => !corrections[row.rowId]?.deleted),
    [result, corrections],
  );
  const otherRows = useMemo(
    () => result.otherRows.filter((row) => !corrections[row.rowId]?.deleted),
    [result.otherRows, corrections],
  );
  const productHubIndex = useMemo(() => {
    const map = new Map<string, ProductHubRecord>();
    for (const record of result.productHubRecords) {
      map.set(record.productCodeLc, record);
    }
    return map;
  }, [result.productHubRecords]);
  const [manualDraft, setManualDraft] = useState<ManualExtractedRowDraft>(emptyManualDraft);
  const normalizedManualMmdd = manualDraft.mmdd.replace(/\D/g, "").slice(0, 4);
  const normalizedManualQuantity = manualDraft.quantity.replace(/,/g, "").trim();
  const canAddManualRow =
    manualDraft.productCode.trim().length > 0 &&
    normalizedManualMmdd.length === 4 &&
    Number.isFinite(Number(normalizedManualQuantity)) &&
    Number(normalizedManualQuantity) > 0 &&
    !isProcessing;

  function handleAddManualRow() {
    if (!canAddManualRow) return;
    onAddManualRow({
      productCode: manualDraft.productCode.trim(),
      mmdd: normalizedManualMmdd,
      quantity: normalizedManualQuantity,
    });
    setManualDraft(emptyManualDraft);
  }

  if (rows.length === 0 && otherRows.length === 0) return null;

  const warningRowCount = rows.filter((item) => item.warningLabels.length > 0).length;

  return (
    <section className="warning-fix-panel warning-fix-panel--table">
      <div className="section-title-row">
        <div>
          <p className="eyebrow">EDIT</p>
          <h2>商品一覧/修正</h2>
          <p>
            商品名・オーダー状況はSupabase productsから取得します。配送依頼書にない商品も手入力で追加できます。
          </p>
        </div>
        <Pill tone={warningRowCount > 0 || otherRows.length > 0 ? "warn" : "good"}>
          商品{rows.length}行 / その他{otherRows.length}行 / 警告{warningRowCount}行
        </Pill>
      </div>

      <div className="manual-row-add-card" aria-label="商品行を手入力で追加">
        <div className="manual-row-add-copy">
          <strong>商品行を手入力で追加</strong>
          <span>配送依頼書に載っていない商品を、商品コード・オーダー日・オーダー数で追加できます。</span>
        </div>
        <div className="manual-row-add-fields">
          <label>
            <span>商品コード</span>
            <input
              type="text"
              value={manualDraft.productCode}
              placeholder="例: sample-01"
              onChange={(event) =>
                setManualDraft((current) => ({ ...current, productCode: event.target.value }))
              }
            />
          </label>
          <label>
            <span>オーダー日</span>
            <input
              type="text"
              inputMode="numeric"
              maxLength={4}
              value={manualDraft.mmdd}
              placeholder="0423"
              onChange={(event) =>
                setManualDraft((current) => ({ ...current, mmdd: event.target.value }))
              }
            />
          </label>
          <label>
            <span>オーダー数</span>
            <input
              type="text"
              inputMode="numeric"
              value={manualDraft.quantity}
              placeholder="20"
              onChange={(event) =>
                setManualDraft((current) => ({ ...current, quantity: event.target.value }))
              }
            />
          </label>
          <button
            className="secondary-button manual-row-add-button"
            type="button"
            onClick={handleAddManualRow}
            disabled={!canAddManualRow}
          >
            行を追加
          </button>
        </div>
      </div>

      {rows.length > 0 && (
        <div className="warning-fix-table-wrap" role="region" aria-label="商品一覧修正テーブル">
          <table className="warning-fix-table">
            <thead>
              <tr className="warning-fix-group-row">
                <th rowSpan={2}>状態</th>
                <th rowSpan={2}>商品コード</th>
                <th rowSpan={2}>商品名</th>
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
                      {row.sourceFile === "手入力" && <small>手入力</small>}
                    </td>
                    <td className="warning-product-name-cell">
                      {productRecord?.productName ? (
                        <strong>{productRecord.productName}</strong>
                      ) : (
                        <span>商品名未取得</span>
                      )}
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
  if (tab === "productDb") return result.productDbUpdateRows.length;
  return result.nyukoRows.length;
}

type RunOptions = {
  keepCurrentResult?: boolean;
  keepActiveTab?: boolean;
  preserveScroll?: boolean;
};

function restoreWindowPosition(position: { x: number; y: number } | null) {
  if (!position || typeof window === "undefined") return;

  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      window.scrollTo({
        left: position.x,
        top: position.y,
        behavior: "auto",
      });
    });
  });
}

function reflectStatusLabel(status: ReflectStatus) {
  if (status === "exported") return "出力済み";
  if (status === "updating") return "更新中";
  if (status === "done") return "完了";
  if (status === "error") return "エラー";
  return "未処理";
}

export default function NyukoApp() {
  const [files, setFiles] = useState<SelectedFiles>(emptyFiles);
  const [unknownFiles, setUnknownFiles] = useState<File[]>([]);
  const [productHubSettings, setProductHubSettings] =
    useState<ProductHubSettings>(() => buildProductHubSettings());
  const [authLoading, setAuthLoading] = useState(true);
  const [authEmail, setAuthEmail] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [isProductHubPanelOpen, setIsProductHubPanelOpen] = useState(false);
  const [isSettingsPanelOpen, setIsSettingsPanelOpen] = useState(false);
  const [uiTheme, setUiTheme] = useState<UiTheme>(getInitialUiTheme);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ProcessResult | null>(null);
  const [manualRows, setManualRows] = useState<ExtractedRow[]>([]);
  const [corrections, setCorrections] = useState<RowCorrectionMap>({});
  const [activeTab, setActiveTab] = useState<PreviewTab>("extracted");
  const [reflectStatus, setReflectStatus] = useState<ReflectStatusMap>(initialReflectStatus);
  const [reflectError, setReflectError] = useState<string | null>(null);
  const [neReauthUrl, setNeReauthUrl] = useState<string | null>(null);
  const bulkInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    document.documentElement.dataset.theme = uiTheme;
    window.localStorage.setItem(UI_THEME_STORAGE_KEY, uiTheme);
  }, [uiTheme]);

  useEffect(() => {
    let isMounted = true;

    function applySession(accessToken: string, email: string) {
      if (!isMounted) return;
      setAuthEmail(email);
      setProductHubSettings(buildProductHubSettings(accessToken));
    }

    if (!supabase) {
      setAuthLoading(false);
      return () => {
        isMounted = false;
      };
    }

    supabase.auth.getSession().then(({ data }) => {
      const session = data.session;
      applySession(session?.access_token ?? "", session?.user.email ?? "");
      if (isMounted) setAuthLoading(false);
    });

    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      applySession(session?.access_token ?? "", session?.user.email ?? "");
      if (isMounted) setAuthLoading(false);
    });

    return () => {
      isMounted = false;
      data.subscription.unsubscribe();
    };
  }, []);

  async function handleLogout() {
    setError(null);
    setResult(null);
    setManualRows([]);
    setCorrections({});
    setReflectStatus(initialReflectStatus);
    setReflectError(null);
    setIsProductHubPanelOpen(false);
    setIsSettingsPanelOpen(false);

    // signOutの完了イベントを待たずに画面状態を先にログアウトへ倒す。
    // 入庫一括専用の保存キーだけを消し、商品DB側のログイン状態は消さない。
    setAuthEmail("");
    setProductHubSettings(buildProductHubSettings(""));

    try {
      const { error: signOutError } =
        (await supabase?.auth.signOut({ scope: "local" })) ?? {};
      if (signOutError) {
        console.warn("Supabase signOut failed:", signOutError.message);
      }
    } catch (signOutError) {
      console.warn("Supabase signOut failed:", signOutError);
    } finally {
      clearNyukoSupabaseAuthStorage();
      setAuthLoading(false);
    }
  }

  const configError = getSupabaseConfigError();
  const isLoggedIn = Boolean(productHubSettings.accessToken);

  const productHubReady = Boolean(
    productHubSettings.apiUrl.trim() &&
      productHubSettings.apiKey.trim() &&
      productHubSettings.accessToken.trim(),
  );
  const canRun =
    files.packingFiles.length > 0 && productHubReady && !isProcessing;
  const selectedFileCount = files.packingFiles.length;



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
    setManualRows([]);
    setCorrections({});
    setReflectStatus(initialReflectStatus);
    setReflectError(null);
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
    setManualRows([]);
    setCorrections({});
    setReflectStatus(initialReflectStatus);
    setReflectError(null);
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
    await runWithCorrections(nextCorrections, {
      keepActiveTab: true,
      keepCurrentResult: true,
      preserveScroll: true,
    });
  }

  async function runWithCorrections(
    nextCorrections: RowCorrectionMap,
    options: RunOptions = {},
    nextManualRows: ExtractedRow[] = manualRows,
  ) {
    const scrollPosition =
      options.preserveScroll && typeof window !== "undefined"
        ? { x: window.scrollX, y: window.scrollY }
        : null;

    setIsProcessing(true);
    setError(null);
    if (!options.keepCurrentResult) {
      setResult(null);
    }

    try {
      const processResult = await runNyukoProcess(
        files,
        productHubSettings,
        nextCorrections,
        nextManualRows,
      );
      setResult(processResult);
      setReflectStatus(buildInitialReflectStatus(processResult));
      setReflectError(null);
      if (!options.keepActiveTab) {
        setActiveTab("extracted");
      }
      restoreWindowPosition(scrollPosition);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "処理中にエラーが発生しました。",
      );
      restoreWindowPosition(scrollPosition);
    } finally {
      setIsProcessing(false);
    }
  }

  async function handleRun() {
    await runWithCorrections(corrections);
  }

  async function handleApplyCorrections() {
    await runWithCorrections(corrections, {
      keepActiveTab: true,
      keepCurrentResult: true,
      preserveScroll: true,
    });
  }

  async function addManualRow(draft: ManualExtractedRowDraft) {
    const productCode = draft.productCode.trim();
    const mmdd = draft.mmdd.replace(/\D/g, "").slice(0, 4);
    const quantity = Number(draft.quantity.replace(/,/g, "").trim());
    if (!productCode || mmdd.length !== 4 || !Number.isFinite(quantity) || quantity <= 0) {
      setError("手入力行は、商品コード・4桁のオーダー日・1以上のオーダー数を入力してください。");
      return;
    }

    const normalizedQuantity = Math.trunc(quantity);
    const productCodeLc = productCode.toLowerCase();
    const rowId = `manual__${productCodeLc}__${mmdd}__${normalizedQuantity}__${Date.now()}`;
    const manualRow: ExtractedRow = {
      rowId,
      productCode,
      productCodeLc,
      mmdd,
      quantity: normalizedQuantity,
      receivedQuantity: normalizedQuantity,
      key: `${mmdd}-${normalizedQuantity}`,
      sourceKey: `${mmdd}-${normalizedQuantity}`,
      packingQuantities: [],
      quantityMismatch: false,
      sourceNote: "手入力",
      sourceFile: "手入力",
    };
    const nextManualRows = [...manualRows, manualRow];
    setManualRows(nextManualRows);
    await runWithCorrections(
      corrections,
      { keepActiveTab: true, keepCurrentResult: true, preserveScroll: true },
      nextManualRows,
    );
  }

  function clearAll() {
    setFiles(emptyFiles);
    setUnknownFiles([]);
    setError(null);
    setResult(null);
    setManualRows([]);
    setCorrections({});
    setReflectStatus(initialReflectStatus);
    setReflectError(null);
    setNeReauthUrl(null);
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

  function updateReflectStatus(key: keyof ReflectStatusMap, status: ReflectStatus) {
    setReflectStatus((current) => ({ ...current, [key]: status }));
  }

  function setNyukoDone(isDone: boolean) {
    setReflectStatus((current) => ({
      ...current,
      nyuko: isDone ? "done" : "exported",
    }));
  }

  async function updateNeByApi() {
    if (!result || reflectStatus.productDb !== "done" || reflectStatus.ne === "done" || reflectStatus.ne === "updating") return;
    if (result.neRows.length === 0) {
      updateReflectStatus("ne", "done");
      return;
    }

    setReflectError(null);
    setNeReauthUrl(null);
    updateReflectStatus("ne", "updating");
    try {
      await updateNextEngineByApi(productHubSettings.accessToken, result.neRows);
      updateReflectStatus("ne", "done");
    } catch (err) {
      updateReflectStatus("ne", "error");
      if (err instanceof NeReauthRequiredError) {
        setNeReauthUrl(err.reauthUrl);
        setReflectError("NE認証の有効期限が切れています。NE認証をやり直してください。");
        return;
      }
      setReflectError(
        err instanceof Error ? err.message : "NE API更新中にエラーが発生しました。",
      );
    }
  }

  async function downloadNyuko() {
    if (!result || reflectStatus.ne !== "done") return;
    const blob = await makeNyukoXlsxBlob(result.nyukoRows, getEffectiveOtherRows());
    saveAs(blob, "入庫リスト.xlsx");
    updateReflectStatus("nyuko", "exported");
  }

  async function downloadZip() {
    if (!result) return;
    const blob = await makeZipBlob({ ...result, otherRows: getEffectiveOtherRows() });
    saveAs(blob, "入庫一括_出力.zip");
    updateReflectStatus("ne", "exported");
    updateReflectStatus("nyuko", "exported");
  }

  async function updateProductDb() {
    if (!result || reflectStatus.productDb === "done" || reflectStatus.productDb === "updating") return;
    if (result.productDbUpdateRows.length === 0) {
      updateReflectStatus("productDb", "done");
      return;
    }
    setReflectError(null);
    updateReflectStatus("productDb", "updating");
    try {
      await updateProductHubOrders(productHubSettings, result.productDbUpdateRows);
      updateReflectStatus("productDb", "done");
    } catch (err) {
      updateReflectStatus("productDb", "error");
      setReflectError(
        err instanceof Error ? err.message : "商品DB更新中にエラーが発生しました。",
      );
    }
  }

  const previewRows: Record<string, unknown>[] = useMemo(() => {
    if (!result) return [];
    if (activeTab === "extracted") return toExtractedPreview(result.extracted);
    if (activeTab === "other") return toOtherPreview(getEffectiveOtherRows());
    if (activeTab === "ne")
      return result.neRows as unknown as Record<string, unknown>[];
    if (activeTab === "productDb")
      return result.productDbUpdateRows as unknown as Record<string, unknown>[];
    return result.nyukoRows as unknown as Record<string, unknown>[];
  }, [activeTab, result, corrections]);

  const isProductDbComplete = reflectStatus.productDb === "done";
  const isNeComplete = reflectStatus.ne === "done";
  const canUpdateProductDb =
    (result?.productDbUpdateRows.length ?? 0) > 0 &&
    reflectStatus.productDb !== "updating" &&
    reflectStatus.productDb !== "done";
  const canOperateNe = Boolean(result) && isProductDbComplete;
  const canUpdateNe =
    canOperateNe &&
    (result?.neRows.length ?? 0) > 0 &&
    reflectStatus.ne !== "updating" &&
    reflectStatus.ne !== "done";
  const canOperateNyuko = Boolean(result) && isProductDbComplete && isNeComplete;
  const canCompleteNyuko =
    canOperateNyuko && (reflectStatus.nyuko === "exported" || reflectStatus.nyuko === "done");

  if (configError) {
    return <ConfigErrorPanel message={configError} />;
  }

  if (authLoading) {
    return (
      <AuthShell>
        <div className="auth-copy">
          <h2>ログイン状態を確認中…</h2>
          <p>Supabase Authのセッションを確認しています。</p>
        </div>
      </AuthShell>
    );
  }

  if (!isLoggedIn) {
    return <LoginPanel />;
  }

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
              onClick={() => {
                setIsProductHubPanelOpen((current) => !current);
                setIsSettingsPanelOpen(false);
              }}
              aria-expanded={isProductHubPanelOpen}
            >
              <span className="product-hub-toggle-dot" />
              <span className="product-hub-toggle-label">商品DB</span>
              <strong>{productHubReady ? "接続済み" : "未接続"}</strong>
            </button>
            <button
              className={`settings-toggle ${isSettingsPanelOpen ? "is-active" : ""}`}
              type="button"
              onClick={() => {
                setIsSettingsPanelOpen((current) => !current);
                setIsProductHubPanelOpen(false);
              }}
              aria-label="設定を開く"
              aria-expanded={isSettingsPanelOpen}
              title="設定"
            >
              <GearIcon />
            </button>
            <div className="auth-user-chip" title={authEmail}>
              <span>{authEmail}</span>
              <button type="button" onClick={handleLogout}>ログアウト</button>
            </div>
          </div>

          {isProductHubPanelOpen && (
            <ProductHubSettingsPanel
              settings={productHubSettings}
              userEmail={authEmail}
            />
          )}

          {isSettingsPanelOpen && (
            <SettingsPanel theme={uiTheme} onChangeTheme={setUiTheme} />
          )}
        </div>
      </header>

      <div className="upload-run-grid">
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
                  : "ラクマート配送依頼書をドロップ"}
              </h2>
            </div>
          </div>
          <div className="drop-zone-side">
            <span className="drop-selected-count">
              {selectedFileCount > 0
                ? `${selectedFileCount}ファイル選択中`
                : "未選択"}
            </span>
          </div>
        </section>

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
      </div>

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

      {!productHubReady && (
        <section className="notice notice--warn">
          <strong>商品DB連携が未設定です</strong>
          <span>
            Supabase Authでログインし、ビルド時に Supabase URL と ANON KEY が設定されている必要があります。
          </span>
        </section>
      )}

      {error && (
        <section className="notice notice--danger">
          <strong>エラー</strong>
          <span>{error}</span>
        </section>
      )}



      {result && (
        <ExtractedRowsEditPanel
          result={result}
          corrections={corrections}
          onChange={updateCorrection}
          onResetRow={resetCorrection}
          onDeleteRow={deleteRow}
          onAddManualRow={addManualRow}
          onApply={handleApplyCorrections}
          isProcessing={isProcessing}
        />
      )}

      {result && (
        <section className="reflect-panel">
          <div className="section-title-row">
            <div>
              <p className="eyebrow">REFLECT</p>
              <h2>入庫反映</h2>
            </div>
          </div>

          {reflectError && (
            <div className="reflect-error" role="alert">
              <span>{reflectError}</span>
              {neReauthUrl && (
                <a href={neReauthUrl} target="_blank" rel="noreferrer">
                  NE認証をやり直す
                </a>
              )}
            </div>
          )}

          <div className="reflect-grid reflect-grid--ordered">
            <article className="reflect-card reflect-card--active">
              <div className="reflect-card-head">
                <div className="reflect-step-title">
                  <span>1</span>
                  <h3>商品DB更新</h3>
                </div>
                <span className={`reflect-status reflect-status--${reflectStatus.productDb}`}>
                  {reflectStatusLabel(reflectStatus.productDb)}
                </span>
              </div>
              <strong>{result.productDbUpdateRows.length}件</strong>
              <button
                type="button"
                onClick={updateProductDb}
                disabled={!canUpdateProductDb}
              >
                {reflectStatus.productDb === "updating"
                  ? "商品DB更新中…"
                  : reflectStatus.productDb === "done"
                    ? "更新完了"
                    : result.productDbUpdateRows.length === 0
                      ? "更新対象なし"
                      : "商品DBを更新"}
              </button>
              <small>入庫済みの order_memo と対応する rakumart_url を削除し、残りを左詰めします。</small>
            </article>

            <article className={`reflect-card ${canOperateNe ? "reflect-card--active" : "reflect-card--locked"}`}>
              <div className="reflect-card-head">
                <div className="reflect-step-title">
                  <span>2</span>
                  <h3>NE更新</h3>
                </div>
                <span className={`reflect-status reflect-status--${reflectStatus.ne}`}>
                  {reflectStatusLabel(reflectStatus.ne)}
                </span>
              </div>
              <strong>{result.neRows.length}件</strong>
              <button type="button" onClick={updateNeByApi} disabled={!canUpdateNe}>
                {reflectStatus.ne === "updating"
                  ? "NE更新中…"
                  : reflectStatus.ne === "done"
                    ? "更新完了"
                    : result.neRows.length === 0
                      ? "更新対象なし"
                      : "NEへAPI更新"}
              </button>
              <small>NE商品マスタアップロードAPIへ直接送信します。CSV出力とNE画面での手動アップロードは不要です。</small>
              {!canOperateNe && <small>商品DB更新が完了すると操作できます。</small>}
            </article>

            <article className={`reflect-card ${canOperateNyuko ? "reflect-card--active" : "reflect-card--locked"}`}>
              <div className="reflect-card-head">
                <div className="reflect-step-title">
                  <span>3</span>
                  <h3>入庫リスト出力</h3>
                </div>
                <span className={`reflect-status reflect-status--${reflectStatus.nyuko}`}>
                  {reflectStatusLabel(reflectStatus.nyuko)}
                </span>
              </div>
              <strong>{result.nyukoRows.length + getEffectiveOtherRows().length}行</strong>
              <button type="button" onClick={downloadNyuko} disabled={!canOperateNyuko}>
                入庫リスト.xlsx 出力
              </button>
              <label className={`reflect-check ${canCompleteNyuko ? "" : "is-disabled"}`}>
                <input
                  type="checkbox"
                  checked={reflectStatus.nyuko === "done"}
                  disabled={!canCompleteNyuko}
                  onChange={(event) => setNyukoDone(event.target.checked)}
                />
                出力完了
              </label>
              {!canOperateNyuko && <small>NE更新の反映完了後に出力できます。</small>}
            </article>
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
                ["productDb", "商品DB更新"],
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

