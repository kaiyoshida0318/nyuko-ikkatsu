"use client";

import { useMemo, useState } from "react";
import type {
  CodeCost,
  CostIssue,
  CostResult,
  CostRules,
  MaterialRule,
} from "@/lib/costTypes";
import { materialRuleKey } from "@/lib/costing";
import type {
  CostRegistrationPayload,
  CostRegistrationResult,
} from "@/lib/costStore";

export type CostRegistrationState = {
  status: "updating" | "done" | "error";
  payload: CostRegistrationPayload;
  skippedCodes: string[];
  message: string;
  result?: CostRegistrationResult;
};

type CostPanelProps = {
  cost: CostResult | null;
  sourceErrors: string[];
  hasCostSources: boolean;
  rules: CostRules;
  rulesLoading: boolean;
  rulesError: string | null;
  locked: boolean;
  registration: CostRegistrationState | null;
  onSaveUnitRules: (values: Array<{ productCode: string; piecesPerUnit: number }>) => Promise<void>;
  onSaveMaterialRule: (rule: MaterialRule) => Promise<void>;
  onReloadRules: () => void;
  onRetryRegistration: () => void;
};

const yen = (value: number, digits = 0) =>
  `¥${value.toLocaleString("ja-JP", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;

const unitYen = (value: number) => yen(value, value < 100 ? 2 : 1);

function shipmentLabel(id: string) {
  const m = id.match(/^P(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/);
  return m ? `${m[2]}/${m[3]} ${m[4]}:${m[5]}便` : id;
}

function statusLabel(status: CodeCost["status"]) {
  if (status === "error") return "要対応";
  if (status === "warning") return "確認";
  return "OK";
}

export default function CostPanel(props: CostPanelProps) {
  const { cost, rules } = props;
  const [showAllRows, setShowAllRows] = useState(false);

  const genkaByKey = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of cost?.neGenka ?? []) {
      map.set(`${row.productCode.toLowerCase()}@@${row.shipmentId}`, row.genkaTnk);
    }
    return map;
  }, [cost]);

  if (!props.hasCostSources) {
    return (
      <section className="preview-panel cost-panel">
        <div className="section-title-row">
          <div>
            <p className="eyebrow">COST</p>
            <h2>原価計算</h2>
          </div>
        </div>
        <p className="cost-muted">
          この作業データには原価の元データがありません。配送依頼書を読み込み直して「処理実行」すると原価を計算します。
        </p>
        {props.sourceErrors.map((message) => (
          <p key={message} className="cost-issue cost-issue--warning">{message}</p>
        ))}
      </section>
    );
  }

  const errors = cost?.issues.filter((issue) => issue.level === "error") ?? [];
  const warnings = cost?.issues.filter((issue) => issue.level === "warning") ?? [];
  const rows = cost?.codes ?? [];
  const problemRows = rows.filter((row) => row.status !== "ok");
  const visibleRows = showAllRows ? rows : problemRows.length > 0 ? problemRows : rows.slice(0, 12);

  return (
    <section className="preview-panel cost-panel">
      <div className="section-title-row">
        <div>
          <p className="eyebrow">COST</p>
          <h2>原価計算</h2>
        </div>
        <div className="cost-head-pills">
          <span className="cost-pill">NEへ原価 {cost?.neGenka.length ?? 0}件</span>
          {errors.length > 0 && <span className="cost-pill cost-pill--danger">要対応 {errors.length}</span>}
          {warnings.length > 0 && <span className="cost-pill cost-pill--warn">確認 {warnings.length}</span>}
        </div>
      </div>

      <p className="cost-muted">
        原価 = 単価×出荷数 + オプション費用 + 中国内運賃（便全体を商品代金の比率で配分）+ 国際送料（箱の決済重量で箱ごとに分け、箱の中は商品代金の比率）。
        元は配送依頼書レートで円換算。NE更新のとき、各商品の<strong>最新の便の1単位原価</strong>を整数に丸めてNEの原価に入れ、便ごとの在庫を登録します。
      </p>

      {props.rulesError && (
        <p className="cost-issue cost-issue--error">
          入数・共有資材ルールを読み込めませんでした：{props.rulesError}
          <button type="button" className="cost-link-button" onClick={props.onReloadRules}>再読み込み</button>
        </p>
      )}
      {props.sourceErrors.map((message) => (
        <p key={message} className="cost-issue cost-issue--warning">{message}</p>
      ))}
      {props.locked && (
        <p className="cost-issue cost-issue--info">
          NE更新済みです。ここでルールを変えても、今回NEへ送った原価・登録する便には反映されません（次回以降に使われます）。
        </p>
      )}

      {props.registration && <RegistrationBox state={props.registration} onRetry={props.onRetryRegistration} />}

      <div className="cost-shipments">
        {cost?.shipments.map((s) => (
          <article key={s.shipmentId} className="cost-shipment">
            <header>
              <strong>{shipmentLabel(s.shipmentId)}</strong>
              <small>{s.shipmentId}</small>
            </header>
            <dl>
              <div><dt>合計原価</dt><dd>{yen(s.totalJpy)}</dd></div>
              <div><dt>レート</dt><dd>{s.rate}</dd></div>
              <div>
                <dt>国際送料</dt>
                <dd>
                  {yen(s.intlFreightJpy)}
                  {s.chargeableKg > 0 && <small> / {s.chargeableKg}kg（{yen(s.intlFreightJpy / s.chargeableKg, 1)}/kg）</small>}
                </dd>
              </div>
              <div><dt>国際送料の配分</dt><dd>{s.intlMethod === "box" ? "箱の決済重量" : "商品代金の比率"}</dd></div>
              {s.ignoredJpy > 0.5 && <div><dt>原価に含めない</dt><dd>{yen(s.ignoredJpy)}</dd></div>}
              {s.unallocatedJpy > 0.5 && (
                <div className="cost-danger"><dt>未割当</dt><dd>{yen(s.unallocatedJpy)}</dd></div>
              )}
            </dl>
          </article>
        ))}
      </div>

      {props.rulesLoading && <p className="cost-muted">ルールを読み込み中…</p>}

      {(errors.length > 0 || warnings.length > 0) && (
        <div className="cost-issues">
          {[...errors, ...warnings].map((issue, index) => (
            <IssueCard
              key={`${issue.kind}-${issue.shipmentId}-${issue.line?.lineNo ?? index}-${index}`}
              issue={issue}
              rules={rules}
              onSaveUnitRules={props.onSaveUnitRules}
              onSaveMaterialRule={props.onSaveMaterialRule}
            />
          ))}
        </div>
      )}

      <div className="cost-table-head">
        <h3>
          商品ごとの原価
          <small>
            {showAllRows || problemRows.length === 0
              ? `${rows.length}件`
              : `要対応・確認 ${problemRows.length}件を表示`}
          </small>
        </h3>
        <button type="button" className="cost-link-button" onClick={() => setShowAllRows((v) => !v)}>
          {showAllRows ? "要対応・確認だけ表示" : `すべて表示（${rows.length}件）`}
        </button>
      </div>
      <div className="table-wrap cost-table-wrap">
        <table className="cost-table">
          <thead>
            <tr>
              <th>商品コード</th>
              <th>便</th>
              <th className="num">入庫数</th>
              <th className="num">商品</th>
              <th className="num">オプション</th>
              <th className="num">国内運賃</th>
              <th className="num">国際送料</th>
              <th className="num">1単位原価</th>
              <th className="num">NEの原価</th>
              <th>状態</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row) => {
              const genka = genkaByKey.get(`${row.productCodeLc}@@${row.shipmentId}`);
              return (
                <tr key={`${row.shipmentId}-${row.productCodeLc}`} className={`cost-row--${row.status}`}>
                  <td className="cost-code">{row.productCode}</td>
                  <td>{shipmentLabel(row.shipmentId)}</td>
                  <td className="num">{row.units.toLocaleString("ja-JP")}</td>
                  <td className="num">{unitYen(row.unitBreakdown.goods)}</td>
                  <td className="num">{unitYen(row.unitBreakdown.option)}</td>
                  <td className="num">{unitYen(row.unitBreakdown.domestic)}</td>
                  <td className="num">{unitYen(row.unitBreakdown.intl + row.unitBreakdown.other)}</td>
                  <td className="num"><strong>{unitYen(row.unitCost)}</strong></td>
                  <td className="num">
                    {genka !== undefined ? yen(genka) : row.status === "error" ? "送らない" : "—"}
                  </td>
                  <td>
                    <span className={`cost-status cost-status--${row.status}`}>{statusLabel(row.status)}</span>
                    {row.messages.length > 0 && <small className="cost-row-note">{row.messages.join(" / ")}</small>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="cost-muted cost-footnote">
        同じ商品が複数の便にある場合、NEに入れるのは一番新しい便の原価です（「—」は古い便）。
        「送らない」は要対応が残っている商品で、NEの原価は変更しません。
      </p>
    </section>
  );
}

function RegistrationBox({ state, onRetry }: { state: CostRegistrationState; onRetry: () => void }) {
  const consumed = state.result?.reconciled.reduce((sum, r) => sum + (r.consumed ?? 0), 0) ?? 0;
  const opening = state.result?.reconciled.filter((r) => (r.opening ?? 0) > 0).length ?? 0;
  const adjusted = state.result?.reconciled.filter((r) => (r.adjusted ?? 0) > 0).length ?? 0;
  return (
    <div className={`cost-registration cost-registration--${state.status}`}>
      <div>
        <strong>
          {state.status === "updating"
            ? "便ごとの在庫を登録中…"
            : state.status === "done"
              ? state.payload.mode === "backfill"
                ? "過去の便を原価だけ登録しました"
                : "便ごとの在庫を登録しました"
              : "便ごとの在庫の登録に失敗しました"}
        </strong>
        <span>{state.message}</span>
        {state.status === "done" && state.result && (
          <span>
            登録 {state.result.registered_lots}件
            {consumed > 0 && ` / 古い便から消費 ${consumed.toLocaleString("ja-JP")}個`}
            {opening > 0 && ` / 期首在庫を作成 ${opening}商品`}
            {adjusted > 0 && ` / 在庫増の調整 ${adjusted}商品`}
            {state.result.skipped_products > 0 && ` / 登録済みのためスキップ ${state.result.skipped_products}商品`}
            {(state.result.revalued_opening_lots ?? 0) > 0 && ` / 期首在庫の原価を置き換え ${state.result.revalued_opening_lots}件`}
          </span>
        )}
        {state.skippedCodes.length > 0 && (
          <small>NE更新の対象外のため便を登録しなかったコード：{state.skippedCodes.join(", ")}</small>
        )}
      </div>
      {state.status === "error" && (
        <button type="button" onClick={onRetry}>再試行</button>
      )}
    </div>
  );
}

function IssueCard({
  issue,
  rules,
  onSaveUnitRules,
  onSaveMaterialRule,
}: {
  issue: CostIssue;
  rules: CostRules;
  onSaveUnitRules: CostPanelProps["onSaveUnitRules"];
  onSaveMaterialRule: CostPanelProps["onSaveMaterialRule"];
}) {
  const showUnitEditor = issue.kind === "missing_unit_rule" || issue.kind === "unit_mismatch";
  const showMaterialEditor =
    issue.line &&
    (issue.kind === "unassigned_material" || issue.kind === "material_no_target" || issue.kind === "material_mismatch");

  return (
    <article className={`cost-issue-card cost-issue-card--${issue.level}`}>
      <p>
        <span className="cost-issue-badge">{issue.level === "error" ? "要対応" : "確認"}</span>
        {issue.shipmentId && <small>{shipmentLabel(issue.shipmentId)}</small>}
        {issue.message}
      </p>
      {issue.line && (
        <p className="cost-line-info">
          行{issue.line.lineNo}｜{issue.line.productInfo.replace(/\n/g, " ")}｜出荷数 {issue.line.shipQty.toLocaleString("ja-JP")}｜単価 {issue.line.unitPriceCny}元
          {issue.line.note && <span title={issue.line.note}>｜備考 {issue.line.note.slice(0, 80)}{issue.line.note.length > 80 ? "…" : ""}</span>}
        </p>
      )}
      {showUnitEditor && (
        <UnitRuleEditor codes={issue.productCodes} rules={rules} shipQty={issue.line?.shipQty} onSave={onSaveUnitRules} />
      )}
      {showMaterialEditor && issue.line && (
        <MaterialRuleEditor issue={issue} rules={rules} onSave={onSaveMaterialRule} />
      )}
    </article>
  );
}

function UnitRuleEditor({
  codes,
  rules,
  shipQty,
  onSave,
}: {
  codes: string[];
  rules: CostRules;
  shipQty?: number;
  onSave: CostPanelProps["onSaveUnitRules"];
}) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(codes.map((code) => [code, rules.unitRules[code.toLowerCase()] ? String(rules.unitRules[code.toLowerCase()]) : ""])),
  );
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function save() {
    const entries = codes
      .map((code) => ({ productCode: code, piecesPerUnit: Number(String(values[code] ?? "").replace(/,/g, "")) }))
      .filter((entry) => entry.piecesPerUnit > 0);
    if (entries.length !== codes.length) {
      setMessage("すべてのコードに1以上の入数を入力してください。");
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      await onSave(entries);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "保存に失敗しました。");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="cost-editor">
      <span className="cost-editor-label">
        入数（NEの1単位に入っている個数）{shipQty ? `｜この行の出荷数 ${shipQty.toLocaleString("ja-JP")}` : ""}
      </span>
      <div className="cost-editor-fields">
        {codes.map((code) => (
          <label key={code}>
            <span>{code}</span>
            <input
              inputMode="decimal"
              value={values[code] ?? ""}
              placeholder="例 4"
              onChange={(event) => setValues((current) => ({ ...current, [code]: event.target.value }))}
            />
          </label>
        ))}
        <button type="button" onClick={save} disabled={saving}>
          {saving ? "保存中…" : "入数を保存"}
        </button>
      </div>
      {message && <small className="cost-editor-error">{message}</small>}
    </div>
  );
}

function MaterialRuleEditor({
  issue,
  rules,
  onSave,
}: {
  issue: CostIssue;
  rules: CostRules;
  onSave: CostPanelProps["onSaveMaterialRule"];
}) {
  const line = issue.line!;
  const existing = rules.materialRules[materialRuleKey(line.orderNo, line.itemNo)];
  const suggested = issue.suggestedCodes ?? [];
  const candidates = useMemo(() => {
    const all = new Set<string>([
      ...suggested,
      ...(existing?.allocations.map((a) => a.productCode) ?? []),
      ...(issue.candidateCodes ?? []),
    ]);
    return [...all];
  }, [existing, issue.candidateCodes, suggested]);

  const [state, setState] = useState<Record<string, { checked: boolean; qty: string }>>(() => {
    const initial: Record<string, { checked: boolean; qty: string }> = {};
    for (const code of candidates) {
      const alloc = existing?.allocations.find((a) => a.productCode.toLowerCase() === code.toLowerCase());
      initial[code] = {
        checked: alloc ? true : !existing && suggested.includes(code),
        qty: alloc ? String(alloc.qtyPerUnit) : "1",
      };
    }
    return initial;
  });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const primary = candidates.filter((code) => suggested.includes(code) || state[code]?.checked);
  const others = candidates.filter((code) => !primary.includes(code));

  async function save(ignore: boolean) {
    const allocations = ignore
      ? []
      : candidates
          .filter((code) => state[code]?.checked)
          .map((code) => ({ productCode: code, qtyPerUnit: Number(state[code].qty) }))
          .filter((a) => a.qtyPerUnit > 0);
    if (!ignore && allocations.length === 0) {
      setMessage("割当先のコードを1つ以上選び、1単位あたりの使用数を入力してください。");
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      await onSave({ orderNo: line.orderNo, itemNo: line.itemNo, allocations, ignore });
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "保存に失敗しました。");
    } finally {
      setSaving(false);
    }
  }

  const renderCode = (code: string) => (
    <label key={code} className={`cost-material-option ${state[code]?.checked ? "is-checked" : ""}`}>
      <input
        type="checkbox"
        checked={state[code]?.checked ?? false}
        onChange={(event) =>
          setState((current) => ({ ...current, [code]: { ...(current[code] ?? { qty: "1" }), checked: event.target.checked } }))
        }
      />
      <span>{code}</span>
      {suggested.includes(code) && <em>備考で指定</em>}
      <input
        className="cost-material-qty"
        inputMode="decimal"
        value={state[code]?.qty ?? "1"}
        aria-label={`${code} の1単位あたり使用数`}
        onChange={(event) =>
          setState((current) => ({ ...current, [code]: { ...(current[code] ?? { checked: true }), qty: event.target.value } }))
        }
      />
      <small>個/単位</small>
    </label>
  );

  return (
    <div className="cost-editor">
      <span className="cost-editor-label">
        割当先（注文番号 {line.orderNo} / 商品番号 {line.itemNo} として保存。倉庫保管品は次回以降も自動で使われます）
      </span>
      <div className="cost-material-options">{primary.map(renderCode)}</div>
      {others.length > 0 && (
        <details className="cost-material-more">
          <summary>ほかのコードから選ぶ（{others.length}件）</summary>
          <div className="cost-material-options">{others.map(renderCode)}</div>
        </details>
      )}
      <div className="cost-editor-fields">
        <button type="button" onClick={() => save(false)} disabled={saving}>
          {saving ? "保存中…" : "この割当で保存"}
        </button>
        <button type="button" className="cost-secondary" onClick={() => save(true)} disabled={saving}>
          原価に含めない
        </button>
      </div>
      {message && <small className="cost-editor-error">{message}</small>}
    </div>
  );
}
