# standby 永続化の単位別 salvage 契約

> Status: decision-complete draft
>
> Draft date: 2026-08-26
>
> Scope: `src/engine/display/standby-persistence.ts` の load / validation と、salvage 後の診断用退避・canonical 再保存

## 1. 目的

standby 永続化ファイルの一部に壊れた entry があっても、互いに独立して復元できる正常 entry と revision tombstone を失わないようにする。validation 自体は緩めず、不正な値を復元対象へ混ぜるのではなく、検証済みの最小単位だけを残す。

2026-08-09 の Pi では VPWS50 foundation が validation 不合格となり、その domain が破棄された。reader 側の直接原因は 2026-08-11 に修正済みだが、旧 JSON が後続保存で上書きされ、事後診断に必要な原文を回収できなかった。本仕様は次の二点を分けて契約する。

1. load 時の障害半径を、復元可能な最小単位へ狭める。
2. salvage 後の canonical 再保存より前に、診断用の原文を残す。

「salvage」は、raw input の一部を破棄または正規化しつつ、同じファイルの正常部分を返すことをいう。期限切れ sweep、legacy migration、semantic field の既定値補完は、validation 不合格による salvage とは数えない。

## 2. 現状の domain 別挙動

### 2.1 root projection（v1 field と v2 rollback projection）

| field / domain | 現在の不正値処理 | 現在の単位・補足 |
|---|---|---|
| `heat` | **domain 全損** | `heat[]` の 1 entry または nested `areas[]` の 1 area が不正でも `heat=[]` |
| `typhoons` | **domain 全損** | 各 entry は scalar migration も含め個別に parse するが、1 件でも `null` なら全配列を破棄 |
| `volcanoes` | **domain 全損** | `.every(isVolcanoState)`。alert と eruption を同じ火山 entry に保持するため、片側の破損でも全火山を破棄 |
| `tornado` | **domain 全損** | `.every(isTornadoState)`。nested `areas[]` の破損も全官署を巻き込む |
| `longPeriod` | **domain 全損** | `.every(isLongPeriodState)`。`safetyRank` と `maxLgInt` の矛盾 1 件でも全 EventID を破棄 |
| root `seen` | **domain 全損** | `.every(isSeenEntry)`。1 tombstone の破損で他 domain を含む全 revision guard を破棄 |
| `floods` | **単位別 salvage＋warn** | `EventID` state 単位。壊れた EventID と同 key の `seen` を落とし、正常 EventID と無関係な cancellation-only `seen` は残す。container (`events` / `seen`) 自体が配列でなければ洪水全損。raw event が全件不正かつ保全可能な `seen` も 0 件なら、現行は `undefined` を返す |
| `weatherAlerts` | **単位別 salvage＋warn** | `source` (`vpws50` / `vpww56`) 単位。source 内の `alerts[]` は atomic で、壊れた alert はその source だけを落とす。container 自体が非配列なら全損 |
| `quakeHost` | singleton 破棄＋warn | 不正なら `null`。domain に 1 単位しかないため、実質的に単位別 salvage 済み |
| `nankaiTrough` | singleton 破棄＋warn | 不正なら `null`。domain に 1 単位しかないため、実質的に単位別 salvage 済み |

v2 では上記の構造検証後に `standbyDomains.gateEntries` との整合を検査し、gate と一致しない `heat` / `typhoons` / `tornado` / `longPeriod` / `nankaiTrough` projection を個別に filter する。この coupling salvage は現在 warn を出さない。

### 2.2 `telegramFoundation`

| foundation domain | 現在の不正値処理 | 現在の単位・補足 |
|---|---|---|
| `vpws50` | **domain 全損＋warn** | holder state と固定 1 subject の gate が atomic。state、history identity、gate、相互整合のどれかが不正なら `emptyVpws50Foundation()`（`authoritative: true` の空 state）へ落とす |
| `vpww56` | **domain 全損＋warn** | 1 官署の stream / pending subject / gate の不正、重複、集合不一致でも全官署を破棄 |
| `tsunami` | **混在** | keyed EventID active、legacy active、gate subject は局所破棄＋warn。観測 `VTSE51` / `VTSE52` は各配列の `.every()`、whole gate・station gate・重複 code の coupling 不一致で tsunami foundation 全損 |
| `volcano` | **domain 全損＋warn** | legacy `active`、holder `alerts` / `eruptions`、alert / eruption gates が相互参照。1 件の構造不正または coupling 不一致で全火山を破棄 |
| `floodForecast` | **混在** | malformed active / gate entry、重複・上限違反は全損。構造が正しい active と gate の coupling 不一致だけは EventID projection を落として gate を保全し、warn |
| `standbyDomains` | **単位別 salvage、warn なし** | invalid / 未知 policy / subject 不一致 gate を `flatMap` で個別除外。container が不正なら全 watermark を破棄して外側で warn |

