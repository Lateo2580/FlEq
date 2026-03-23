# FlEq ランディングページ 実装プラン

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** FlEq の紹介ランディングページを `docs/site/` に構築し、GitHub Actions で GitHub Pages にデプロイする。

**Architecture:** 素の HTML/CSS/JS による単一ページ。CSS カスタムプロパティでライト/ダークテーマを管理し、`data-theme` 属性で切り替える。GitHub Actions ワークフローで `docs/site/` を GitHub Pages にデプロイする。

**Tech Stack:** HTML / CSS (custom properties) / Vanilla JS

**Spec:** `docs/superpowers/specs/2026-03-23-landing-page-design.md`

---

## ファイル構成

| ファイル | 責務 |
|----------|------|
| `docs/site/index.html` | ページ構造（全セクション） |
| `docs/site/style.css` | ライト/ダーク両対応のスタイル。レスポンシブ対応 |
| `docs/site/script.js` | ダークモード切替、npm コマンドコピー、スムーススクロール |
| `.github/workflows/pages.yml` | GitHub Pages デプロイワークフロー |

---

### Task 1: GitHub Actions ワークフロー

**Files:**
- Create: `.github/workflows/pages.yml`

- [ ] **Step 1: ワークフローファイルを作成**

```yaml
name: Deploy to GitHub Pages

on:
  push:
    branches: [main]
    paths: ['docs/site/**']
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - uses: actions/checkout@v4

      - name: Setup Pages
        uses: actions/configure-pages@v5

      - name: Upload artifact
        uses: actions/upload-pages-artifact@v3
        with:
          path: docs/site

      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v4
```

- [ ] **Step 2: コミット**

```bash
git add .github/workflows/pages.yml
git commit -m "ci: add GitHub Pages deploy workflow for landing page"
```

---

### Task 2: HTML 骨格 — ナビバー + ヒーロー

**Files:**
- Create: `docs/site/index.html`

- [ ] **Step 1: `docs/site/` ディレクトリを作成**

```bash
mkdir -p docs/site
```

- [ ] **Step 2: `index.html` にナビバーとヒーローセクションを作成**

```html
<!DOCTYPE html>
<html lang="ja" data-theme="light">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>FlEq — リアルタイム地震・津波・EEW情報モニター CLI</title>
  <meta name="description" content="dmdata.jp の API を利用して、地震・津波・緊急地震速報（EEW）・火山情報をリアルタイムに CLI で受信・表示するツール">
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <!-- ナビバー -->
  <nav class="navbar">
    <div class="nav-inner">
      <a href="#" class="nav-logo">FlEq</a>
      <div class="nav-links">
        <a href="#features">機能</a>
        <a href="#categories">対応区分</a>
        <a href="#install">インストール</a>
        <a href="https://github.com/Lateo2580/FlEq" target="_blank" rel="noopener">GitHub</a>
        <button class="theme-toggle" id="theme-toggle" aria-label="テーマ切替">
          <span class="icon-light">☀️</span>
          <span class="icon-dark">🌙</span>
        </button>
      </div>
    </div>
  </nav>

  <!-- ヒーロー -->
  <section class="hero">
    <h1 class="hero-title">FlEq</h1>
    <p class="hero-subtitle">地震・津波・EEW・火山情報をリアルタイムに CLI で受信</p>
    <div class="hero-install">
      <code id="install-cmd">npm install -g @sayue_ltr/fleq</code>
      <button class="copy-btn" data-copy="npm install -g @sayue_ltr/fleq" aria-label="コマンドをコピー">コピー</button>
    </div>
    <!-- NOTE: バージョンはリリース時に更新すること -->
    <p class="hero-meta">v1.50.1 · MIT License</p>
  </section>

  <script src="script.js"></script>
</body>
</html>
```

- [ ] **Step 3: ブラウザで開いて構造を確認**

```bash
# docs/site/index.html をブラウザで直接開いて、ナビバーとヒーローが表示されることを目視確認
```

- [ ] **Step 4: コミット**

```bash
git add docs/site/index.html
git commit -m "feat(site): add HTML skeleton with navbar and hero section"
```

---

### Task 3: CSS — ライト/ダークテーマ基盤 + ナビバー + ヒーロー

**Files:**
- Create: `docs/site/style.css`

- [ ] **Step 1: CSS カスタムプロパティとベーススタイルを作成**

