import type { MaterialValue, Operation } from "../../contracts/p1-parser-boundary.types";
import type { ReportRef, UnreadableMarkView } from "../../contracts/p2-shared-runtime.types";
import type { DisplayAreaSystem } from "../../contracts/p2-snapshot-sse.types";
import type { WeatherTimeseriesPublicSubject } from "../../contracts/p2-weather-timeseries-unit.types";
import type { BriefingUnitView } from "../../contracts/p3-briefing-unit.types";
import type { FloodUnitView } from "../../contracts/p3-flood-unit.types";
import type { LandslideUnitView } from "../../contracts/p3-landslide-unit.types";
import type { LocalBulletinsUnitView } from "../../contracts/p3-local-bulletins-unit.types";
import type { NankaiInformationView, NankaiUnitView } from "../../contracts/p3-nankai-unit.types";
import type { TyphoonName, TyphoonUnitView } from "../../contracts/p3-typhoon-unit.types";
import type { WeatherCurrentPublicArea } from "../../contracts/p3-uw-canon.types";
import type { VolcanoBulletinView, VolcanoShortfall, VolcanoUnitView } from "../../contracts/p3-volcano-unit.types";
import type {
  DisplayCutText, DisplayStateMark, VocabCell, VocabFact, VocabItem, VocabItemOf, VocabKind, VocabList, VocabMaterial, VocabRef, VocabValue,
} from "../../contracts/p4-display-wire.types";

// P4-DISPLAY-VOCAB-001: view の要素 → 語彙の項目の純粋な関数と、文字列の上限の表。publisher（snapshot、切る）と owner（詳細、切らない）が
// 同じ関数を呼ぶ（無いと snapshot と詳細で語彙が食い違う、表 §5.4）。owner は unit・domain の module を読むと循環するので contracts の型だけを読む。

// 表示用の文字列の上限（escape 後の JSON の byte、引用符を除く）の唯一の表（P4-DW-D-STRING-SOURCE、台帳 50）。後ろの 4 つは本契約の表 §3.2。
const WIRE_LIMITS = {
  eventId: 40, time: 40, hypocenter: 192, coordinate: 64, valueRaw: 32, description: 96, place: 192, firstWave: 48, height: 24,
  unkeyedName: 192, tsunamiEval: 384, cardTitle: 96, cardHeadline: 384, comment: 2048,
  phenomenonName: 1536, office: 256, inundationText: 1536, rawText: 40,
} as const;

const escapedBytes = (value: string): number => Buffer.byteLength(JSON.stringify(value)) - 2;
// boundedString と同じ単位で字の境で切る。印の字は足さず、cut で返す（P4-DW-AC03）。
function cutText(value: string, limit: number): DisplayCutText {
  if (escapedBytes(value) <= limit) return { text: value, cut: false };
  let text = "", bytes = 0;
  for (const character of value) {
    const size = escapedBytes(character);
    if (bytes + size > limit) break;
    text += character;
    bytes += size;
  }
  return { text, cut: true };
}

type VocabSources = {
  "weatherCurrent.area": WeatherCurrentPublicArea;
  "weatherTimeseries.subject": WeatherTimeseriesPublicSubject;
  "nankai.current": NankaiUnitView["currents"][number];
  "nankai.information": NankaiInformationView;
  "volcano.alert": VolcanoUnitView["alerts"][number];
  "volcano.eruption": VolcanoUnitView["eruptions"][number];
  "volcano.ashfall": VolcanoUnitView["ashfalls"][number];
  "volcano.bulletin": VolcanoBulletinView;
  "volcano.shortfall": VolcanoShortfall;
  "landslide.office": LandslideUnitView["currents"][number];
  "flood.event": FloodUnitView["currents"][number];
  "briefing.current": BriefingUnitView["currents"][number];
  "localBulletins.tornado": LocalBulletinsUnitView["tornado"][number];
  "localBulletins.heat": LocalBulletinsUnitView["heat"][number];
  "localBulletins.transient": LocalBulletinsUnitView["transient"][number];
  "typhoon.analysis": TyphoonUnitView["analysis"][number];
  "typhoon.probability": TyphoonUnitView["probability"][number];
};
// view の要素と種類の組（判別は k）。
type VocabSource = { [K in VocabKind]: Readonly<{ k: K; value: VocabSources[K] }> }[VocabKind];

