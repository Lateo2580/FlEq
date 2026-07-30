# 震度マップ（地図レイヤー a）仕様

> 状態: **Reviewed Draft（Codex 最終レビュー前）**  
> 更新日: 2026-07-30  
> 対象: FlEq 常設情報ディスプレイ  
> 実装対象: レイヤー a「震度市町村塗り」の初期段階

## 1. 目的・スコープ

### 1.1 目的

FlEq の情報ディスプレイに地図基盤を導入し、地震情報電文の震度分布を地域コードで境界データへ結合して表示する。

地図基盤全体は次のレイヤー構成を想定する。

- a: 震度分布
- b: 気象警報
- c: 台風
- d: 指定河川洪水予報
- e: 津波予報区

本仕様で実装するのはレイヤー a のみとする。ただし、静的アセットの配置、engine→display protocol、地図コンポーネントの責務は、後続レイヤーを追加できる構造にする。

### 1.2 初期実装の表示範囲

初期実装では、気象庁 `AreaForecastLocalE` の細分区域境界を使った全国図のみを frontend に表示する。

`AreaInformationCity_quake` の市町村等境界については、変換済みアセットの生成と実電文 fixture とのコード照合までを Phase 1 に含める。ただし初期 frontend はこのアセットを fetch、import、prefetch しない。市町村等による震央周辺拡大図は Phase 5 とする。

### 1.3 表示条件

最大震度が震度3以上の地震を地図表示対象とする。

- 震度1～2: 地図表示面を自動表示しない。
- 震度3～4: 専用の非緊急表示面 `quakeMap` を表示する。
- 震度5弱以上: 既存の緊急画面と `QuakePanel` の経路を維持し、緊急主パネル内に地図を内包する。

画面モードは次の三値とする。

```ts
type ScreenMode = "standby" | "quakeMap" | "emergency";
```

優先順位は常に次のとおりとする。

```text
emergency > quakeMap > standby
```

### 1.4 地図と文字情報

地図は文字一覧の代替ではない。緊急主パネルおよび専用 `quakeMap` 表示面では、震度地図と地域別震度一覧を同時に表示する。

既存 `QuakePanel` の地域別震度一覧とページング機構は維持する。地図追加を理由に一覧を削除したり、スクロール表示へ変更したりしない。

### 1.5 結合条件

境界データと電文の結合キーには地域コードだけを使用する。

- 地名文字列照合は禁止する。
- コードを数値へ変換しない。
- 先頭ゼロを保持した文字列として扱う。
- 不明コードを地名から推測して補完しない。
- コード不一致は欠落として観測可能にし、誤った地域を塗らない。

### 1.6 非スコープ

初期実装では次を扱わない。

- レイヤー b～e の実装
- 指定河川洪水予報における実測水位の地図表示
- 市町村等による震央周辺拡大図の runtime 表示
- パン、ユーザー操作によるズーム、回転
- WebGL
- runtime での GIS 投影、簡略化、inset 移動
- 地名文字列によるコード欠落の補完
- 外部地図 API、地図タイルサーバー、CDN への依存
- Raspberry Pi 実機での SVG 描画性能の合否確定

Raspberry Pi 実測は Phase 6 の検証項目として残す。

## 2. 設計原則と現行実装上の前提

### 2.1 静的形状と動的値を分離する

境界形状は build 時に生成した静的 JSON として frontend に同梱する。震度コードと震度値だけを engine→display protocol で送る。

GIS 座標や SVG path を SSE に載せてはならない。

```text
気象庁 Shapefile
    ↓ build-time 変換
code → SVG path の静的 JSON

VXSE 電文
    ↓ runtime
code → 震度 rank の snapshot データ
```

frontend は両者をコードで結合し、既存の SVG `<path>` の `fill` だけを更新する。

### 2.2 parser の現状

現在の VXSE パーサは `Pref → Area` を走査して地域名と最大震度を抽出しているが、`Area.Code` と配下の `City` を保存していない（`src/dmdata/telegram-parser.ts:183-216`）。

`ParsedEarthquakeInfo.intensity.areas` にも地域名、震度、長周期地震動階級しか定義されていない（`src/types.ts:649-657`）。

Presentation への変換でも `areaItems` には地域名と最大震度しか渡されていない（`src/engine/presentation/events/from-earthquake.ts:22-27`）。一方、`PresentationAreaItem` 自体には既に任意の `code` が存在する（`src/engine/presentation/types.ts:259-265`）。

したがって、レイヤー a の parser 改修では、新しい独立パーサを作らず、既存 VXSE 経路でコードと市町村階層を失わないようにする。

### 2.3 緊急画面の現状

震度5弱以上は `largeQuake` に投影され、`QuakePanel` の入力になる（`src/engine/display/project-event.ts:98-118`）。

frontend の現行 `ScreenMode` は `standby | emergency` の二値であり、緊急パネルが1件以上あれば `emergency` になる（`display/frontend/src/lib/derive.ts:9,79-105`）。`App.svelte` も待機画面と緊急画面の二面を切り替えている（`display/frontend/src/App.svelte:170-201`）。

震度3～4は `largeQuake` に入らないため、専用 `quakeMap` モードを追加する。

### 2.4 protocol の現状

`DisplayStateSnapshotV1` は engine と frontend に同じ型定義を持ち、snapshot/state SSE の権威値として使用されている（`src/engine/display/protocol.ts:494-531`）。

地図値は一時イベントではなく `DisplayStateSnapshotV1.mapLayers` に置く。これにより、途中接続・再接続した frontend も現在表示中の地図状態を snapshot から復元できる。

既存制限は次のとおりである。