`docs/site/style.css` に以下を記述:

- CSS リセット（`box-sizing: border-box`, `margin: 0`）
- `[data-theme="light"]` と `[data-theme="dark"]` でカスタムプロパティ定義:
  - `--bg`: ページ背景色
  - `--bg-secondary`: セクション交互背景色
  - `--text`: 本文テキスト色
  - `--text-secondary`: 補助テキスト色
  - `--border`: ボーダー色
  - `--card-bg`: カード背景色
  - `--code-bg`: コードブロック背景色
  - `--accent`: アクセントカラー
- `@media (prefers-color-scheme: dark)` で `[data-theme="light"]` のデフォルトをダークに
- body: `font-family` はシステムフォントスタック、`background: var(--bg)`, `color: var(--text)`
- `.navbar`: `position: sticky; top: 0; z-index: 100; background: var(--bg); border-bottom: 1px solid var(--border)`
- `.nav-inner`: `max-width: 960px; margin: 0 auto; display: flex; justify-content: space-between; align-items: center; padding: 0.75rem 1.5rem`
- `.nav-links`: `display: flex; gap: 1rem; align-items: center; font-size: 0.875rem`
- `.theme-toggle`: ボタンリセット + カーソルポインタ、テーマに応じてアイコン表示切替（`[data-theme="light"] .icon-dark { display: none }` 等）
- `.hero`: `text-align: center; padding: 4rem 1.5rem 3rem`
- `.hero-title`: `font-size: 3rem; font-weight: 800; letter-spacing: -0.5px`
- `.hero-subtitle`: `color: var(--text-secondary); margin-top: 0.5rem`
- `.hero-install`: コードとコピーボタンを横並び（`display: inline-flex`）、`background: var(--code-bg); border-radius: 0.5rem; padding: 0.5rem 1rem`
- `.copy-btn`: 小さめのボタン、ホバーで色変化
- `.hero-meta`: `font-size: 0.75rem; color: var(--text-secondary); margin-top: 0.5rem`

- [ ] **Step 2: ブラウザで確認**

ライトモードとダークモード（OS設定切替 or DevTools）で見た目を確認。

- [ ] **Step 3: コミット**

```bash
git add docs/site/style.css
git commit -m "feat(site): add CSS with light/dark theme and navbar/hero styles"
```

---

### Task 4: JS — ダークモード切替 + コピーボタン

**Files:**
- Create: `docs/site/script.js`

- [ ] **Step 1: `script.js` を作成**

```javascript
// テーマ切替
(function () {
  const toggle = document.getElementById('theme-toggle');
  const html = document.documentElement;

  // localStorage > OS preference > light
  function getPreferred() {
    const stored = localStorage.getItem('theme');
    if (stored) return stored;
    return window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  }

  function apply(theme) {
    html.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }

  apply(getPreferred());

  toggle.addEventListener('click', function () {
    var current = html.getAttribute('data-theme');
    apply(current === 'dark' ? 'light' : 'dark');
  });
})();

// コピーボタン
document.querySelectorAll('.copy-btn').forEach(function (btn) {
  btn.addEventListener('click', function () {
    var text = btn.getAttribute('data-copy');
    navigator.clipboard.writeText(text).then(function () {
      var original = btn.textContent;
      btn.textContent = 'コピー済み';
      setTimeout(function () {
        btn.textContent = original;
      }, 1500);
    });
  });
});

// スムーススクロール
document.querySelectorAll('a[href^="#"]').forEach(function (a) {
  a.addEventListener('click', function (e) {
    var target = document.querySelector(a.getAttribute('href'));
    if (target) {
      e.preventDefault();
      target.scrollIntoView({ behavior: 'smooth' });
    }
  });
});
```

- [ ] **Step 2: ブラウザで動作確認**

- テーマトグルボタンでライト/ダーク切替
- ページリロード後もテーマが保持される
- コピーボタンでクリップボードにコピーされる

- [ ] **Step 3: コミット**

```bash
git add docs/site/script.js
git commit -m "feat(site): add dark mode toggle, copy button, smooth scroll"
```

---

### Task 5: 機能紹介セクション (FEATURES)

**Files:**
- Modify: `docs/site/index.html` — ヒーローの下に追加
- Modify: `docs/site/style.css` — `.features` スタイル追加

