import type { MaterialValue, Operation } from "./p1-parser-boundary.types";
import type { DisplayRemoval, LossTally, MarkViewed, RuntimeUnitId, UnreadableCardView } from "./p2-shared-runtime.types";
import type {
  DisplayAreaSystem,
  DisplayChannelView,
  DisplayConnectionView,
  DisplayRecoveryView,
  DisplaySummaryItem,
  DisplayWorkerView,
  VisibleNotice,
} from "./p2-snapshot-sse.types";
import type { PersistenceStatus, UnitId } from "./p2-shared-runtime.types";
import type { TsunamiAreaClass, TsunamiForecastArea, TsunamiObservationFamily, TsunamiStation, TsunamiUnkeyedArea } from "./p3-tsunami-unit.types";
import type { EewPredictionIntensity } from "./p2-eew-unit.types";
import type { EewReportArea } from "./p3-eew-facts.types";
import type { EarthquakeEventView, LongPeriodSubject, SeismicIntensityItem, SeismicIntensityObservation } from "./p3-seismic-unit.types";
import type { WeatherTimeseriesDetailError } from "./p2-weather-timeseries-unit.types";
import type { TyphoonFrame } from "./p3-typhoon-unit.types";
import type { FloodStation } from "./p3-flood-unit.types";

// P4-DISPLAY-WIRE-001（B0）: 新しい経路が配る表示の wire（保護 3 分野と今の型のままの共通部）。
// 鍵の名前は表 p4-display-wire-tables.md の付録 A と script p4-display-wire-max.mjs と同じ（型の最大値の試験が script の数と照らす、P4-DW-AC04）。
// 字は text node でだけ入れる前提で、HTML・SVG path・投影後の座標・生 XML は入れない（P4-DW-AC11、spec §8.1）。

// 段の番号（表 §1.2）: 0〜9 が震度 0〜7、10 が over（To だけ）、−1 が不明、−2 が表外の値、欠けは null。
export type DisplayLevel = number | null;
// 上限（escape 後の byte、P4-DW-D-STRING-SOURCE）で切った字と切った印。
export type DisplayCutText = Readonly<{ text: string; cut: boolean }>;
// M・深さの値と description（P4-DW-AC09）。
export type DisplayValueText = Readonly<{ v: string; desc: string | null; cut: boolean }>;
// 詳細の参照（P4-DW-AC08）: id は sha256([unit, operation, subject]) の hex、rev はその part が返す view の object の JSON の sha256 の hex。
export type DisplayDetailRef = Readonly<{ id: string; rev: string }>;
export type DisplayStateMark = "unconfirmed" | "restored" | "expiryPending" | "capacityExceeded";
export type DisplayFromTo = Readonly<{ f: DisplayLevel; t: DisplayLevel }>;
// 合成の 1 区域 [コード, 段]（区域名は描画の側が G0 の表から引く、P4-DW-D-COMPOSITE）。
export type DisplayPaint = readonly [code: string, level: number];

// ---- EEW（表 §1.2） ----
export type EewCardLetter = "A" | "B" | "C" | "D" | "E" | "F";
export type EewCardHeader = Readonly<{
  eventId: string; operation: Operation; letter: EewCardLetter; warning: boolean; serial: number; final: boolean;
  reportTime: string | null; max: DisplayFromTo; hypo: DisplayCutText | null; mag: DisplayValueText | null; depth: DisplayValueText | null;
  epi: DisplayCutText | null; assumed: boolean; detectOnly: boolean; place: DisplayCutText | null; lg: DisplayFromTo; unread: boolean;
  marks: readonly DisplayStateMark[]; unknownAreas: number; dupAreas: number; ref: DisplayDetailRef;
}>;
// 区域の Condition はコード（P4-DW-D-CONDITION-CODE）、到達の状況は Kind/Code の下 1 桁（0・1・9、表外は −2）。
export type EewAreaRow = Readonly<{ c: string; f: DisplayLevel; t: DisplayLevel; cd: "arrived" | "unknown" | null; ks: 0 | 1 | 9 | -2 | null;
  at: string | null; lg: DisplayFromTo }>;
