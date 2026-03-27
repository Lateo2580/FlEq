# CLAUDE.md

dmdata.jp の地震・津波・EEW・火山電文を受信して表示する TypeScript CLI。

## ビルド・実行

```bash
npm run build        # TypeScript コンパイル → dist/
npm test             # vitest でテスト実行
npm run dev          # ビルド + 実行
npm run dev:lowmem   # ビルド + メモリ最適化モードで実行 (--optimize-for-size)
npm run start:lowmem # メモリ最適化モードで実行
```

## 実装上の注意

- chalk は v4 系 (CommonJS) 前提。ESM 前提の chalk 5+ へ上げるとビルドが壊れる
- 遅延ロード: `cli.ts → cli-run.ts / cli-init.ts`、`monitor.ts → repl.ts` は dynamic import（メモリ最適化）

## アーキテクチャ（責務マップ）

| ディレクトリ | 責務 |
|-------------|------|
| `engine/cli/` | CLI 定義・起動ハンドラ |
| `engine/startup/` | 設定解決・起動時初期化 (津波/火山状態復元) |
| `engine/monitor/` | 実行中オーケストレーション・シャットダウン・REPL 協調 |
| `engine/messages/` | 電文ルーティング・津波/火山状態管理 |
| `engine/eew/` | EEW 追跡・ログ記録 |
| `engine/notification/` | デスクトップ通知・通知レベル判定・通知音 |
| `dmdata/` | dmdata.jp 通信 (REST, WebSocket) とパーサ |
| `ui/` | formatter / REPL / テーマ |

新しい電文対応は原則 **parser → router → formatter → notifier → test** の順で追加する。

## 電文ルーティング

`message-router.ts` が `classification` + `head.type` で振り分ける。

### ルーティング優先順位

1. `eew.forecast` / `eew.warning` → EEW パス (EewTracker 重複検出 + EewEventLogger)
2. `telegram.volcano` → 火山パス (VolcanoStateHolder + VolcanoPresentation)
3. `telegram.earthquake` + `VXSE56`/`VXSE60`/`VZSE40` → テキスト系
4. `telegram.earthquake` + `VXSE62` → 長周期地震動観測
5. `telegram.earthquake` + `VXSE*` → 地震情報
6. `telegram.earthquake` + `VTSE*` → 津波情報
7. `telegram.earthquake` + `VYSE*` → 南海トラフ
8. それ以外 → `displayRawHeader` (フォールバック)

**特記**: VFVO53 は単発処理ではなく `volcano-vfvo53-aggregator.ts` でバッチ集約される。

### 電文→パーサ→表示 対応表

| head.type | パーサ | 表示 |
|-----------|--------|------|
| VXSE43/44/45 | `parseEewTelegram` | `displayEewInfo` |
| VXSE51/52/53/61 | `parseEarthquakeTelegram` | `displayEarthquakeInfo` |
| VXSE56/60, VZSE40 | `parseSeismicTextTelegram` | `displaySeismicTextInfo` |
| VXSE62 | `parseLgObservationTelegram` | `displayLgObservationInfo` |
| VTSE41/51/52 | `parseTsunamiTelegram` | `displayTsunamiInfo` |
| VYSE50/51/52/60 | `parseNankaiTroughTelegram` | `displayNankaiTroughInfo` |
| VFVO50-56/60, VFSVii, VZVO40 | `parseVolcanoTelegram` | `displayVolcanoInfo` |

### フレームレベル判定

`FrameLevel`: `critical` / `warning` / `normal` / `info` / `cancel`

- **EEW**: 警報=critical, 予報=warning, 取消=cancel
- **地震**: 震度6弱以上=critical, 4以上=warning, 取消=cancel
- **津波**: 大津波警報=critical, 津波警報=warning, 取消=cancel
- **長周期**: LgInt4=critical, 3=warning, 2=normal
- **テキスト**: 取消=cancel, その他=info
- **南海トラフ**: Code120=critical, Code130/111-113/210-219=warning, Code190/200=info
- **火山** (volcano-presentation.ts):
  - VFVO56 噴火速報=critical
  - VFVO50 Lv4-5引上げ=critical, Lv2-3引上げ=warning, 引下げ/解除=normal
  - VFVO50 継続: Lv4-5(初見=critical, 再通知=warning), Lv2-3(初見=warning, 再通知=normal)
  - VFVO52 爆発/噴煙≥3000m=warning, 軽微=normal
  - VFVO54=warning, VFVO55=normal, VFVO53=info
  - VFVO51 臨時=warning, 通常=info
  - VFSVii Code31/36=warning, Code33=normal
  - VFVO60=normal, VZVO40=info, 取消=cancel

## テスト

- テストは **vitest** (`npm test`)
- `test/setup.ts` で node-notifier をグローバルモック済み
- 電文テストは `test/helpers/mock-message.ts` の `createMockWsDataMessage(fixtureName)` を使う
- フィクスチャは `test/fixtures/` に配置。命名: `{分類番号}_{連番}_{日付}_{電文タイプ}.xml`
- フィクスチャ定数: `FIXTURE_VXSE53_ENCHI` 等 (mock-message.ts で export)

## コーディング規約

- **import**: 近傍ファイルの既存スタイルに合わせる。`logger` / `theme` 等は namespace import (`import * as log from ...`) が多い。内部 named import も広く使われている
- **null チェック**: `== null` を使う（`=== null || === undefined` ではなく）
- **`any` 禁止**: strict TypeScript

## 設定

設定は以下の優先順位で解決される (上位が優先):

1. CLI オプション (`--api-key`, `-c`, `--test`, `--mode`, `--debug` 等)
2. 環境変数 `DMDATA_API_KEY`
3. `.env` ファイル
4. Config ファイル (OS 依存パス。`XDG_CONFIG_HOME` 設定時はそちら優先)
5. デフォルト値 (`DEFAULT_CONFIG`)

新しい設定項目を追加する際もこの優先順位に従うこと。

## Claude Harness Policy

- `CLAUDE.md` は常設の制約・設計原則を置く（「憲法」）
- Skills は特定タスクの手順とチェックリストを置く
- Hooks は機械的に判定できる自動ガードだけを置く
- 重い検証やリリース判定は Hook に寄せず、npm scripts / CI に残す
- Hook は短時間・決定的・副作用最小を原則とする
- 詳細設計は `docs/specs/claude-harness.md` を参照

## レビュー方針

- コードレビューはサブエージェントではなく **Codex MCP に依頼**する
- Superpowers が生成した specs/plans は作業完了後 `C:/Users/meiri/Dev/Superpowers_Archive/` に移動し、`docs/superpowers/` を削除する

## リリースフロー

- **方針**: 機能まとめリリース。日々のコミットは `git push` で積み、意味のあるまとまり（新機能追加・複数のUI改善など）が溜まったタイミングでリリースする。コミットごとにリリースしない
- **コミット**: Conventional Commits 形式 (`feat:`, `fix:`, `refactor:` 等)
- **リリース手順**: `npm run release` → `git push --follow-tags`。破壊的変更は `npm run release:major`