- event: 32 KiB
- snapshot: 256 KiB  
  （`src/engine/display/constants.ts:8-9`）

地図値を public event DTO に複製してはならない。

## 3. 境界データの準備

### 3.1 入力データ

気象庁「予報区等 GIS データ」の次の Shapefile を使用する。

| 用途 | データ | 初期 frontend |
|---|---|---|
| 全国図 | `AreaForecastLocalE` | 使用する |
| 拡大図 | `AreaInformationCity_quake` | Phase 1 で生成・検証するが fetch しない |

座標系は JGD2011 とする。

区域コード属性は電文 `Area.Code` と同体系のものを使用する。変換スクリプトの設定には、採用した Shapefile 名、コード属性名、取得元URL、取得日、入力ファイルのハッシュを記録する。

### 3.2 リポジトリ内の配置

次の構成を基本とする。

```text
display/
  maps/
    quake/
      source.lock.json
      insets.v1.json
  scripts/
    maps/
      fetch-jma-gis.mjs
      build-quake-maps.mjs
      verify-quake-map-codes.mjs
  frontend/
    public/
      maps/
        quake/
          area-forecast-local-e.v1.json
          area-information-city-quake.v1.json
          manifest.v1.json
          NOTICE.txt
docs/
  licenses/
    jma-forecast-area-gis.md
```

取得した ZIP、展開済み Shapefile、変換途中の GeoJSON はキャッシュ領域に置き、リポジトリへコミットしない。コミット対象は変換スクリプト、設定、ライセンス表記、manifest、変換済み JSON とする。

### 3.3 変換パイプライン

変換処理は再現可能なスクリプトとして実装し、手作業の GIS 編集を正本にしない。

基本パイプラインは次のとおりとする。

```text
Shapefile
  → mapshaper -simplify 0.1% -clean -filter-fields <code>
  → 簡略化 GeoJSON
  → d3-geo で投影
  → inset の移動・縮尺を適用
  → code ごとの SVG path に集約
  → JSON と manifest を決定的順序で出力
```

`mapshaper` と `d3-geo` は `display/package.json` の固定された開発依存として管理し、実装時には `display/package-lock.json` も同期する。実行時に任意の最新版を取得する方式にはしない。

出力はコード昇順とし、同じ入力と設定から byte-identical な JSON が生成されることを目標とする。

### 3.4 出力スキーマ

変換済みアセットは概ね次の構造とする。

```ts
interface ProjectedMapAssetV1 {
  schemaVersion: 1;
  dataset: "AreaForecastLocalE" | "AreaInformationCity_quake";
  codeType: string;
  viewBox: [number, number, number, number];
  pathsByCode: Record<string, string>;
  insets: Array<{
    id: string;
    label: string;
    frame: [number, number, number, number];
    labelPosition: [number, number];
  }>;
}
```

`pathsByCode` の値は投影済み SVG path の `d` 文字列とする。MultiPolygon は同一コードの複数 subpath を一つの `d` にまとめる。

runtime は座標変換、投影、inset 移動を行わない。

### 3.5 inset

沖縄、先島諸島、小笠原諸島など、本土と同一縮尺のままでは視認性または余白効率が悪い地域は inset として別枠配置する。

- 対象地域の選択は明示的なコード集合または地理範囲設定による。
- 地名文字列照合で対象 feature を選ばない。
- 投影、縮尺、移動は変換スクリプトで確定する。
- runtime は生成済み path をそのまま描画する。
- inset の枠線とラベル位置もアセットに記録する。
- 枠線は意味色を持たない neutral/hairline 色とする。
- ラベルは短い固定表記とし、震度色と競合しない muted 色を使う。

### 3.6 コード検証

生成時に次を検証し、違反時は失敗させる。

- コードが空でない。
- コードが文字列として保存されている。
- 先頭ゼロが失われていない。
- 同一コードの重複 feature が意図どおり一つの path に統合される。
- path が空でない。
- 数値に `NaN`、`Infinity` がない。
- inset 対象が本図と重複描画されていない。
- representative VXSE fixture の `Area.Code` が `AreaForecastLocalE` に存在する。
- representative VXSE fixture の `City.Code` が `AreaInformationCity_quake` に存在する。

既知の廃止・統合コードなどを例外扱いする場合は、コード、理由、確認日を allowlist に明記する。地名による暗黙の救済は行わない。

### 3.7 ライセンスと出典

政府標準利用規約に基づく出典表記と、加工済みデータである旨を次の二か所へ記載する。

- `docs/licenses/jma-forecast-area-gis.md`
- 配布物に含まれる `display/frontend/public/maps/quake/NOTICE.txt`

地図コンポーネントにも短い出典表記を表示する。

例:

```text
出典: 気象庁「予報区等 GIS データ」を加工して作成
```

文書には取得元URL、取得日、対象データ名、実施した簡略化・投影・inset 加工を記録する。

### 3.8 更新手順

境界データ更新時は次の順で行う。

1. `source.lock.json` の取得元と対象版を更新する。
2. 取得スクリプトで入力を repo 内キャッシュへ取得する。
3. 入力ハッシュを確認・記録する。
4. 全国図と市町村等の両アセットを再生成する。
5. コード照合テストと決定性テストを実行する。
6. feature 数、コード数、ファイルサイズ、inset 設定の差分を確認する。
7. manifest とライセンス文書を更新する。
8. 変換済み JSON と関連ファイルだけをコミットする。

## 4. VXSE parser と Presentation

### 4.1 parser の型

`ParsedEarthquakeInfo.intensity.areas` を次の情報を保持できる形へ拡張する。