`telegramFoundation` 自体が record でない場合、または root envelope の `version` / `savedAt` など単位境界より上が不正な場合は、v2 ファイル全体を不採用とする。v2 各 foundation domain の不採用は、他の foundation domain を巻き込まない。

### 2.3 参照実装の構造

洪水の `sanitizeFloodState()` は次の順で処理する。

1. `events` と `seen` の container 境界を検証する。
2. `events.filter(isFloodEvent)` で正常 EventID state を残す。
3. raw event から識別できた壊れた EventID を集め、同 key の `seen` を落とす。
4. 独立した cancellation-only `seen` は保全する。
5. 件数差があれば 1 回 warn する。

気象警報の `sanitizeWeatherAlertStates()` は container を検証後、`filter(isWeatherAlertState)` で source entry を残し、件数差があれば 1 回 warn する。共通点は「entry validator を変更せず、`.every()` による配列全体の合否を `filter` と集約 warn に置き換える」ことだ。

## 3. 統一契約

### 3.1 基本原則

この節は §3.2 の root collection と §3.3 の全 foundation subject bundle に無条件で適用する。§3.5 の top-level / container / VPWS50 singleton 例外だけは、同じ collection 内に独立した正常単位を証明できないため除く。

1. container が配列であることを確認した後は、1 entry の validation 不合格を理由に同じ collection の正常 entry を破棄してはならない。
2. salvage 単位の内部は atomic とする。nested child だけを残すと既存 invariant を証明できない場合は、child を含む外側単位を落とす。
3. active projection と gate / tombstone が対応する domain は、表示 state より再送防止を弱めない。壊れた active は落としても、独立に妥当性を証明できる cancellation gate / tombstone は残す。
4. identifier を安全に読めない不正 entry は「識別不能 1 件」として捨て、推測で別 entry や gate を削除しない。identifier を読める場合だけ、同一単位の相互参照を連動して処理する。
5. valid entry の順序、値、legacy field の許容、TTL、authority、dual-write、重複 entry の現行扱いは、本仕様だけを理由に変更しない。
6. salvage は schema validation の緩和ではない。validator を通らない raw object を型 assertion だけで復元してはならない。

### 3.2 root の salvage 単位

| field | 統一後の単位 | nested / coupling の扱い |
|---|---|---|
| `heat` | outer `heat[]` entry (`key`) | `areas[]` は entry 内 atomic。不正 area を持つ日付 entry だけを落とす |
| `typhoons` | outer `typhoons[]` entry (`key`) | display snapshot と 4 種の `SpecialValue` migration を一体で検証し、失敗した台風だけを落とす |
| `volcanoes` | 火山 `code` bundle | alert / eruption / revisions / expiry / source IDs を atomic に検証する。いずれかが不正なら当該 code bundle 全体を落とし、他 code は残す |
| `tornado` | `publishingOffice` entry | `areas[]` は官署 entry 内 atomic。集約カード全体ではなく壊れた官署だけを落とす |
| `longPeriod` | `eventId` entry | `maxLgInt` / `safetyRank` / revision / hosted を一体で検証。`hosted` は restore 時に valid `quakeHost.eventId` と再照合する現行 fail-safe を維持 |
| root `seen` | `PersistedSeenEntry` 1 件 (`key`) | 他 key と他 domain の tombstone を巻き込まない。raw key が読めても、不正 revision を他 state の削除根拠にはしない |
| `floods` | EventID bundle | 現行参照実装を維持。壊れた event と同 key の seen は連動除外、独立 cancellation-only seen は保全 |
| `weatherAlerts` | source entry | 現行参照実装を維持。source 内 `alerts[]` は atomic |
| `quakeHost` | singleton | 不正時 `null`。正常な long-period entry は残し、restore 時に `hosted=false` へ安全側補正 |
| `nankaiTrough` | singleton | 不正時 `null` |

v2 の gate coupling filter も同じ salvage report に含め、構造不正と区別して warn する。

### 3.3 foundation の salvage 単位

