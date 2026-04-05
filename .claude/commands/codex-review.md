---
description: Codex に変更差分をレビューさせる
argument-hint: "[scope: diff|staged|ファイルパス]"
---

Codex Skill を使って、以下の手順でコードレビューを実行してください。

## スコープ決定

- 引数なし → `git diff` (未ステージの変更)
- `staged` → `git diff --staged`
- `diff` → `git diff` (明示)
- ファイルパス → そのファイルの現在の内容

## レビュー依頼

1. スコープに応じた差分を取得する
2. Codex に以下の形式でレビューを依頼する:
   - 単発モード (`codex exec -s read-only -o <tmpfile> -- "<prompt>"`) を使用
   - **Claude の自己評価は渡さない**（盲点の多様性確保のため）
   - diff と対象ファイルのみを渡す

3. レビュー出力形式を指定する:
   ```
   severity (critical/warning/info) | file:line | issue | suggestion
   ```

4. レビュー結果をユーザーに報告する

$ARGUMENTS
