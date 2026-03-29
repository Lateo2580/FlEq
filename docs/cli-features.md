# CLI 強化機能ガイド

Phase 0-7 で追加された CLI 強化機能の詳細な使い方を説明します。

## 電文統計 (stats)

REPL コマンド `stats` でセッション中の受信統計を表示します。

```
fleq> stats
```

ドメイン別・電文タイプ別の受信件数やフレームレベルの内訳を確認できます。統計はフィルタの影響を受けず、全受信電文が対象です。

## フィルタ (--filter)

条件式で電文を絞り込み、一致しない電文の**表示のみ**を抑制します。通知・統計には適用されません。

### 基本構文

```
path op value
```

- 複数の条件は `and` / `or` / `not` で結合できます
- 括弧 `()` でグループ化できます

### 演算子

| 演算子 | 説明 |
|--------|------|
| `=` | 等しい |
| `!=` | 等しくない |
| `<` | 小さい |
| `<=` | 以下 |
| `>` | 大きい |
| `>=` | 以上 |
| `~` | 正規表現にマッチ |
| `!~` | 正規表現にマッチしない |
| `in` | リストに含まれる |
| `contains` | 配列フィールドが値を含む |

### フィールド一覧

| フィールド | 説明 | 型 |
|------------|------|-----|
| `domain` | 電文ドメイン (`"earthquake"`, `"eew"`, `"volcano"`, `"tsunami"`) | string |
| `type` | head.type (`"VXSE53"` 等) | string |
| `frameLevel` | フレームレベル (`"critical"`, `"warning"`, `"normal"`, `"info"`, `"cancel"`) | string (順序比較可) |
| `maxInt` | 最大震度 (`"1"`, `"2"`, ..., `"5-"`, `"5+"`, `"6-"`, `"6+"`, `"7"`) | string (順序比較可) |
| `magnitude` | マグニチュード | number |
| `depth` | 震源の深さ (km) | number |
| `hypocenterName` | 震源名 | string |
| `volcanoName` | 火山名 | string |
| `alertLevel` | 噴火警戒レベル | number |
| `isWarning` | 警報かどうか | boolean |
| `isTest` | テスト電文かどうか | boolean |
| `isCancellation` | 取消電文かどうか | boolean |
| `forecastAreaNames` | 予報区名のリスト | string[] |
| `tsunamiKinds` | 津波予報の種類のリスト | string[] |

### 実運用例

```bash
# EEW 警報だけ表示
fleq --filter 'domain = "eew" and isWarning = true'

# 震度 5 弱以上の地震情報だけ表示
fleq --filter 'domain = "earthquake" and maxInt >= "5-"'

# 桜島または阿蘇の火山情報だけ表示
fleq --filter 'volcanoName ~ "桜島|阿蘇"'

# 大津波警報を含む電文だけ表示
fleq --filter 'tsunamiKinds contains "大津波警報"'
```

### REPL での動的変更

実行中にフィルタを変更できます。

```
fleq> filter set domain = "eew"
fleq> filter clear
fleq> filter test maxInt >= "4"
```

### 適用範囲

| 対象 | 適用 |
|------|------|
| 表示 | 適用（一致しない電文は非表示） |
| 通知 | 非適用（全電文が通知対象） |
| 統計 | 非適用（全電文がカウント対象） |

## テンプレート (--template)

ユーザー定義テンプレートでコンパクト表示の 1 行要約をカスタマイズします。

### 構文

```
{{変数}}                          — 変数を展開
{{変数|フィルタ:引数}}             — フィルタ適用
{{#if 条件}}...{{else}}...{{/if}} — 条件分岐
```

### 利用可能フィルタ

| フィルタ | 説明 | 例 |
|----------|------|----|
| `default` | 値が空のときのデフォルト値 | `{{magnitude\|default:"-"}}` |
| `truncate` | 指定文字数で切り詰め | `{{title\|truncate:20}}` |
| `pad` | 指定幅にパディング | `{{maxInt\|pad:3}}` |
| `join` | 配列を結合 | `{{areas\|join:", "}}` |
| `date` | 日時フォーマット | `{{time\|date:"HH:mm"}}` |
| `replace` | 文字列置換 | `{{text\|replace:"旧":"新"}}` |
| `upper` | 大文字変換 | `{{code\|upper}}` |
| `lower` | 小文字変換 | `{{code\|lower}}` |