// snapshot だけで切り、詳細では切る段を外す（表 §3.2、P4-DV-D-UNBOUNDED-TEXT=A）。型は両方とも DisplayCutText（k ごとの union を 1 つに保つ）。
type Cut = Readonly<{ text: (value: string, limit: number) => DisplayCutText; raw: (value: string | null | undefined) => string | null }>;
const SNAPSHOT: Cut = { text: cutText, raw: (value) => value == null || escapedBytes(value) > WIRE_LIMITS.rawText ? null : value };
const DETAIL: Cut = { text: (value) => ({ text: value, cut: false }), raw: (value) => value ?? null };

const f = <Label extends string>(label: Label, value: VocabValue): VocabFact<Label> => [label, value];
const marks = (value: Readonly<{ unconfirmed?: ReportRef }>): readonly DisplayStateMark[] => value.unconfirmed != null ? ["unconfirmed"] : [];
// 主の ReportRef（表 §1.3）: time・serial は見出しに、family と InfoType は事実の行に。
const sourceFacts = (source: ReportRef | null, cut: Cut) => [f("source.family", source?.family ?? null), f("source.infoType", cut.raw(source?.infoTypeRaw))] as const;
function list<Role extends string, Col extends string = never, Fact extends string = never>(role: Role, rows: readonly (readonly VocabCell[])[],
  more: Partial<Readonly<{ label: string | null; sys: DisplayAreaSystem | null; cols: readonly Col[]; facts: readonly VocabFact<Fact>[]; omitted: number }>> = {}): VocabList<Role, Col, Fact> {
  return { role, label: more.label ?? null, sys: more.sys ?? null, cols: more.cols ?? [], facts: more.facts ?? [], rows, omitted: more.omitted ?? 0 };
}
const codes = <Role extends string>(role: Role, values: readonly string[], sys: DisplayAreaSystem | null = null, label: string | null = null) =>
  list(role, values.map((code) => [code, null]), { sys, label });
// 読めない印（表 §2.4、P4-DV-D-UNREADABLE-PARTS=A）。部分の原文は part=unreadable で開く。
function markList<Role extends "unreadable" | "marineUnreadable">(role: Role, mark: UnreadableMarkView | undefined) {
  return mark == null ? [] : [list<Role, "scope" | "raw", "headline" | "addition" | "rawDropped" | "partsCut">(role,
    mark.parts.map((part) => [part.site, part.scope ?? null, part.raw]), { cols: ["scope", "raw"],
      facts: [f("headline", mark.headline), f("addition", mark.addition === true), f("rawDropped", mark.rawDropped === true), f("partsCut", mark.partsCut === true)] })];
}
const texts = <Role extends string>(...values: readonly (readonly [Role, string | null | undefined])[]): readonly (readonly [Role, string])[] =>
  values.flatMap(([role, text]) => text == null ? [] : [[role, text] as const]);
const material = (value: MaterialValue): VocabMaterial => value.kind === "number" ? ["sv", "number", value.value, null, value.raw]
  : value.kind === "text" ? ["sv", "text", value.value, null, value.raw] : value.kind === "range" ? ["sv", "range", value.value, value.bound, value.raw]
    : value.kind === "missing" ? ["sv", "missing", null, null, null] : ["sv", value.kind, null, null, value.raw];
const kindFacts = <Prefix extends string>(prefix: Prefix, value: Readonly<{ code: string; name: string; condition?: string | null }> | null) =>
  [f(`${prefix}.code`, value?.code ?? null), f(`${prefix}.name`, value?.name ?? null)] as const;
const nameFacts = (name: TyphoonName) => [f("name.name", name.name), f("name.nameKana", name.nameKana), f("name.number", name.number), f("name.remark", name.remark)] as const;

type Ids = Readonly<{ id: string; rev: string }>;
type Head = Readonly<{ id: string; rev: string; op: Operation; title: string | null; time: string | null; serial: string | null; marks: readonly DisplayStateMark[];
  unread: boolean; ref: VocabRef | null }>;
function head(ids: Ids, value: Readonly<{ operation: Operation; source: ReportRef | null; unconfirmed?: ReportRef; unreadableView?: UnreadableMarkView }>,
  title: string | null, cut: Cut, ref: VocabRef | null = null): Head {
  return { id: ids.id, rev: ids.rev, op: value.operation, title, time: cut.raw(value.source?.reportDateTimeRaw), serial: cut.raw(value.source?.serialRaw),
    marks: marks(value), unread: value.unreadableView != null, ref };
}
// 本文の口の参照（id は生の subject、rev は source の三つ組、P3-BT-D-KEY）。
const textRef = (value: Readonly<{ subject: string; source: ReportRef }>): VocabRef =>
  ({ part: "text", id: value.subject, rev: JSON.stringify([value.source.inputId, value.source.reportDateTimeRaw, value.source.controlDateTimeRaw]) });

