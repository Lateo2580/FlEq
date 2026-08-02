---
paths:
  - src/dmdata/**
  - src/engine/messages/**
  - src/engine/presentation/**
  - src/engine/display/**
  - src/engine/eew/**
  - src/engine/notification/**
  - display/frontend/src/**
  - test/dmdata/**
  - test/engine/messages/**
  - test/engine/presentation/**
  - test/engine/telegram-foundation/**
  - test/fixtures/**
---

# 電文パイプライン

新しい電文対応は原則 **parser → router → formatter → notifier → test** の順で追加する。

## ルーティング優先順位

`message-router.ts` が `classification` + `head.type` で振り分ける。

0. （最優先・classification 非依存）`head.type` が `IGNORED_HEAD_TYPES` (VPWW53/54・VPNO50・VPOA50・VPZJ50・VPCJ50・VPFJ50・VMCJ50/51/52・VXWW50) → `ignore` ルート。handler 冒頭で早期 return し、**表示・通知・統計をすべてスキップ**（raw フォールバックも出さない）。配信終了予定 + 既存電文 (VPWW55-61/VPWS50・VPZJ51/VPCJ51/VPFJ51 等) と内容重複のため。
1. `eew.forecast` / `eew.warning` → EEW パス (EewTracker 重複検出 + EewEventLogger)
2. `telegram.volcano` → 火山パス (VolcanoStateHolder + VolcanoPresentation)
3. `telegram.earthquake` + `VXSE56`/`VXSE60`/`VZSE40` → テキスト系
4. `telegram.earthquake` + `VXSE62` → 長周期地震動観測
5. `telegram.earthquake` + `VXSE*` → 地震情報
6. `telegram.earthquake` + `VTSE*` → 津波情報
7. `telegram.earthquake` + `VYSE*` → 南海トラフ
8. `telegram.weather` + `VPWW55-61`/`VPWS50` → 気象警報・注意報
9. `telegram.weather` + `VPHW50`/`VPHW51` → 竜巻注意情報
10. `telegram.weather` + `VPBS50` → 気象防災速報 (線状降水帯/記録雨/短時間大雪)
11. `telegram.weather` + `VPAW51` → 早期天候情報 (高温/低温/大雪/雪 の長期予報)
12. `telegram.weather` + `VPWP50` → 気象警報・注意報時系列情報 (3 時間/24 時間/日単位 の時系列予測)
13. `telegram.weather` + `VPZI50`/`VPCI50` → 全般/地方天候情報 (気温・降水量の平年差/比 を含む長期気候統計情報。VPCI50 は梅雨入り/明け等の seasonEvents も持つ)
14. `telegram.weather` + `VPCJ51`/`VPZJ51`/`VPFJ51`/`VMCJ53`/`VMCJ54`/`VMCJ55` → 気象解説情報 (地方/全般/府県 — 気象台が積極的に解説する事象、大雪・高温・豪雨・線状降水帯・台風等。VMCJ53-55 は潮位版で大潮・副振動等の TidalLevelPart を持つ)
15. `telegram.weather` + `VPFT50` → 熱中症警戒アラート (環境省・気象庁共同の暑さ指数 (ＷＢＧＴ) ベース注意喚起。Body は平文のみ)
16. `telegram.weather` + `VPTW60`/`VPTW61`/`VPTW62` → 台風解析・予報情報 (台風の実況解析・推定・5日予報。VPTW60/61/62 は同一スキーマで 1 parser。通知は一律 normal)
17. `telegram.weather` + `VPTA50` → 台風の暴風域に入る確率 (375地域×5日積算 + 40step時系列、府県集約・targetRows=24・連続ゼロdedup)
18. `telegram.weather` + `VXKO50-89`/`VXSU50-59` → 指定河川洪水予報・水位周知河川 (parser は schema 分岐で同一型に正規化、formatter は VXKO full / VXSU minimal の 2 layout。Phase 3B 以降、EventID lifecycle・revision・取消 tombstone は共通 `TelegramRevisionGate` の `clearCurrent` が所有する。state holder は VXKO の EventID 単位 station digest dedup のみを持ち、取消 / 訂正 / Headline-only / VXSU は digest dedup を bypass する。EventID 欠落は ticker/CLI 表示だけを許す fail-open で、standby・通知・durable state は変更しない。v1 / pre-flood-v2 の表示 EventID は正規報受理か期限切れまで別集合で保全する。observeOnly は内容 revision を維持したまま numeric serial を持つ `appliedRevision` を gate と意味的一致させ、かつ内容 revision がそれ以下であることを要求して、通常報による未適用の revision 遅行と区別する。aggregateByRiver は formatter 内呼出 (engine→ui 境界遵守))
19. それ以外 → `displayRawHeader` (フォールバック)

**特記**: VFVO53 は単発処理ではなく `volcano-vfvo53-aggregator.ts` でバッチ集約される。CLI 表示・通知はバッチ 1 イベントのまま、**display テロップだけは投影段で火山ごとの単発相当イベントに分割**される（`expandVolcanoBatchForDisplay`、groupKey は `volcano:eventId:volcanoCode` で単発取消と系列一致。source msg 欠落時は分割せず縮退）。

**特記（火山の state 保持単位）**: VFVO50/VFVO51/VFSVii の警報系列は `volcano:alert:${volcanoCode}`、VFVO52/VFVO56 の噴火系列は `volcano:eruption:${volcanoCode}` を共通 `TelegramRevisionGate` の subject とする。VFVO51 は数値レベルと非数値区分の双方を火山別 state entry に展開し、同一 subject が複数ある場合は電文順の最後を一度だけ適用する。state entry が空、または火山コードを確定できない入力は `volcanoStateMutationAccepted=false` の fail-open 表示に留め、holder・standby・通知・永続化を変更しない。非活性 entry は同じ火山の alert subject だけを `clearCurrent` する。alert/eruption は各 512 subject、tombstone は従来の standby guard と同じ 30 日/2 日で、gate の退場後は holder と standby も同じ active subject 集合へ同期する。現行の EventID 欠落噴火は live provenance として保持し、EventID 不一致時の一意 fallback は `legacyV1Fallback` を持つ旧v1 seedだけに限定する。空コード取消の再送は gate の `legacyRevisionKey` から tombstone subject を逆引きし、transient表示へ落とさない。rollback key は v2 に `eventId` / `codeFallback` provenance を保存し、空コード取消の EventID 逆引きには実 EventID 由来だけを使う。provenance 欠落の旧 v2 は誤取消を避けて逆引き対象外とする。EventID欠落取消は既存subjectの旧EventID rollback keyを維持する。v2 foundation の trusted gate は rollback 用 v1 `seen` の同一 key に無条件で優先し、旧 key (`volcano:alert:<code>` / `volcano:event:<EventID|code>`) へ dual-write する。`legacyRevisionKey` 導入前の active 噴火は canonical holder state の一意な火山コードから EventID を回収する。取消済みで EventID を復元不能な場合だけ code fallback を維持する。期限切れの旧 v1 噴火表示は取消対象 identity へ seed しない。VFVO53 の batch aggregator は durable な alert/eruption state とは別責務だが、最終網羅では非 durable `markCancelled` gate を通過後に集約する。v2 foundation を真実源とし、起動時 REST の VFVO50 replay は同一 payload の holder 再構成、または新しい受理報の適用だけに使う。

**特記 (テロップ抑制)**: sentence も body も組めない非取消の VPWP50 は `tickerSuppressed: true` でテロップに流れない（event broadcast 自体は seq 整合のため流れる。`project-event.ts` の判定、spec 2026-07-23 ticker-content-lifetime T5-2）。

**Phase 3B standby revision contract**: VPHW50/51、VPFT50、VPTW60-62、VPTA50、VYSE50-60、VPWP50、VXSE62 は router の transport dedup / 日時診断後に共通 semantic revision gate を通す。subject 不明は表示/ticker のみで、通知・standby projection・VPWP50 detail cache・VPTA50 連続ゼロ cacheを更新しない。clearCurrent family は同一 revision 訂正で取消 tombstone を解除せず、受理済み訂正だけを一度通知する。durable projection の適用完了は `appliedSemanticKey` で gate payload と結合し、旧 v1 projection は各 subject が正規報を受けるまで legacy として保全する。

**Phase 3B transient revision contract**: earthquake（VXSE51/52/53/61）、seismicText、VPBS50、VPAW51、VPWW55/57-61、VPZI50/VPCI50、気象解説、raw fallback は `markCancelled` policy を持つ。地震は head.type を跨ぐ EventID subject、その他は type＋EventID subject とし、EventID 欠落は受信時刻や名称で結合せず単発 transient gate にする。重複・stale・invalid revision は stats / display / notification より前に落とし、受理済み訂正だけを一度通知する。地震の観測値保持は従来どおり downstream の quake-observation-merge が担い、QuakeExtremeStore と quake map の局所 guard は永続 state / source 別投影の防御として残す。VFVO53-55 の降灰と VZVO40/VFVO60 も非 durable policy を明示し、VFVO53 は gate 通過後だけ既存 batch aggregator へ入れる。classification/prefix の broad route に未登録 head.type が到達した場合は警告して raw policy へ落とす。火山 handler は parse failure と semantic suppression を discriminated result で区別し、parse failure だけを raw 表示へ戻す。

**Phase 4A intensity contract**: `VXSE43`／`44`／`45`／`51`／`53`／`62` の `Intensity`／`LgInt` は `SpecialValue` を真実源にする。parser は `specialValueBody` の shadow tree で raw／`Condition`／`Description`／From／To を保持し、`missing`・`empty`・`unknown`・`qualitative`・`range` を区別する。EEW 親 `Area/Condition` は ForecastInt の `intensityValue.condition` と別 field で、PLUM／主要動到達も別 flag とする。

- 共通受理経路は parser → presentation → notification の後に display sink へ渡す。display hub 内の順序は display projection → display state → ticker recent queue／event broadcast であり、standby／daily persistence owner は受理済み event／state を別責務で保存する。全経路で qualifier を失わない。legacy scalar は optional semantic の互換 adapter であり、display protocol V1 は `DisplayIntensitySemanticV1`／EEW semantic／`restoreRevision` を additive に持つ。
- `IntensitySafetyRank` と `LgIntensitySafetyRank` は別型・別 helper で解決する。`5弱以上未入電` は下限 rank 5 の gate／色／`≥` badge、unknown は `?`、empty は `∅`、missing は非描画・構造欠落とする。unknown／empty／qualitative は observation merge の missing ではない。
- regionless EEW は overall 値を評価して emergency payload を生成できるが、地域 item／地域カードは生成しない。表示 payload の置換と retained safety latch は §7.3 に従い分離し、unknown が emergency host を降格させない。terminal retract は `restoreRevision` で直前の権威表示を復元する。
- frontend の badge 点は bounding box 中心ではなく scanline で求めた path 内部点を使い、凡例／tooltip／ARIA に `≥`／`↔`／`?`／`∅` の意味を出す。変更単位8の契約 fixture は synthetic XML のみで、実電文確認済みとは扱わない。

**Phase 3B gate capacity / trigger contract**: 全 revision family は有限の `maxSubjects` を宣言し、その合計を gate 全体の設計容量以下に固定する。退場は family 内だけで行い、他 family の流量で watermark／取消 tombstone を削除しない。family が退場不能な保護対象だけで満杯なら、新規 subject を `capacityExceeded` で fail-closed に拒否して hard bound を守る。EventID 等が欠落した transient subject も同じ family の TTL と `maxSubjects` に従う。取消 trigger は A（明示取消）> B（terminal）> C（deactivation）で `resolvedTrigger` 一つへ解決し、台風の `transitionedToLow`／`formationCancelled` は B とする。

**特記 (VPWW56 の state 保持単位)**: `Vpww56StateHolder` は view を **`(head.type, publishingOffice)` の複合キー単位で保持し、参照時に union して返す**。VPWW56 は府県予報区ごとに別の地方気象台が発表するため全体 1 view 置換にすると別官署の続報が既存官署の警報を消してしまい、さらに同一官署が複数カテゴリ (土砂・大雨・高潮…) を出しうるため type も要る。revision watermark と取消 tombstone は共通 `TelegramRevisionGate` が同じ複合 subject `weather:${type}:${publishingOffice}` で所有し、holder は gate 通過後の active view と union だけを持つ。取消 tombstone は旧 dormant と同じ 6 時間、可変 subject は holder／gate とも 128 件で同期する。官署欠落で subject が作れない fail-open event は `weatherStateMutationAccepted=false` として ticker だけへ流し、standby/promotion を変更しない。union の updatedAt／expiry は event 自身ではなく active subject 群の最新 ReportDateTime から導出する。`getCurrentAreasForDisplay()` は union 済みの単一 view を返すので呼び出し側の形は変わらない。subject と `project-event.ts` のテロップ groupKey は `weatherOfficeStreamKey()` で同じ正規化を使う（VPWS50 だけは全国集約の単一ストリーム `weather:vpws50` へ畳む別扱い）。**複合キーは将来への備えで、現状の挙動は変わらない** — `processWeather` が `head.type === "VPWW56"` で門番しているため入ってくるのは VPWW56 だけ。将来 VPWW55/57-61 を気象カード経路に載せるには、表示設計と registry policy を同時に追加する。

## 表示パイプライン

### 背景トーン / テロップ面の wire 経路

`PresentationEvent → projectDisplayEvent() → DisplayEventDtoV1.tickerSurface → toTickerJob() → TickerLane`。solid の可否は `projectDisplayEvent()` が大津波・気象 L5 相当・震度 7・取消を判定し、frontend は role から再推測しない。

`PresentationEvent → monitor 所有 QuakeExtremeStore → DisplayStateStore.snapshot().backgroundTone → App[data-background-tone]`。震度 7 は `originTime` から 12 時間保持し、下方修正・同系列取消で解除する。monitor の JSON 永続化を通るため display off/on とプロセス再起動をまたぐ。

`runDisplayPipeline()` (`message-router.ts` 内) が全ルートの統一表示エントリポイント。

```
ProcessOutcome → toPresentationEvent() → PresentationDiffStore.apply()
  → shouldDisplay() → summaryTracker.record() → focus判定
  → renderTemplate() or renderSummaryLine() or displayFn()
```

通知は filter 非適用のため `runDisplayPipeline` の前に実行される。

## 電文→パーサ→表示 対応表

| head.type | パーサ | 表示 |
|-----------|--------|------|
| VXSE43/44/45 | `parseEewTelegram` | `displayEewInfo` |
| VXSE51/52/53/61 | `parseEarthquakeTelegram` | `displayEarthquakeInfo` |
| VXSE56/60, VZSE40 | `parseSeismicTextTelegram` | `displaySeismicTextInfo` |
| VXSE62 | `parseLgObservationTelegram` | `displayLgObservationInfo` |
| VTSE41/51/52 | `parseTsunamiTelegram` | `displayTsunamiInfo` |
| VYSE50/51/52/60 | `parseNankaiTroughTelegram` | `displayNankaiTroughInfo` |
| VFVO50-56/60, VFSVii, VZVO40 | `parseVolcanoTelegram` | `displayVolcanoInfo` |
| VPWW55-61, VPWS50 | `parseWeatherWarning` | `displayWeatherWarning` |
| VPHW50, VPHW51 | `parseTornadoAdvisory` | `displayTornadoAdvisory` |
| VPBS50 | `parseWeatherBriefing` | `displayWeatherBriefing` |
| VPAW51 | `parseEarlyWeather` | `displayEarlyWeatherInfo` |
| VPWP50 | `parseWeatherWarningTimeseries` | `displayWeatherWarningTimeseriesInfo` |
| VPZI50, VPCI50 | `parseClimateInfo` | `displayClimateInfo` |
| VPCJ51 | `parseWeatherExplanation` | `displayWeatherExplanation` |
| VPZJ51 | `parseWeatherExplanation` | `displayWeatherExplanation` |
| VPFJ51 | `parseWeatherExplanation` | `displayWeatherExplanation` |
| VMCJ53 | `parseWeatherExplanation` | `displayWeatherExplanation` |
| VMCJ54 | `parseWeatherExplanation` | `displayWeatherExplanation` |
| VMCJ55 | `parseWeatherExplanation` | `displayWeatherExplanation` |
| VPFT50 | `parseHeatAlert` | `displayHeatAlertInfo` |
| VPTW60, VPTW61, VPTW62 | `parseTyphoonAnalysis` | `displayTyphoonAnalysisInfo` |
| VPTA50 | `parseTyphoonProbability` | `displayTyphoonProbabilityInfo` |
| VXKO50-89 | `parseFloodForecast` | `displayFloodForecastInfo` |
| VXSU50-59 | `parseFloodForecast` (`schema: "vxsu50"`) | `displayFloodForecastInfo` (`displayVxsuMinimal`) |

## フレームレベル判定

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
- **気象警報・注意報** (weather-parser.ts の `maxDisplaySeverity` + `weatherFrameLevel`、Phase C で displaySeverity ベース化):
  - 取消=cancel
  - officialL5 / officialL4 / nonLevelSpecial (特別警報・L4 危険警報・土砂災害警戒情報等)=critical
  - officialL3 / nonLevelWarning (警報級)=warning
  - officialL2 / nonLevelAdvisory (注意報級)=normal
  - officialL1 / unknown / release のみ=info
  - **Phase C 変更点 (2026-06-12)**: Code 43/48/49 (警戒レベル4相当) が warning → critical に変更 (VPWW55-61/VPWP50 と整合)
  - **通知音 (soundLevel) は表示と独立 (2026-06-12 決定)**: `weatherSoundLevel` は parser が `computeMaxSoundLevel` で導出した `maxSoundLevel` (集合ベース: 全 Kind を `DISPLAY_SEVERITY_TO_SOUND_LEVEL` に写して最大) を引く。critical 音は特別警報級 (officialL5/nonLevelSpecial) のみ、officialL4 は表示 critical のまま音は warning (気象警報・注意報系は通知項目が多いため)。VPWW55-61/VPWS50/VPWP50 すべてに適用。**L4 と特別警報級の共存時は特別警報側 (critical) が勝つ (集合ベース判定)** — rank 1 点代表の `maxDisplaySeverity` 経由だと critical 音が潰れていた (2026-06-12 共存エッジ解消)
- **竜巻注意情報** (tornado-parser.ts の `tornadoFrameLevel`、Phase D で parser 段の displaySeverity ベース化):
  - 取消=cancel
  - 目撃情報あり (VPHW51 / sightingAreas あり、または目撃電文で地域抽出に失敗したフェイルセーフ) = nonLevelSpecial → critical
  - 通常の発表 (activeAreaCount > 0) = nonLevelWarning → warning
  - 発表地域なし (displaySeverity=null)=info
  - parser (`resolveTornadoSeverity`) が `displaySeverity` / `soundLevel` を 2 系統で解決し、`tornadoFrameLevel` は前者を、`tornadoSoundLevel` は後者を引く (関数名は据置)
  - **通知音 (soundLevel) は表示と独立 (2026-06-12 決定)**: 目撃情報あり = 表示 critical / **音 warning**。critical 音 = 特別警報そのもの (officialL5 + 特別警報の名を持つ nonLevelSpecial) のみ、という原則による (竜巻目撃は nonLevelSpecial だが特別警報の名を持たないため critical 音にしない)
- **気象防災速報** (briefing-parser.ts の `briefingFrameLevel`、Phase D で集合ベース化):
  - 取消=cancel
  - 線状降水帯発生 / 記録的短時間大雨 = nonLevelSpecial → critical (即時危険)
  - 線状降水帯予想 / 短時間大雪 = nonLevelWarning → warning
  - 対象なし (maxDisplaySeverity=null)=info
  - **集合ベース化 (Phase D)**: parser (`extractConditions`) が全 Condition を出自 (情報タグ / fallback) つきで集合収集し (先頭 Condition 単一採用を廃止、重複は除去)、各 Condition を `resolveBriefingSeverity` で解決して evidence 化。frame は `maxDisplaySeverity` (DISPLAY_SEVERITY_RANK 最大)、音は集合ベースの `maxSoundLevel` (別系統) を引く。先頭が軽い条件 (短時間大雪) でも後続の重い条件 (記録雨) が沈まない
  - **未分類 Condition の昇格**: 情報タグ由来で未分類の Condition は `unknownConditions` に分離され、frame / sound とも最低 warning へ昇格 (base が info/normal のときのみ昇格、critical は潰さない)。fallback 由来の未分類は info 据置
  - **通知音 (soundLevel) は表示と独立 (2026-06-12 決定)**: 線状降水帯発生 / 記録雨 = 表示 critical / **音 warning** (特別警報の名を持たない nonLevelSpecial は critical 音にしない、上記原則)
- **早期天候情報** (level-helpers.ts の `earlyWeatherFrameLevel`):
  - 取消=cancel
  - その他=normal (5〜7日後の長期予報のため一律 normal)
  - 一律 normal は Phase D で契約テスト固定化 (2026-06-12 決定。Headline キーワード解釈による昇格は不採用)
- **気象警報・注意報時系列情報** (level-helpers.ts の `weatherWarningTimeseriesFrameLevel`):
  - 取消=cancel
  - 未知 Code 含む=**最低 warning へ昇格** (見落とし防止。本体最大が info/normal のときのみ昇格し、critical/warning は潰さない — 2026-06-12 降格バグ修正: 旧実装は本体最大より先に warning を return しており、L4/L5/特別警報級 + 未知 Code の共存で critical 表示を warning に降格させていた。音側ガード・briefingFrameLevel と同型に統一)
  - `maxDisplaySeverity` = officialL5 / officialL4 / nonLevelSpecial → critical
    - **Phase B 変更点 (2026-06-11)**: Code 41 (警戒レベル4相当 = officialL4) が warning → critical に変更 (VPWW55-61 と整合)
  - `maxDisplaySeverity` = officialL3 / nonLevelWarning → warning
  - `maxDisplaySeverity` = officialL2 / nonLevelAdvisory / officialL1 → normal
  - `maxDisplaySeverity` = null → info
  - 旧実装 (Phase A 以前) は `maxKnownSignificancy.severity` (3 段階: special/warning/advisory) ベースだった。displaySeverity ベースへの切替えにより Code 41 の扱いが変化する
  - **通知音 (soundLevel) は表示と独立 (2026-06-12 決定)**: `weatherWarningTimeseriesSoundLevel` は parser が集合ベースで導出した `maxSoundLevel` を引く (critical 音は officialL5/nonLevelSpecial のみ、officialL4 = Code 41 は表示 critical のまま音は warning)。**L4 と特別警報級の共存時 (例: Code 41+50) は特別警報側 (critical) が勝つ (集合ベース判定、2026-06-12 共存エッジ解消)**。未知 Code → warning 昇格ガードは「最低 warning へ昇格」として維持 (maxSoundLevel が critical ならそちらが勝つ)
- **全般/地方天候情報 (VPZI50/VPCI50)** (level-helpers.ts の `climateInfoFrameLevel`):
  - 取消=cancel
  - その他=normal (1〜数ヶ月の気候統計情報のため、内容によらず一律 normal。早期天候情報と同じ方針)
  - VPCI50 (地方天候情報。梅雨入り/明け等) も VPZI50 と同じく一律 normal
- **気象解説情報 (VPCJ51/VPZJ51/VPFJ51 共通。(潮位) VMCJ53-55 も同方針 — 一律 normal)** (level-helpers.ts の `weatherExplanationFrameLevel`):
  - 取消=cancel
  - その他=normal (気象台の積極的解説、警報級ではないため一律 normal。
    警報級判定は VPWS50/VPBS50/VPWP50 等の専門電文の責任で行う。
    VPZJ51 の台風 Headline / VPFJ51 の「観測史上１位」でも normal 固定)
  - 一律 normal は Phase D で契約テスト固定化 (2026-06-12 決定。Headline キーワード解釈による昇格は不採用 — 名前マッチの脆さを持ち込まないため)
- **熱中症警戒アラート (VPFT50)** (level-helpers.ts の `resolveHeatAlertLevels` — frame/sound を pair で解決):
  - 取消=cancel (音も cancel)
  - 題名に「特別警戒」を含む=表示 critical / **音は warning** (環境省の特別警戒アラート級が同型電文で配信された場合のフェイルセーフ昇格。critical 音 = 特別警報そのもののみ、の原則)
  - 通常の発表=表示 warning / 音 warning (nonLevelWarning 相当)
  - 通知は dispatchNotify が `outcome.presentation.soundLevel` を override で渡す (weather F-3 の横展開)
- **台風解析・予報情報 (VPTW60/61/62)** (level-helpers.ts の `resolveTyphoonAnalysisLevels` — frame/sound を pair で解決):
  - 取消=cancel (音も cancel)
  - その他=normal (音も normal)
  - 定時解析・予報のため一律 normal（解説扱い）。段階化は持ち越し⑤
- **台風の暴風域に入る確率 (VPTA50)** (level-helpers.ts の `resolveTyphoonProbabilityLevels`):
  - 取消=cancel (音も cancel)
  - 発表時 frame=normal 固定（気象解説情報系の規約）
  - sound: maxDaily5>0 → normal / maxDaily5===0 (暴風域消滅) → info（静音化）
  - 連続ゼロ抑制: 同一 EventID で前回も今回も maxDaily5===0 のとき `suppressNotify=true`（VPWS50 と同じ「ProcessDeps に注入した state holder で履歴ベース dedup」パターン。`Vpws50StateHolder` の rich diff とは別 interface、本クラスは単純 dedup のみ）
- **指定河川洪水予報・水位周知河川 (VXKO50-89 / VXSU50-59)** (level-helpers.ts の `resolveFloodForecastLevels` — frame/sound を pair で解決):
  - 取消=cancel (音も cancel)
  - parser が解決した `maxLevel` から決定:
    - Code 53 / Code 51 (氾濫発生情報 / 警戒レベル 5 相当) = critical
    - Code 41 / Code 40 (氾濫危険情報 / 警戒レベル 4 相当) = critical (VPWW55-61 / VPWP50 と同型扱い)
    - Code 31 / Code 30 (氾濫警戒情報 / 警戒レベル 3 相当) = warning
    - L2 (水位周知の氾濫注意) / L1 (水位上昇) = normal
    - その他 (Headline-only 等) = info
  - **通知音 (soundLevel) は表示と独立**: Code 51/53 は表示 critical / **音 critical** (洪水の即時危険、特別警報相当の名を持つため。weather/briefing の「critical 音 = 特別警報そのもののみ」原則と整合)、Code 41 は表示 critical / 音 warning (警戒レベル 4 相当だが特別警報の名を持たない、weather/timeseries と同じ判断)
  - **dedup bypass 4 ケース** (processor 側で判定、`state.diffAndUpdate` を呼ばない): 取消電文 (rollback のみ) / 訂正電文 / Headline-only (rawStations 空) / VXSU schema (`schema === "vxsu50"`)。通常 VXKO は新規 EventID でも `diffAndUpdate` に通して `new` reason を出す (`isNewEvent: true` で初回扱い)
  - **未知 Kind.Code 受信時**: frame=info に倒し、`logger.warn` で警告ログのみ (parser は null を返さない)
  - **VXSU50 (水位周知河川)**: 内部 schema 分岐 (`schema === "vxsu50"`)。observed series を持たないため state holder への登録はスキップ (processor 側で early return)、formatter は `displayVxsuMinimal` の最小 layout (Headline kindName + headlineText + footer のみ)
  - **取消後の再受理**: 取消電文を受けたら `state.rollback(eventId)` で station digest を削除し、共通 gate の tombstone は保持する。同一 revision の遅延報は拒否し、より新しい revision の再発表だけを新 lifecycle として受理する
  - 詳細: `設計メモ 2026-06-14-flood-water-level-design.md` §6 (frame/sound マッピング) / §10 (dedup) / §11 (engine→ui 境界)。Stage 14 後アーカイブ予定

## テスト

- 電文テストは `test/helpers/mock-message.ts` の `createMockWsDataMessage(fixtureName)` を使う
- フィクスチャは `test/fixtures/` に配置。命名: `{分類番号}_{連番}_{日付}_{電文タイプ}.xml`
- フィクスチャ定数: `FIXTURE_VXSE53_ENCHI` 等 (mock-message.ts で export)