```ts
interface ParsedQuakeArea {
  name: string;
  code: string;
  intensity: string;
  lgIntensity?: string;
  cities: ParsedQuakeCity[];
}

interface ParsedQuakeCity {
  name: string;
  code: string;
  intensity: string;
  lgIntensity?: string;
}
```

既存の地域名・震度利用箇所を壊さないよう、`areas` 自体は細分区域の配列として維持する。`cities` は各 `Area` の配下として追加する。

### 4.2 XML 走査

VXSE の次の階層を走査する。

```text
Intensity
  └ Observation
      └ Pref
          └ Area
              ├ Name
              ├ Code
              ├ MaxInt
              ├ MaxLgInt
              └ City
                  ├ Name
                  ├ Code
                  ├ MaxInt
                  └ MaxLgInt
```

要件は次のとおりとする。

- `Area.Code` と `City.Code` を文字列のまま保存する。
- `City` がない場合は空配列にする。
- 未知・欠落コードの item を地名から補完しない。
- コード欠落 item は文字一覧には残せるが、地図値には含めない。
- 同一コードが複数回出現した場合は、同一電文内の最大震度 rank を採用する。
- 取消報では新しい地図値を生成しない。

### 4.3 PresentationEvent

`fromEarthquakeOutcome()` は細分区域の `areaItems` に `code` を設定する。

```ts
{
  name: area.name,
  code: area.code,
  maxInt: area.intensity,
  maxLgInt: area.lgIntensity,
}
```

市町村等については `municipalityNames` と `municipalityCount` を正しく設定するとともに、地図用の構造化データを Presentation へ通す。

```ts
interface PresentationQuakeMapLayer {
  localAreas: Array<{
    code: string;
    maxInt: string;
    maxIntRank: number;
  }>;
  municipalities: Array<{
    code: string;
    maxInt: string;
    maxIntRank: number;
  }>;
}
```

`PresentationEvent` には将来のレイヤー追加を妨げない任意フィールドを設ける。

```ts
mapLayers?: {
  quake?: PresentationQuakeMapLayer;
};
```

既存の `areaNames`、`areaItems`、`intensityGroups` は文字表示用として維持する。地図対応のために既存一覧の粒度や並びを変更しない。

### 4.4 震度 rank

地図値は既存 `intensityToRank()` と同じ9段階を使用する。

| rank | 震度 |
|---:|---|
| 1 | 1 |
| 2 | 2 |
| 3 | 3 |
| 4 | 4 |
| 5 | 5弱 |
| 6 | 5強 |
| 7 | 6弱 |
| 8 | 6強 |
| 9 | 7 |

文字列の比較や独自変換表を地図側に重複実装しない。

## 5. engine→display protocol と状態管理

### 5.1 `DisplayStateSnapshotV1.mapLayers`

`DisplayStateSnapshotV1` に optional な `mapLayers` を追加する。

```ts
interface DisplayStateSnapshotV1 {
  // existing fields...
  mapLayers?: DisplayMapLayersV1;
}

interface DisplayMapLayersV1 {
  quake?: DisplayQuakeMapStateV1;
}
```

旧 engine から `mapLayers` が届かない場合、frontend は地図なしとして正常に縮退する。

### 5.2 震度地図 state

複数の緊急地震が同時に保持されても `QuakePanel` と地図値を対応づけられるよう、地図 event には安定した `eventKey` を持たせる。

```ts
interface DisplayQuakeMapStateV1 {
  events: DisplayQuakeMapEventV1[];
  nonEmergencyHost: {
    eventKey: string;
    expiresAtMs: number;
  } | null;
}

interface DisplayQuakeMapEventV1 {
  eventKey: string;
  eventId: string | null;
  reportDateTime: string;
  originTime: string | null;
  hypocenterName: string | null;
  depth: string | null;
  magnitude: string | null;
  maxInt: string;
  maxIntRank: number;
  tsunamiWarning: boolean;
  intensityGroups: DisplayIntensityGroupV1[];
  localAreas: Array<{
    code: string;
    rank: number;
  }>;
  updatedAtMs: number;
}
```

Phase 1～4 の wire には全国図で使用する `localAreas` だけを載せる。市町村等のコードと震度は parser・Presentation・fixture 照合まで通すが、municipality wire の追加は Phase 5 で snapshot サイズ設計とともに行う。

`eventKey` は `eventId` を優先し、欠落時は既存 DTO ID から生成する。`largeQuakes` 側にも対応する optional `mapEventKey` を追加し、null `eventId` を配列 index で結合しない。

### 5.3 public event DTO に載せない

地図のコード列は `DisplayEventDtoV1` へ追加しない。

`InfoDisplayHub.ingest()` で `PresentationEvent.mapLayers.quake` を state store へ直接渡す。これは、現在 `tsunamiObservations` を Presentation から state store へ渡している server-internal bridge（`src/engine/display/hub.ts:94-118`）と同じ責務分離とする。

これにより次を満たす。

- event の 32 KiB 制限を守る。
- ticker 用 DTO を地図都合で肥大化させない。
- 初期接続では snapshot 一つから地図を復元できる。
- 地図状態更新は通常の debounced `state` SSE で同期できる。

### 5.4 lifecycle

最大震度3～4の `nonEmergencyHost` は engine が期限を管理する。

- 初回受理: `expiresAtMs = now + 5分`
- 同一 `eventKey` の続報: 内容を更新し、期限を受理時刻から5分後へ延長
- 別の表示対象地震: host を新しい地震へ置換し、期限を新たに5分後へ設定
- 最大震度1～2の地震: 現在の host を置換しない
- 同一地震の取消または震度3未満への訂正: host と対応する地図値を除去
- 期限到達: host を除去
- emergency 表示中: 期限の時計を停止しない
- emergency 終了時: host が残り、期限内なら `quakeMap` へ復帰
- emergency 終了時に期限切れ: `standby` へ戻る

