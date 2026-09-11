# CLAUDE.md

dmdata.jp の地震・津波・EEW・火山・気象電文を受信して表示する TypeScript CLI。

@AGENTS.md

ビルド・テストコマンド、コーディング規約、完了条件は `AGENTS.md`（Claude / Codex 共有）を参照。

## 実行

```bash
npm run dev          # ビルド + 実行
npm run dev:lowmem   # ビルド + メモリ最適化モードで実行 (--optimize-for-size)
npm run start:lowmem # メモリ最適化モードで実行
```

## アーキテクチャ（責務マップ）

| ディレクトリ | 責務 |
|-------------|------|
| `engine/cli/` | CLI 定義・起動ハンドラ |
| `engine/startup/` | 設定解決・起動時初期化 (津波/火山状態復元) |
| `engine/monitor/` | 実行中オーケストレーション・シャットダウン・REPL 協調 |
| `engine/messages/` | 電文ルーティング・状態管理 (津波/火山/気象警報)・統計・要約追跡 |
| `engine/presentation/` | PresentationEvent 変換・severity/frame/sound 解決・差分管理 |
| `engine/eew/` | EEW 追跡・ログ記録 |
| `engine/notification/` | デスクトップ通知・通知レベル判定・通知音 |
| `engine/filter/` | フィルタ DSL (パーサ・コンパイラ・型検査) |
| `engine/template/` | テンプレート DSL (パーサ・コンパイラ・フィルタ関数) |
| `dmdata/` | dmdata.jp 通信 (REST, WebSocket) と全電文パーサ |
| `ui/` | formatter・REPL・テーマ・サマリーパイプライン |

新しい電文対応は原則 **parser → router → formatter → notifier → test** の順で追加する。電文ルーティング・パーサ対応表・フレームレベル判定の詳細は `.claude/rules/message-pipeline.md` を参照。

## 実装上の注意

- 遅延ロード: `cli.ts → cli-run.ts / cli-init.ts`、`monitor.ts → repl.ts` は dynamic import（メモリ最適化）
- 型で守る（type-system-discipline）: 不正な状態を型で表現不能にする。外部データ（dmdata の XML / JSON、設定、CLI 引数）は境界でパースして内部では型を信頼する。`as` や `any` でコンパイラに嘘をつかない。判別共用体は `switch` で網羅する
- 足す前に引く（subtract-before-you-add）: 機能追加の前に、死んだコード・冗長なバリデータ・スタブ参照を先に除き、単純になった土台の上に作る。変更は問題を解く最小のものに寄せる
- 上 2 行の出典と、未採用の候補 7 本は Vault `Knowledge/Dev/2026-08-28-pstack-principles-inventory.md`（pstack 21 原則の棚卸し）
- 最小実装（オーバーエンジニアリング回避）: 仕組みを 1 つ足す前に「それは要るか・無いと何が壊れるか」を 1 行で書く。実装が 1 つしかない interface、製品が 1 つの factory、変わらない値の設定化、将来のための拡張点・scaffolding は作らない。最新の Codex モデル（gpt-6-astra）はここが厚くなりやすいので、委譲文に必ず明記する（2026-09-11 ご主人指示）
- 最小テスト（無駄なテストを作らない）: テストは **受入条件・契約の境界・実際に起きた不具合の再発防止・corpus 履歴（fixture→期待状態）** に限る。実装の内部構造を写すテスト、同じ分岐の言い換え、fixture の焼き直し、private 関数ごとの suite は作らない。1 つの振る舞いに 1 テスト。「テストが多い＝安全」ではない。ponytail（YAGNI はしご）は両エージェントに runtime で注入されるが、それは語りの層。この 2 行が repo に残る規範で、clone 先や plugin off でも効く

## Claude Harness Policy

- `CLAUDE.md` は常設の制約・設計原則を置く（「憲法」）
- Skills は特定タスクの手順とチェックリストを置く
- Hooks は機械的に判定できる自動ガードだけを置く
- 重い検証やリリース判定は Hook に寄せず、npm scripts / CI に残す
- Hook は短時間・決定的・副作用最小を原則とする
- パス固有のルールは `.claude/rules/` に配置
- 詳細設計は `docs/specs/claude-harness.md` を参照

## レビュー方針

- コードレビューはサブエージェントではなく **Codex MCP に依頼**する
- Superpowers が生成した specs/plans は作業完了後 `C:/Users/meiri/Dev/Superpowers_Archive/` に移動し、`docs/superpowers/` を削除する

## Codex 併用ルール（分担表 v1, 2026-07-14）

| 用途 | モデル |
|---|---|
| 日常相談・探索・コード読解 | Terra medium |
| 中間 diff レビュー（フェーズ末含む） | Terra high |
| 定型実装の委譲 | Luna medium/high |
| 難しい範囲限定実装 | Sol medium/high |
| 最終全体レビュー・セキュリティ・見解衝突 | 新規スレッドの Sol high |