- [ ] **Step 1: `index.html` のヒーロー `</section>` の後に機能セクションを追加**

```html
<!-- 機能紹介 -->
<section class="section" id="features">
  <h2 class="section-title">主な機能</h2>
  <p class="section-label">FEATURES</p>
  <div class="feature-grid">
    <div class="feature-card">
      <div class="feature-icon">⚡</div>
      <h3>リアルタイム受信</h3>
      <p>WebSocket による自動再接続・複線接続対応</p>
    </div>
    <div class="feature-card">
      <div class="feature-icon">🎨</div>
      <h3>色分け表示</h3>
      <p>震度・レベルに応じた配色（CUD 準拠テーマ）</p>
    </div>
    <div class="feature-card">
      <div class="feature-icon">🔔</div>
      <h3>デスクトップ通知</h3>
      <p>カテゴリ別 ON/OFF・通知音</p>
    </div>
    <div class="feature-card">
      <div class="feature-icon">📡</div>
      <h3>EEW 同時追跡</h3>
      <p>差分表記・ログ記録</p>
    </div>
    <div class="feature-card">
      <div class="feature-icon">🖥️</div>
      <h3>REPL 操作</h3>
      <p>実行中に設定変更・状態確認</p>
    </div>
    <div class="feature-card">
      <div class="feature-icon">🍓</div>
      <h3>低メモリ対応</h3>
      <p>Raspberry Pi 等の ARM デバイスでも動作</p>
    </div>
  </div>
</section>
```

- [ ] **Step 2: `style.css` に機能セクションのスタイルを追加**

- `.section`: `max-width: 960px; margin: 0 auto; padding: 3rem 1.5rem; text-align: center`
- `.section-title`: `font-size: 1.5rem; font-weight: 700`
- `.section-label`: `font-size: 0.75rem; color: var(--text-secondary); letter-spacing: 0.1em; margin-top: 0.25rem`
- `.feature-grid`: `display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem; margin-top: 2rem`
- `.feature-card`: `background: var(--card-bg); border: 1px solid var(--border); border-radius: 0.5rem; padding: 1.5rem; text-align: center`
- `.feature-icon`: `font-size: 1.5rem; margin-bottom: 0.5rem`
- `.feature-card h3`: `font-size: 0.9rem; font-weight: 600`
- `.feature-card p`: `font-size: 0.8rem; color: var(--text-secondary); margin-top: 0.25rem`
- レスポンシブ: `@media (max-width: 768px)` → 2列、`@media (max-width: 480px)` → 1列

- [ ] **Step 3: ブラウザで確認**

3列表示とレスポンシブ（ブラウザ幅を狭めて2列→1列に変化）を確認。

- [ ] **Step 4: コミット**

```bash
git add docs/site/index.html docs/site/style.css
git commit -m "feat(site): add features section with responsive grid"
```

---

### Task 6: スクリーンショットセクション (SCREENSHOT)

**Files:**
- Modify: `docs/site/index.html` — 機能セクションの下に追加
- Modify: `docs/site/style.css` — `.screenshot` スタイル追加

- [ ] **Step 1: `index.html` に追加**

```html
<!-- スクリーンショット -->
<section class="section-alt" id="screenshot">
  <div class="section-inner">
    <h2 class="section-title">出力例</h2>
    <p class="section-label">SCREENSHOT</p>
    <div class="terminal">
      <div class="terminal-header">
        <span class="terminal-dot red"></span>
        <span class="terminal-dot yellow"></span>
        <span class="terminal-dot green"></span>
        <span class="terminal-title">fleq</span>
      </div>
      <div class="terminal-body">
        <div class="term-line dim">$ fleq</div>
        <div class="term-line dim">FlEq v1.50.1 — Ctrl+C to exit</div>
        <div class="term-line">&nbsp;</div>
        <div class="term-line accent">━━━ 震源・震度に関する情報 (VXSE53) ━━━</div>
        <div class="term-line">発生時刻: 2026年03月23日 14時30分頃</div>
        <div class="term-line">震源地:   熊本県熊本地方</div>
        <div class="term-line">深さ:     10km</div>
        <div class="term-line">マグニチュード: M4.2</div>
        <div class="term-line warn">最大震度:  4</div>
        <div class="term-line">&nbsp;</div>
        <div class="term-line dim">[ 各地の震度 ]</div>
        <div class="term-line warn">震度4: 熊本市中央区, 益城町</div>
        <div class="term-line">震度3: 熊本市東区, 宇土市, 嘉島町</div>
        <div class="term-line dim">震度2: 熊本市西区, 合志市, 菊陽町</div>
      </div>
    </div>
  </div>
</section>
```