foundation は本仕様の統一対象である。raw array 単位ではなく、次の subject bundle で整合を判定する。

| foundation domain | salvage 単位 | 保全規則 |
|---|---|---|
| `vpws50` | `weather:vpws50` singleton | 1 subject しかないため、不整合時の domain 全損は例外として残る。正常な部分だけで holder / gate 整合を証明できない |
| `vpww56` | 官署 `stateSubjectKey` | 同 subject の stream または pending marker と gate を bundle 化。不正 bundle だけを落とし、他官署と妥当な cancellation gate を残す |
| tsunami VTSE41 | EventID subject | keyed active と gate を bundle 化。壊れた active の subject が識別できる場合、その active と非取消 gate を落とす。独立 cancellation gate は残す |
| tsunami observation | revision family 内の `stationCode` bundle | station observation と station gate を一体で扱う。whole-family gate が不正ならその family (`VTSE51` または `VTSE52`) だけを落とし、他 family と VTSE41 を残す |
| `volcano` | 火山 `code` bundle | root active projection、holder alert / eruption、両 family の対応 gate を同じ code の atomic bundle として検証する。不正なら当該 code bundle 全体を落とし、他 code を巻き込まない |
| `floodForecast` | EventID bundle | malformed entry も coupling mismatch と同じ EventID 障害半径へ縮小。妥当な cancellation gate と他 EventID を残す |
| `standbyDomains` | gate `stateSubjectKey` | 現行の局所 filter を維持し、除外時の warn を追加 |

subject が識別不能な entry はその entry だけを除外する。重複 subject は、既存コードに明示された安全な revision 比較がある場合だけ 1 件へ集約する。それ以外は競合した subject bundle 全体を落とし、配列中の無関係 subject は残す。件数上限違反は、既存 policy に順序付き末尾保持が定義されている場合だけその policy で bounded 化し、任意の切り捨てを新設しない。

### 3.4 warn 文言規約

warn は raw payload や巨大な identifier を出さない。1 回の file load につき `(source, domain)` ごとに 1 行だけ出し、`discarded` / `retained` は raw entry 数ではなく salvage **bundle 数**とする。文言はテスト可能な固定 token とする。

```text
[standby-persistence] salvage source=<basename> domain=<domain> unit=<unit> discarded=<n> retained=<n> reason=<reason>
[standby-persistence] discard source=<basename> domain=<domain> unit=domain reason=<reason>
```

- `source` は parse に使った file path の basename だけを使う。fallback v1 / canonical v2 は別 source として報告する。
- `domain` は `root.heat`, `root.typhoons`, `root.volcanoes`, `root.tornado`, `root.longPeriod`, `root.seen`, `root.floods`, `root.weatherAlerts`, `root.quakeHost`, `root.nankaiTrough`, `foundation.vpws50`, `foundation.vpww56`, `foundation.tsunami`, `foundation.volcano`, `foundation.floodForecast`, `foundation.standbyDomains` の閉じた語彙を使う。
- `unit` は `entry`, `source`, `eventId`, `code`, `subject`, `stationCode`, `family`, `singleton`, `domain` の閉じた語彙を使う。`domain` は discard 行（container 破損・§3.5 の例外による domain 全体破棄）専用で、salvage 行には使わない。各 domain の対応は次表で固定する。
- `reason` は `invalid-entry`, `invalid-container`, `coupling-mismatch`, `duplicate-subject`, `limit-exceeded` の閉じた語彙を使う。複数 reason がある場合は `invalid-container` → `invalid-entry` → `duplicate-subject` → `coupling-mismatch` → `limit-exceeded` の優先順位で 1 つだけを出す。個別 reason の全件分布は repair report に残す。
- `discard` は信頼できる単位境界がない container 破損、singleton、または §3.5 の例外だけに使う。
- 0 件を捨てた通常 load、field 欠落を許す既存 migration、期限切れ sweep では warn しない。

| domain | `unit` token |
|---|---|
| `root.heat`, `root.typhoons`, `root.tornado`, `root.longPeriod`, `root.seen` | `entry` |
| `root.volcanoes`, `foundation.volcano` | `code` |
| `root.floods`, `foundation.floodForecast`, `foundation.tsunami` VTSE41 | `eventId` |
| `root.weatherAlerts` | `source` |
| `root.quakeHost`, `root.nankaiTrough`, `foundation.vpws50` | `singleton` |
| `foundation.vpww56`, `foundation.standbyDomains` | `subject` |
| `foundation.tsunami` VTSE51 / VTSE52 observation | `stationCode`。family gate だけを落とす場合は `family` |

