# ディスプレイ反映経路 検証ブリーフ（外部レビュー用）

> 目的: FlEq の「電文受信 → 常設情報ディスプレイへの反映」経路に処理の穴（CLI には出るがディスプレイに反映されない・切替/解除が畳まれない等）が残っていないかの外部検証を依頼するための現状整理。
> 対象 commit: main `83be002`（2026-08-30 時点）

## 1. 背景となった実運用事象（2026-08-30 福井県大雨特別警報）

1. VPWW55（府県気象警報・注意報）の特別警報がディスプレイに即時反映されず、後着の VPWS50（全国電文）まで数分遅延した
2. 特別警報の表示が、既に表示中だった他の警報/危険警報（L4）を消してしまった
3. 特別警報→警報の切替（VPNO50 気象特別警報報知）が CLI には出たが、ディスプレイは特別警報表示のまま残った

## 2. 修正済みの内容（main 反映済み）

- `ebc7698` VPWW55 を VPWS50 と同一 revision family に統合。官署別 overlay として全国 snapshot へ地域単位 merge（他県保持）。promotion（緊急パネル）・訂正通知・永続復元・容量保護まで配線
- `0f26888` WeatherAlertCard / weatherExpandedKinds を「最高 rank のみ」から emergency + warning/L4 の rank 共存表示へ
- `1858447` 「対応電文未確認」qualifier の描画を CLI・ディスプレイ全 5 経路で非表示化（内部状態・通知は維持）
- `56e85c2` 切替・解除系 5 穴の修正:
  - VPNO50 を weather state / promotion / 永続化へ接続、対象官署の emergency overlay を失効（官署一致主・府県 prefix 補助）
  - 官署別 emergency-clear watermark（LRU・永続化）で遅延 VPWW55 による再点灯を防止
  - VPWW55 取消は官署別 partialHistory（深さ 8・永続化）から直前報を復元、復元 subject を別官署続報の同期削除から保護
  - 広域解除の unsafe 判定を件数比 80% から「明示解除を持つ完全電文は受理」へ
  - 受理済み VPWW55 の差分を短時間変更表示へ許可
- `83be002` VPWW57-61（高潮/暴風/暴風雪/波浪/大雪等）を同じ stateful overlay 系へ接続:
  - overlay 合成を area 置換から現象（kind）単位 merge へ（大雨＋高潮の同一市町村並立を保持）
  - 部分報の明示解除を area×現象 tombstone として合成（古い全国 base の復活防止、曖昧解除は既存 tombstone を所有集合へ union）
  - VPNO50 watermark を官署単位（head type 非依存）へ統一
  - 内容不変訂正の通知・短時間変更表示を VPWW57-61 にも適用

回帰テストは実電文 fixture（VPNO50 切替/発表・福井 VPWW55 L5/降格 `test/fixtures/18_00_01_260830_*.xml`、および VPWW57/58/61 の既存実 fixture）による実時系列で固定。

## 3. 反映面マトリクス（現状）

反映面の実装位置:

- CLI: `src/ui/display-adapter.ts`（domain switch・assertNever 網羅）
- ticker/詳細文: `src/engine/display/project-event.ts` / `ticker-sentence.ts`
- 常設カード state: `src/engine/display/standby-state-store.ts`（applyEvent、default は NO_MUTATION）
- weatherAlerts state: `src/engine/monitor/display-sink.ts`
- promotion: `src/engine/display/weather-promotion-ingest.ts`
- 永続化: `src/engine/display/standby-persistence.ts`