// 1 件のときは大カードの行、2 件以上のときは最小の欄（「以上」は ＋10）、2 件のときは上位 2 行も。
export type EewMini = readonly [code: string, level: DisplayLevel];
export type EewCard = EewCardHeader & (Readonly<{ rows: readonly EewAreaRow[] }> | Readonly<{ mini: readonly EewMini[]; top?: readonly EewAreaRow[] }>);
// composites は塗る区分ごとに 1 枚（P4-DW-D-OPERATION=A で通常の 1 枚だけ）。omitted はカードに出ない EEW の件数。
export type EewWire = Readonly<{ cards: readonly EewCard[]; composites: readonly (readonly DisplayPaint[])[]; omitted: number }>;

// ---- 津波 ----
export type TsunamiForecastRow = Readonly<{ c: string; k: TsunamiAreaClass; first: Readonly<{ raw: string | null; cond: DisplayCutText | null }>;
  h: Readonly<{ raw: string; cut: boolean }> | null }>;
export type TsunamiUnkeyedRow = Readonly<{ name: DisplayCutText; k: TsunamiAreaClass }>;
export type TsunamiForecastWire = Readonly<{
  eventId: string; operation: Operation; serial: number; reportTime: string | null; comment: DisplayCutText | null; unread: boolean;
  marks: readonly DisplayStateMark[]; omittedUnkeyed: number; unknownAreas: number; dupAreas: number; ref: DisplayDetailRef;
  rows: readonly TsunamiForecastRow[]; unkeyed: readonly TsunamiUnkeyedRow[];
}>;
// 閉じた印は開ける part が無いので詳細の参照を持たない（統合担当の決め 2026-11-21）。
export type TsunamiClosedWire = Readonly<{ eventId: string; family: TsunamiObservationFamily; closedAt: number }>;
export type TsunamiWire = Readonly<{
  forecasts: readonly TsunamiForecastWire[]; omittedEvents: number;
  composites: readonly Readonly<{ forecast: readonly (readonly [code: string, cls: TsunamiAreaClass])[]; observed: readonly (readonly [code: string, height: string])[] }>[];
  // 3 区分とも、normal・training・test の順（塗る区分の選び方によらない）。
  closed: readonly Readonly<{ items: readonly TsunamiClosedWire[]; omitted: number }>[];
}>;

// ---- 地震 ----
// 日次行の ref の rev は同じ snapshot に event があるときだけ（表 §5.6）。
export type EarthquakeRowWire = Readonly<{
  eventId: string; operation: Operation; origin: string | null; reportTime: string | null; hypo: DisplayCutText | null;
  mag: DisplayValueText | null; depth: DisplayValueText | null; maxInt: DisplayLevel; cancelled: boolean; tsunami: DisplayCutText | null;
  strongest: readonly string[]; omittedStrongest: number; marks: readonly DisplayStateMark[]; unknownAreas: number;
  ref: Readonly<{ id: string; rev: string | null }>;
}>;
export type LongPeriodWire = Readonly<{ eventId: string; operation: Operation; reportTime: string | null; maxLg: DisplayLevel;
  marks: readonly DisplayStateMark[]; unknownAreas: number; ref: DisplayDetailRef }>;
export type EarthquakeWire = Readonly<{
  rows: readonly EarthquakeRowWire[];
  daily: readonly Readonly<{ operation: Operation; count: number; maxInt: DisplayLevel }>[];
  composites: readonly Readonly<{ areas: readonly DisplayPaint[]; unknownAreas: number }>[];
  longPeriods: readonly LongPeriodWire[]; omittedLongPeriods: number;
  longPeriodComposites: readonly Readonly<{ areas: readonly DisplayPaint[]; unknownAreas: number }>[];
}>;

