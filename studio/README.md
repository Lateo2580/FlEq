# FlEq Display Studio

**Phase 1 完了** (fixture プレビュー / テーマ編集 / 表示オプション / before-after diff)。`npm run studio` で backend (Hono :7787) と frontend (Vite :5173) が同時起動する。

## セットアップ

```bash
cd studio
npm install
```

## 起動

repo ルートから (backend + frontend 同時起動):

```bash
npm run studio
```

→ http://127.0.0.1:5173 を開く (API は Vite proxy 経由で :7787 へ)

backend だけ起動する場合:

```bash
npm run studio:backend
```

## API

- `GET /api/health` — ヘルスチェック
- `GET /api/fixtures` — weather fixture 一覧 (registry カバー状況つき)
- `POST /api/render` — fixture を parse → format → ANSI を返す (width は 40-300 の整数)
- `GET /api/theme` — テーマカタログ (パレット 9 / ロール 92 / カテゴリ 7 / デフォルト / 保存済み theme.json)
- `POST /api/theme/save` — theme.json へ書き戻し (既存は `.bak` 1 世代退避、警告つき継続)
- `GET /api/display-reference?type=VPWW55` — docs/display-reference.md の該当セクションを抽出して返す
- `POST /api/diff` — 保存済み theme (before) と編集中 override (after) を 1 mutex 保持で逐次 render して返す

## テスト

```bash
cd studio
npm test          # backend (node) + frontend (jsdom) の vitest projects
npm run typecheck # backend + frontend .ts の strict ゲート
```

## Phase 1 完了後の残項目

- 対応電文: VPWW55-61 / VPWS50 / VPWP50 / VPHW50-51 / VPBS50 / VPAW51 / VPZI50 / VPCJ51・VPZJ51・VPFJ51 (weather 系)
- Save 後、FlEq 本体が起動中の場合は REPL で `theme reload` が必要 (UI にもヒント表示)
- **compact プレビューは本番仕様どおり無着色** — theme/Night/NO_COLOR の効果は normal モードで確認する (diff も compact 中は常に同一になる)
- RoleEditor の blur-commit polish (入力途中 render / clear 時 snap-back) は未対応
- E2E (playwright) は見送り — 代わりに render parity テスト (Studio vs 本番 formatter の byte 一致) が回帰を防ぐ
