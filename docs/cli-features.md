# CLI 強化機能ガイド

Phase 0-7 で追加された CLI 強化機能の詳細な使い方を説明します。

## 電文統計 (stats)

REPL コマンド `stats` でセッション中の受信統計を表示します。

```
fleq> stats
```

ドメイン別・電文タイプ別の受信件数やフレームレベルの内訳を確認できます。統計はフィルタの影響を受けず、全受信電文が対象です。

## コンパクト表示 (--compact / mode compact)

端末幅に応じて自動的に情報を段階的に省略する幅適応型 1 行表示です。

- priority 0 のフィールド（severity、主要識別子）は常に表示
- 端末幅が狭くなるにつれ、優先度の低い情報から段階的に省略
- `mode compact` REPL コマンドで実行中に切替可能

```bash
fleq --mode compact
```

## 定期要約 (--summary-interval)

N 分ごとの受信統計を sparkline グラフ付きで表示します。

```bash
# 30 分ごとに要約表示
fleq --summary-interval 30
```

REPL から手動で直近の要約を表示することもできます。

```
fleq> summary
```

Config に保存する場合:

```bash
fleq config set summaryInterval 30
```

## ナイトモード (--night)

彩度・輝度を抑制した夜間向け表示モードです。critical レベルの危険色は視認性を維持するためそのまま表示されます。

```bash
fleq --night
```

REPL での切替:

```
fleq> night on
fleq> night off
```

Config に保存する場合:

```bash
fleq config set nightMode true
```

## EEW 副回線 (backup)

dmdata.jp の2本目のソケットを EEW 専用の副回線として起動し、EEW の受信冗長性を高めます。primary と backup の両方から受信した電文は `msg.id` で自動重複排除されます。

### 有効化方法

```bash
# Config に保存
fleq config set backup true

# REPL で動的に操作
fleq> backup on     # 副回線を起動
fleq> backup off    # 副回線を停止
fleq> backup        # 副回線の状態を表示
```

### 動作

- backup 用 config は `classifications` を EEW 区分 (`eew.forecast`, `eew.warning`) のみに制限
- `appName` は `{config.appName}-backup` (primary と区別)
- EEW 契約がない場合は起動しない (`"no_eew_contract"`)
- `config.backup: true` の場合、接続確立後に自動起動

### 制限

- dmdata.jp の同時接続上限は 2 本。副回線を起動すると枠を使い切る
- backup の接続/切断は REPL プロンプトの接続状態表示には影響しない