// 読めない報のカード（H43）。題と見出しは画面へ送るときに切る（P4-DW-D-CARD-TEXT=A、保存の 1,536 byte は変えない）。
export type DisplayWireCard = Omit<UnreadableCardView, "title" | "headline"> & Readonly<{ title: DisplayCutText | null; headline: DisplayCutText | null }>;
// 分野の wrapper（unit・contentRevision・items は今の DisplayDomainView と同じ）。
export type DisplayWireDomain<Unit extends RuntimeUnitId, Wire> = Readonly<{
  unit: Unit; contentRevision: string; items: readonly [DisplaySummaryItem, DisplaySummaryItem, DisplaySummaryItem];
  wire: Wire; cards: readonly DisplayWireCard[];
}>;

// 新しい経路の版（旧の 1 とは別の値）。描画の側は自分の版でない snapshot を描かず非対応を出す（spec §8.3）。
export type DisplayWireVersion = "p4-display-wire-v3";
export type DisplayWireSnapshot = Readonly<{
  schemaVersion: DisplayWireVersion;
  streamId: string;
  sequence: number;
  generatedAt: string;
  semanticRevision: string;
  connection: DisplayConnectionView;
  worker: DisplayWorkerView;
  persistence: Readonly<Partial<Record<UnitId, PersistenceStatus>>>;
  recovery: DisplayRecoveryView;
  channels: Readonly<Record<"desktop" | "sound", DisplayChannelView>>;
  current: Readonly<{
    eew: DisplayWireDomain<"U-E", EewWire>;
    tsunami: DisplayWireDomain<"U-T", TsunamiWire>;
    earthquake: DisplayWireDomain<"U-Q", EarthquakeWire>;
    weatherCurrent: DisplayVocabDomain<"U-W">;
    weatherTimeseries: DisplayVocabDomain<"U-F">;
    nankai: DisplayVocabDomain<"U-N">;
    volcano: DisplayVocabDomain<"U-V">;
    landslide: DisplayVocabDomain<"U-L">;
    flood: DisplayVocabDomain<"U-R">;
    briefing: DisplayVocabDomain<"U-B">;
    localBulletins: DisplayVocabDomain<"U-M">;
    typhoon: DisplayVocabDomain<"U-Y">;
  }>;
  notices: readonly VisibleNotice[]; removals: DisplayRemovalWire; losses: DisplayLossWire; // removals・losses: 消えた理由の一覧と H39 の欄（P4-REMOVAL-LOSS-001、file の末尾）
}>;

// ---- 詳細の要求と応答（P4-DW-AC08、表 §2。応答の payload は分野ごとの DTO、P4-DW-D-DETAIL-PAYLOAD=B） ----
// 要求は operation を持たない（id の sha256 に入る、U-W の要求と同じ）。page は 0 から。
export type WireDetailRequest =
  | Readonly<{ unit: "U-T" | "U-Q" | "U-N" | "U-V" | "U-M" | "U-L" | "U-R" | "U-B" | "U-Y"; part: "index"; revision: string; page: number }>
  | Readonly<{ unit: "U-E"; part: "areas"; id: string; revision: string; page: number }>
  | Readonly<{ unit: "U-T"; part: "areas" | "stations"; id: string; revision: string; page: number }>
  | Readonly<{ unit: "U-T"; part: "comment"; id: string; revision: string }>
  | Readonly<{ unit: "U-Q"; part: "event"; id: string; revision: string; page: number }>
  // 読めない報のカードの原文: id はカードの inputId、revision は receivedAt の 10 進（表 §2.3 の例外）。
  | Readonly<{ unit: RuntimeUnitId; part: "raw"; id: string; revision: string }>
  // 9 分野の切らない語彙の項目 1 件と、読めない印の部分の原文（P4-DV-AC12）。id と revision は snapshot の項目の id と rev。
  | Readonly<{ unit: VocabUnit; part: "item"; id: string; revision: string }>
  | Readonly<{ unit: VocabUnit; part: "unreadable"; id: string; revision: string }> | Readonly<{ unit: RuntimeUnitId; part: "losses"; revision: string }>; // losses: H39 の理由の行（P4-RL-AC08 (7)、revision は H39 の欄の rev）

