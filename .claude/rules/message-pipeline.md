---
paths:
  - src/dmdata/**
  - src/engine/messages/**
  - src/engine/presentation/**
  - src/engine/eew/**
  - src/engine/notification/**
  - test/dmdata/**
  - test/engine/messages/**
  - test/engine/presentation/**
  - test/fixtures/**
---

# 電文パイプライン

新しい電文対応は原則 **parser → router → formatter → notifier → test** の順で追加する。

## ルーティング優先順位

`message-router.ts` が `classification` + `head.type` で振り分ける。

1. `eew.forecast` / `eew.warning` → EEW パス (EewTracker 重複検出 + EewEventLogger)
2. `telegram.volcano` → 火山パス (VolcanoStateHolder + VolcanoPresentation)
3. `telegram.earthquake` + `VXSE56`/`VXSE60`/`VZSE40` → テキスト系
4. `telegram.earthquake` + `VXSE62` → 長周期地震動観測
5. `telegram.earthquake` + `VXSE*` → 地震情報
6. `telegram.earthquake` + `VTSE*` → 津波情報
7. `telegram.earthquake` + `VYSE*` → 南海トラフ
8. それ以外 → `displayRawHeader` (フォールバック)

**特記**: VFVO53 は単発処理ではなく `volcano-vfvo53-aggregator.ts` でバッチ集約される。

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

## テスト

- 電文テストは `test/helpers/mock-message.ts` の `createMockWsDataMessage(fixtureName)` を使う
- フィクスチャは `test/fixtures/` に配置。命名: `{分類番号}_{連番}_{日付}_{電文タイプ}.xml`
- フィクスチャ定数: `FIXTURE_VXSE53_ENCHI` 等 (mock-message.ts で export)