- [ ] **Step 2: `style.css` にスタイルを追加**

- `.section-alt`: `background: var(--bg-secondary)` で背景色を変えてセクション区切り
- `.section-inner`: `max-width: 960px; margin: 0 auto; padding: 3rem 1.5rem; text-align: center`
- `.terminal`: `max-width: 600px; margin: 2rem auto 0; border-radius: 0.5rem; overflow: hidden; text-align: left`
- `.terminal-header`: ダークグレー背景に macOS 風の3つのドット + タイトル
- `.terminal-body`: `background: #1e1e1e; padding: 1rem 1.5rem; font-family: monospace; font-size: 0.8rem; color: #d4d4d4; line-height: 1.6`
- `.term-line.dim`: `color: #666`
- `.term-line.accent`: `color: #6bc5f7`（セクション区切り線）
- `.term-line.warn`: `color: #ffd43b`（震度強調）

- [ ] **Step 3: ブラウザで確認**

ターミナル風フレームが表示され、ライト/ダーク両モードで違和感がないか確認。

- [ ] **Step 4: コミット**

```bash
git add docs/site/index.html docs/site/style.css
git commit -m "feat(site): add screenshot section with terminal mockup"
```

---

### Task 7: 対応区分セクション (SUPPORTED CATEGORIES)

**Files:**
- Modify: `docs/site/index.html` — スクリーンショットの下に追加
- Modify: `docs/site/style.css` — `.category-grid` スタイル追加

- [ ] **Step 1: `index.html` に追加**

```html
<!-- 対応区分 -->
<section class="section" id="categories">
  <h2 class="section-title">対応区分</h2>
  <p class="section-label">SUPPORTED CATEGORIES</p>
  <div class="category-grid">
    <div class="category-card">
      <div class="category-icon">🌍</div>
      <h3>地震・津波関連</h3>
      <p class="category-api">telegram.earthquake</p>
      <ul>
        <li>震度速報</li>
        <li>震源に関する情報</li>
        <li>震源・震度に関する情報</li>
        <li>長周期地震動に関する観測情報</li>
        <li>津波警報・注意報</li>
      </ul>
    </div>
    <div class="category-card">
      <div class="category-icon">⚠️</div>
      <h3>緊急地震速報</h3>
      <p class="category-api">eew.forecast / eew.warning</p>
      <ul>
        <li>EEW 予報</li>
        <li>EEW 警報</li>
        <li>同時追跡・差分表記</li>
        <li>ログ記録</li>
      </ul>
    </div>
    <div class="category-card">
      <div class="category-icon">🌋</div>
      <h3>火山関連</h3>
      <p class="category-api">telegram.volcano</p>
      <ul>
        <li>噴火警報・予報</li>
        <li>噴火速報</li>
        <li>降灰予報</li>
        <li>火山の状況に関する解説情報</li>
      </ul>
    </div>
    <div class="category-card">
      <div class="category-icon">🌊</div>
      <h3>南海トラフ</h3>
      <p class="category-api">telegram.earthquake (VYSE*)</p>
      <ul>
        <li>南海トラフ地震臨時情報</li>
        <li>南海トラフ地震関連解説情報</li>
      </ul>
    </div>
  </div>
</section>
```

- [ ] **Step 2: `style.css` にスタイルを追加**

- `.category-grid`: `display: grid; grid-template-columns: repeat(2, 1fr); gap: 1rem; margin-top: 2rem; text-align: left`
- `.category-card`: `background: var(--card-bg); border: 1px solid var(--border); border-radius: 0.5rem; padding: 1.5rem`
- `.category-icon`: `font-size: 1.5rem; margin-bottom: 0.5rem`
- `.category-card h3`: `font-size: 1rem; font-weight: 600`
- `.category-api`: `font-family: monospace; font-size: 0.75rem; color: var(--text-secondary); margin-top: 0.25rem`
- `.category-card ul`: `margin-top: 0.75rem; padding-left: 1.25rem; font-size: 0.85rem; line-height: 1.8; color: var(--text-secondary)`
- レスポンシブ: `@media (max-width: 600px)` → 1列

