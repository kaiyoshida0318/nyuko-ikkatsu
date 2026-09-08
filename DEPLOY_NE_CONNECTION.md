# NE接続状況機能の反映手順

変更は `ne-sync-worker` と `nyuko-ikkatsu` の2側にあります。

## 1. ne-sync-worker を先にデプロイ

`ne-sync-worker` 側で以下を反映してからデプロイします。

- `src/index.ts`
- `README.md`（説明のみ）

```powershell
npm install
npm run deploy
```

追加API: `GET /api/ne/connection-test`

このAPIはSupabase Authまたは既存管理者認証を通したうえで、NEの会社情報APIへ実際に接続し、Worker到達可否とNE認証可否を切り分けます。

## 2. nyuko-ikkatsu を反映

`nyuko-ikkatsu` 側で以下を反映します。

- `components/NyukoApp.tsx`
- `lib/neSyncWorker.ts`
- `app/globals.css`
- `README.md`（説明のみ）

Repository secret `NEXT_PUBLIC_NE_SYNC_WORKER_URL` は設定済みの値をそのまま使います。
mainへpushするか、Actionsの `Deploy Next.js to GitHub Pages` を再実行してください。

## 動作

ログイン後に1回、自動でNE接続テストを実行します。
ヘッダーには次の状態が表示されます。

- 接続済み
- 要再認証
- 接続エラー
- エラー
- 未設定 / 未確認 / 確認中

NE表示をクリックすると詳細パネルが開き、手動の「接続テスト」と、必要時の「NEを再認証」が使えます。

## 注意

自動テストおよび手動の接続テストは、NE APIの会社情報APIを1回呼ぶため、NE API利用回数に含まれます。
