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
  if (status === "error") return "保留";
  if (status === "warning") return "確認";
  return "確定";
}

const count = (value: number) => value.toLocaleString("ja-JP");

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
  const heldCount = rows.filter((row) => row.status === "error").length;
  const problemRows = rows.filter((row) => row.status !== "ok");
  const visibleRows = showAllRows ? rows : problemRows.length > 0 ? problemRows : rows.slice(0, 12);
  const allIssues = [...errors, ...warnings];

  return (
    <section className="preview-panel cost-panel">
      <div className="section-title-row">
        <div>
          <p className="eyebrow">COST</p>
          <h2>原価計算</h2>
        </div>
        <div className="cost-head-pills">
          <span className="cost-pill">NE登録原価 {cost?.neGenka.length ?? 0}件</span>
          {errors.length > 0 && <span className="cost-pill cost-pill--danger">入力が必要 {errors.length}</span>}
          {warnings.length > 0 && <span className="cost-pill cost-pill--warn">確認 {warnings.length}</span>}
        </div>
      </div>

      <div className={`cost-summary cost-summary--${errors.length > 0 ? "error" : warnings.length > 0 ? "warning" : "ok"}`}>
        {errors.length > 0 ? (
          <>
            <strong>入力が必要な項目が{errors.length}件あります</strong>
            <span>
              下記の「入力が必要」の項目を入力すると原価が確定します。未入力の間、該当する商品（{heldCount}件）はNEの原価を更新せず「保留」とします。
              入力内容は保存され、次回以降は自動で適用されます。
            </span>
          </>
        ) : warnings.length > 0 ? (
          <>
            <strong>原価の計算が完了しました（確認事項 {warnings.length}件）</strong>
            <span>確認事項は入力不要です。内容を確認のうえ、そのまま次に進めます。</span>
          </>
        ) : (
          <>
            <strong>原価の計算が完了しました</strong>
            <span>このままNE更新に進めます。</span>
          </>
        )}
      </div>

      <details className="cost-howto">
        <summary>原価の計算方法</summary>
        <p>
          1個あたりの原価 ＝（単価×入荷数 ＋ オプション費用 ＋ 中国国内送料 ＋ 国際送料）÷ 入荷数。人民元は配送依頼書のレートで円換算しています。
        </p>
        <ul>
          <li>中国国内送料：便全体の合計を商品代金の比率で按分します。</li>
          <li>国際送料：箱ごとの請求重量で按分し、同じ箱の中では商品代金の比率で按分します。</li>
          <li>NEに登録する原価は、各商品の最新の便の原価（整数）です。</li>
        </ul>
      </details>

      {props.rulesError && (
        <p className="cost-issue cost-issue--error">
          保存済みの設定（個数・付属品の割当先）を読み込めませんでした：{props.rulesError}
          <button type="button" className="cost-link-button" onClick={props.onReloadRules}>再読み込み</button>
        </p>
      )}
      {props.sourceErrors.map((message) => (
        <p key={message} className="cost-issue cost-issue--warning">{message}</p>
      ))}
      {props.locked && (
        <p className="cost-issue cost-issue--info">
          NE更新は完了しています。ここで設定を変更しても今回分には反映されず、次回以降に適用されます。
        </p>
      )}

      {props.registration && <RegistrationBox state={props.registration} onRetry={props.onRetryRegistration} />}

      {props.rulesLoading && <p className="cost-muted">保存済みの設定を読み込み中…</p>}

      {allIssues.length > 0 && (
        <div className="cost-issues">
          {allIssues.map((issue, index) => (
            <IssueCard
              key={`${issue.kind}-${issue.shipmentId}-${issue.line?.lineNo ?? index}-${index}`}
              issue={issue}
              index={index + 1}
              total={allIssues.length}
              rules={rules}
              onSaveUnitRules={props.onSaveUnitRules}
              onSaveMaterialRule={props.onSaveMaterialRule}
            />
          ))}
        </div>
      )}

      <div className="cost-shipments">
        {cost?.shipments.map((s) => (
          <article key={s.shipmentId} className="cost-shipment">
            <header>
              <strong>{shipmentLabel(s.shipmentId)}</strong>
              <small>{s.shipmentId}</small>
            </header>
            <dl>
              <div><dt>費用合計</dt><dd>{yen(s.totalJpy)}</dd></div>
              <div><dt>レート（1元）</dt><dd>{s.rate}円</dd></div>
              <div>
                <dt>国際送料</dt>
                <dd>
                  {yen(s.intlFreightJpy)}
                  {s.chargeableKg > 0 && <small> / {s.chargeableKg}kg（{yen(s.intlFreightJpy / s.chargeableKg, 1)}/kg）</small>}
                </dd>
              </div>
              <div><dt>国際送料の按分</dt><dd>{s.intlMethod === "box" ? "箱の請求重量" : "商品代金の比率"}</dd></div>
              {s.ignoredJpy > 0.5 && <div><dt>原価に含めない費用</dt><dd>{yen(s.ignoredJpy)}</dd></div>}
              {s.unallocatedJpy > 0.5 && (
                <div className="cost-danger"><dt>割当先未設定の費用</dt><dd>{yen(s.unallocatedJpy)}</dd></div>
              )}
            </dl>
          </article>
        ))}
      </div>

      <div className="cost-table-head">
        <h3>
          商品ごとの原価
          <small>
            {showAllRows || problemRows.length === 0
              ? `${rows.length}件`
              : `保留・確認の${problemRows.length}件を表示中`}
          </small>
        </h3>
        <button type="button" className="cost-link-button" onClick={() => setShowAllRows((v) => !v)}>
          {showAllRows ? "保留・確認だけ表示" : `すべて表示（${rows.length}件）`}
        </button>
      </div>
      <div className="table-wrap cost-table-wrap">
        <table className="cost-table">
          <thead>
            <tr>
              <th>商品コード</th>
              <th>便</th>
              <th className="num">入荷数</th>
              <th className="num">商品代</th>
              <th className="num">オプション</th>
              <th className="num">中国国内送料</th>
              <th className="num">国際送料</th>
              <th className="num">1個あたり原価</th>
              <th className="num">NE登録原価</th>
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
                  <td className="num">{count(row.units)}</td>
                  <td className="num">{unitYen(row.unitBreakdown.goods)}</td>
                  <td className="num">{unitYen(row.unitBreakdown.option)}</td>
                  <td className="num">{unitYen(row.unitBreakdown.domestic)}</td>
                  <td className="num">{unitYen(row.unitBreakdown.intl + row.unitBreakdown.other)}</td>
                  <td className="num"><strong>{unitYen(row.unitCost)}</strong></td>
                  <td className="num">
                    {genka !== undefined ? yen(genka) : row.status === "error" ? "保留" : "—"}
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
        「NE登録原価」が「—」の行は、同じ商品がより新しい便にも含まれるものです（NEには最新の便の原価を登録します）。
        「保留」は入力が必要な項目が残っている商品で、NEの原価は更新しません。
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
  index,
  total,
  rules,
  onSaveUnitRules,
  onSaveMaterialRule,
}: {
  issue: CostIssue;
  index: number;
  total: number;
  rules: CostRules;
  onSaveUnitRules: CostPanelProps["onSaveUnitRules"];
  onSaveMaterialRule: CostPanelProps["onSaveMaterialRule"];
}) {
  const text = describeIssue(issue);
  const showUnitEditor = issue.kind === "missing_unit_rule" || issue.kind === "unit_mismatch";
  const showMaterialEditor =
    issue.line &&
    (issue.kind === "unassigned_material" || issue.kind === "material_no_target" || issue.kind === "material_mismatch");

  return (
    <article className={`cost-issue-card cost-issue-card--${issue.level}`}>
      <div className="cost-issue-top">
        <span className="cost-issue-badge">{issue.level === "error" ? "入力が必要" : "確認"}</span>
        <small>
          {index}/{total}
          {issue.shipmentId && `・${shipmentLabel(issue.shipmentId)}`}
        </small>
      </div>
      <h4>{text.title}</h4>
      <p className="cost-issue-body">{text.body}</p>

      {issue.line && (
        <dl className="cost-line-facts">
          <div><dt>配送依頼書</dt><dd>{issue.line.lineNo}行目（商品番号 {issue.line.itemNo}）</dd></div>
          <div><dt>商品情報</dt><dd>{issue.line.productInfo.replace(/\n/g, " ") || "—"}</dd></div>
          <div><dt>入荷数</dt><dd>{count(issue.line.shipQty)}個（単価 {issue.line.unitPriceCny}元）</dd></div>
          {issue.amountJpy !== undefined && <div><dt>費用</dt><dd>{yen(issue.amountJpy)}</dd></div>}
          {issue.line.note && (
            <div><dt>箱詰め備考</dt><dd className="cost-line-note">{issue.line.note}</dd></div>
          )}
        </dl>
      )}

      {issue.kind === "quantity_mismatch" && issue.items && <MismatchList items={issue.items} />}

      {showUnitEditor && (
        <UnitRuleEditor
          codes={issue.productCodes}
          codeUnits={issue.codeUnits ?? {}}
          rules={rules}
          shipQty={issue.line?.shipQty}
          onSave={onSaveUnitRules}
        />
      )}
      {showMaterialEditor && issue.line && (
        <MaterialRuleEditor issue={issue} rules={rules} onSave={onSaveMaterialRule} />
      )}
    </article>
  );
}