// 語彙の項目を 1 件作る（表 §1〜§3）。facts・lists・texts・special の欄の行き先は表 §1.3・§1.5・§2 のとおり。
function vocabItem(source: VocabSource, ids: Ids, detail: boolean): VocabItem {
  const cut = detail ? DETAIL : SNAPSHOT;
  switch (source.k) {
    case "weatherCurrent.area": {
      const v = source.value;
      // 区域は層ごとに 1 つの一覧（sys は層、区域名は描画が G0 の表から引く、計画 §5.3 の C=A）。areas は [層, Code] の昇順。
      // 層ごとの配列に 1 行ずつ足す（区域の数に線形。一覧を足すたびに写し直さない）。
      const layers: { sys: DisplayAreaSystem; rows: (readonly VocabCell[])[] }[] = [];
      for (const [system, code] of v.areas) {
        const last = layers.at(-1);
        if (last?.sys === system) last.rows.push([code, null]);
        else layers.push({ sys: system, rows: [[code, null]] });
      }
      // names は codes の部分集合（p3-uw-canon.types.ts の names）なので、名前の無い Code は null。
      const phenomena = list<"phenomena", "areaCount">("phenomena", Object.keys(v.codes).sort().map((code) =>
        [code, v.names[code] == null ? null : cut.text(v.names[code], WIRE_LIMITS.phenomenonName), v.codes[code]]), { cols: ["areaCount"] });
      const item: VocabItemOf<"weatherCurrent.area"> = { ...head(ids, v, null, cut, { part: "areas", id: v.id, rev: v.revision }), k: source.k,
        facts: [...sourceFacts(v.source, cut), f("prefecture", v.prefecture), f("cellCount", v.cellCount), f("restoredCellCount", v.restoredCellCount)],
        lists: [...layers.map((layer) => list<"areas">("areas", layer.rows, { sys: layer.sys })), phenomena], texts: [], special: null };
      return item;
    }
    case "weatherTimeseries.subject": {
      const v = source.value;
      const item: VocabItemOf<"weatherTimeseries.subject"> = { ...head(ids, v, null, cut, { part: "current", id: v.id, rev: v.revision }), k: source.k,
        facts: [...sourceFacts(v.source, cut), f("office", cut.text(v.office, WIRE_LIMITS.office)), f("effective", v.effective), f("unavailableReason", v.unavailableReason),
          f("validUntil", v.validUntil), f("unknownCode.unknown", v.unknownCode.unknown), f("unknownCode.missing", v.unknownCode.missing),
          f("unknownCode.empty", v.unknownCode.empty), f("periodCount", v.periodCount), f("lastKnownPeriodCount", v.lastKnownPeriodCount)],
        lists: [codes("areaCodes", v.areaCodes, "forecastArea"), codes("knownCodes", v.knownCodes), ...markList("unreadable", v.unreadableView)], texts: [], special: null };
      return item;
    }
    case "nankai.current": {
      const v = source.value;
      const item: VocabItemOf<"nankai.current"> = { ...head(ids, v, v.title, cut), k: source.k,
        facts: [...sourceFacts(v.source, cut), f("eventId", v.eventId), f("retainUntil", v.retainUntil), f("line", v.line), f("status", v.status),
          f("warningUntil", "warningUntil" in v ? v.warningUntil ?? null : null), f("infoSerial.code", v.infoSerial?.code ?? null),
          f("infoSerial.name", v.infoSerial?.name ?? null), f("truncated", v.truncated), f("validUntil", v.validUntil)],
        lists: markList("unreadable", v.unreadableView), texts: texts(["headline", v.headline]), special: null };
      return item;
    }
    case "nankai.information": {
      const v = source.value;
      const item: VocabItemOf<"nankai.information"> = { ...head(ids, v, v.title, cut, textRef(v)), k: source.k,
        facts: [...sourceFacts(v.source, cut), f("family", v.family), f("eventId", v.eventId), f("retainUntil", v.retainUntil), f("infoKind", v.infoKind),
          f("infoSerial.code", v.infoSerial?.code ?? null), f("infoSerial.name", v.infoSerial?.name ?? null), f("truncated", v.truncated), f("validUntil", v.validUntil)],
        lists: markList("unreadable", v.unreadableView), texts: texts(["headline", v.headline]), special: null };
      return item;
    }
    case "volcano.alert": {
      const v = source.value, marine = v.marineSource;
      // 副の ReportRef（表 §1.3）: marineUnconfirmed は有無、marineSource は主の source と同じ規則の事実の行。landEventId・marineEventId は載せない。
      const item: VocabItemOf<"volcano.alert"> = { ...head(ids, v, null, cut), k: source.k,
        facts: [...sourceFacts(v.source, cut), f("volcanoCode", v.volcanoCode), f("eventId", v.eventId), f("marineSource.time", cut.raw(marine?.reportDateTimeRaw)),
          f("marineSource.serial", cut.raw(marine?.serialRaw)), f("marineSource.family", marine?.family ?? null), f("marineSource.infoType", cut.raw(marine?.infoTypeRaw)),
          ...kindFacts("landKind", v.landKind), f("landKind.condition", v.landKind?.condition ?? null), ...kindFacts("marineKind", v.marineKind),
          f("marineKind.condition", v.marineKind?.condition ?? null), f("retainUntil", v.retainUntil), f("marineUnconfirmed", v.marineUnconfirmed != null),
          f("volcanoName", v.volcanoName), ...kindFacts("kind", v.kind), f("kind.condition", v.kind.condition), ...kindFacts("lastKind", v.lastKind),
          f("level", v.level), f("coordinate", v.coordinate), f("truncated", v.truncated), f("marineUnread", v.marineUnreadableView != null)],
        lists: [...v.municipalities.map((group) => codes("municipalities", group.codes, "municipality", group.kindName)),
          ...v.marineAreas.map((group) => codes("marineAreas", group.codes, null, group.kindName)),
          ...markList("unreadable", v.unreadableView), ...markList("marineUnreadable", v.marineUnreadableView)],
        texts: texts(["headline", v.headline], ["prevention", v.prevention]), special: null };
      return item;
    }
    case "volcano.eruption": {
      const v = source.value;
      const item: VocabItemOf<"volcano.eruption"> = { ...head(ids, v, null, cut), k: source.k,
        facts: [...sourceFacts(v.source, cut), f("volcanoCode", v.volcanoCode), f("eventId", v.eventId), f("retainUntil", v.retainUntil), f("volcanoName", v.volcanoName),
          f("flash", v.flash), ...kindFacts("phenomenon", v.phenomenon), f("eventDateTimeRaw", v.eventDateTimeRaw), f("craterName", v.craterName),
          f("plumeAboveCrater", material(v.plumeAboveCrater)), f("plumeAboveSeaLevel", material(v.plumeAboveSeaLevel)), f("plumeDirection", v.plumeDirection),
          f("truncated", v.truncated), f("validUntil", v.validUntil)],
        lists: [codes("municipalities", v.municipalities, "municipality"), ...markList("unreadable", v.unreadableView)], texts: texts(["headline", v.headline]), special: null };
      return item;
    }
    case "volcano.ashfall": {
      const v = source.value;
      const item: VocabItemOf<"volcano.ashfall"> = { ...head(ids, v, null, cut), k: source.k,
        facts: [...sourceFacts(v.source, cut), f("volcanoCode", v.volcanoCode), f("eventId", v.eventId), f("retainUntil", v.retainUntil), f("volcanoName", v.volcanoName),
          f("variant", v.variant), f("forecastStartsAt", v.forecastStartsAt), f("forecastEndsAt", v.forecastEndsAt), f("omittedGroupCount", v.omittedGroupCount),
          f("truncated", v.truncated)],
        lists: [...v.groups.map((group) => list<"ashGroup", "firstForecastEndAt", "hazardClass" | "ashCode" | "areaCount">("ashGroup",
          group.topAreas.map((area) => [area.code, area.name, area.firstForecastEndAt]), { label: group.ashName, cols: ["firstForecastEndAt"],
            facts: [f("hazardClass", group.hazardClass), f("ashCode", group.ashCode), f("areaCount", group.areaCount)], omitted: group.omittedAreaCount })),
        ...markList("unreadable", v.unreadableView)], texts: texts(["headline", v.headline]), special: null };
      return item;
    }
    case "volcano.bulletin": {
      const v = source.value;
      const item: VocabItemOf<"volcano.bulletin"> = { ...head(ids, v, v.title, cut, textRef(v)), k: source.k,
        facts: [...sourceFacts(v.source, cut), f("family", v.family), f("eventId", v.eventId), f("retainUntil", v.retainUntil), f("extraordinary", v.extraordinary),
          f("truncated", v.truncated)],
        lists: [codes("volcanoCodes", v.volcanoCodes), ...markList("unreadable", v.unreadableView)], texts: texts(["headline", v.headline]), special: null };
      return item;
    }
    case "volcano.shortfall": {
      const v = source.value;
      const item: VocabItemOf<"volcano.shortfall"> = { id: ids.id, rev: ids.rev, k: source.k, op: v.operation, title: null, time: null, serial: null, marks: [], unread: false,
        ref: null, facts: [f("id", v.id), f("slice", v.slice), f("scope", v.scope), f("volcanoCode", v.volcanoCode),
          f("lastKnown.reportDateTimeRaw", v.lastKnown?.reportDateTimeRaw ?? null), f("lastKnown.serialRaw", v.lastKnown?.serialRaw ?? null), f("reason", v.reason)],
        lists: [], texts: [], special: null };
      return item;
    }
    case "landslide.office": {
      const v = source.value;
      const item: VocabItemOf<"landslide.office"> = { ...head(ids, v, v.title, cut), k: source.k,
        facts: [...sourceFacts(v.source, cut), f("office", v.office), f("retainUntil", v.retainUntil), f("truncated", v.truncated)],
        lists: [...v.kinds.map((group) => list<"kinds", never, "code" | "level">("kinds", group.areas.map((code) => [code, null]),
          { label: group.name, sys: "municipality", facts: [f("code", group.code), f("level", group.level)] })), ...markList("unreadable", v.unreadableView)],
        texts: [], special: null };
      return item;
    }
    case "flood.event": {
      const v = source.value;
      // inundation の鍵が無いのは「読めない」で「想定地区なし」ではない（p3-flood-unit.types.ts）ので、有無を事実の行に残す。
      const item: VocabItemOf<"flood.event"> = { ...head(ids, v, v.title, cut), k: source.k,
        facts: [...sourceFacts(v.source, cut), f("headType", v.headType), f("eventId", v.eventId), f("retainUntil", v.retainUntil), f("areaName", v.areaName),
          f("inundation", v.inundation != null), f("basisReportDateTimeRaw", v.basisReportDateTimeRaw), f("truncated", v.truncated)],
        lists: [...v.kinds.map((group) => list<"kinds", never, "code" | "level">("kinds", group.rivers.map((river) => [river.code, river.name]),
          { label: group.name, facts: [f("code", group.code), f("level", group.level)] })),
        ...(v.inundation ?? []).map((group) => list<"inundation", "stationCode" | "prefecture" | "city" | "subCities", "text">("inundation",
          group.areas.map((area) => [area.cityCode, cut.text(area.name, WIRE_LIMITS.inundationText), area.stationCode, cut.text(area.prefecture, WIRE_LIMITS.inundationText),
            cut.text(area.city, WIRE_LIMITS.inundationText), cut.text(area.subCities, WIRE_LIMITS.inundationText)]),
          { label: group.kindName, cols: ["stationCode", "prefecture", "city", "subCities"], facts: [f("text", group.text)], omitted: group.omittedAreaCount })),
        ...markList("unreadable", v.unreadableView)],
        texts: [], special: { kind: "floodSeries", times: v.times, stations: v.stations } };
      return item;
    }
    case "briefing.current": {
      const v = source.value;
      const report = v.headType === "VPBS50" ? v : null, record = v.headType === "VPOA50" ? v : null;
      const item: VocabItemOf<"briefing.current"> = { ...head(ids, v, v.title, cut), k: source.k,
        facts: [...sourceFacts(v.source, cut), f("series", v.series), f("retainUntil", v.retainUntil), f("headType", v.headType), f("eventId", report?.eventId ?? null),
          f("inherited", report == null ? null : report.inherited === true), f("effective", v.effective), f("editorialOffice", v.editorialOffice), f("truncated", v.truncated)],
        lists: [...(report?.items ?? []).map((entry) => list<"items", never, "kind" | "condition">("items", entry.areas.map((area) => [area.code, area.name]),
          { facts: [f("kind", entry.kind), f("condition", entry.condition)] })),
        ...report == null ? [] : [list<"observations", "part" | "label" | "value" | "unit" | "approximation" | "time">("observations", report.observations.map((entry) =>
          [entry.areaCode, entry.areaName, entry.part, entry.label, entry.value, entry.unit, entry.approximation, entry.time]),
        { cols: ["part", "label", "value", "unit", "approximation", "time"] })],
        ...record == null ? [] : [list<"areas">("areas", record.areas.map((area) => [area.code, area.name]))], ...markList("unreadable", v.unreadableView)],
        texts: texts(["headline", v.headline]), special: null };
      return item;
    }
    case "localBulletins.tornado": {
      const v = source.value;
      const item: VocabItemOf<"localBulletins.tornado"> = { ...head(ids, v, v.title, cut), k: source.k,
        facts: [...sourceFacts(v.source, cut), f("retainUntil", v.retainUntil), f("activeUntil", v.activeUntil), f("editorialOffice", v.editorialOffice),
          f("sighted", v.sighted), f("truncated", v.truncated)],
        lists: [list<"areas", "layer">("areas", v.areas.map((area) => [area.code, area.name, area.layer]), { cols: ["layer"] }), ...markList("unreadable", v.unreadableView)],
        texts: texts(["headline", v.headline]), special: null };
      return item;
    }
    case "localBulletins.heat": {
      const v = source.value;
      const item: VocabItemOf<"localBulletins.heat"> = { ...head(ids, v, v.title, cut), k: source.k,
        facts: [...sourceFacts(v.source, cut), f("retainUntil", v.retainUntil), f("activeUntil", v.activeUntil), f("targetDate", v.targetDate),
          f("editorialOffice", v.editorialOffice), f("areaName", v.areaName), f("truncated", v.truncated)],
        lists: markList("unreadable", v.unreadableView), texts: texts(["headline", v.headline]), special: null };
      return item;
    }
    case "localBulletins.transient": {
      const v = source.value;
      const item: VocabItemOf<"localBulletins.transient"> = { ...head(ids, v, v.title, cut), k: source.k,
        facts: [...sourceFacts(v.source, cut), f("family", v.family), f("retainUntil", v.retainUntil), f("visibleUntil", v.visibleUntil),
          f("editorialOffice", v.editorialOffice), f("truncated", v.truncated)],
        lists: [list<"areas">("areas", v.areas.map((area) => [area.code, area.name])), codes("tags", v.tags), ...markList("unreadable", v.unreadableView)],
        texts: texts(["headline", v.headline]), special: null };
      return item;
    }
    case "typhoon.analysis": {
      const v = source.value;
      // 予報円は view の形のまま（投影後の座標と SVG path は入れない、spec §8.1、表 §2.3）。
      const item: VocabItemOf<"typhoon.analysis"> = { ...head(ids, v, v.title, cut), k: source.k,
        facts: [...sourceFacts(v.source, cut), f("retainUntil", v.retainUntil), f("activeUntil", v.activeUntil), f("baseTime", v.baseTime), ...nameFacts(v.name),
          f("truncated", v.truncated)],
        lists: markList("unreadable", v.unreadableView), texts: [], special: { kind: "typhoonFrames", frames: v.frames } };
      return item;
    }
    case "typhoon.probability": {
      const v = source.value;
      const item: VocabItemOf<"typhoon.probability"> = { ...head(ids, v, v.title, cut), k: source.k,
        facts: [...sourceFacts(v.source, cut), f("retainUntil", v.retainUntil), f("activeUntil", v.activeUntil), f("baseTime", v.baseTime), f("slotCount", v.slotCount),
          ...nameFacts(v.name), f("maxFiveDay", v.maxFiveDay), f("truncated", v.truncated)],
        lists: [list<"prefectures">("prefectures", v.prefectures.map((entry) => [entry.code, entry.name])),
          list<"areas", "prefectureCode" | "d1" | "d2" | "d3" | "d4" | "d5" | "peak" | "peakSlot">("areas", v.areas.map((area) =>
            [area.code, area.name, area.prefectureCode, ...[0, 1, 2, 3, 4].map((day) => area.daily[day] ?? null), area.peak, area.peakSlot]),
          { cols: ["prefectureCode", "d1", "d2", "d3", "d4", "d5", "peak", "peakSlot"] }), ...markList("unreadable", v.unreadableView)],
        texts: [], special: null };
      return item;
    }
  }
}

export { WIRE_LIMITS, cutText, vocabItem };