frontend も `expiresAtMs` を確認し、engine の sweep 間隔を理由に期限切れ画面を延長しない。

震度5弱以上の地図値は既存 `largeQuakes` と同じ lifecycle で保持する。U8 の5分制限によって、既存の `LARGE_QUAKE_HOLD_MIN = 10` を短縮しない。

不要になった地図 event は、対応する `largeQuake` と `nonEmergencyHost` のどちらからも参照されなくなった時点で除去する。

### 5.5 severity と背景

震度3～4の `quakeMap` 表示中は次の扱いとする。

- `severityTier`: 最大 `caution`
- `backgroundTone`: `caution`
- 緊急パネル: 発火させない
- frame level: 地図表示を理由に昇格させない
- ticker priority: 地図表示を理由に昇格させない
- sound: 地図表示を理由に追加・昇格させない
- alert/critical 専用の減光解除条件: 発火させない

現行 `deriveSeverityTier()` は震度5弱以上だけを地震由来の `alert` にしている（`src/engine/display/state-store.ts:315-331`）。震度3～4の active `nonEmergencyHost` を `caution` として反映する。

震度5弱以上は従来どおり `alert` 以上とする。

### 5.6 protocol 同期

protocol 型は必ず次の両方を同一変更で更新する。

- `src/engine/display/protocol.ts`
- `display/frontend/src/lib/protocol.ts`

`PROTOCOL-SYNC` 範囲の完全一致を維持し、`test/engine/display/protocol-sync.test.ts` を通す。

### 5.7 snapshot サイズ

実電文相当の最大ケースを使い、`MAX_SNAPSHOT_BYTES = 256 KiB` 内に収まることをテストする。

Phase 1～4 では市町村値を wire に載せない。細分区域値については、地図の正確性を損なう無言の末尾切り捨てを禁止する。上限超過時は実装を完了扱いにせず、表現形式または保持 event 数を再設計する。

### 5.8 standby persistence

`mapLayers.quake` は runtime の一時表示状態であり、既存 `standby-persistence` には保存しない。

したがって、プロセス稼働中の frontend 再接続では snapshot から復元できるが、engine プロセス再起動後は復元しない。

将来、地図表示期限をプロセス再起動後にも継続する場合は、期限の wall-clock 化、schema version、破損時縮退を含む別仕様とする。

## 6. frontend

### 6.1 静的アセットのロード

Vite は `display/frontend` を root とし、`base: "./"` を使用している（`display/vite.config.ts:7-8`）。地図アセットは `display/frontend/public/maps/quake/` に置き、build 時にそのまま配布物へ含める。

初期ロードでは地図 JSON を取得しない。震度3以上の地図表示が初めて必要になった時点で、全国図だけを遅延 fetch する。

URL は相対 base に対応する形で解決する。

```ts
new URL("maps/quake/area-forecast-local-e.v1.json", document.baseURI)
```

ロード結果と進行中 Promise は frontend 内でキャッシュし、画面切替のたびに再取得しない。

初期実装では次を禁止する。

- `area-information-city-quake.v1.json` の fetch
- 同アセットの静的 import
- preload / prefetch
- service worker 等による先読み

### 6.2 コンポーネント構成

次の責務分割を基本とする。

```text
QuakeMap
  ├─ asset load
  ├─ code → rank の結合
  ├─ SVG path
  ├─ inset frame / label
  ├─ legend
  └─ source attribution

QuakeMapScreen
  ├─ 震源・最大震度概要
  ├─ QuakeMap
  └─ ページング付き地域別震度一覧

QuakePanel
  ├─ 既存の震源・最大震度概要
  ├─ QuakeMap（主パネル時）
  └─ 既存のページング付き地域別震度一覧
```

`QuakeMap` は表示面や lifecycle を決めない。渡された `DisplayQuakeMapEventV1` と静的アセットだけを描画する。

### 6.3 SVG 描画

固定 `viewBox` を持つインライン SVG を使用する。

```svelte
<svg viewBox="...">
  {#each paths as path}
    <path d={path.d} fill={colorForRank(path.rank)} />
  {/each}
</svg>
```

要件は次のとおりとする。

- pan/zoom を実装しない。
- runtime で path を再計算しない。
- 更新時は主に `fill` だけを変える。
- SVG path はコード順で安定して描画する。
- code が電文にない区域は neutral の未観測色にする。
- 電文 code が境界 asset にない場合は描画せず、診断可能な警告を残す。
- 地名による代替結合をしない。
- inset の枠線とラベルも同じ SVG に描画する。
- path はフォーカス対象にせず、文字一覧を情報取得の正本にする。

### 6.4 震度色

震度 rank 1～9 は既存の震度トークンと同じ色相を使用する（`display/frontend/src/lib/theme.css:78-88`）。

- rank 1～7: `--int-1` ～ `--int-7`
- rank 8: `--int-8-bg`
- rank 9: `--int-9-bg`

地図専用に異なる震度パレットを作らない。

文字用トークンを面塗りへ適用したときの識別性と隣接区域の境界線を確認し、必要な場合は同じ色相を基にした map-fill alias を theme に追加する。震度の意味対応そのものは変えない。

未観測区域、海、背景、境界線、inset 枠には震度色を使用しない。

### 6.5 緊急 `QuakePanel`