/** 種類ごとの、初めての人にも分かる見出しと説明 */
function describeIssue(issue: CostIssue): { title: string; body: string } {
  const codes = issue.productCodes.join("・");
  switch (issue.kind) {
    case "missing_unit_rule":
      return {
        title: "1行に複数の商品が含まれています",
        body:
          `この行の入荷数 ${count(issue.line?.shipQty ?? 0)}個は、${codes} の合計です。` +
          "費用を按分するため、各商品のNEの1個あたりに、この行の品物を何個使用するかを入力してください（例：4個で1セットの場合は 4）。",
      };
    case "unit_mismatch":
      return {
        title: "保存済みの個数で計算すると、入荷数と一致しません",
        body:
          `${codes} の個数を確認してください。セット内容の変更、またはオーダー数の修正が必要な可能性があります。` +
          "計算は継続していますが、費用の按分に誤差が出ている可能性があります。",
      };
    case "unassigned_material":
      return {
        title: "商品コードの記載がない行があります",
        body:
          "箱詰め備考に「●商品コード▲」の記載がないため、この行の費用の割当先が決まっていません。" +
          "ケース・袋・紙などの付属品の場合は、使用する商品を選択してください。おまけ・サンプル等、商品と関係のないものは「原価に含めない」を選択してください。" +
          "設定は注文番号ごとに保存され、同じ品物が再度入荷した際に自動で適用されます。",
      };
    case "material_no_target":
      return {
        title: "付属品の割当先の商品が、この便に含まれていません",
        body:
          `この行は ${codes} の付属品として設定されていますが、今回の便には該当する商品が含まれていません。` +
          "割当先を選択し直すか、「原価に含めない」を選択してください。",
      };
    case "material_mismatch":
      return {
        title: "付属品の数量が、商品の数量と一致しません",
        body:
          "付属品の入荷数と、選択した商品の使用数が一致しません。按分の比率としては使用できるため、計算は継続しています。" +
          "1個あたりの使用数に誤りがあれば修正してください。",
      };
    case "deleted_line":
      return {
        title: "削除した商品の費用が、原価に含まれていません",
        body: `${codes} を商品一覧で削除したため、この行の費用はいずれの商品にも割り当てられていません。未入荷の商品であれば、このままで問題ありません。`,
      };
    case "no_cost_data":
      return {
        title: "配送依頼書に金額のない商品があります",
        body: `${codes} は手入力で追加した商品などのため、配送依頼書に金額がありません。原価を計算できないため、NEの原価は更新しません。`,
      };
    case "intl_fallback":
      return {
        title: "国際送料を箱ごとに按分できませんでした",
        body: "配送依頼書に箱の請求重量、または商品の梱包箱の情報が不足しているため、この便の国際送料は商品代金の比率で按分しています。",
      };
    case "quantity_mismatch":
      return {
        title: "梱包数とオーダー数が異なる商品があります",
        body:
          "セット品（例：8個で1セット）の場合は、修正の必要はありません。" +
          "「分納の可能性あり」と表示されている商品は、商品一覧でオーダー数を実際の入荷数に修正してください。修正しない場合、1個あたりの原価が低く計算されます。",
      };
    default:
      return { title: "配送依頼書の読み取りに関する注意事項", body: issue.message };
  }
}

