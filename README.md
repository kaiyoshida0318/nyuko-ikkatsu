# 入庫一括（nyuko-ikkatsu）

ラクマートで発注した商品が自社に到着したときに使う、入庫処理一括アプリです。

ブラウザ内で配送依頼書を読み取り、商品情報・オーダー状況は Supabase の `products` テーブルから取得します。

処理後は以下を行います。

- NE商品マスタアップロードAPIで `zaiko_su` と `kataban` を直接更新
- Supabase の `order_memo_1〜5` と `rakumart_url_1〜5` を更新
- `入庫リスト.xlsx` を出力

## 入力ファイル

### ラクマート配送依頼書 `P~.xlsx`

- 複数ファイル対応
- `梱包リスト` シートを使用
- `箱詰め備考` 列から `●商品コード▲MMDD-数量` を抽出
- `●商品コード▲MMDD-数量` がない行は「その他」として抽出

## 商品DB連携 / ログイン

Supabase URL と Supabase anon key は、ビルド時の環境変数からアプリに埋め込みます。画面上での手入力は不要です。

```env
NEXT_PUBLIC_SUPABASE_URL=https://PROJECT_REF.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=YOUR_SUPABASE_ANON_KEY
NEXT_PUBLIC_NE_SYNC_WORKER_URL=https://YOUR_NE_SYNC_WORKER.workers.dev
```

アプリ起動時に Supabase Auth のログイン画面を表示します。商品DBと同じメールアドレス・パスワードでログインすると、`products` の取得・更新を実行できます。

GitHub Pages の Actions では、Repository secrets に以下を登録してください。

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `NEXT_PUBLIC_NE_SYNC_WORKER_URL`

対象テーブルは `products` です。

使用カラム:

- `product_code`
- `product_name`
- `floor`
- `order_memo_1〜5`
- `rakumart_url_1〜5`

## 消し込みルール

ラクマート配送依頼書から抽出した `MMDD-数量` を、Supabase の `order_memo_1〜5` と照合します。

一致条件は以下です。

- 完全一致: `0416-500`
- 注記付きも一致: `0416-500setRM`, `0416-500空`, `0416-500保管`
- 数字が続くものは不一致: `0416-5000`

一致した `order_memo` は削除し、対応する `rakumart_url` も削除します。残ったオーダーとURLは左詰めで `products` に書き戻します。

## 原価計算（便ごと・先入先出）

配送依頼書の「配送依頼書詳細」シートから、便ごと・商品コードごとの原価を計算します。

```
原価 = 単価×出荷数 + オプション費用 + 中国内運賃 + 国際送料（+ 代行手数料・その他）
```

- 元建ての金額は「配送依頼書レート」で円換算
- 中国内運賃：便全体の合計を商品代金の比率で配分
- 国際送料：箱の決済重量で箱ごとに按分し、箱の中は商品代金の比率で配分（所在箱・箱情報が揃わない便は便全体の商品代金比）
- 入庫数（NEの単位）は従来どおり梱包リストの `●商品コード▲MMDD-数量`（修正後の値）
- 複数行で1商品（セット品）：行の金額を合計して入庫数で割る（マスタ不要）
- 1行に複数コード（例：sika04 / sika06）：**入数マスタ**（`cost_unit_rules`）で按分。未登録なら画面で入力して保存
- 商品コードのない行（共有資材の紙など）：**共有資材ルール**（`cost_material_rules`、注文番号＋商品番号）で割当。備考で注文番号が書かれているコードを候補として自動でチェック。「原価に含めない」も選べます

### NE更新時の動き

1. NE商品マスタアップロードに `genka_tnk`（各商品の**最新の便**の1単位原価、整数）を追加
2. Workerがアップロード直前のNE在庫数（`stock_quantity`）と原価を返す
3. Supabase の `cost_register_receipt` で便を登録
   - NE在庫 < 便の残数合計 → 差分を古い便から消費
   - NE在庫 > 便の残数合計 → 差分を「調整」として追加（返品・棚卸増など）
   - 便が1つもない商品 → NE在庫を「期首在庫」としてNEの現在原価で作成
   - 同じ便・同じ商品は二重登録しない（再試行可）

要対応（入数未登録など）が残っている商品は、NEの原価を変更せず、便は `needs_review` 付きで登録します。

### セットアップ

1. Supabase SQL Editor で `supabase/cost_lots.sql` を実行
2. `ne-sync-worker` を更新してデプロイ（`genka_tnk` 対応・入庫前在庫の返却）
3. 入庫一括を通常どおりビルド・デプロイ

商品ごとの在庫金額は `cost_inventory_by_product` ビューで見られます。

## ローカル起動

```bash
npm install
cp .env.local.example .env.local
# .env.local に NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY を入れる
npm run dev
```

ブラウザで `http://localhost:3000` を開きます。

## 静的ビルド

```bash
npm run build
```

`out/` に静的ファイルが出力されます。

## Supabase Auth のログイン分離

入庫一括は商品DBと同じ Supabase Auth を使いますが、ブラウザ内の保存キーは入庫一括専用にしています。
そのため、商品DBでログインしていても入庫一括へ自動ログインされません。

Supabase URL は `https://xxxxx.supabase.co` の形式を推奨します。誤って `/rest/v1` や `/rest/v1/products` まで入っていても、ログイン処理ではプロジェクトURL部分だけを使います。


## NE更新API

入庫一括の「NE更新」はCSV出力ではなく、`ne-sync-worker` の `/api/ne/reflect-nyuko` にPOSTしてNE商品マスタアップロードAPIへ直接送信します。

送信認証はSupabase Authのaccess tokenを `Authorization: Bearer ...` で渡します。`ne-sync-worker` 側では既存のADMIN_TOKEN認証に加えてSupabase Auth認証も許可します。

更新内容は以下です。

- `syohin_code`: 商品コード
- `zaiko_su`: 入庫数量
- `kataban`: 消し込み後の発注状況。空欄になる場合は `0`

## NE接続状況表示

ログイン後、ヘッダーに `NE` の接続状態を表示します。

- `接続済み`: Workerへ到達し、NE APIの実通信テストも成功
- `要再認証`: Workerへは到達できるが、NE認証が未接続・無効・期限切れ
- `接続エラー`: Workerへ到達できない
- `エラー`: Workerへは到達したが、NE API確認中に別のエラーが発生

ページを開いてログイン状態が確定したタイミングで1回、自動で接続テストを実行します。NE表示をクリックすると詳細を開け、`接続テスト` を手動でも実行できます。再認証が必要な場合は `NEを再認証` リンクを表示します。

接続テストは `ne-sync-worker` の `GET /api/ne/connection-test` を使い、NEの会社情報APIへ実際に1回アクセスするため、NE API呼び出し回数に含まれます。
