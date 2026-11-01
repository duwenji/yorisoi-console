# TODO

チャンネル管理システムで残っている作業。できている機能は [README](../README.md) と [利用ガイド](manual/README.md)、構成は [architecture.md](design/architecture.md) にある。

## 本番の準備

手順は [鍵の手順書](operations/keys.md) と [配備の手順](operations/deploy.md) にある。

1. 独自ドメインと、SES のサンドボックスの解除（[ARCH-001](design/architecture.md) 未決事項 No.1・No.6）。そのあと本番の `notify` を `ses` にする（DES-006 J-12・J-13）
2. 鍵の移し替えの本人確認の手順（ARCH-001 未決事項 No.5）
3. 運営の AI の中継（ARCH-001 A-21）: 月の予算と Play Integrity の鍵をそろえてから配備する（[運営の AI の手順](operations/ai-relay.md)「配備」）
4. スポットのタイル（ARCH-001 A-22）: 本番の配信を作る時期を決めてから配備する（platform API-SPOT-TILES 未決事項 No.2、[スポットのタイルの手順](operations/spot-tiles.md)「配備」）
5. スタジオ（ARCH-001 A-23）: 本番の中継のあとに配備し、`config.ts` の本番の `studio` を `true` にする（[スタジオの手順](operations/studio.md)「配備」）

## 確かめること

- [ ] 試用チケットで、素材集・基準を使うチャンネルをアプリで通しで確かめる（SanpoGuide 側。チャンネル提供者の鍵ファイルが届いてから）
- [ ] スタジオの画面をブラウザで通しで確かめる（提供者の申し込み → 承認 → スタジオ → 通報 → 運営の対応）
- [ ] スタジオの音声（実際の M4A）で、Transcribe と確認・配信・アプリでの再生を通しで確かめる