震度5弱以上は既存 `largeQuakes → EmergencyScreen → QuakePanel` の経路を維持する。

主パネルの `QuakePanel` では地図と文字一覧を並置する。

- 地図を主要領域として確保する。
- 地域別震度一覧は既存ページングを維持する。
- 地図更新で現在ページを不必要にリセットしない。
- 文字一覧は省略しない。
- compact な副パネルとして表示される `QuakePanel` では地図を省略し、既存の文字表示を優先できる。
- 地図値が当該 `largeQuake.mapEventKey` と一致しない場合は文字表示だけへ縮退する。

### 6.6 震度3～4の `QuakeMapScreen`

`QuakeMapScreen` は `StandbyScreen` 内の一時カードではなく、独立した画面 layer として追加する。

既存待機画面は、左上の `LatestQuakeCard`、中央時計、左右カード、下段情報の配置を持ち、カード移動には既存 FLIP 処理も存在する。地図をこの中へ押し込まず、独立面とすることで待機レイアウトを維持する。

`QuakeMapScreen` は次を表示する。

- 地震情報の固定ラベル
- 発生時刻
- 震源
- マグニチュード、深さ
- 最大震度
- 全国震度地図
- 既存形式のページング付き地域別震度一覧
- 出典表記

緊急画面への遷移時は即座に隠れ、期限内であれば緊急終了後に復帰する。

### 6.7 取得中・取得失敗時

地図 asset の取得中でも、震源概要と文字一覧は直ちに表示する。

取得失敗、JSON schema 不正、path 欠落の場合は次のように縮退する。

- `QuakeMapScreen` または `QuakePanel` 自体は維持する。
- 地図領域に簡潔な「地図を表示できません」を出す。
- ページング付き文字一覧は通常どおり表示する。
- 自動リロードを繰り返さない。
- 例外を App 全体へ漏らさない。
- 次の地震更新でも同一失敗を無制限に再試行しない。

### 6.8 accessibility

- SVG には地震、最大震度、表示範囲を含む accessible name を与える。
- 個々の区域 path に大量の focus stop を作らない。
- 色だけに依存せず、同時表示する文字一覧で内容を取得できるようにする。
- 凡例には震度表記を併記する。
- `prefers-reduced-motion` 時は既存画面切替と同様に不要な transition を抑止する。
- inset ラベルと出典表記が小さすぎないことを確認する。

## 7. 全国図・拡大図と画面切替

### 7.1 初期全国図

初期実装は `AreaForecastLocalE` の細分区域による全国図だけを表示する。

離島部は U6 に基づく inset で配置する。runtime での自動移動や viewport による再配置はしない。

初期全国図では次を必須としない。

- 震央マーカー
- 震央中心の自動 crop
- 市町村境界
- 粒度切替
- ユーザー操作によるズーム

### 7.2 市町村等拡大図

`AreaInformationCity_quake` の市町村等アセットは Phase 1 で生成・コード照合するが、表示は Phase 5 まで行わない。

Phase 5 では、全国図は細分区域、拡大図は市町村等とする粒度切替を検討する。切替条件は U5 の未決事項とする。

### 7.3 `ScreenMode` 導出

mode の導出は次の順序で行う。

```ts
function deriveMode(state, nowMs): ScreenMode {
  if (deriveEmergencyPanels(state).length > 0) return "emergency";
  if (hasUnexpiredQuakeMapHost(state, nowMs)) return "quakeMap";
  return "standby";
}
```

震度3～4の地図 state を `deriveEmergencyPanels()` に追加してはならない。`quakeMap` は非緊急面であり、緊急パネルの優先順位や配置へ混入させない。

### 7.4 U8 lifecycle

専用非緊急面の表示保持時間は5分とする。

```text
震度3～4を受理
    ↓
quakeMap（5分）
    ├─ 同一地震の続報 → 内容更新・5分へ延長
    ├─ 別の震度3以上の地震 → 新しい地震へ置換
    ├─ emergency 発生 → emergency へ割込み
    │                     └─ 時計は進行を継続
    │                         ├─ 期限内に終了 → quakeMap へ復帰
    │                         └─ 期限後に終了 → standby
    └─ 期限到達 → standby
```

ユーザー操作による早期終了の具体的 UI は実装 Phase で確定してよい。ただし、自動5分保持を基本動作とし、早期終了機能を追加しても engine の地図 state や他クライアントを破壊しない設計にする。

### 7.5 tips context

`ticker` 自体は `quakeMap` 中も表示する。地図表示を理由に ticker priority や sound を変更しない。

tips feeder には三値 mode を明示的に渡し、`quakeMap` が偶然 `standby` として扱われないようにする。

`quakeMap` 中に表示する tips の集合、抑止条件、再開条件の詳細は Phase 4B で確定してよい。実装前に明示的な policy とテストを追加し、暗黙の default 分岐にはしない。

### 7.6 画面遷移

`App.svelte` に `QuakeMapScreen` 用の第三の screen layer を追加する。

- standby → quakeMap: calm/caution 系の既存 transition を基準にする。
- quakeMap → emergency: emergency 用の既存進入 transition を優先する。
- emergency → quakeMap: 期限内 host がある場合だけ復帰する。
- quakeMap → standby: 通常の fade とする。
- reduced motion: 既存 policy に従う。
- standby の overlay や一時 replay は、standby を離れる際に既存と同じく明示的に閉じる。

## 8. 障害時動作・性能・運用

### 8.1 欠落コード

電文に存在し境界 asset に存在しないコードは、次のように扱う。

- 別区域へ塗らない。
- 地図からは欠落させる。
- 文字一覧には残す。
- missing code 数とコードを診断可能にする。
- 本番表示をクラッシュさせない。

