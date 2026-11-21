import type { Operation } from "./p1-parser-boundary.types";
import type { MarkViewed, RuntimeUnitId, UnreadableCardView } from "./p2-shared-runtime.types";
import type {
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
import type { LandslideUnitView } from "./p3-landslide-unit.types";
import type { FloodUnitView } from "./p3-flood-unit.types";
import type { BriefingUnitView } from "./p3-briefing-unit.types";
import type { TyphoonUnitView } from "./p3-typhoon-unit.types";

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
export type DisplayWireVersion = "p4-display-wire-v1";
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
  }>;
  notices: readonly VisibleNotice[];
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
  | Readonly<{ unit: RuntimeUnitId; part: "raw"; id: string; revision: string }>;

export type EewAreaDetail = Readonly<{ code: string; intensity: EewPredictionIntensity; report: EewReportArea | null }>;
// 索引の項目: 保護 2 分野は part への参照、U-N・U-V・U-M は本文の口の id と revision（生の subject と三つ組）、ほかは現況の要素（DTO）そのもの。
export type WireIndexEntry =
  | Readonly<{ id: string; revision: string; operation: Operation; part: "areas" | "stations" | "comment" | "event" }>
  | Readonly<{ id: string; revision: string; operation: Operation; part: "text" }>
  | Readonly<{ id: string; revision: string; operation: Operation; part: "item"; item: LandslideUnitView["currents"][number] | FloodUnitView["currents"][number]
      | BriefingUnitView["currents"][number] | TyphoonUnitView["analysis"][number] | TyphoonUnitView["probability"][number] }>;
export type WireOmitted = Readonly<{ index: number; reason: "pageBudget" }>;
type WirePage<Part extends string, Item> = Readonly<{ kind: "ok"; part: Part; revision: string; page: number; pageCount: number; itemCount: number;
  items: readonly Readonly<{ index: number; item: Item }>[]; omitted: readonly WireOmitted[] }>;
export type WireEventHeader = Omit<EarthquakeEventView, "intensity"> & Readonly<{ intensity: Omit<SeismicIntensityObservation, "items"> | null }>;
// 長周期の見出しの ref で開く形（U-Q の view の長周期の記録から震度の要素を除いたもの）。
export type WireLongPeriodHeader = Omit<MarkViewed<LongPeriodSubject>, "intensity"> & Readonly<{ intensity: Omit<SeismicIntensityObservation, "items"> | null }>;
// 見出しが 1 応答の予算に入らないときに値を外した欄（null・空にするか欄ごと消す）。
export type WireOmittedField = "hypocenter" | "headline" | "title" | "tsunamiComment" | "sources" | "unreadableView" | "unavailable" | "cancelledSummary" | "strongHold";
export type WireDetailResponse =
  // 索引は U-W の索引と同じ欄の名（entries）。入らない項目は omitted の index で示す。
  | Readonly<{ kind: "ok"; part: "index"; revision: string; page: number; pageCount: number; entryCount: number; entries: readonly WireIndexEntry[]; omitted: readonly WireOmitted[] }>
  | (WirePage<"areas", EewAreaDetail | TsunamiForecastArea | TsunamiUnkeyedArea> & Readonly<{ id: string }>)
  | (WirePage<"stations", TsunamiStation> & Readonly<{ id: string }>)
  | (WirePage<"event", SeismicIntensityItem> & Readonly<{ id: string; event: WireEventHeader | WireLongPeriodHeader; omittedFields: readonly WireOmittedField[] }>)
  | Readonly<{ kind: "ok"; part: "comment"; id: string; revision: string; text: string }>
  | Readonly<{ kind: "ok"; part: "raw"; id: string; revision: string; raw: string | null; rawCut: boolean; rawDropped: boolean }>
  | WeatherTimeseriesDetailError;