- **独立レビューは必ず新規 codex 呼び出し + read-only**。実装に使ったスレッドを流用しない
- **独立性**: Claude の自己評価を Codex に見せない（盲点の多様性確保）
- **実装委譲時は作業契約を必須とする**: 目的・完了条件・対象/非対象範囲・allowed_paths・base_oid 固定・禁止 git 操作・成果物は patch のみ（`git diff --binary --no-ext-diff`）。検証不能時は blocked 報告を認める（成功扱いにしない）
- 委譲環境は使い捨て clone で用意し、依存準備は `npm ci --ignore-scripts` を標準とする
- 委譲の段階導入・意味的手直し率の判定閾値は運用側メモ（memory `reference_model_division_v1`）を参照
- **display/frontend の実装委譲は Phase 0（規範読み込み）を最初の成果物にする**: `docs/specs/display-design-system.md`・`theme.css`・header/footer 統一 spec・錨カードを読み、使うトークンと倣う錨の file:line を申告してから実装（2026-09-05、規範を読まない類推実装で乖離 11 件が積み上がった経緯）
- **実装委譲文には「最小実装・最小テスト」を定型で入れる**: 完了条件の列挙に続けて「仕組みを足すときは無いと何が壊れるかを 1 行で示す／テストは受入条件・契約境界・実不具合・corpus 履歴に限り、追加した各テストがどれに対応するかを成果物に 1 行で書く」を書く。gpt-6-astra への委譲では省略しない（2026-09-11 ご主人指示、詳細は `AGENTS.md` §コーディング規約）
- **ブラウザ capture の実走は親（Liebe）が担う**: 子の sandbox は listen 不可。子は records に対する `--assert-from` で assertion を検証する
- **スコープ**: repo 全体ではなく diff 単位に絞る
- **形式**: file:line 付きの構造化出力・確信度を求める。スタイルのみの指摘は不要と伝える
- **最終判断**: 人間が採否を決める

## Obsidian 記録

- セッション内で区切りがついたら（バグ修正完了、機能実装完了、調査結論など）Obsidian にセッションログを記録する
- 些細な成果でも記録する。記録しすぎて困ることはない
- ボルトの場所・テンプレート・運用ルールは memory の `reference_obsidian_vault.md` を参照
- 記録時に frontmatter `relations:`（8 型）を任意付与、関連参照は Vault の `MOC-Relations.md` を入口にする（詳細: assort CLAUDE.md §関連情報の辿り方）

## バックログ運用

真実源は Obsidian Vault `Artifacts/FlEq-やりたいことリスト.md`。**セッションを跨ぐ常設バックログ**で、実機観測・思いつき・持ち越しの置き場。

- **セッション開始時に読む**。次の作業はここから拾う
- **気づいたらその場で追記する**。些細でも書く（実機観測は特に、書かないと消える）
- **節構成**: 実機観察ラウンド（時期別）／大きめ（spec 案件）／実機観測からの改善（中小）／⏳待ち／小粒の未着手／完了。完了節は必ず末尾に置く
- **状態の書き方**: 着手したら項目内に進捗を追記（spec 名・commit・配送先）、完了したら `- [x] ~~**題**~~` の形で取り消し線＋完了日を付け、**完了節へ移動する**（消さない。経緯が次の判断材料になる）
- **大玉には進捗を刻む**: 数ヶ月かかる spec 案件は 1 行のままだと「進めても減らない」ように見える。題の横に `` `[n/m]` `` を付け、直下に `- **進捗 n/m**` と子チェックボックス（フェーズ・レイヤー単位）を置く。実装が進んだら子を埋めて分子を上げる
- **⏳待ち節**: 実事象（実警報の発表・実地震）やご主人の裁定・外部レビューを待つだけの項目はここへ移す。**未着手ではなく待機**——Liebe からは着手しない。条件が揃ったら元の節へ戻すか完了へ送る
- **裁定ラベル**: 自律サイクル（`.claude/rules/autonomous-cycle.md`）で配送まで完走してよい項目には `🌙自走OK` と 6 要素ラベルを添える。**空欄が 1 つでもあれば配送不可**
- **セッション終了時（wrap-up）**: その回で完了・待機化した項目を反映してから閉じる。Obsidian セッションログとバックログはセットで更新する

## 構造的欠陥台帳

真実源は Obsidian Vault `Artifacts/FlEq-構造的欠陥台帳.md`（2026-09-09 ご主人提案）。バックログが「やること」、台帳が「局所修正で消えない構造の事実」。全面再構成の判断材料として育てる。

- spec のレビュー・実機観測・調査で構造の事実（数値・file:line 付き）が確定したら、**その場で追記する**（wrap-up まで溜めない）
- 1 項目 = 題／事実／観測日と出典／局所修正の状態／再構成での扱い。解消しても消さず「解消」と日付を残す
- spec の「再構成に送る材料」節を書いたら同じ内容を台帳へ転記する

## リリースフロー

- **方針**: 機能まとめリリース。日々のコミットは `git push` で積み、意味のあるまとまり（新機能追加・複数のUI改善など）が溜まったタイミングでリリースする。コミットごとにリリースしない
- **コミット**: Conventional Commits 形式 (`feat:`, `fix:`, `refactor:` 等)
- **リリース手順**: `npm run release` → `git push --follow-tags`。破壊的変更は `npm run release:major`