境界 asset に存在するが電文にないコードは未観測色とする。

### 8.2 schema 不一致

asset の `schemaVersion` が未対応の場合は地図取得失敗として扱い、文字一覧へ縮退する。未知 schema を部分的に推測して読まない。

### 8.3 セキュリティ

- JSON 内の path を `innerHTML` で注入しない。
- `d` 属性として DOM に設定する。
- schema、数値、path 文字列の基本検証を loader で行う。
- 外部 URL への runtime fetch を行わない。
- asset の出典URLは表示用テキストとして扱う。

### 8.4 性能方針

初期目標サイズは前提調査値を基準とする。

- 細分区域: 約0.86 MB級
- 市町村等: 約2.23 MB級

全国図は一度だけ遅延ロードし、再利用する。震度更新ごとに JSON を再 parse しない。

Raspberry Pi 実機では次を測定するが、Phase 1～4 の着手条件にはしない。

- 初回 fetch・parse 時間
- SVG 初回 mount 時間
- fill 更新時間
- 画面遷移時の frame drop
- 常駐メモリ増加
- 複数回続報時の安定性

測定結果により path 数削減や簡略率変更を検討できるが、コード結合と文字フォールバックの契約は変えない。

## 9. テスト計画

### 9.1 parser

- VXSE53 fixture から `Area.Code` を取得できる。
- `City.Code` と市町村最大震度を取得できる。
- 先頭ゼロを保持する。
- Area/City が1件または複数でも同じ結果になる。
- City 欠落を空配列として扱う。
- Code 欠落で地名補完しない。
- 同一コード重複時に最大 rank を採用する。
- 取消報から active 地図値を生成しない。
- 既存の地域名・最大震度テストを壊さない。

### 9.2 Presentation

- `areaItems[].code` に細分区域コードが通る。
- `mapLayers.quake.localAreas` に code と rank が通る。
- municipality code が Presentation まで保持される。
- `municipalityNames/count` が実データと一致する。
- 既存 `intensityGroups` の表示順と内容が維持される。

### 9.3 projection・asset

- 同じ入力から同じ JSON が生成される。
- 全 code が文字列で一意である。
- path が空でない。
- `viewBox` 内に path と inset が収まる。
- inset 対象が本図と二重描画されない。
- inset の枠とラベル位置が固定される。
- manifest の feature/code 数が出力と一致する。
- 全国図と市町村等の両アセットを検証する。
- representative VXSE fixture の Area/City code が対応 asset に存在する。
- allowlist 以外の不一致で失敗する。

### 9.4 protocol-sync

- engine/frontend の protocol sync test が通る。
- `mapLayers` 欠落を旧 server 互換として扱う。
- snapshot JSON round-trip で code、rank、eventKey、期限を保持する。
- 最大想定データが256 KiB以内に収まる。
- public event DTO に地図コード列が含まれない。

### 9.5 state-store

- 最大震度1～2では `nonEmergencyHost` を作らない。
- 最大震度3・4では host を作り、severity が caution になる。
- 最大震度5弱以上は既存 `largeQuakes` 経路を維持する。
- 3～4では `deriveEmergencyPanels()` が空のままである。
- 同一地震の続報で期限が5分へ延長される。
- 別の表示対象地震で host が置換される。
- 最大震度1～2の別地震では host が置換されない。
- 取消・対象外への訂正で同一 host が消える。
- 5分経過で host が消える。
- emergency 中も期限が進む。
- emergency 終了時、期限内なら host が復帰候補になる。
- emergency 終了時、期限切れなら standby になる。
- 震度5弱以上の地図保持が既存10分 lifecycle を短縮しない。
- orphan になった map event が回収される。
- map state が standby persistence に書かれない。

state、期限、共有状態を変更するため、実装時は通常テストに加えて `npm run test:shuffle` を必須とする。

### 9.6 frontend

- `ScreenMode` が `emergency > quakeMap > standby` の順で導出される。
- 震度3～4で `QuakeMapScreen` が表示される。
- 震度5弱以上で従来どおり `EmergencyScreen/QuakePanel` が表示される。
- emergency 中に `QuakeMapScreen` が同時表示されない。
- emergency 終了時の復帰・非復帰が期限どおりである。
- 全国図 asset が初回必要時だけ fetch される。
- 市町村等 asset が fetch、import、prefetch されない。
- code→rank→fill が正しい。
- 未観測 code は neutral になる。
- missing code でクラッシュしない。
- 地図と文字一覧が同時表示される。
- 既存の文字一覧ページングが維持される。
- compact `QuakePanel` は地図なしで正常表示できる。
- asset 取得中も文字情報が表示される。
- asset 取得失敗時も文字一覧が利用できる。
- inset の枠とラベルが描画される。
- accessible name、凡例、reduced motion を確認する。
- `quakeMap` tips context が明示的に処理される。

### 9.7 実機検証

Phase 6 で Raspberry Pi 上の代表画面サイズを使い、初回 mount、続報更新、緊急割込み、復帰を実測する。

合否閾値は U7 として未決のまま残す。

## 10. 段階導入プラン

### Phase 0: 仕様確定

内容:

- U1、U2、U3、U6、U8 の決定を記録する。
- U4、U5、U7 が後続判断であることを明記する。
- 初期実装の acceptance criteria を固定する。

完了条件:

- U1: 全国図のみが決定済み。
- U2: 震度3以上が決定済み。
- U3: 地図と文字一覧の同時表示が決定済み。
- U6: build-time inset が決定済み。
- U8: 専用非緊急面、5分 lifecycle、割込み復帰規則が決定済み。
- U4、U5、U7 が初期 Phase の隠れた blocker になっていない。
- 本仕様が最終レビューを通過している。

