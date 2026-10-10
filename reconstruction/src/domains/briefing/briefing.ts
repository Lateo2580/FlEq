import type { DecodedMaterial, Operation, XmlElement, XmlNode } from "../../../contracts/p1-parser-boundary.types";
import type { DiagnosticDetails, RejectionReason, ReportRef } from "../../../contracts/p2-shared-runtime.types";
import type { BriefingArea, BriefingItem, BriefingKind, BriefingObservation } from "../../../contracts/p3-briefing-unit.types";
import { validateSemanticEnvelope } from "../../runtime/shared-runtime";
import { cut, infoRankOf, loneSurrogate, validEventId, validInputId, validName, validReportDateTime, validSerial, validTime, validValue }
  from "../flood/flood";

// P3-UNIT-B-001 の adapter: VPBS50・VPOA50 の本文を Q-ENUM の順で確かめ、候補を項目ごとに組み立てる。
// 値の形の検査は U-R と同じ規則なので domains/flood の export を使う（写さない。共有化は統合担当が決める、AC12）。

// P3-C12-KINDS=A: 情報タグの Condition の trim を NFKC で引く完全一致の表。
const KINDS: ReadonlyMap<string, BriefingKind> = new Map([["線状降水帯発生", "linearRainObserved"], ["線状降水帯直前", "linearRainPredicted"],
  ["記録雨", "recordRain"], ["記録的短時間大雨", "recordRain"], ["短時間大雪", "shortSnow"]]);
// 受理と decode で同じ値から引く。切った condition から引くので、切り詰めで表と食い違う保存物を作らない。
const kindOf = (condition: string | null): BriefingKind => condition == null ? "unknown" : KINDS.get(condition.normalize("NFKC")) ?? "unknown";

// I-U-B.bounds（UTF-16 の長さ）と P3-C12-BOUNDS=A の件数。
const BOUNDS = { title: 64, headline: 192, office: 16, condition: 16, name: 16, unit: 8 } as const;
const LIMITS = { items: 4, areas: 16, observations: 8 } as const;
const RECORD_RAIN = "記録的短時間大雨情報（発表細分）";

const validCode = (value: string): boolean => /^\d{1,8}$/.test(value);
// headline は改行だけを許し、ほかの制御文字と孤立したサロゲートを拒む（I-U-B.bounds）。
const validHeadline = (value: string): boolean => !/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/.test(value) && !loneSurrogate(value);
const validUnit = (value: string): boolean => value.length <= BOUNDS.unit && !/[\u0000-\u001f\u007f]/.test(value) && !loneSurrogate(value);
// 系列は EventID の最初の「_」より前なので「_」を含まない（P3-C12-SUBJECTS=A）。
const validSeries = (value: string): boolean => /^[\x21-\x5e\x60-\x7e]{1,40}$/.test(value);

// ---- XML の読み取り（domains/flood・landslide と同じ写し。共有化は統合担当が決める、AC12） ----

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

type BriefingCandidate = Readonly<{
  operation: Operation; headType: "VPBS50" | "VPOA50"; series: string; subject: string; source: ReportRef; reportDateTimeMs: number;
  infoRank: number; cancelled: boolean; title: string; headline: string; editorialOffice: string; items: readonly BriefingItem[];
  observations: readonly BriefingObservation[]; areas: readonly BriefingArea[]; truncated: boolean;
}>;
type ParseResult = Readonly<{ kind: "accepted"; candidate: BriefingCandidate }>
  | Readonly<{ kind: "rejected"; subject: string; reason: RejectionReason; diagnostic: DiagnosticDetails }>;

const PARTS = [["EventPart", "event"], ["PrecipitationPart", "precipitation"], ["SnowfallDepthPart", "snowfall"]] as const;
const VALUE_TAG = { precipitation: "Precipitation", snowfall: "SnowfallDepth" } as const;

