# 開発用の環境での通しの確認

配備した開発用の環境（`YorisoiConsole-dev`）で、機械審査・試用チケット・審査・鍵の移し替えとメールを本物の AWS で確かめる台本です。テスト用のチャンネルと申請を作り、確かめたあとで消します（操作の記録と、`archive/`・`samples/`・`trial/` のファイルは残り、期限で消えます）。

```sh
export AWS_PROFILE=sanpo-dev
npx tsx tools/e2e/machine-review.ts   # 署名したパッケージが「審査待ち」に、改ざんしたものが「機械の確認で不合格」になる
npx tsx tools/e2e/test-ticket.ts      # 管理 API の Lambda を直接呼んで試用チケットを発行し、署名と trial/ のパッケージを確かめる
npx tsx tools/e2e/review.ts           # 申請 → 機械審査 → 運営の審査と承認 → リストに載る → 準拠テスト（V-07 まで）→ 後片付け
npx tsx tools/e2e/collections.ts      # 外部の音声つきの素材集 → 機械審査（外部の素材のハッシュ）→ 身元の確認つきで承認 → collections[] → それを使うチャンネル → 利用の記録 → media・resourcesSize → 準拠テスト（V-19〜V-25）→ 毎日の外部の素材の確認 → 後片付け
npx tsx tools/e2e/ecosystem.ts        # walk だけ・walk と cycle・cycle だけのチャンネル → 機械審査の見本（walk は SanpoGuide、cycle は CycleGuide の ride-）→ 承認 → リストの activities・minAppVersions（DES-011）→ 準拠テスト（V-27・V-29）→ 後片付け。--keep で残してアプリで確かめ（CycleGuide には walk だけのものが出ない）、--cleanup で片付ける
npx tsx tools/e2e/transfer.ts         # 鍵 A の版 1 を承認 → 鍵 B への移し替えを承認 → 鍵 B の版 2 を承認 → リストに publisherChange（V-16）→ メールの記録 → 後片付け
npx tsx tools/e2e/app-check.ts        # AI の根拠に使ってよい素材集（鶴岡八幡宮の付近）とそれを使うチャンネルをリストに残し、SanpoGuide で費用の目安・通報・資料の出典を確かめる（platform ADR-004）。--cycle で自転車のチャンネル（同じ地点のきっかけと、スポットのきっかけ。CycleGuide の AC-31・AC-32）にする。--cleanup で片付ける
```

本番の環境では使いません。