- [ ] **Step 3: ブラウザで確認**

4カードの2×2グリッド表示と、モバイル幅での1列を確認。

- [ ] **Step 4: コミット**

```bash
git add docs/site/index.html docs/site/style.css
git commit -m "feat(site): add supported categories section"
```

---

### Task 8: インストール手順セクション (GETTING STARTED)

**Files:**
- Modify: `docs/site/index.html` — 対応区分の下に追加
- Modify: `docs/site/style.css` — `.install` スタイル追加

- [ ] **Step 1: `index.html` に追加**

```html
<!-- インストール -->
<section class="section-alt" id="install">
  <div class="section-inner">
    <h2 class="section-title">インストール</h2>
    <p class="section-label">GETTING STARTED</p>

    <div class="install-steps">
      <div class="install-step">
        <div class="step-number">1</div>
        <div class="step-content">
          <h3>インストール</h3>
          <div class="step-code">
            <code>npm install -g @sayue_ltr/fleq</code>
            <button class="copy-btn" data-copy="npm install -g @sayue_ltr/fleq" aria-label="コマンドをコピー">コピー</button>
          </div>
          <p class="step-alt">または単発で実行:</p>
          <div class="step-code">
            <code>npx @sayue_ltr/fleq --help</code>
            <button class="copy-btn" data-copy="npx @sayue_ltr/fleq --help" aria-label="コマンドをコピー">コピー</button>
          </div>
        </div>
      </div>

      <div class="install-step">
        <div class="step-number">2</div>
        <div class="step-content">
          <h3>初期設定</h3>
          <p>対話形式で API キーや受信設定をまとめて行えます。</p>
          <div class="step-code">
            <code>fleq init</code>
            <button class="copy-btn" data-copy="fleq init" aria-label="コマンドをコピー">コピー</button>
          </div>
        </div>
      </div>

      <div class="install-step">
        <div class="step-number">3</div>
        <div class="step-content">
          <h3>起動</h3>
          <div class="step-code">
            <code>fleq</code>
            <button class="copy-btn" data-copy="fleq" aria-label="コマンドをコピー">コピー</button>
          </div>
        </div>
      </div>
    </div>

    <div class="install-notes">
      <h3>前提条件</h3>
      <ul>
        <li><strong>Node.js 18 以上</strong>が必要です</li>
        <li><a href="https://dmdata.jp/" target="_blank" rel="noopener">dmdata.jp</a> のアカウントと API キーが必要です</li>
        <li>API キーには <code>socket.start</code> 権限と受信区分の <code>telegram.get.*</code> 権限を付与してください</li>
        <li>受信する情報の種類によっては dmdata.jp の有料契約が必要です</li>
      </ul>
      <h3>対応 OS</h3>
      <table class="os-table">
        <thead><tr><th>OS</th><th>備考</th></tr></thead>
        <tbody>
          <tr><td>macOS 10.13+</td><td>メイン開発・テスト環境</td></tr>
          <tr><td>Linux (x64 / ARM)</td><td>Raspberry Pi 等の ARM デバイスでも動作</td></tr>
          <tr><td>Windows 10+</td><td>ConPTY 対応のターミナルを推奨</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</section>
```

- [ ] **Step 2: `style.css` にスタイルを追加**

- `.install-steps`: `max-width: 600px; margin: 2rem auto 0; text-align: left`
- `.install-step`: `display: flex; gap: 1rem; margin-bottom: 1.5rem`
- `.step-number`: `width: 2rem; height: 2rem; border-radius: 50%; background: var(--accent); color: white; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 0.875rem; flex-shrink: 0`
- `.step-content h3`: `font-size: 1rem; font-weight: 600`
- `.step-code`: `display: inline-flex; align-items: center; gap: 0.5rem; background: var(--code-bg); border-radius: 0.375rem; padding: 0.375rem 0.75rem; margin-top: 0.5rem; font-family: monospace; font-size: 0.85rem`
- `.step-alt`: `font-size: 0.8rem; color: var(--text-secondary); margin-top: 0.5rem`
- `.install-notes`: `max-width: 600px; margin: 2.5rem auto 0; text-align: left; padding-top: 1.5rem; border-top: 1px solid var(--border)`
- `.install-notes h3`: `font-size: 0.9rem; font-weight: 600; margin-bottom: 0.5rem; margin-top: 1.5rem` (最初の h3 は `margin-top: 0`)
- `.install-notes ul`: `padding-left: 1.25rem; font-size: 0.85rem; line-height: 1.8; color: var(--text-secondary)`
- `.os-table`: `width: 100%; border-collapse: collapse; font-size: 0.85rem; margin-top: 0.5rem`
- `.os-table th, .os-table td`: `text-align: left; padding: 0.5rem; border-bottom: 1px solid var(--border)`
- `.os-table th`: `font-weight: 600; font-size: 0.8rem`