// Q-ENUM.priorityRule の順に最初の一 RejectionReason を返す。拒否の subject は系列を読めた後だけ subject。
function parseBriefing(material: DecodedMaterial): ParseResult {
  const common = validateSemanticEnvelope(material);
  if (common.kind === "rejected") return { kind: "rejected", subject: "", reason: common.reason, diagnostic: common.diagnostic };
  const reject = (reason: RejectionReason, subject = ""): ParseResult => ({ kind: "rejected", subject, reason,
    diagnostic: { level: "WARN", component: "briefing", reason, inputId: material.inputId, unit: "U-B" } });

  // Q-ENUM.identity: Head/EventID の系列（P3-C12-SUBJECTS=A）と Serial（必須）。
  const head = children(material.xml, "Head")[0] ?? null;
  const eventIds = children(head, "EventID");
  const eventId = eventIds.length === 0 ? null : scalar(eventIds[0]);
  if (eventIds.length === 0 || eventIds.length === 1 && eventId === "") return reject("identityMissing");
  const headType = material.headType === "VPBS50" || material.headType === "VPOA50" ? material.headType : null;
  if (eventIds.length !== 1 || eventId == null || !validEventId(eventId) || eventId.startsWith("_") || headType == null)
    return reject("identityInvalid");
  const series = eventId.split("_")[0];
  const subject = `${material.operation}/${headType}/${series}`;
  const serialRaw = material.serialRaw.trim();
  if (serialRaw === "") return reject("identityMissing", subject);
  // 保存する ReportRef の byte の上限（Q-ENUM.identity、C11 と同じ文字の形）。
  if (!validSerial(serialRaw) || material.reportDateTimeRaw.length > 40 || material.infoTypeRaw.length > 8 || !validInputId(material.inputId))
    return reject("identityInvalid", subject);

  // 存在を全部確かめてから妥当性を見る（Q-ENUM.priorityRule）。
  let missing = false, invalid = false, truncated = false;
  const bound = (value: string, limit: number): string => {
    if (value.length > limit) truncated = true;
    return cut(value, limit);
  };
  // 1 個の非空 scalar の名前を読む。無いか空は missing、重複・子要素・制御文字は invalid。
  const name = (parent: XmlElement | null, tag: string): string | null => {
    const nodes = children(parent, tag);
    const text = nodes.length === 0 ? null : scalar(nodes[0]);
    if (nodes.length === 0 || text === "") { missing = true; return null; }
    if (nodes.length > 1 || text == null || !validName(text)) { invalid = true; return null; }
    return text;
  };
  // 区域・地点の Code は数字だけ 8 byte 以下（切らない）。
  const code = (parent: XmlElement): string | null => {
    const nodes = children(parent, "Code");
    const text = nodes.length === 0 ? null : scalar(nodes[0]);
    if (nodes.length === 0 || text === "") { missing = true; return null; }
    if (nodes.length > 1 || text == null || !validCode(text)) { invalid = true; return null; }
    return text;
  };
  const areasOf = (parent: XmlElement | null): BriefingArea[] => children(parent, "Area").flatMap((area) => {
    const value = code(area), label = name(area, "Name");
    return value == null || label == null ? [] : [{ code: value, name: bound(label, BOUNDS.name) }];
  });

  const title = name(head, "Title");
  // Head/InfoType も 1 個の scalar を確かめる（P1 は最初の要素の直下 text だけを読む、C10 の Q-C10-IMPL-AMEND(15)）。
  const infoTypes = children(head, "InfoType");
  const infoTypeText = infoTypes.length === 0 ? null : scalar(infoTypes[0]);
  const infoTypeRaw = material.infoTypeRaw;
  const infoRank = infoTypes.length === 1 && infoTypeText === infoTypeRaw.trim() ? infoRankOf(infoTypeRaw) : undefined;
  if (infoTypes.length === 0 || infoTypeText === "") missing = true;
  else if (infoRank == null) invalid = true;
  const cancelled = infoRank === 3;

  let headline = "", editorialOffice = "";
  let items: BriefingItem[] = [], observations: BriefingObservation[] = [], areas: BriefingArea[] = [];
  // Control/EditorialOffice は取消でも有無と形を確かめる（Q-ENUM.familyTable.required、統合担当の決定）。取消は事実を持たないので保存しない。
  const office = name(children(material.xml, "Control")[0] ?? null, "EditorialOffice");
  // 取消は Body と Headline を読まない（Q-ENUM.familyTable.legalMissing）。
  if (!cancelled) {
    const headlines = children(head, "Headline");
    const texts = children(headlines[0] ?? null, "Text");
    const text = texts.length === 0 ? "" : scalar(texts[0]);
    if (headlines.length > 1 || texts.length > 1 || text == null || !validHeadline(text)) invalid = true;
    else headline = bound(text, BOUNDS.headline);
    if (office != null) editorialOffice = bound(office, BOUNDS.office);
    const informations = children(headlines[0] ?? null, "Information");

    if (headType === "VPBS50") {
      // P3-C12-FACTS=A: 情報タグの各 Item（Kind 1 個、Condition 0 か 1 個、Areas 0 か 1 個）。ほかの Information は読まない。
      const read: BriefingItem[] = [];
      for (const item of informations.filter((node) => attribute(node, "type") === "情報タグ").flatMap((node) => children(node, "Item"))) {
        const kinds = children(item, "Kind"), conditions = children(kinds[0] ?? null, "Condition"), areaNodes = children(item, "Areas");
        if (kinds.length !== 1 || conditions.length > 1 || areaNodes.length > 1) invalid = true;
        const raw = conditions.length === 0 ? null : scalar(conditions[0]);
        if (conditions.length !== 0 && (raw == null || !validName(raw))) invalid = true;
        const condition = raw == null || raw === "" ? null : bound(raw, BOUNDS.condition);
        read.push({ kind: kindOf(condition), condition, areas: areasOf(areaNodes[0] ?? null) });
      }
      // P3-C12-BOUNDS=A: item 4・区域の延べ 16 を超えた分は電文順の後ろから捨てる。区域の無い予測の item は除く（P3-C12-REPLACE.common）。
      if (read.length > LIMITS.items) truncated = true;
      let budget: number = LIMITS.areas;
      items = read.slice(0, LIMITS.items).flatMap((item) => {
        const kept = item.areas.slice(0, Math.max(budget, 0));
        if (kept.length < item.areas.length) truncated = true;
        budget -= kept.length;
        return item.kind === "linearRainPredicted" && kept.length === 0 ? [] : [{ ...item, areas: kept }];
      });

      // Body の観測実況（EventPart・PrecipitationPart・SnowfallDepthPart だけ）。
      const bodies = children(material.xml, "Body");
      if (bodies.length > 1) invalid = true;
      const observationItems = children(bodies[0] ?? null, "MeteorologicalInfos").flatMap((node) => children(node, "MeteorologicalInfo"))
        .flatMap((node) => children(node, "Item"));
      for (const item of observationItems) {
        const places = [...children(item, "Area"), ...children(item, "Station")];
        if (places.length !== 1) { invalid = true; continue; }
        const areaCode = code(places[0]), areaName = name(places[0], "Name");
        for (const property of children(item, "Kind").flatMap((node) => children(node, "Property"))) {
          const typeNodes = children(property, "Type");
          const propertyType = typeNodes.length === 1 ? scalar(typeNodes[0]) : null;
          for (const [tag, part] of PARTS) {
            const nodes = children(property, tag);
            if (nodes.length > 1) invalid = true;
            if (nodes.length !== 1) continue;
            // event の値は Event の中、雨・雪は要素（jmx_eb:Precipitation・SnowfallDepth）と Part の Time。
            const values = children(nodes[0], part === "event" ? "Event" : VALUE_TAG[part]);
            if (values.length > 1) invalid = true;
            const element = values[0] ?? null;
            const names = part === "event" ? children(element, "EventName") : [];
            const eventName = names.length === 0 ? null : scalar(names[0]);
            if (names.length > 1 || names.length === 1 && eventName == null) invalid = true;
            const times = children(part === "event" ? element : nodes[0], "Time");
            const time = times.length === 0 ? "" : scalar(times[0]);
            if (times.length > 1 || time == null || time !== "" && !validTime(time)) invalid = true;
            const valueText = part === "event" || element == null ? "" : scalar(element);
            if (valueText == null || valueText !== "" && !validValue(valueText)) invalid = true;
            const unit = part === "event" || element == null ? null : attribute(element, "unit");
            if (unit != null && unit !== "" && !validUnit(unit)) invalid = true;
            // label は EventName か type 属性。無ければ Property/Type。どれも無い観測はその観測だけを捨てて truncated にする（type は
            // legalMissing、C9〜C11 の fail-bright の先例、統合担当の決定）。
            const labelText = (part === "event" ? eventName : element == null ? null : attribute(element, "type")) || propertyType;
            if (labelText == null || labelText === "") { truncated = true; continue; }
            if (!validName(labelText)) invalid = true;
            if (areaCode == null || areaName == null || !validName(labelText) || valueText == null || time == null) continue;
            const value = valueText === "" ? null : Number(valueText);
            const condition = part === "event" || element == null ? null : attribute(element, "condition");
            observations.push({ part, areaCode, areaName: bound(areaName, BOUNDS.name), label: bound(labelText, BOUNDS.name), value,
              unit: unit == null || unit === "" ? null : unit,
              approximation: condition === "以上" ? "atLeast" : condition === "約" ? "approx" : condition == null || condition === ""
                ? value == null ? "unknown" : "exact" : "unknown",
              time: time === "" ? null : time });
          }
        }
      }
      if (observations.length > LIMITS.observations) { truncated = true; observations = observations.slice(0, LIMITS.observations); }
    } else {
      // VPOA50 は Head の「記録的短時間大雨情報（発表細分）」の区域だけ（Body は読まない、P3-C12-FACTS=A）。
      const typed = informations.filter((node) => attribute(node, "type") === RECORD_RAIN);
      const typedItems = children(typed[0] ?? null, "Item");
      if (typed.length !== 1 || typedItems.length === 0) invalid = true;
      const fixed = (kind: XmlElement | null, tag: string, value: string) => {
        const nodes = children(kind, tag);
        return nodes.length === 1 && scalar(nodes[0]) === value;
      };
      for (const item of typedItems) {
        const kinds = children(item, "Kind"), areaNodes = children(item, "Areas");
        if (kinds.length !== 1 || !fixed(kinds[0], "Code", "1") || !fixed(kinds[0], "Name", "記録的短時間大雨情報") || !fixed(kinds[0], "Condition", "発表")
          || areaNodes.length !== 1 || children(areaNodes[0], "Area").length === 0) invalid = true;
        areas.push(...areasOf(areaNodes[0] ?? null));
      }
      if (areas.length > LIMITS.areas) { truncated = true; areas = areas.slice(0, LIMITS.areas); }
    }
  }
  if (missing) return reject("requiredStructureMissing", subject);
  if (invalid || infoRank == null || title == null) return reject("requiredStructureInvalid", subject);
  return { kind: "accepted", candidate: { operation: material.operation, headType, series, subject,
    source: { inputId: material.inputId, origin: material.origin, operation: material.operation, family: headType, subject,
      reportDateTimeRaw: material.reportDateTimeRaw, serialRaw, infoTypeRaw },
    reportDateTimeMs: common.envelope.reportDateTimeMs, infoRank, cancelled, title: bound(title, BOUNDS.title), headline, editorialOffice,
    items, observations, areas, truncated } };
}

export { BOUNDS, KINDS, LIMITS, kindOf, parseBriefing, validCode, validHeadline, validSeries, validUnit };
export type { BriefingCandidate };
