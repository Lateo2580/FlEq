# AGENTS.md

dmdata.jp の地震・津波・EEW・火山・気象電文を受信して表示する TypeScript CLI。

## 実行環境

- Node 20 / 22 / 24 のいずれか（vitest 4 が Node 20 以上を要求する）
- 依存関係の準備は `npm ci --ignore-scripts`（lockfile どおりに入れる。`package.json` / `package-lock.json` は変更しない）

## ビルド・テスト

- `npm run build` — TypeScript コンパイル → dist/
- `npm test` — vitest でテスト実行（test/setup.ts で node-notifier をグローバルモック済み）
- `npm run test:shuffle` — ファイル・it の実行順をシャッフルして実行。**永続化・共有状態・module スコープの変数を触ったときは必ず通す**。2026-07-25 に、デフォルト順では緑なのに順序を変えると落ちるテストが実在した（`vi.hoisted()` の一方向カウンタをファイル内の複数 it が共有していた）。「テストが緑」と「テストが常に緑」は別物
- `npm run typecheck:test` — `test/` 配下の型検査（段階導入中。範囲と次段の手順は `tsconfig.test.json` 冒頭コメント）

## コーディング規約

- import は近傍ファイルの既存スタイルに合わせる（logger/theme 等は namespace import が多い）
- null チェックは `== null` を使う（`=== null || === undefined` ではなく）
- `any` 禁止（strict TypeScript）
- 新しい電文対応は parser → router → formatter → notifier → test の順で追加する。電文処理を触るときは `.claude/rules/message-pipeline.md` も読むこと

## 作業開始時の確認

- `git rev-parse HEAD` が作業契約の base_oid と一致すること
- `git status --porcelain` が空であること
- どちらかを満たさない場合は作業せず中止して報告する（fetch や reset で直そうとしない）

## 完了条件（タスク種別ごと）

- **コード実装**: `npm run build` と `npm test` の両方が成功していること。テストを実行せずに「完了」と報告しない
- **文書・設定のみの変更**: 該当する検証があれば実行、なければ N/A と明記する
- **read-only レビュー**: build は実行しない。レビュー依頼で指定された検査のみ行う
- 依存取得失敗などで検証を実行できない場合は、成功扱いにせず **blocked** と明記し、現状の成果物と理由を返す
- 依頼された範囲外のファイルを変更しない。範囲外の問題を見つけたら変更せず報告する

## 成果物の返し方（実装タスク）

- allowed_paths に限定した `git diff --binary --no-ext-diff` の patch
- 変更ファイル一覧
- 実行したコマンドと結果（build / test の成否）
- 未実行の検証とその理由、残存リスク

## git 操作

許可（読み取りのみ）:

- `git status --porcelain` / `git rev-parse HEAD`
- `git diff`（allowed_paths に限定）/ `git diff --check`
- 必要最小限の `git show` / `git ls-files`

上記以外の git 操作は禁止。特に commit / push / fetch / merge / rebase / cherry-pick / reset / branch / tag / add / restore / switch / stash / clean / worktree / config は実行しない。履歴操作と統合は統合担当が行う。

## 探索範囲

- この checkout の作業ディレクトリ内のみを読む
- 親ディレクトリ、他の checkout、ユーザープロファイル、global git config、認証情報は対象外