- [ ] **Step 3: ブラウザで確認**

ステップ表示、コピーボタン、前提条件テーブルの表示を確認。

- [ ] **Step 4: コミット**

```bash
git add docs/site/index.html docs/site/style.css
git commit -m "feat(site): add install section with steps, prerequisites, and OS table"
```

---

### Task 9: フッター

**Files:**
- Modify: `docs/site/index.html` — インストールの下に追加
- Modify: `docs/site/style.css` — `.footer` スタイル追加

- [ ] **Step 1: `index.html` の `</body>` 前（`<script>` タグの前）にフッターを追加**

```html
<!-- フッター -->
<footer class="footer">
  <div class="footer-inner">
    <div class="footer-links">
      <a href="https://github.com/Lateo2580/FlEq" target="_blank" rel="noopener">GitHub</a>
      <a href="https://www.npmjs.com/package/@sayue_ltr/fleq" target="_blank" rel="noopener">npm</a>
      <a href="https://dmdata.jp/" target="_blank" rel="noopener">dmdata.jp</a>
    </div>
    <p class="footer-license">FlEq · MIT License</p>
    <p class="footer-attribution">地震情報・津波情報等は気象庁が発表したものを dmdata.jp 経由で受信しています</p>
  </div>
</footer>
```

- [ ] **Step 2: `style.css` にスタイルを追加**

- `.footer`: `background: var(--bg-secondary); border-top: 1px solid var(--border); padding: 2rem 1.5rem; text-align: center`
- `.footer-inner`: `max-width: 960px; margin: 0 auto`
- `.footer-links`: `display: flex; justify-content: center; gap: 1.5rem; font-size: 0.85rem`
- `.footer-links a`: `color: var(--text-secondary); text-decoration: none` + hover で underline
- `.footer-license`: `font-size: 0.8rem; color: var(--text-secondary); margin-top: 1rem`
- `.footer-attribution`: `font-size: 0.75rem; color: var(--text-secondary); margin-top: 0.5rem`

- [ ] **Step 3: ブラウザで全体を通してスクロールして確認**

全セクションが正しく表示され、ナビリンクがスムーススクロールで各セクションに飛ぶことを確認。

- [ ] **Step 4: コミット**

```bash
git add docs/site/index.html docs/site/style.css
git commit -m "feat(site): add footer with links and attribution"
```

---

### Task 10: レスポンシブ調整 + 仕上げ

**Files:**
- Modify: `docs/site/style.css` — レスポンシブブレークポイント最終調整

- [ ] **Step 1: レスポンシブのブレークポイントを整理**

既存のメディアクエリを確認し、以下が揃っていることを検証:

- `@media (max-width: 768px)`: 機能カード 3列→2列、ナビリンクのフォントサイズ縮小
- `@media (max-width: 600px)`: 対応区分 2列→1列
- `@media (max-width: 480px)`: 機能カード 2列→1列、ヒーロータイトルのフォントサイズ縮小

不足があれば追加。

- [ ] **Step 2: ブラウザの DevTools でレスポンシブを確認**

以下の幅で表示を確認:
- 1024px（デスクトップ）
- 768px（タブレット）
- 375px（モバイル）

- [ ] **Step 3: コミット**

```bash
git add docs/site/style.css
git commit -m "feat(site): finalize responsive breakpoints"
```

---

### Task 11: .gitignore に .superpowers を追加

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: `.gitignore` に `.superpowers/` を追加**

ブレインストームセッションのファイルがリポジトリに入らないように。

```bash
echo ".superpowers/" >> .gitignore
```

- [ ] **Step 2: コミット**

```bash
git add .gitignore
git commit -m "chore: add .superpowers to gitignore"
```