### 例

```bash
# 震源名・マグニチュード・最大震度を表示
fleq --template '{{title}} {{hypocenterName|default:"-"}} M{{magnitude|default:"-"}} 最大{{maxInt|default:"-"}}'

# 条件分岐で警報時のみ強調
fleq --template '{{#if isWarning}}[警報] {{/if}}{{title}} {{hypocenterName|default:""}}'
```

## コンパクト表示 (--compact / mode compact)

端末幅に応じて自動的に情報を段階的に省略する幅適応型 1 行表示です。

- priority 0 のフィールド（severity、主要識別子）は常に表示
- 端末幅が狭くなるにつれ、優先度の低い情報から段階的に省略
- `mode compact` REPL コマンドで実行中に切替可能

```bash
fleq --mode compact
```

## Focus モード (--focus)

条件に一致しない電文を dim compact 表示に落とします。`--filter` との違いは以下の通りです。

| 機能 | 一致する電文 | 一致しない電文 |
|------|-------------|---------------|
| `--filter` | 通常表示 | **非表示** |
| `--focus` | 通常表示 | dim compact 表示（薄く 1 行で表示） |

```bash
# 震度 4 以上にフォーカス
fleq --focus 'maxInt >= "4"'

# EEW と津波にフォーカス
fleq --focus 'domain = "eew" or tsunamiKinds contains "津波警報"'
```

### REPL での動的変更

```
fleq> focus set maxInt >= "4"
fleq> focus clear
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

## ミニマップ (minimap)

地震情報・EEW・津波情報・長周期地震動観測で、フル表示のフレーム下に日本全国の震度/津波分布を ASCII グリッドで表示します。

### 表示条件

- ターミナル幅 80 文字以上
- 取消電文でないこと
- 地震情報: 最大震度 4 以上、または観測地域 4 箇所以上
- EEW: 予報区域が 1 つ以上
- 津波: 予報区域あり かつ critical / warning / normal レベル
- 長周期地震動: 最大震度 4 以上、または観測地域 4 箇所以上
- 火山・テキスト系・南海トラフには表示されません

ミニマップは compact モード時には表示されません (compact では `renderSummaryLine` による1行表示のみ)。

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

## フィルタの domain フィールド

`--filter` の `domain` フィールドに指定可能な値:

| 値 | 対象 |
|-----|------|
| `"earthquake"` | 地震情報 (VXSE51/52/53/61) |
| `"eew"` | 緊急地震速報 (VXSE43/44/45) |
| `"tsunami"` | 津波情報 (VTSE41/51/52) |
| `"volcano"` | 火山情報 (VFVO50-56/60, VFSVii, VZVO40) |
| `"seismicText"` | テキスト系 (VXSE56/60, VZSE40) |
| `"lgObservation"` | 長周期地震動 (VXSE62) |
| `"nankaiTrough"` | 南海トラフ (VYSE50/51/52/60) |
| `"raw"` | その他 |

```bash
# 火山情報だけ表示
fleq --filter 'domain = "volcano"'

# 火山と地震以外を非表示
fleq --filter 'domain = "volcano" or domain = "earthquake"'
```

## 順序比較の内部ランク

フィルタやフォーカスの条件式で `<`, `<=`, `>`, `>=` を使う際、以下の内部ランクで比較されます。

### frameLevel

| レベル | ランク |
|--------|--------|
| `cancel` | 0 |
| `info` | 1 |
| `normal` | 2 |
| `warning` | 3 |
| `critical` | 4 |

### 震度 (maxInt)

| 震度 | ランク |
|------|--------|
| `1` | 1 |
| `2` | 2 |
| `3` | 3 |
| `4` | 4 |
| `5-` | 5 |
| `5+` | 6 |
| `6-` | 7 |
| `6+` | 8 |
| `7` | 9 |
