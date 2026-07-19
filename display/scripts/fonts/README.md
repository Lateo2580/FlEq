# 可変フォント取得・サブセット手順

`display/frontend/src/assets/fonts/` に配置している可変フォント (woff2) の再生成手順。
一度きりのホスト側作業で、成果物をコミットすれば `npm run build` には不要。

## 取得元・バージョン (2026-07-08 時点)

- **JetBrains Mono Variable**: `https://github.com/JetBrains/JetBrainsMono/releases/latest/download/JetBrainsMono-2.304.zip` (v2.304)
  - ライセンス: `https://raw.githubusercontent.com/JetBrains/JetBrainsMono/master/OFL.txt` → `display/frontend/src/assets/fonts/OFL-JetBrainsMono.txt`
- **Noto Sans JP Variable**: `https://raw.githubusercontent.com/google/fonts/main/ofl/notosansjp/NotoSansJP%5Bwght%5D.ttf` (google/fonts main ブランチ時点)
  - ライセンス: `https://raw.githubusercontent.com/google/fonts/main/ofl/notosansjp/OFL.txt` → `display/frontend/src/assets/fonts/OFL-NotoSansJP.txt`

両フォントとも SIL Open Font License 1.1 (OFL)。ライセンス全文は上記 `OFL-*.txt` に同梱。

## 前提ツール

```bash
pip install fonttools brotli
```

## 手順 (Git Bash)

```bash
mkdir -p display/scripts/fonts && cd display/scripts/fonts

# 1. JetBrains Mono Variable 取得・展開
curl -sL -o jbmono.zip https://github.com/JetBrains/JetBrainsMono/releases/latest/download/JetBrainsMono-2.304.zip
# 角括弧ファイル名は unzip のワイルドカード誤爆を避けるため -j (パス無視) + glob で指定
unzip -j -o jbmono.zip "fonts/variable/JetBrainsMono*wght*.ttf" -x "*Italic*" -d .
rm -f "JetBrainsMono-Italic[wght].ttf"   # Italic は不要なので削除

# 2. Noto Sans JP Variable 取得
curl -sL -o NotoSansJP-var.ttf "https://raw.githubusercontent.com/google/fonts/main/ofl/notosansjp/NotoSansJP%5Bwght%5D.ttf"

# 3. Noto Sans JP サブセット化 (JIS X 0208 level1+2 + かな + ASCII + 記号、wght 可変軸保持)
python -m fontTools.subset "NotoSansJP-var.ttf" \
  --output-file="../../frontend/src/assets/fonts/NotoSansJP-subset-var.woff2" \
  --flavor=woff2 \
  --layout-features='*' \
  --unicodes="U+0020-007E,U+00A0-00FF,U+2000-206F,U+2190-21FF,U+2460-24FF,U+2500-257F,U+25A0-25FF,U+3000-303F,U+3040-309F,U+30A0-30FF,U+3190-319F,U+31F0-31FF,U+3220-325F,U+3280-32FF,U+3300-33FF,U+3400-4DBF,U+4E00-9FFF,U+F900-FAFF,U+FF00-FFEF" \
  --name-IDs='*' --no-hinting

# 4. JetBrains Mono woff2 化 (サブセット不要、欧文のみ軽量)
python -m fontTools.subset "JetBrainsMono[wght].ttf" \
  --output-file="../../frontend/src/assets/fonts/JetBrainsMono-var.woff2" \
  --flavor=woff2 --layout-features='*' \
  --unicodes="U+0020-007E,U+00A0-00FF,U+2000-206F" --name-IDs='*' --no-hinting
```

`pyftsubset` コマンドが PATH にあれば `python -m fontTools.subset` の代わりに直接呼んでもよい (同一実装)。

## 出力サイズ (2026-07-08 実測)

| ファイル | サイズ | 目安 |
|---|---|---|
| `NotoSansJP-subset-var.woff2` | 約 3.9MB | 1–4MB |
| `JetBrainsMono-var.woff2` | 約 45KB | 100KB 未満 |

両ファイルとも `fvar` テーブルに `wght` 軸が保持されていることを確認済み (`--instance` を渡していないため)。

極端に小さい (kanji 欠落) / 大きい (未サブセット) 場合は `--unicodes` の範囲を見直すこと。
特に地名の kanji 欠落を避けるため JIS X 0208 の主要ブロック (`U+4E00-9FFF` 等) は削らない。

## 後始末

`jbmono.zip`, `NotoSansJP-var.ttf`, `JetBrainsMono[wght].ttf` 等の中間生成物はコミット対象外
(このディレクトリの本体は README のみ)。
