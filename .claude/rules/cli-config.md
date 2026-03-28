---
paths:
  - src/config.ts
  - src/engine/cli/**
  - test/engine/cli-run.test.ts
  - test/engine/config.test.ts
---

# CLI/設定ルール

## 設定優先順位

設定は以下の優先順位で解決される (上位が優先):

1. CLI オプション (`--api-key`, `-c`, `--test`, `--mode`, `--debug` 等)
2. 環境変数 `DMDATA_API_KEY`
3. `.env` ファイル
4. Config ファイル (OS 依存パス。`XDG_CONFIG_HOME` 設定時はそちら優先)
5. デフォルト値 (`DEFAULT_CONFIG`)

新しい設定項目を追加する際もこの優先順位に従うこと。

## CLI オプション追加時

- `src/engine/cli/` のコマンド定義を更新
- `src/config.ts` の型定義と解決ロジックを更新
- 関連テストを追加・更新
