import type { DecodedMaterial, Operation, XmlElement, XmlNode } from "../../../contracts/p1-parser-boundary.types";
import type { DiagnosticDetails, RejectionReason, ReportRef } from "../../../contracts/p2-shared-runtime.types";
import type { TornadoArea, TornadoAreaLayer, TransientArea, TransientFamily } from "../../../contracts/p3-local-bulletins-unit.types";
import { validateSemanticEnvelope } from "../../runtime/shared-runtime";
import { validCode, validHeadline } from "../briefing/briefing";
import { cut, infoRankOf, loneSurrogate, validName, validReportDateTime, validSerial } from "../flood/flood"; import { controlDateTimeOf } from "../../contracts-revision/version";

// P3-UNIT-M-001 の adapter: VPHW50/51・VPFT50・短命の解説情報の本文を Q-ENUM の順で確かめ、候補を項目ごとに組み立てる。
// 値の形の検査（cut・validName・validSerial ほか）は U-R と同じ規則なので domains/flood の export を使い、XML の読み取りだけを写す（AC13）。

const HOUR = 3_600_000, DAY = 24 * HOUR;
// I-U-M.bounds（UTF-16 の長さ）と P3-C13-BOUNDS=A の件数。
const BOUNDS = { title: 64, headline: 384, name: 24, office: 24, eventId: 64 } as const;
const LIMITS = { tornadoAreas: 128, transientAreas: 16, tags: 16 } as const;

type TornadoHeadType = "VPHW50" | "VPHW51";
type TransientHeadType = "VXSE56" | "VXSE60" | "VZSE40" | "VPAW51" | "VPZI50" | "VPCI50" | "VPZJ51" | "VPCJ51" | "VPFJ51" | "VMCJ53" | "VMCJ54" | "VMCJ55";

// P3-C13-TRANSIENT-FAMILIES=A の表と P3-C13-TRANSIENT-TTL=A の記憶の長さ・P3-C13-BOUNDS=A の件数。
const TRANSIENT_TYPES: readonly TransientHeadType[] = ["VXSE56", "VXSE60", "VZSE40", "VPAW51", "VPZI50", "VPCI50", "VPZJ51", "VPCJ51", "VPFJ51",
  "VMCJ53", "VMCJ54", "VMCJ55"];
const FAMILY_OF: Readonly<Record<TransientHeadType, TransientFamily>> = { VXSE56: "seismicText", VXSE60: "seismicText", VZSE40: "seismicText",
  VPAW51: "earlyWeather", VPZI50: "climateInfo", VPCI50: "climateInfo", VPZJ51: "weatherExplanation", VPCJ51: "weatherExplanation",
  VPFJ51: "weatherExplanation", VMCJ53: "weatherExplanation", VMCJ54: "weatherExplanation", VMCJ55: "weatherExplanation" };
const TRANSIENT_RETAIN: Readonly<Record<TransientFamily, number>> = { seismicText: 36 * HOUR, weatherExplanation: 36 * HOUR, earlyWeather: 7 * DAY,
  climateInfo: 30 * DAY };
const TRANSIENT_LIMIT: Readonly<Record<TransientFamily, number>> = { seismicText: 256, earlyWeather: 128, climateInfo: 128, weatherExplanation: 256 };
const TORNADO_RETAIN = 36 * HOUR, HEAT_RETAIN = 3 * DAY, VISIBLE_TRANSIENT = 3 * HOUR, TORNADO_DEFAULT_VALID = HOUR, HEAT_TARGET_WINDOW = 48 * HOUR;
const TORNADO_LIMIT = 128, HEAT_LIMIT = 256;

const TORNADO_LAYERS: ReadonlyMap<string, TornadoAreaLayer> = new Map([["竜巻注意情報（発表細分）", "announcement"],
  ["竜巻注意情報（一次細分区域等）", "primary"], ["竜巻注意情報（市町村等をまとめた地域等）", "municipalityGroup"],
  ["竜巻注意情報（市町村等）", "municipality"], ["竜巻注意情報（目撃情報あり）", "sighting"]]);