export type EewAreaDetail = Readonly<{ code: string; intensity: EewPredictionIntensity; report: EewReportArea | null }>;
// 索引の項目: 保護 2 分野は part への参照、7 分野は切らない語彙の項目（本文の参照は項目の ref、P4-DV-AC05）。
export type WireIndexEntry =
  | Readonly<{ id: string; revision: string; operation: Operation; part: "areas" | "stations" | "comment" | "event" }>
  | Readonly<{ id: string; revision: string; operation: Operation; part: "item"; item: VocabIndexItem }>;
export type WireOmitted = Readonly<{ index: number; reason: "pageBudget" }>;
// 7 分野の索引で 1 件だけで 1 応答に入らない項目の印（P4-DV-D-ITEM-OVERSIZE=A。part=item も 503 になる）。
export type WireIndexOmitted = WireOmitted | (WireOmitted & Readonly<{ id: string; revision: string }>);
// part=unreadable の 1 つの印（side は陸上の印か U-V の警報の海上の印）。parts は欠片の鍵 (site, scope) ごとに 1 件（P4-DV-AC12）。
export type WireUnreadableSide = Readonly<{ side: "land" | "marine"; parts: readonly Readonly<{ site: string; scope: string | null; raw: string | null }>[];
  headline: string | null }>;
type WirePage<Part extends string, Item> = Readonly<{ kind: "ok"; part: Part; revision: string; page: number; pageCount: number; itemCount: number;
  items: readonly Readonly<{ index: number; item: Item }>[]; omitted: readonly WireOmitted[] }>;
export type WireEventHeader = Omit<EarthquakeEventView, "intensity"> & Readonly<{ intensity: Omit<SeismicIntensityObservation, "items"> | null }>;
// 長周期の見出しの ref で開く形（U-Q の view の長周期の記録から震度の要素を除いたもの）。
export type WireLongPeriodHeader = Omit<MarkViewed<LongPeriodSubject>, "intensity"> & Readonly<{ intensity: Omit<SeismicIntensityObservation, "items"> | null }>;
// 見出しが 1 応答の予算に入らないときに値を外した欄（null・空にするか欄ごと消す）。
export type WireOmittedField = "hypocenter" | "headline" | "title" | "tsunamiComment" | "sources" | "unreadableView" | "unavailable" | "cancelledSummary" | "strongHold";
export type WireDetailResponse =
  // 索引は U-W の索引と同じ欄の名（entries）。入らない項目は omitted の index で示す。
  | Readonly<{ kind: "ok"; part: "index"; revision: string; page: number; pageCount: number; entryCount: number; entries: readonly WireIndexEntry[]; omitted: readonly WireIndexOmitted[] }>
  | (WirePage<"areas", EewAreaDetail | TsunamiForecastArea | TsunamiUnkeyedArea> & Readonly<{ id: string }>)
  | (WirePage<"stations", TsunamiStation> & Readonly<{ id: string }>)
  | (WirePage<"event", SeismicIntensityItem> & Readonly<{ id: string; event: WireEventHeader | WireLongPeriodHeader; omittedFields: readonly WireOmittedField[] }>)
  | Readonly<{ kind: "ok"; part: "comment"; id: string; revision: string; text: string }>
  | Readonly<{ kind: "ok"; part: "raw"; id: string; revision: string; raw: string | null; rawCut: boolean; rawDropped: boolean }>
  | Readonly<{ kind: "ok"; part: "item"; id: string; revision: string; item: VocabItem }>
  | Readonly<{ kind: "ok"; part: "unreadable"; id: string; revision: string; sides: readonly WireUnreadableSide[] }>
  | Readonly<{ kind: "ok"; part: "losses"; unit: RuntimeUnitId; revision: string; rows: readonly LossTally[] }>
  | WeatherTimeseriesDetailError;