| domain | CLI | weatherAlerts | promotion | ticker/詳細文 | 常設カード | 永続化 |
|---|---|---|---|---|---|---|
| eew | ○ | – | – | ×(抑制) | activeEews 経由 | – |
| earthquake | ○ | – | – | ○ | ○ quakeHost | ○ |
| seismicText | ○ | – | – | ○ | × | – |
| lgObservation | ○ | – | – | ○ | ○ | ○ |
| tsunami | ○ | – | – | ○ | tsunami state 側 | ○ |
| volcano | ○ | – | – | ○ | ○ | ○ |
| nankaiTrough | ○ | – | – | ○ | ○ | ○ |
| weather VPWS50 | ○ | ○ | ○ | ○ | × | ○ |
| weather VPWW55-61 | ○ | ○（官署別 overlay） | ○ | ○ | × | ○ |
| weather VPWW56 | ○ | ○ | ○ | ○ | × | ○ |
| tornado | ○ | – | – | ○ | ○ | ○ |
| briefing (VPBS50) | ○ | – | – | ○ | ○（非永続） | ×（意図的） |
| earlyWeather | ○ | – | – | ○ | × | – |
| weatherWarningTimeseries (VPWP50) | ○ | – | – | ○ | × | – |
| climateInfo | ○ | – | – | ○ | × | – |
| weatherExplanation | ○ | – | – | ○ | × | – |
| heatAlert | ○ | – | – | ○ | ○ | ○ |
| typhoonAnalysis | ○ | – | – | ○ | ○ | ○ |
| typhoonProbability (VPTA50) | ○ | – | – | ○ | × | × |
| floodForecast | ○ | – | – | ○ | ○ | ○ |
| legacyCounterpart VPOA50 | ○ | × | × | ○ | ○（briefing card・非永続） | × |
| legacyCounterpart VPNO50 | ○ | ○（overlay 失効＋watermark） | ○（降格反映） | ○ | × | ○（watermark） |
| legacyCounterpart VXWW50 | ○ | × | × | ○ | × | × |
| raw | ○ | – | – | ○ | × | – |
| ignore（VPWW53/54, VPZJ50 等 8 種） | × | × | × | × | × | × |

「–」= その面の対象外（weather 系以外は weatherAlerts/promotion を持たない）。「×」= 未接続・非表示。

## 4. 既知の非対称（意図的 or 未対応として把握済み）

- typhoonProbability (VPTA50): engine 側は standby 用配線が半分存在するが display 側に受け口がなく dead-end
- weatherWarningTimeseries (VPWP50): standby gate は通すが card への case なし（CLI 詳細専用 cache）
- briefing card（VPBS50/VPOA50）は意図的に非永続（再起動で消える）
- seismicText / climateInfo / earlyWeather / weatherExplanation は ticker のみ（transient 設計）
- VXWW50（legacyCounterpart）は表示のみで state 未接続
- ignore route の VPWW53/54: 「VPWW55-61 と重複」前提での破棄。VPWW57-61 の stateful 化後も route contract 上は重複維持が妥当と判断（2026-08-30 調査）
- VPNO50 の曖昧解除（Code 00 に LastKind も過去所有情報もない場合）は現象を特定できず clear しない（他現象の誤消去を避ける安全側。実電文では Body 側に情報があり完全欠落は稀）

## 5. 検証依頼の観点

1. §3 マトリクスに「CLI には出るがディスプレイ state に反映されない」穴が他に残っていないか
2. 切替・解除・取消・訂正の下り方向遷移が、全 stateful domain（weather 以外も: tsunami/volcano/heat/typhoon/flood 等）で対称に畳まれるか
3. 再起動（永続化 round-trip）を挟んだ場合の状態一貫性（watermark・履歴・復元 subject・容量保護・tombstone）
4. 順序逆転（遅延電文の後着）・官署間の干渉・容量境界（128 subject）・現象並立（大雨＋高潮）での状態破壊がないか
5. §4 の「意図的」とされた非対称のうち、実運用リスクとして再評価すべきもの

## 6. 参考

- 電文ルーティング詳細: `.claude/rules/message-pipeline.md`
- 電文基盤 contract: `test/engine/telegram-foundation/phase0-manifest.ts`
- 主要 state 実装: `src/engine/messages/vpws50-state.ts`（overlay/watermark/tombstone/履歴）