const LAYER_SET: readonly TornadoAreaLayer[] = ["announcement", "primary", "municipalityGroup", "municipality", "sighting"];
const SIGHTED_MARK = "【目撃情報あり】";

const validOffice = (value: string): boolean => value.length <= BOUNDS.office && validName(value);
// 系列は EventID の最初の「_」より前（P3-C13-TRANSIENT-FAMILIES=A）。
const validSeries = (value: string): boolean => value.length <= BOUNDS.eventId && !value.includes("_") && validName(value);
const validEventId = (value: string): boolean => value.length <= BOUNDS.eventId && !value.startsWith("_") && validName(value);
const validKeyTitle = (value: string): boolean => value.length <= BOUNDS.title && validName(value);

// 熱中症の対象日（P3-C13-HEAT-EXPIRY=A）: JST の日付と、その日の終わり（翌日 0 時）。
const JST = 9 * HOUR;
const jstDate = (ms: number): string => new Date(ms + JST).toISOString().slice(0, 10);
const jstDayEnd = (ms: number): number => (Math.floor((ms + JST) / DAY) + 1) * DAY - JST;
const dateEnd = (date: string): number | null => {
  const start = Date.parse(`${date}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(start) && new Date(start).toISOString().startsWith(date) ? start + DAY - JST : null;
};

// ---- XML の読み取り（domains/briefing・flood と同じ写し。共有化は統合担当が決める、AC13） ----

const localName = (node: XmlElement): string => node.name.split(":").at(-1)!;
function children(parent: XmlElement | null, name?: string): XmlElement[] {
  return parent == null ? [] : parent.children.filter((node): node is XmlElement =>
    node.kind === "element" && (name == null || localName(node) === name));
}
function scalar(node: XmlElement): string | null {
  return children(node).length === 0 ? node.children.filter((part): part is Extract<XmlNode, { kind: "text" }> =>
    part.kind === "text").map((part) => part.value).join("").trim() : null;
}
const attribute = (node: XmlElement, name: string): string | null => node.attributes.find((item) => item.name === name)?.value.trim() ?? null;

// ---- 候補 ----

type Base = Readonly<{
  operation: Operation; subject: string; source: ReportRef; reportDateTimeMs: number; infoRank: number; cancelled: boolean;
  title: string; headline: string; editorialOffice: string; truncated: boolean;
}>;
type TornadoCandidate = Base & Readonly<{
  slice: "tornado"; headType: TornadoHeadType;
  // 区域が全部「なし」の通常の解除（P3-C13-TORNADO-FACTS）。
  release: boolean; sighted: boolean; areas: readonly TornadoArea[];
  // ValidDateTime の値（通知の「有効期限」に電文の値を出す）と、通知の「発表中 N地域」の数（切る前の最も細かい層）。
  validMs: number | null; noticeAreas: number;
}>;
type HeatCandidate = Base & Readonly<{ slice: "heat"; headType: "VPFT50"; targetDate: string; areaName: string | null; activeUntil: number }>;
type TransientCandidate = Base & Readonly<{
  slice: "transient"; headType: TransientHeadType; family: TransientFamily; areas: readonly TransientArea[]; tags: readonly string[];
}>;
type LocalBulletinsCandidate = TornadoCandidate | HeatCandidate | TransientCandidate;
type ParseResult = Readonly<{ kind: "accepted"; candidate: LocalBulletinsCandidate }>
  | Readonly<{ kind: "rejected"; subject: string; reason: RejectionReason; diagnostic: DiagnosticDetails }>;

type Named = Readonly<{ state: "ok" | "missing" | "invalid"; value: string }>;
// 1 個の非空 scalar。無いか空は missing、重複・子要素は invalid。
function one(parent: XmlElement | null, tag: string): Named {
  const nodes = children(parent, tag);
  const text = nodes.length === 0 ? null : scalar(nodes[0]);
  if (nodes.length === 0 || text === "") return { state: "missing", value: "" };
  return nodes.length > 1 || text == null ? { state: "invalid", value: "" } : { state: "ok", value: text };
}
const AREA_LAYER_ORDER = ["municipality", "municipalityGroup", "primary", "announcement"] as const;

// Q-ENUM.priorityRule の順に最初の一 RejectionReason を返す。拒否の subject は identity を読めた後だけ subject。
function parseLocalBulletins(material: DecodedMaterial): ParseResult {
  const common = validateSemanticEnvelope(material);
  if (common.kind === "rejected") return { kind: "rejected", subject: "", reason: common.reason, diagnostic: common.diagnostic };
  const reject = (reason: RejectionReason, subject = ""): ParseResult => ({ kind: "rejected", subject, reason,
    diagnostic: { level: "WARN", component: "localBulletins", reason, inputId: material.inputId, unit: "U-M" } });

  const headType = material.headType;
  const tornadoType: TornadoHeadType | null = headType === "VPHW50" || headType === "VPHW51" ? headType : null;
  const transientType = TRANSIENT_TYPES.find((item) => item === headType) ?? null;
  if (tornadoType == null && headType !== "VPFT50" && transientType == null) return reject("identityInvalid");
  const head = children(material.xml, "Head")[0] ?? null;
  const control = children(material.xml, "Control")[0] ?? null;
  const operation = material.operation;

  // ---- identity（存在 → 妥当性）。竜巻は官署＋Head/Title、VPAW51 は TargetArea の code＋Head/Title、熱中症とほかは EventID ----
  const keyTitle = one(head, "Title");
  const eventId = one(head, "EventID");
  const office = one(control, "EditorialOffice");
  const targetArea = children(children(material.xml, "Body")[0] ?? null, "TargetArea");
  const targetCode = one(targetArea[0] ?? null, "Code");
  let subject = "", series = "";
  if (tornadoType != null || transientType === "VPAW51") {
    if (tornadoType != null && office.state === "missing" || keyTitle.state === "missing" || transientType === "VPAW51" && targetCode.state === "missing")
      return reject("identityMissing");
    if (tornadoType != null && (office.state === "invalid" || office.state === "ok" && (!validOffice(office.value) || office.value.includes("/")))
      || keyTitle.state === "invalid" || keyTitle.state === "ok" && !validKeyTitle(keyTitle.value)
      || transientType === "VPAW51" && (targetArea.length !== 1 || targetCode.state === "invalid" || targetCode.state === "ok" && !validCode(targetCode.value)))
      return reject("identityInvalid");
    if (tornadoType != null && office.state === "ok" && keyTitle.state === "ok") subject = `${operation}/tornado/${office.value}/${keyTitle.value}`;
    else if (targetCode.state === "ok" && keyTitle.state === "ok") subject = `${operation}/VPAW51/${targetCode.value}/${keyTitle.value}`;
  } else {
    if (eventId.state === "missing") return reject("identityMissing");
    if (eventId.state === "invalid" || eventId.state === "ok" && !validEventId(eventId.value)) return reject("identityInvalid");
    if (eventId.state === "ok") {
      series = transientType == null ? eventId.value : eventId.value.split("_")[0];
      subject = `${operation}/${headType}/${series}`;
    }
  }
  if (subject === "") return reject("identityInvalid");
  const serialRaw = material.serialRaw.trim();
  // 保存する ReportRef の byte の上限（Q-ENUM.identity）。Serial は任意で、あれば 10 桁以下の数字列。
  if (serialRaw !== "" && !validSerial(serialRaw) || !validReportDateTime(material.reportDateTimeRaw) || material.infoTypeRaw.length > 8) return reject("identityInvalid", subject);

  // ---- 必須構造（存在を全部確かめてから妥当性を見る） ----
  let missing = false, invalid = false, truncated = false;
  const bound = (value: string, limit: number): string => {
    if (value.length > limit) truncated = true;
    return cut(value, limit);
  };
  const name = (found: Named): string | null => {
    if (found.state === "missing") missing = true;
    else if (found.state === "invalid") invalid = true;
    else if (!validName(found.value)) invalid = true;
    else return found.value;
    return null;
  };
  const title = name(keyTitle);
  const infoTypes = children(head, "InfoType");
  const infoTypeText = infoTypes.length === 0 ? null : scalar(infoTypes[0]);
  const infoRank = infoTypes.length === 1 && infoTypeText === material.infoTypeRaw.trim() ? infoRankOf(material.infoTypeRaw) : undefined;
  if (infoTypes.length === 0 || infoTypeText === "") missing = true;
  else if (infoRank == null) invalid = true;
  const cancelled = infoRank === 3;
  // Control/EditorialOffice は取消でも有無と形を確かめる。竜巻は identity で確かめ済み。
  let editorialOffice = "";
  if (tornadoType == null) {
    const value = name(office);
    if (value != null && value.length > BOUNDS.office) invalid = true;
    else if (value != null) editorialOffice = value;
  } else if (office.state === "ok") editorialOffice = office.value;

  const base = { operation, subject, source: { inputId: material.inputId, origin: material.origin, operation, family: material.headType, subject,
    reportDateTimeRaw: material.reportDateTimeRaw, controlDateTimeRaw: controlDateTimeOf(material.controlDateTimeRaw), serialRaw, infoTypeRaw: material.infoTypeRaw }, reportDateTimeMs: common.envelope.reportDateTimeMs,
    infoRank: infoRank ?? 0, cancelled };
  const reportMs = common.envelope.reportDateTimeMs;
  // 取消は Headline・Body を読まない。
  let headline = "", headlineRaw = "";
  const headlines = children(head, "Headline");
  // 竜巻の非取消は Head/Headline が必須（Q-ENUM.familyTable）。
  if (!cancelled && tornadoType != null && headlines.length === 0) missing = true;
  if (!cancelled) {
    const texts = children(headlines[0] ?? null, "Text");
    const text = texts.length === 0 ? "" : scalar(texts[0]);
    if (headlines.length > 1 || texts.length > 1 || text == null || !validHeadline(text)) invalid = true;
    else { headlineRaw = text; headline = bound(text, BOUNDS.headline); }
  }
  const finish = (candidate: LocalBulletinsCandidate): ParseResult => missing ? reject("requiredStructureMissing", subject)
    : invalid || title == null || infoRank == null ? reject("requiredStructureInvalid", subject) : { kind: "accepted", candidate };
  const titleText = title ?? "";
  // truncated は最後の finish の時点の値（Title の切り詰めを先に評価する）。
  const shared = () => { const cutTitle = bound(titleText, BOUNDS.title); return { ...base, title: cutTitle, headline, editorialOffice, truncated }; };

  // 区域の Code は数字だけ 8 byte 以下（切らない）、Name は 24 単位に切る。
  // 欠落は竜巻なら必須の欠落、transient なら区域の欠落（合法、Q-ENUM.familyTable）。形の外は invalid。
  const areaOf = (parent: XmlElement | null, optional = false): TransientArea | null => {
    const code = one(parent, "Code"), label = one(parent, "Name");
    if (code.state === "missing" || label.state === "missing") { missing ||= !optional; return null; }
    if (code.state === "invalid" || !validCode(code.value) || label.state === "invalid" || !validName(label.value)) { invalid = true; return null; }
    return { code: code.value, name: label.value };
  };

  if (tornadoType != null) {
    let release = false, sighted = false, validMs: number | null = null, noticeAreas = 0;
    let areas: TornadoArea[] = [];
    if (!cancelled) {
      const valids = children(head, "ValidDateTime");
      const validText = valids.length === 0 ? "" : scalar(valids[0]);
      if (valids.length > 1 || validText == null || validText !== "" && !validReportDateTime(validText)) invalid = true;
      else if (validText !== "") validMs = Date.parse(validText);
      // Item の読み取り。Kind は 1 個以上（各 Kind の Name・Code は 0 か 1 個の scalar）。Kind/Code が「0」か Kind/Name が「なし」ならなし。
      const itemActive = (item: XmlElement): boolean => {
        const kinds = children(item, "Kind");
        if (kinds.length === 0) invalid = true;
        let active = false;
        for (const kind of kinds) {
          const names = children(kind, "Name"), codes = children(kind, "Code");
          const nameText = names.length === 0 ? null : scalar(names[0]), codeText = codes.length === 0 ? null : scalar(codes[0]);
          if (names.length > 1 || codes.length > 1 || names.length === 1 && nameText == null || codes.length === 1 && codeText == null) invalid = true;
          if (codeText !== "0" && nameText !== "なし") active = true;
        }
        return active;
      };
      type Entry = Readonly<{ layer: TornadoAreaLayer | null; active: boolean; places: readonly TransientArea[] }>;
      const entries: Entry[] = [];
      const typed = (nodes: readonly XmlElement[]) => nodes.filter((node) => (attribute(node, "type") ?? "").startsWith("竜巻注意情報（"));
      const informations = typed(children(headlines[0] ?? null, "Information"));
      for (const information of informations) {
        const layer = TORNADO_LAYERS.get(attribute(information, "type") ?? "") ?? null;
        for (const item of children(information, "Item")) {
          const areaNodes = children(item, "Areas");
          if (areaNodes.length > 1) invalid = true;
          const places = children(areaNodes[0] ?? null, "Area").flatMap((node) => { const place = areaOf(node); return place == null ? [] : [place]; });
          entries.push({ layer, active: itemActive(item), places });
        }
      }
      // Headline に竜巻の Information が無い報だけ Body/Warning を読む。
      if (informations.length === 0) {
        const bodies = children(material.xml, "Body");
        if (bodies.length > 1) invalid = true;
        for (const warning of typed(children(bodies[0] ?? null, "Warning"))) {
          const layer = TORNADO_LAYERS.get(attribute(warning, "type") ?? "") ?? null;
          for (const item of children(warning, "Item")) {
            const nodes = children(item, "Area");
            // Area が無い Item は区域を出さない（拒否しない、P3-C13-TORNADO-FACTS の fail-bright）。Area の形の外は invalid。
            if (nodes.length > 1) invalid = true;
            const place = nodes.length === 1 ? areaOf(nodes[0]) : null;
            entries.push({ layer, active: itemActive(item), places: place == null ? [] : [place] });
          }
        }
      }
      if (entries.length === 0) missing = true;
      const active = entries.some((entry) => entry.active);
      release = !active;
      if (active && validMs != null && validMs <= reportMs) invalid = true;
      if (active) {
        const counts = new Map<TornadoAreaLayer, number>();
        for (const entry of entries) {
          if (!entry.active) continue;
          if (entry.layer == null) { if (entry.places.length !== 0) truncated = true; continue; }
          counts.set(entry.layer, (counts.get(entry.layer) ?? 0) + entry.places.length);
          for (const place of entry.places) areas.push({ layer: entry.layer, code: place.code, name: bound(place.name, BOUNDS.name) });
          if (entry.layer === "sighting" && entry.places.length !== 0) sighted = true;
        }
        if (areas.length === 0) truncated = true;
        noticeAreas = AREA_LAYER_ORDER.map((layer) => counts.get(layer) ?? 0).find((value) => value > 0) ?? 0;
        if (areas.length > LIMITS.tornadoAreas) { truncated = true; areas = areas.slice(0, LIMITS.tornadoAreas); }
        sighted = sighted || headlineRaw.startsWith(SIGHTED_MARK);
      }
    }
    return finish({ ...shared(), slice: "tornado", headType: tornadoType, release, sighted, areas: release || cancelled ? [] : areas, validMs, noticeAreas });
  }

  if (headType === "VPFT50") {
    let targetDate = "", activeUntil = 0;
    if (!cancelled) {
      // 対象日は Head/TargetDateTime の JST の日付（P3-C13-HEAT-EXPIRY=A）。受信時刻で補わない。Body は読まず、形も確かめない。
      const targets = children(head, "TargetDateTime");
      const text = targets.length === 0 ? "" : scalar(targets[0]);
      if (targets.length === 0 || text === "") missing = true;
      else if (targets.length > 1 || text == null || !validReportDateTime(text)) invalid = true;
      else {
        const target = Date.parse(text);
        activeUntil = jstDayEnd(target);
        targetDate = jstDate(target);
        if (activeUntil <= reportMs || activeUntil > reportMs + HEAT_TARGET_WINDOW) invalid = true;
      }
    }
    // 地域名は切り詰める前の Title の「熱中症警戒アラート」の前の部分（引けなければ null。特別警戒は持たない、P3-C13-HEAT-SPECIAL=A）。
    const at = titleText.indexOf("熱中症警戒アラート");
    const area = at < 0 ? "" : titleText.slice(0, at).trim();
    // 切り詰め（truncated を立てる）を shared() の評価より先に済ませる。
    const areaName = area === "" ? null : bound(area, BOUNDS.name);
    return finish({ ...shared(), slice: "heat", headType: "VPFT50", targetDate, areaName, activeUntil });
  }

  // transient
  if (transientType == null) return reject("identityInvalid", subject);
  const family = FAMILY_OF[transientType];
  let areas: TransientArea[] = [];
  const tags: string[] = [];
  if (!cancelled) {
    // 区域は Head/Headline の Information の Item の Areas/Area、無ければ Body/TargetArea。tag は weatherExplanation の「情報タグ」の Condition。
    const fromHeadline: TransientArea[] = [];
    for (const information of children(headlines[0] ?? null, "Information"))
      for (const item of children(information, "Item")) {
        const areaNodes = children(item, "Areas");
        if (areaNodes.length > 1) invalid = true;
        for (const node of children(areaNodes[0] ?? null, "Area")) { const place = areaOf(node, true); if (place != null) fromHeadline.push(place); }
        if (family !== "weatherExplanation") continue;
        for (const kind of children(item, "Kind")) {
          const names = children(kind, "Name");
          if (names.length !== 1 || scalar(names[0]) !== "情報タグ") continue;
          for (const condition of children(kind, "Condition")) {
            const text = scalar(condition);
            if (text == null || /[\u0000-\u0008\u000e-\u001f\u007f]/.test(text) || loneSurrogate(text)) invalid = true;
            for (const word of (text ?? "").split(/\s+/)) if (word !== "") tags.push(word);
          }
        }
      }
    const fallback = fromHeadline.length === 0 && targetArea.length === 1 ? areaOf(targetArea[0], true) : null;
    const found = fromHeadline.length !== 0 ? fromHeadline : fallback == null ? [] : [fallback];
    if (found.length > LIMITS.transientAreas) truncated = true;
    areas = found.slice(0, LIMITS.transientAreas).map((place) => ({ code: place.code, name: bound(place.name, BOUNDS.name) }));
  }
  if (tags.length > LIMITS.tags) truncated = true;
  const kept = tags.slice(0, LIMITS.tags).map((word) => bound(word, BOUNDS.name));
  return finish({ ...shared(), slice: "transient", headType: transientType, family, areas, tags: kept });
}

export {
  BOUNDS, FAMILY_OF, HEAT_LIMIT, HEAT_RETAIN, HEAT_TARGET_WINDOW, HOUR, JST, LAYER_SET, LIMITS, TORNADO_DEFAULT_VALID, TORNADO_LIMIT, TORNADO_RETAIN,
  TRANSIENT_LIMIT, TRANSIENT_RETAIN, TRANSIENT_TYPES, VISIBLE_TRANSIENT, dateEnd, parseLocalBulletins, validEventId, validKeyTitle,
  validOffice, validSeries,
};
export type { HeatCandidate, LocalBulletinsCandidate, TornadoCandidate, TransientCandidate, TransientHeadType };