### 3.5 全損に留める例外

次は正常 entry の境界または相互整合を証明できないため、全損を許す。

1. JSON parse 失敗、unsupported `version`、top-level envelope 不正。ファイル全体を不採用とする。
2. domain collection の container 自体が配列でない場合。その domain を空にし、他 domain は復元する。
3. `telegramFoundation` 自体が record でない場合。v2 の foundation を構成できないため、現行どおり v2 ファイルを不採用とする。
4. VPWS50 foundation。固定 1 subject なので salvage 単位と domain が同一である。
5. identifier / gate / active の対応を分離不能な bundle。その bundle 全体は落としてよいが、識別できる他 bundle まで落としてはならない。

## 4. salvage 後の原文退避と再保存

### 4.1 必須順序と backup 成功条件

salvage または validation discard が 1 件でも発生した load は、source 別 repair report を保持する。reader は JSON parse に渡した同一の raw `Buffer` を report へ保持し、後から path を再読して backup bytes を作ってはならない。canonical state の再保存は次の順を守る。

1. 採用・fallback 判定に使った各入力 source のうち、内容を破棄または変更した source の captured bytes を同一ディレクトリへ退避する。
2. source ごとに `wx` 相当の非上書き create、全 bytes の write、file `fsync`、close、利用可能な platform での directory `fsync` を完了して初めて backup 成功とする。directory `fsync` 非対応は capability として起動時に一度だけ記録し、file `fsync` の成功を妨げない。対応環境での directory `fsync` 失敗は backup 失敗である。
3. standby store、各 foundation holder、revision gate への restore と起動時 sweep を完了する。
4. backup が全 source で成功した場合だけ、restore 後の最新 export を通常の v1/v2 dual-write 経路へ 1 回渡し、salvage 済み canonical state を保存する。

backup 名は元 basename、UTC timestamp、衝突回避 suffix を含む `.salvage-backup` とし、captured bytes を JSON parse / pretty-print せず byte-for-byte write する。自動削除は本仕様の対象外とし、診断資料を retention 判断なしに消さない。

backup に失敗した場合は write block に入り、runtime は salvaged memory state で起動を続ける。**各** `save()` / `schedule()` の実書き込み / `flush()` の直前に、未退避 source の captured bytes を再退避する。全 source が成功した最初の時点で write block を解除し、途中の古い予約を捨てて最新 pending state を 1 件だけ保存する。成功まで v1 / v2 の rename は一切行わない。

backup-blocked warn は source ごとに初回、以後は 60 秒に 1 回以下とし、`source=<basename> attempts=<n> blockedMs=<n>` を含める。process counter `persistenceSalvageBackupBlocked`、成功解除 counter `persistenceSalvageBackupRecovered`、未退避 source 件数を既存の monitor diagnostics / stats へ出し、運用側が memory-only 状態を識別できるようにする。

load が一切の salvage / discard を行わなかった場合は eager rewrite しない。両候補とも不採用で `load() === null` の場合も、空 state を推測して書き戻さない。

## 5. 確定裁定

1. foundation を含む全 standby persistence domain に §3 の単位別 salvage を適用する。VPWS50 は固定 1 subject の singleton 例外である。
2. volcano は `code` 単位の atomic bundle とする。alert / eruption の片側だけを再構成しない。
3. canonical 再保存は raw backup の成功後、全 holder / gate restore と起動 sweep の直後に 1 回予約する。
4. backup 失敗中は write block とし、各 write 前に再試行する。成功時は最新 pending state 1 件を保存して block を解除する。

## 6. 変更単位

### 単位 1: root collection の salvage 共通化

- `src/engine/display/standby-persistence.ts`
- `test/engine/display/standby-persistence.test.ts`

洪水・気象警報を参照形として、残存 6 field を outer entry filter＋集約 warn へ変更する。valid / invalid / all-invalid / invalid-container、root seen の他 domain tombstone 保全、longPeriod と quakeHost の非 atomic restore を検証する。

### 単位 2: foundation subject bundle

- `src/engine/display/standby-persistence.ts`
- `test/engine/messages/vpws50-foundation.test.ts`
- `test/engine/telegram-foundation/phase3b-vpww56.test.ts`
- `test/engine/telegram-foundation/phase3b-tsunami.test.ts`
- `test/engine/telegram-foundation/phase3b-volcano.test.ts`
- `test/engine/telegram-foundation/phase3b-flood.test.ts`
- `test/engine/telegram-foundation/phase3b-standby-domains.test.ts`