function MismatchList({ items }: { items: NonNullable<CostIssue["items"]> }) {
  return (
    <ul className="cost-mismatch-list">
      {items.map((item) => (
        <li key={`${item.productCode}-${item.key}`} className={item.partial ? "is-partial" : ""}>
          <strong>{item.productCode}</strong>
          <span>オーダー {item.key}</span>
          <span>梱包数 {item.packingQuantities.length ? item.packingQuantities.map(count).join(" / ") : "—"}</span>
          <em>
            {item.partial
              ? item.packingQuantities.length === 1
                ? `分納の可能性あり：オーダー数を入荷数に修正（梱包数どおりなら ${count(item.packingQuantities[0])}）`
                : "分納の可能性あり：オーダー数を入荷数に修正"
              : "全数入荷済み：セット品であれば修正不要"}
          </em>
        </li>
      ))}
    </ul>
  );
}

function UnitRuleEditor({
  codes,
  codeUnits,
  rules,
  shipQty,
  onSave,
}: {
  codes: string[];
  codeUnits: Record<string, number>;
  rules: CostRules;
  shipQty?: number;
  onSave: CostPanelProps["onSaveUnitRules"];
}) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(codes.map((code) => [code, rules.unitRules[code.toLowerCase()] ? String(rules.unitRules[code.toLowerCase()]) : ""])),
  );
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const parsed = codes.map((code) => Number(String(values[code] ?? "").replace(/,/g, "")));
  const allFilled = parsed.every((v) => v > 0);
  const total = codes.reduce((sum, code, i) => sum + (codeUnits[code] ?? 0) * (parsed[i] > 0 ? parsed[i] : 0), 0);
  const matches = shipQty !== undefined && allFilled && Math.round(total) === Math.round(shipQty);

  async function save() {
    if (!allFilled) {
      setMessage("すべての商品に1以上の数値を入力してください。");
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      await onSave(codes.map((code, i) => ({ productCode: code, piecesPerUnit: parsed[i] })));
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "保存に失敗しました。");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="cost-editor">
      <div className="cost-unit-rows">
        {codes.map((code, i) => (
          <label key={code} className="cost-unit-row">
            <strong>{code}</strong>
            <span>：NEの1個あたり</span>
            <input
              inputMode="decimal"
              value={values[code] ?? ""}
              placeholder="例 4"
              onChange={(event) => setValues((current) => ({ ...current, [code]: event.target.value }))}
            />
            <span>個</span>
            {codeUnits[code] !== undefined && (
              <small>
                × 入荷 {count(codeUnits[code])} ＝ {parsed[i] > 0 ? count(codeUnits[code] * parsed[i]) : "?"}個
              </small>
            )}
          </label>
        ))}
      </div>
      {shipQty !== undefined && (
        <p className={`cost-unit-check ${allFilled ? (matches ? "is-ok" : "is-ng") : ""}`}>
          {allFilled
            ? matches
              ? `合計 ${count(total)}個：この行の入荷数 ${count(shipQty)}個と一致しています`
              : `合計 ${count(total)}個：この行の入荷数 ${count(shipQty)}個と一致しません。入力値を確認してください`
            : `この行の入荷数は ${count(shipQty)}個です。合計がこの数と一致するように入力してください`}
        </p>
      )}
      <div className="cost-editor-fields">
        <button type="button" onClick={save} disabled={saving}>
          {saving ? "保存中…" : "保存（次回以降も適用）"}
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
      setMessage("割当先の商品を1つ以上選択してください。");
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
      {suggested.includes(code) && <em>備考に記載あり</em>}
      <small>NEの1個あたり</small>
      <input
        className="cost-material-qty"
        inputMode="decimal"
        value={state[code]?.qty ?? "1"}
        aria-label={`${code} の1個あたりに使う数`}
        onChange={(event) =>
          setState((current) => ({ ...current, [code]: { ...(current[code] ?? { checked: true }), qty: event.target.value } }))
        }
      />
      <small>個</small>
    </label>
  );

  return (
    <div className="cost-editor">
      <span className="cost-editor-label">割当先の商品</span>
      {primary.length > 0 ? (
        <div className="cost-material-options">{primary.map(renderCode)}</div>
      ) : (
        <p className="cost-muted">候補がありません。「ほかの商品から選択」から選択してください。</p>
      )}
      {others.length > 0 && (
        <details className="cost-material-more">
          <summary>ほかの商品から選択（この便の{others.length}件）</summary>
          <div className="cost-material-options">{others.map(renderCode)}</div>
        </details>
      )}
      <div className="cost-editor-fields">
        <button type="button" onClick={() => save(false)} disabled={saving}>
          {saving ? "保存中…" : "選択した商品に割り当てる"}
        </button>
        <button type="button" className="cost-secondary" onClick={() => save(true)} disabled={saving}>
          原価に含めない（おまけ・サンプル等）
        </button>
      </div>
      <small className="cost-muted">注文番号 {line.orderNo}・商品番号 {line.itemNo} の設定として保存します。</small>
      {message && <small className="cost-editor-error">{message}</small>}
    </div>
  );
}
