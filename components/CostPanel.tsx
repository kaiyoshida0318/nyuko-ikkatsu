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
          <span className="cost-pill">NEに入れる原価 {cost?.neGenka.length ?? 0}件</span>
          {errors.length > 0 && <span className="cost-pill cost-pill--danger">入力が必要 {errors.length}</span>}
          {warnings.length > 0 && <span className="cost-pill cost-pill--warn">確認 {warnings.length}</span>}
        </div>
      </div>

      <div className={`cost-summary cost-summary--${errors.length > 0 ? "error" : warnings.length > 0 ? "warning" : "ok"}`}>
        {errors.length > 0 ? (
          <>
            <strong>あと{errors.length}か所、教えてほしいことがあります</strong>
            <span>
              下の「入力が必要」に答えると原価が確定します。答えるまでは、その分の商品（{heldCount}件）はNEの原価を変えずに「保留」にします。
              一度答えた内容は保存され、次からは自動で使われます。
            </span>
          </>
        ) : warnings.length > 0 ? (
          <>
            <strong>原価はすべて計算できました。念のため{warnings.length}か所を確認してください</strong>
            <span>確認だけで、答えなくても先に進めます。</span>
          </>
        ) : (
          <>
            <strong>原価はすべて計算できました</strong>
            <span>このままNE更新に進めます。</span>
          </>
        )}
      </div>

      <details className="cost-howto">
        <summary>原価の計算方法</summary>
        <p>
          1個あたりの原価 ＝（単価×届いた数 ＋ オプション費用 ＋ 中国内の送料 ＋ 国際送料）÷ 届いた数。中国の元は配送依頼書のレートで円にしています。
        </p>
        <ul>
          <li>中国内の送料：便全体の合計を、商品代金の比率で配ります。</li>
          <li>国際送料：箱ごとの請求重量で箱に配り、箱の中では商品代金の比率で配ります。</li>
          <li>NEに入れるのは、各商品の一番新しい便の原価（整数）です。</li>
        </ul>
      </details>

      {props.rulesError && (
        <p className="cost-issue cost-issue--error">
          保存してある答え（個数・付属品の行き先）を読み込めませんでした：{props.rulesError}
          <button type="button" className="cost-link-button" onClick={props.onReloadRules}>再読み込み</button>
        </p>
      )}
      {props.sourceErrors.map((message) => (
        <p key={message} className="cost-issue cost-issue--warning">{message}</p>
      ))}
      {props.locked && (
        <p className="cost-issue cost-issue--info">
          NE更新は終わっています。ここで答えを変えても今回の分には反映されず、次回から使われます。
        </p>
      )}

      {props.registration && <RegistrationBox state={props.registration} onRetry={props.onRetryRegistration} />}

      {props.rulesLoading && <p className="cost-muted">保存してある答えを読み込み中…</p>}

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
              <div><dt>この便の費用の合計</dt><dd>{yen(s.totalJpy)}</dd></div>
              <div><dt>レート（1元）</dt><dd>{s.rate}円</dd></div>
              <div>
                <dt>国際送料</dt>
                <dd>
                  {yen(s.intlFreightJpy)}
                  {s.chargeableKg > 0 && <small> / {s.chargeableKg}kg（{yen(s.intlFreightJpy / s.chargeableKg, 1)}/kg）</small>}
                </dd>
              </div>
              <div><dt>国際送料の分け方</dt><dd>{s.intlMethod === "box" ? "箱の重さ" : "商品代金の比率"}</dd></div>
              {s.ignoredJpy > 0.5 && <div><dt>原価に含めない費用</dt><dd>{yen(s.ignoredJpy)}</dd></div>}
              {s.unallocatedJpy > 0.5 && (
                <div className="cost-danger"><dt>行き先が決まっていない費用</dt><dd>{yen(s.unallocatedJpy)}</dd></div>
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
              <th className="num">届いた数</th>
              <th className="num">商品代</th>
              <th className="num">オプション</th>
              <th className="num">中国内送料</th>
              <th className="num">国際送料</th>
              <th className="num">1個の原価</th>
              <th className="num">NEに入れる原価</th>
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
        「NEに入れる原価」の「—」は、同じ商品がもっと新しい便にもあるもの（NEには新しい便の原価を入れます）。
        「保留」は答えが必要なところが残っている商品で、NEの原価は今のまま変えません。
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
          <div><dt>配送依頼書の行</dt><dd>{issue.line.lineNo}行目（注文の商品番号 {issue.line.itemNo}）</dd></div>
          <div><dt>中身</dt><dd>{issue.line.productInfo.replace(/\n/g, " ") || "—"}</dd></div>
          <div><dt>届いた数</dt><dd>{count(issue.line.shipQty)}個（単価 {issue.line.unitPriceCny}元）</dd></div>
          {issue.amountJpy !== undefined && <div><dt>この行の費用</dt><dd>{yen(issue.amountJpy)}</dd></div>}
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
        title: "1つの行に、2つ以上の商品がまとめて入っています",
        body:
          `この行で届いた${count(issue.line?.shipQty ?? 0)}個は、${codes} で分け合うものです。` +
          "金額をどう分けるか決めるために、それぞれの商品が「NEで1個」と数えるときに、この行の品物を何個使うかを入れてください。" +
          "（例：4枚で1セットの商品なら 4）",
      };
    case "unit_mismatch":
      return {
        title: "保存してある「何個で1セットか」で計算すると、届いた数と合いません",
        body:
          `${codes} の個数を確認してください。商品のセット内容が変わった、またはオーダー数の修正が必要な可能性があります。` +
          "計算は続けていますが、金額の分け方がずれているかもしれません。",
      };
    case "unassigned_material":
      return {
        title: "商品コードの書かれていない行があります",
        body:
          "この行は箱詰め備考に「●商品コード▲」がないので、費用をどの商品の原価に入れればいいか分かりません。" +
          "ケース・袋・紙などの付属品なら、使う商品を選んでください。おまけ・サンプルなど商品と関係ないものは「原価に含めない」を選んでください。" +
          "選んだ内容は注文番号ごとに保存され、同じ品物がまた来たときは自動で使われます。",
      };
    case "material_no_target":
      return {
        title: "前に決めた付属品の行き先の商品が、この便にありません",
        body:
          `この行は前に「${codes} の付属品」と決めてありますが、今回の便にはその商品が入っていません。` +
          "今回入れる商品を選び直すか、「原価に含めない」を選んでください。",
      };
    case "material_mismatch":
      return {
        title: "付属品の数が、商品の数と合いません",
        body:
          "付属品の数と、選んだ商品が使う数が一致しません。費用を分ける比率としては使えるので計算は続けています。" +
          "1個に使う数が違っていれば直してください。",
      };
    case "deleted_line":
      return {
        title: "削除した商品の分の費用が、どの原価にも入っていません",
        body: `${codes} を商品一覧で削除したため、この行の費用はどの商品にも乗っていません。届いていない商品なら、このままで大丈夫です。`,
      };
    case "no_cost_data":
      return {
        title: "配送依頼書に金額がない商品があります",
        body: `${codes} は手入力で追加したなどの理由で、配送依頼書に金額がありません。原価は計算できないので、NEの原価は今のまま変えません。`,
      };
    case "intl_fallback":
      return {
        title: "国際送料を箱ごとに分けられませんでした",
        body: "配送依頼書に箱の重さか、どの箱に入っているかの情報が足りないため、この便の国際送料は商品代金の比率で分けています。",
      };
    case "quantity_mismatch":
      return {
        title: "梱包数とオーダー数が違う商品があります",
        body:
          "多くはセット品（例：8個で1セット）で、その場合はこのままで大丈夫です。" +
          "「一部だけ届いた可能性」と出ている商品は、上の商品一覧でオーダー数を実際に届いた数に直してください。直さないと、1個の原価が安く計算されます。",
      };
    default:
      return { title: "配送依頼書の読み取りで気になる点があります", body: issue.message };
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
                ? `一部だけ届いた可能性 → オーダー数を届いた数に（梱包数どおりなら ${count(item.packingQuantities[0])}）`
                : "一部だけ届いた可能性 → オーダー数を届いた数に直す"
              : "全部届いている → セット品ならこのままでOK"}
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
      setMessage("すべての商品に1以上の数を入れてください。");
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
            <span>は、NEの1個に</span>
            <input
              inputMode="decimal"
              value={values[code] ?? ""}
              placeholder="例 4"
              onChange={(event) => setValues((current) => ({ ...current, [code]: event.target.value }))}
            />
            <span>個使う</span>
            {codeUnits[code] !== undefined && (
              <small>
                × 今回{count(codeUnits[code])}個 ＝ {parsed[i] > 0 ? count(codeUnits[code] * parsed[i]) : "?"}個
              </small>
            )}
          </label>
        ))}
      </div>
      {shipQty !== undefined && (
        <p className={`cost-unit-check ${allFilled ? (matches ? "is-ok" : "is-ng") : ""}`}>
          {allFilled
            ? matches
              ? `合計 ${count(total)}個 ＝ この行で届いた ${count(shipQty)}個 と一致しています`
              : `合計 ${count(total)}個 ／ この行で届いたのは ${count(shipQty)}個（合っていません。数を見直してください）`
            : `この行で届いたのは ${count(shipQty)}個 です。入れた数の合計がこれと一致すれば正解です`}
        </p>
      )}
      <div className="cost-editor-fields">
        <button type="button" onClick={save} disabled={saving}>
          {saving ? "保存中…" : "この数で保存（次回から自動）"}
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
      setMessage("この行の品物を使う商品を1つ以上選んでください。");
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
      {suggested.includes(code) && <em>備考に書いてある</em>}
      <small>NEの1個に</small>
      <input
        className="cost-material-qty"
        inputMode="decimal"
        value={state[code]?.qty ?? "1"}
        aria-label={`${code} の1個あたりに使う数`}
        onChange={(event) =>
          setState((current) => ({ ...current, [code]: { ...(current[code] ?? { checked: true }), qty: event.target.value } }))
        }
      />
      <small>個使う</small>
    </label>
  );

  return (
    <div className="cost-editor">
      <span className="cost-editor-label">この行の品物を使う商品</span>
      {primary.length > 0 ? (
        <div className="cost-material-options">{primary.map(renderCode)}</div>
      ) : (
        <p className="cost-muted">候補が見つかりませんでした。下の「ほかの商品から選ぶ」から選んでください。</p>
      )}
      {others.length > 0 && (
        <details className="cost-material-more">
          <summary>ほかの商品から選ぶ（この便の{others.length}件）</summary>
          <div className="cost-material-options">{others.map(renderCode)}</div>
        </details>
      )}
      <div className="cost-editor-fields">
        <button type="button" onClick={() => save(false)} disabled={saving}>
          {saving ? "保存中…" : "選んだ商品の原価に入れる"}
        </button>
        <button type="button" className="cost-secondary" onClick={() => save(true)} disabled={saving}>
          原価に含めない（おまけ・サンプルなど）
        </button>
      </div>
      <small className="cost-muted">注文番号 {line.orderNo}・商品番号 {line.itemNo} の答えとして保存します。</small>
      {message && <small className="cost-editor-error">{message}</small>}
    </div>
  );
}