domain ごとに raw entry を subject bundle へ分類してから、構造・重複・coupling を検証する。正常 subject、cancellation gate、他 foundation domain の独立性、volcano code bundle の atomic discard を fixture で証明する。

### 単位 3: repair report と raw backup

- `src/engine/display/standby-persistence.ts`
- `test/engine/display/standby-persistence.test.ts`

load 中の salvage / discard を source file 別に集約し、最初の post-load write より前に byte-for-byte backup を作る。v2 canonical、standalone v1 fallback、両方に異常があるケース、backup 名衝突、backup 失敗時の write block、正常 load で backup が増えないことを検証する。

### 単位 4: restore 後の canonical rewrite と診断可視化

- `src/engine/monitor/monitor.ts`
- `test/engine/display/standby-wiring.test.ts`
- `src/engine/messages/message-router.ts`（実装時裁定 2026-08-26: D4-A の「運用可視化」の機械的必然として、salvage backup 診断 3 指標＝blocked 侵入・実解除 recovered・pending source 数を `buildDisplayStats()` 系へ additive 接続するために対象へ追加）
- `src/engine/display/protocol.ts`（同上: `DisplayStatsV1` への additive field 追加。engine⇔frontend protocol sync 区間の byte-for-byte 一致が必要な場合は `display/frontend/src/lib/protocol.ts` の mirror 行と `test/engine/display/protocol-sync.test.ts` も同裁定で対象に含める。additive のみ・既存 field 非変更）

standby store、VPWS50 / VPWW56 / tsunami / volcano / flood holder、revision gate の restore と起動時 sweep より後、dmdata 接続開始より前に repair rewrite を 1 回だけ予約する。通常 load では追加 write を発生させない。

依存順は `1 → 2 → 3 → 4` とする。

## 7. 完了条件と検証

- mixed-validity collection で、不正単位だけが落ち、正常単位の値と順序が維持される。
- container が正常で全 bundle が不正の場合、repeated root domain は空の present domain を返す。具体的に `heat` / `typhoons` / `volcanoes` / `tornado` / `longPeriod` / `seen` / `weatherAlerts` は `[]`、`floods` は `{ events: [], seen: [] }` とする。`undefined` は container 不正または旧 field 欠落の既存互換にだけ使う。
- active / gate / tombstone の相互参照を持つ domain で、壊れた active から古い再送が復活せず、妥当な cancellation-only watermark が残る。
- warn が §3.4 の固定形式・集約件数で出て、通常 load では出ない。
- salvage 対象 source の backup は JSON parse に使った同一 Buffer と byte-for-byte 一致し、`wx` create・全量 write・file fsync・対応環境での directory fsync 成功前には v1 / v2 のどちらも rename されない。
- backup 失敗中は各 save / flush 前に再試行し、warn rate limit と blocked / recovered diagnostics が働く。成功後は最新 pending state だけを 1 回保存し、再起動後に同じ salvage warn / backup を増やさない。
- JSON parse 失敗、unsupported version、invalid container、VPWS50 singleton の fail-closed は §3.5 のまま維持される。

実装時の必須検証コマンド:

```bash
npm run build
npm test
npm run test:shuffle
npm run typecheck:test
git diff --check
```

永続化・共有状態・起動 restore 順を触るため、`npm run test:shuffle` は省略不可とする。`npm run typecheck:test` が段階導入範囲外の既存理由で失敗する場合も成功扱いにせず、対象内外を切り分けて blocked と報告する。

## 8. 非対象・既存挙動保存

- parser、router、formatter、notifier、telegram-foundation の電文受理規則は変更しない。
- persistence schema version と JSON field を、本仕様だけを理由に増やさない。repair report は process 内状態と log / backup file で扱う。
- save debounce、tmp＋rename の atomic write、seq による新旧逆転防止、v1/v2 dual-write、migration conflict telemetry を維持する。
- expiry、最大 subject 数、semantic key compaction、legacy adapter、authority 昇格条件を変更しない。
- salvage 時に raw entry を自動修正したり、未知 field / 値から identifier を推測したりしない。
- backup の自動 upload、長期 retention、自動削除、CLI の診断コマンド追加は対象外とする。
- `docs/specs/telegram-foundation.md` は変更しない。