// ---- 9 分野の語彙（P4-DISPLAY-VOCAB-001、表 §1） ----
// 描画は k と label・role で描き分け、分野の名前で分けない（R46）。label・role・cols・special は k ごとの閉じた語で、型に無い語は作れない（spec:1268）。
export type VocabUnit = "U-W" | "U-F" | "U-N" | "U-V" | "U-L" | "U-R" | "U-B" | "U-M" | "U-Y";
// U-V の噴煙の値（表 §1.3 の sv）。kind ごとに value・bound・raw の入り方が決まる。
export type VocabMaterial = readonly [tag: "sv", kind: MaterialValue["kind"], value: number | string | null, bound: "lower" | "upper" | null, raw: string | null];
export type VocabValue = string | number | boolean | null | DisplayCutText | VocabMaterial;
export type VocabFact<Label extends string> = readonly [label: Label, value: VocabValue];
export type VocabCell = string | number | boolean | null | DisplayCutText;
// rows は [鍵, 名前 か null, ...値] で、値の欄の名は cols に 1 回だけ書く。sys は鍵が区域 Code のときだけその層。
export type VocabList<Role extends string, Col extends string = never, Fact extends string = never> = Readonly<{ role: Role; label: string | null;
  sys: DisplayAreaSystem | null; cols: readonly Col[]; facts: readonly VocabFact<Fact>[]; rows: readonly (readonly VocabCell[])[]; omitted: number }>;
