---
paths:
  - src/ui/**
  - src/engine/presentation/**
  - test/ui/**
  - test/engine/presentation/**
---

# UI/表示ルール

- 表示変更時は `docs/display-reference.md` が存在する場合、同期更新すること
- 新規 formatter は full 表示のみを持つ。compact は summary パイプライン (token-builders) 側の責務
  （旧 formatter には互換の compact 分岐 `getDisplayMode() === "compact"` が残っているが、新規には追加しない）
- ターミナル幅を前提にしたレイアウトでは、最小幅での崩れに注意
- chalk は v4 系 (CommonJS) 前提。ESM 前提の chalk 5+ へ上げるとビルドが壊れる