### Phase 1: 境界 asset とコード照合

内容:

- 取得・変換スクリプトを追加する。
- `AreaForecastLocalE` と `AreaInformationCity_quake` を変換する。
- 全国図と市町村等の inset を焼き込む。
- manifest、NOTICE、ライセンス文書を追加する。
- VXSE fixture と両 asset の code を照合する。

完了条件:

- 両アセットが決定的に再生成できる。
- representative Area/City code が境界 asset と一致する。
- allowlist 以外のコード不一致がない。
- 全国図と市町村等のファイルサイズが記録される。
- 市町村 asset はまだ frontend から参照されない。

### Phase 2: parser→Presentation

内容:

- VXSE parser で Area/City の code と震度を保持する。
- Presentation に細分区域・市町村等の地図値を通す。
- 既存文字一覧を維持する。
- 最大震度3以上を地図候補として生成する。

完了条件:

- parser、Presentation、既存 formatter のテストが通る。
- 地名照合なしで code と rank が得られる。
- 市町村値が Presentation まで失われない。

### Phase 3: protocol・state・severity

内容:

- `DisplayStateSnapshotV1.mapLayers` を追加する。
- protocol 両側を同期する。
- hub の server-internal bridge を追加する。
- map event と `nonEmergencyHost` を管理する。
- 5分期限と severity caution を実装する。
- emergency 割込み中も期限を進める。

完了条件:

- protocol-sync が通る。
- state lifecycle テストが通る。
- snapshot が256 KiB以内に収まる。
- standby persistence が変化しない。
- `npm run test:shuffle` が通る。

### Phase 4A: 震度5弱以上の全国図

内容:

- 全国図 asset loader と `QuakeMap` を追加する。
- 主 `QuakePanel` に地図を内包する。
- 地図と既存ページング一覧を並置する。
- asset 失敗時の文字フォールバックを実装する。

完了条件:

- 震度5弱以上の従来 emergency 経路が維持される。
- 主パネルで地図と文字一覧が同時表示される。
- compact パネルが破綻しない。
- 全国図だけが遅延 fetch される。
- 市町村等 asset は fetch されない。

### Phase 4B: 震度3～4の専用表示面

内容:

- `ScreenMode` を三値化する。
- `QuakeMapScreen` を追加する。
- `emergency > quakeMap > standby` を実装する。
- 同一地震延長、別地震置換、緊急割込み、期限内復帰を実装する。
- tips context と早期終了 UI の詳細を確定する。

完了条件:

- 震度3～4が緊急パネルを発火せず、専用面に出る。
- 表示保持が5分である。
- 続報、置換、割込み、復帰のテストが通る。
- severity は caution を上限とする。
- frame、ticker priority、sound を新たに昇格させない。
- 地図失敗時にも専用面で文字一覧が読める。

### Phase 5: 市町村等拡大図

内容:

- `AreaInformationCity_quake` を frontend から遅延取得する。
- municipality 値の wire 表現を追加する。
- 震央周辺の拡大図を追加する。
- 全国図と拡大図の切替規則を実装する。

完了条件:

- U5 が決定している。
- 市町村 code だけで結合できる。
- 全国図と拡大図で震度値が一致する。
- snapshot サイズと asset ロード量が許容範囲内である。

### Phase 6: Raspberry Pi 実測・調整

内容:

- 実機で初回描画と続報更新を測定する。
- 緊急割込みと復帰を測定する。
- 必要なら簡略率、path 分割、描画戦略を調整する。

完了条件:

- U7 の合否閾値が決定している。
- 実測結果と端末条件が記録されている。
- 調整後も code 結合、色対応、文字フォールバックが維持される。

## 11. 変更ファイルと規模感

### 11.1 主な変更候補

engine/parser:

- `src/types.ts`
- `src/dmdata/telegram-parser.ts`
- `src/engine/presentation/types.ts`
- `src/engine/presentation/events/from-earthquake.ts`
- `src/engine/display/project-event.ts`
- `src/engine/display/protocol.ts`
- `src/engine/display/hub.ts`
- `src/engine/display/state-store.ts`
- `src/engine/display/constants.ts`

frontend:

- `display/frontend/src/lib/protocol.ts`
- `display/frontend/src/lib/derive.ts`
- `display/frontend/src/lib/theme.css`
- `display/frontend/src/App.svelte`
- `display/frontend/src/components/QuakePanel.svelte`
- `display/frontend/src/components/QuakeMap.svelte`（新規）
- `display/frontend/src/components/QuakeMapScreen.svelte`（新規）
- `display/frontend/src/lib/quake-map-loader.ts`（新規）
- `display/frontend/public/maps/quake/*`（新規生成物）

データ生成:

- `display/package.json`
- `display/package-lock.json`
- `display/maps/quake/*`（新規）
- `display/scripts/maps/*`（新規）
- `docs/licenses/jma-forecast-area-gis.md`（新規）

テスト:

- `test/dmdata/telegram-parser.test.ts`
- `test/engine/presentation/events/from-earthquake.test.ts`
- `test/engine/display/protocol-sync.test.ts`
- `test/engine/display/state-store.test.ts`
- `test/engine/display/hub.test.ts`
- map build/code 照合テスト（新規）
- frontend derive/store/component テスト（新規・既存追記）

### 11.2 規模感

Phase 1～4B 全体は中～大規模の変更となる。

目安:

- source/test ファイル: 約20～30ファイル
- 実装コード: 約800～1,400行
- テストコード: 約700～1,200行
- 変換済み静的 asset: 合計約3 MB級
- parser 単体改修: 小～中
- protocol/state/mode 三値化: 中
- SVG 地図・レイアウト・fallback: 中～大
- GIS 変換と検証の再現性確保: 中

最大のリスクは SVG path 数そのものより、コードが parser、Presentation、state、protocol、frontend の途中で失われないことと、既存の緊急画面 lifecycle を変えずに非緊急面を追加することにある。

## 12. 決定事項・未決事項

### U1: 初期の全国図／拡大図範囲

**決定済み — 2026-07-30**

初期 frontend は `AreaForecastLocalE` の全国図だけを表示する。

`AreaInformationCity_quake` は Phase 1 で asset 生成と code 照合を行うが、frontend は fetch、import、prefetch しない。市町村等拡大図は Phase 5 に据え置く。

### U2: 地図表示トリガー

**決定済み — 2026-07-30**

最大震度3以上で地図を表示する。

- 震度3～4: 非緊急 `quakeMap` 面、severity は最大 caution
- 震度5弱以上: 既存 emergency/`QuakePanel`

震度3～4を理由に frame、ticker priority、sound、緊急パネルを昇格させない。

### U3: 地図と文字一覧の関係

**決定済み — 2026-07-30**

地図と文字一覧を同時表示する。

緊急主 `QuakePanel` と `QuakeMapScreen` の双方で、既存形式のページング付き地域別震度一覧を維持する。compact 緊急副パネルでは文字表示を優先し、地図を省略できる。

### U4: 待機画面への常設

**未決**

地震表示期限外にも、待機画面へ無着色の地図または直近地震地図を常設するかは未決とする。

初期実装では常設しない。`quakeMap` の期限終了後は通常の `standby` へ戻る。

### U5: Phase 5 の全国図／拡大図切替

**未決**

市町村等拡大図を導入するときの切替条件は未決とする。

候補には次がある。

- 最大震度または被害想定による自動切替
- 震央位置・表示地域数による自動切替
- 全国図と拡大図の時間交互表示
- ユーザー操作による切替

Phase 5 着手前に決定する。

### U6: inset

**決定済み — 2026-07-30**

沖縄、小笠原等は inset として別枠配置する。

投影、縮尺、移動は変換スクリプトで焼き込み、runtime では移動しない。inset の枠線とラベル位置も生成物に含める。

### U7: Raspberry Pi 性能閾値

**未決**

初回描画時間、更新時間、許容 frame drop、メモリ増加量の合否閾値は未決とする。

Phase 6 で実機条件とともに決定する。初期 spec では測定項目だけを固定する。

### U8: 震度3～4の表示面と lifecycle

**決定済み — 2026-07-30**

候補A「専用の非緊急表示面」を採用する。

```ts
type ScreenMode = "standby" | "quakeMap" | "emergency";
```

優先順位:

```text
emergency > quakeMap > standby
```

表示保持時間は5分とする。

付帯規則:

- 同一地震の続報で内容を更新し、期限を5分へ延長する。
- 別の表示対象地震で現在の地震を置換する。
- emergency は即時割込みする。
- emergency 中も期限の時計を進める。
- emergency 終了時、期限内なら `quakeMap` へ復帰する。
- emergency 終了時、期限切れなら `standby` へ戻る。

ユーザー操作による早期終了と `quakeMap` 用 tips context の詳細は Phase 4B で確定してよい。ただし、三値 mode と自動5分 lifecycle を変更する判断にはしない。

## 13. 初期実装の完了条件

レイヤー a の初期実装は、Phase 1～4B が完了し、次をすべて満たした時点で完了とする。

- 境界結合に地域コードだけを使用している。
- VXSE の `Area.Code` が parser→Presentation→snapshot まで失われない。
- `City.Code` が parser→Presentation まで通り、市町村 asset と fixture の照合が完了している。
- 全国図と市町村等の変換済み asset を再現可能に生成できる。
- 全国図に build-time inset が反映されている。
- ライセンス・出典・加工内容が記録されている。
- `DisplayStateSnapshotV1.mapLayers` が engine/frontend で同期している。
- 地図値が public event DTO に入っていない。
- snapshot が256 KiB以内である。
- 震度1～2では地図面を自動表示しない。
- 震度3～4では `quakeMap` を表示する。
- 震度5弱以上では既存 `QuakePanel` 経路を維持する。
- mode の優先順位が `emergency > quakeMap > standby` である。
- 震度3～4の表示保持が5分である。
- 同一地震の続報で期限が延長される。
- 別の表示対象地震で置換される。
- emergency 割込み中も期限が進む。
- emergency 終了時、期限内だけ `quakeMap` へ復帰する。
- 震度3～4の severity が caution を上限とする。
- 震度3～4を理由に frame、ticker priority、sound が昇格しない。
- 緊急主パネルおよび専用面で地図と文字一覧を同時表示する。
- 既存の地域別震度ページングを維持する。
- 全国図 asset が必要時だけ遅延 fetch される。
- 市町村等 asset が frontend から取得されない。
- asset 取得失敗時も文字情報が利用できる。
- コード不一致で誤った区域を塗らない。
- protocol-sync、parser、projection、state-store、frontend の各テストが通る。
- state と期限を変更するテストについて `npm run test:shuffle` が通る。
- U4、U5、U7 が未決事項として残っていても、初期全国図の動作に暗黙の分岐を残していない。

U4 は待機画面常設、U5 は Phase 5 の拡大図、U7 は Phase 6 の実機性能基準であり、Phase 1～4B の完了を妨げない。
