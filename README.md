# 入庫一括（nyuko-ikkatsu）

ラクマートで発注した商品が自社に到着したときに使う、入庫処理一括アプリです。

ブラウザ内で配送依頼書を読み取り、商品情報・オーダー状況は Supabase の `products` テーブルから取得します。

処理後は以下を行います。

- `NE更新.csv` を出力
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
```

アプリ起動時に Supabase Auth のログイン画面を表示します。商品DBと同じメールアドレス・パスワードでログインすると、`products` の取得・更新を実行できます。

GitHub Pages の Actions では、Repository secrets に以下を登録してください。

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`

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