type MarkList<Role extends "unreadable" | "marineUnreadable"> = VocabList<Role, "scope" | "raw", "headline" | "addition" | "rawDropped" | "partsCut">;
// 詳細を開く参照（表 §5.2）。ほかの 13 種は null。
export type VocabRef = Readonly<{ part: "areas" | "current" | "text"; id: string; rev: string }>;
type Source = "source.family" | "source.infoType";
type Shape<Fact extends string, List, Text extends string, Special> = Readonly<{ fact: Fact; list: List; text: Text; special: Special }>;
type Unread = MarkList<"unreadable">;
type Codes<Role extends string> = VocabList<Role>;
type VocabShapes = {
  "weatherCurrent.area": Shape<Source | "prefecture" | "cellCount" | "restoredCellCount", Codes<"areas"> | VocabList<"phenomena", "areaCount">, never, null>;
  "weatherTimeseries.subject": Shape<Source | "office" | "effective" | "unavailableReason" | "validUntil" | "unknownCode.unknown" | "unknownCode.missing"
    | "unknownCode.empty" | "periodCount" | "lastKnownPeriodCount", Codes<"areaCodes"> | Codes<"knownCodes"> | Unread, never, null>;
  "nankai.current": Shape<Source | "eventId" | "retainUntil" | "line" | "status" | "warningUntil" | "infoSerial.code" | "infoSerial.name" | "truncated"
    | "validUntil", Unread, "headline", null>;
  "nankai.information": Shape<Source | "family" | "eventId" | "retainUntil" | "infoKind" | "infoSerial.code" | "infoSerial.name" | "truncated" | "validUntil",
    Unread, "headline", null>;
  "volcano.alert": Shape<Source | "volcanoCode" | "eventId" | "marineSource.time" | "marineSource.serial" | "marineSource.family" | "marineSource.infoType"
    | "landKind.code" | "landKind.name" | "landKind.condition" | "marineKind.code" | "marineKind.name" | "marineKind.condition" | "retainUntil"
    | "marineUnconfirmed" | "volcanoName" | "kind.code" | "kind.name" | "kind.condition" | "lastKind.code" | "lastKind.name" | "level" | "coordinate"
    | "truncated" | "marineUnread", Codes<"municipalities"> | Codes<"marineAreas"> | Unread | MarkList<"marineUnreadable">, "headline" | "prevention", null>;
  "volcano.eruption": Shape<Source | "volcanoCode" | "eventId" | "retainUntil" | "volcanoName" | "flash" | "phenomenon.code" | "phenomenon.name"
    | "eventDateTimeRaw" | "craterName" | "plumeAboveCrater" | "plumeAboveSeaLevel" | "plumeDirection" | "truncated" | "validUntil",
    Codes<"municipalities"> | Unread, "headline", null>;
  "volcano.ashfall": Shape<Source | "volcanoCode" | "eventId" | "retainUntil" | "volcanoName" | "variant" | "forecastStartsAt" | "forecastEndsAt"
    | "omittedGroupCount" | "truncated", VocabList<"ashGroup", "firstForecastEndAt", "hazardClass" | "ashCode" | "areaCount"> | Unread, "headline", null>;
  "volcano.bulletin": Shape<Source | "family" | "eventId" | "retainUntil" | "extraordinary" | "truncated", Codes<"volcanoCodes"> | Unread, "headline", null>;
  "volcano.shortfall": Shape<"id" | "slice" | "scope" | "volcanoCode" | "lastKnown.reportDateTimeRaw" | "lastKnown.serialRaw" | "reason", never, never, null>;
  "landslide.office": Shape<Source | "office" | "retainUntil" | "truncated", VocabList<"kinds", never, "code" | "level"> | Unread, never, null>;
  "flood.event": Shape<Source | "headType" | "eventId" | "retainUntil" | "areaName" | "inundation" | "basisReportDateTimeRaw" | "truncated",
    VocabList<"kinds", never, "code" | "level"> | VocabList<"inundation", "stationCode" | "prefecture" | "city" | "subCities", "text"> | Unread, never,
    Readonly<{ kind: "floodSeries"; times: readonly string[]; stations: readonly FloodStation[] }>>;
  "briefing.current": Shape<Source | "series" | "retainUntil" | "headType" | "eventId" | "inherited" | "effective" | "editorialOffice" | "truncated",
    VocabList<"items", never, "kind" | "condition"> | VocabList<"observations", "part" | "label" | "value" | "unit" | "approximation" | "time"> | Codes<"areas">
    | Unread, "headline", null>;
  "localBulletins.tornado": Shape<Source | "retainUntil" | "activeUntil" | "editorialOffice" | "sighted" | "truncated", VocabList<"areas", "layer"> | Unread,
    "headline", null>;
  "localBulletins.heat": Shape<Source | "retainUntil" | "activeUntil" | "targetDate" | "editorialOffice" | "areaName" | "truncated", Unread, "headline", null>;
  "localBulletins.transient": Shape<Source | "family" | "retainUntil" | "visibleUntil" | "editorialOffice" | "truncated", Codes<"areas"> | Codes<"tags"> | Unread,
    "headline", null>;
  "typhoon.analysis": Shape<Source | "retainUntil" | "activeUntil" | "baseTime" | "name.name" | "name.nameKana" | "name.number" | "name.remark" | "truncated",
    Unread, never, Readonly<{ kind: "typhoonFrames"; frames: readonly TyphoonFrame[] }>>;
  "typhoon.probability": Shape<Source | "retainUntil" | "activeUntil" | "baseTime" | "slotCount" | "name.name" | "name.nameKana" | "name.number" | "name.remark"
    | "maxFiveDay" | "truncated", Codes<"prefectures"> | VocabList<"areas", "prefectureCode" | "d1" | "d2" | "d3" | "d4" | "d5" | "peak" | "peakSlot"> | Unread,
    never, null>;
};
export type VocabKind = keyof VocabShapes;
export type VocabUnitKinds = {
  "U-W": "weatherCurrent.area"; "U-F": "weatherTimeseries.subject"; "U-N": "nankai.current" | "nankai.information";
  "U-V": "volcano.alert" | "volcano.eruption" | "volcano.ashfall" | "volcano.bulletin" | "volcano.shortfall"; "U-L": "landslide.office"; "U-R": "flood.event";
  "U-B": "briefing.current"; "U-M": "localBulletins.tornado" | "localBulletins.heat" | "localBulletins.transient"; "U-Y": "typhoon.analysis" | "typhoon.probability";
};
// 語彙の項目（表 §1.2）。id は sha256([unit, operation, subject])、rev は view の object の JSON の sha256（U-W・U-F は公開形の revision）。
export type VocabItemOf<K extends VocabKind> = K extends VocabKind ? Readonly<{
  id: string; rev: string; k: K; op: Operation; title: string | null; time: string | null; serial: string | null; marks: readonly DisplayStateMark[];
  unread: boolean; ref: VocabRef | null; facts: readonly VocabFact<VocabShapes[K]["fact"]>[]; lists: readonly VocabShapes[K]["list"][];
  texts: readonly (readonly [role: VocabShapes[K]["text"], text: string])[]; special: VocabShapes[K]["special"];
}> : never;
export type VocabItem = VocabItemOf<VocabKind>;
// 索引に出る 15 種（unit ごとの種類は VocabUnitKinds で縛る）。
export type VocabIndexUnit = Exclude<VocabUnit, "U-W" | "U-F">;
export type VocabIndexItem<Unit extends VocabIndexUnit = VocabIndexUnit> = VocabItemOf<VocabUnitKinds[Unit]>;
// items は id の昇順。facts は分野に 1 つの値（U-W の freshnessSuspectCount だけ）。
export type VocabWire = Readonly<{ items: readonly VocabItem[]; facts: readonly VocabFact<"freshnessSuspectCount">[] }>;
// 9 分野の包み（表 §1.1）。要約は旧の要約と同じ形でカードを持たない（P4-DV-D-SUMMARY-RULE）。
export type DisplayVocabDomain<Unit extends VocabUnit> = Readonly<{ unit: Unit; contentRevision: string; items: readonly [DisplaySummaryItem, DisplaySummaryItem, DisplaySummaryItem] }> & (
  | Readonly<{ delivery: "full"; wire: VocabWire; cards: readonly DisplayWireCard[] }>
  | Readonly<{ delivery: "summary"; reason: "snapshotBudget"; originalBytes: number; budgetBytes: number }>);

