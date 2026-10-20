# TODO

チャンネル管理システムで残っている作業。できている機能は [README](../README.md) と [利用ガイド](guide/README.md)、構成は [architecture.md](architecture.md) にある。

## 本番の準備

手順は [鍵の手順書](operations/keys.md) と [配備の手順](operations/deploy.md) にある。

1. 独自ドメイン（[ADR-001](adr/ADR-001-aws-architecture.md) T-2）と、SES のサンドボックスの解除（T-3）。そのあと本番の `notify` を `ses` にする（DES-006 J-12・J-13）
2. 鍵の移し替えの本人確認の手順（ADR-001 未決事項 No.5）
3. 運営の AI の中継（ADR-001 A-21）: Anthropic のユースケースの申告、月の予算、Play Integrity の鍵をそろえてから配備する（[運営の AI の手順](operations/ai-relay.md)「配備」）

## 確かめること

- [ ] Haiku 5.5 のクォータが認められたら、開発用の中継をモデル `haiku-5-5` に切り替えて生成を確かめる（今は `upstream_error`）
- [ ] 試用チケットで、素材集・基準を使うチャンネルをアプリで通しで確かめる（SanpoGuide 側。チャンネル提供者の鍵ファイルが届いてから）