// ---- 消えた理由の一覧と H39 の欄（P4-REMOVAL-LOSS-001、表 §3） ----
// 一覧の 1 件（P4-RL-AC08 (2)）。id は B0 の ref と同じ sha256([unit, operation, subject])、at は射影した時の publisher の wall。markCleared と
// expiredWhileStopped は一覧に載らない。期限切れだけが消える前の記録の最終更新（報時刻、無ければ null）を運ぶ（C2 が H23 を出す）。
export type DisplayRemovalItem = Readonly<{ unit: UnitId; operation: Operation; at: number; ref: Readonly<{ id: string }> }> & (
  | Readonly<{ reason: "expired"; updatedAt: number | null }>
  | Readonly<{ reason: Exclude<DisplayRemoval, "expired" | "markCleared" | "expiredWhileStopped"> }>);
// 分野ごとに新しい順の 4 件と、落とした件数（P4-RL-D-WIRE-CAP=B、RL-RET-01）。消えたことの無い分野は欄を持たない。stream ごとに空から始まる。
export type DisplayRemovalWire = Readonly<Partial<Record<UnitId, Readonly<{ items: readonly DisplayRemovalItem[]; omitted: number }>>>>;
// H28 の 10 分で外した EEW の未確認の区間（publisher の手元、P4-RL-AC07）。区間が無ければ count 0 と null。
export type DisplayEewWindow = Readonly<{ count: number; from: number | null; to: number | null }>;
// H39 の unit の欄（P4-RL-D-H39-SHAPE=B）。5 区分は LossTally の count の和（安全な整数で飽和）、hole は件数の分からない欠け（穴を持たない unit は null）、
// rev は LossTally の行の JSON の sha256 の hex で part=losses の revision。eewWindow は U-E の欄だけが持つ。
export type DisplayLossRow = Readonly<{ dropped: number; evicted: number; missed: number; outcomeUnknown: number; unreadable: number; hole: boolean | null; rev: string;
  eewWindow?: DisplayEewWindow }>;
export type DisplayLossWire = Readonly<Record<UnitId, DisplayLossRow>>;
