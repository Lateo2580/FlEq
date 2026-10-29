import type { DecodedMaterial, Operation, XmlElement } from "../../../contracts/p1-parser-boundary.types";
import type { DiagnosticDetails, RejectionReason, ReportRef, UnreadableMark } from "../../../contracts/p2-shared-runtime.types";
import type { BriefingArea, BriefingItem, BriefingKind, BriefingObservation, BriefingUnreadableSite } from "../../../contracts/p3-briefing-unit.types";
import { validateSemanticEnvelope } from "../../runtime/shared-runtime";
import { cut, infoRankOf, loneSurrogate, validEventId, validName, validReportDateTime, validSerial, validTime, validValue }
  from "../flood/flood"; import { controlDateTimeOf } from "../../contracts-revision/version";
import { unreadableNotes } from "../../units/unreadable"; import { attribute, children, localName, scalar } from "../../decode-material/xml-read";

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
// 系列は EventID の最初の「_」より前か、記録的短時間大雨では EventID の全体（P3-C12-SUBJECTS=A・P3-EF-AC09 (1)）。先頭は「_」でない。
const validSeries = (value: string): boolean => /^[\x21-\x5e\x60-\x7e][\x21-\x7e]{0,39}$/.test(value);

// ---- XML の読み取り（decode-material/xml-read.ts に集約、P3-XML-READERS-001） ----

// ---- 候補 ----

type BriefingCandidate = Readonly<{
  operation: Operation; headType: "VPBS50" | "VPOA50"; series: string; eventId: string; subject: string; source: ReportRef; reportDateTimeMs: number;
  infoRank: number; cancelled: boolean; title: string; headline: string; editorialOffice: string; items: readonly BriefingItem[];
  observations: readonly BriefingObservation[]; areas: readonly BriefingArea[]; truncated: boolean; unreadable: UnreadableMark | null;
}>;
// diagnostics は受けた報の読めなかった所（P3-EF-AC13、H51 の B）。
type ParseResult = Readonly<{ kind: "accepted"; candidate: BriefingCandidate; diagnostics: readonly DiagnosticDetails[] }>
  | Readonly<{ kind: "rejected"; subject: string; reason: RejectionReason; diagnostic: DiagnosticDetails }>;

const PARTS = [["EventPart", "event"], ["PrecipitationPart", "precipitation"], ["SnowfallDepthPart", "snowfall"]] as const;
const VALUE_TAG = { precipitation: "Precipitation", snowfall: "SnowfallDepth" } as const;

// Q-ENUM.priorityRule の順に最初の一 RejectionReason を返す。拒否の subject は系列を読めた後だけ subject。
function parseBriefing(material: DecodedMaterial): ParseResult {
  const common = validateSemanticEnvelope(material);
  if (common.kind === "rejected") return { kind: "rejected", subject: "", reason: common.reason, diagnostic: common.diagnostic };
  const diagnostic = (reason: RejectionReason): DiagnosticDetails => ({ level: "WARN", component: "briefing", reason, inputId: material.inputId, unit: "U-B" });
  const reject = (reason: RejectionReason, subject = ""): ParseResult => ({ kind: "rejected", subject, reason, diagnostic: diagnostic(reason) });
  // H51 の B（P3-EF-AC13）: 読めない所は報を断らず、所ごとに WARN を 1 件残す。
  type Unreadable = "requiredStructureMissing" | "requiredStructureInvalid";
  // P3-UM-AC01 (2): 同じ所を印の part にもする（WARN は所ごとに 1 件のまま、part は (site, scope) ごと）。node は読めなかった要素か親。
  const warnings = new Map<string, Unreadable>();
  const notes = unreadableNotes();
  const warn = (site: BriefingUnreadableSite, reason: Unreadable, node: XmlElement | null, scope?: string) => {
    if (!warnings.has(site)) warnings.set(site, reason);
    notes.note(site, reason, node, scope);
  };

  // Q-ENUM.identity: Head/EventID の系列（P3-C12-SUBJECTS=A）と Serial（必須）。
  const head = children(material.xml, "Head")[0] ?? null;
  const eventIds = children(head, "EventID");
  const eventId = eventIds.length === 0 ? null : scalar(eventIds[0]);
  if (eventIds.length === 0 || eventIds.length === 1 && eventId === "") return reject("identityMissing");
  const headType = material.headType === "VPBS50" || material.headType === "VPOA50" ? material.headType : null;
  if (eventIds.length !== 1 || eventId == null || !validEventId(eventId) || eventId.startsWith("_") || headType == null)
    return reject("identityInvalid");
  const prefix = eventId.split("_")[0];
  // P3-EF-AC09 (1): VPOA50 は報ごと（EventID の全体）。VPBS50 の取消は情報タグを読まないので全体で当て、記録雨の記録が無ければ記録の無い取消になる。
  const whole = headType === "VPOA50" || infoRankOf(material.infoTypeRaw) === 3;
  const subject = `${material.operation}/${headType}/${whole ? eventId : prefix}`;
  // P3-EF-AC13 (5): Serial の欠け・形の外は空にして受ける（新旧に Serial を使わない、K7）。
  let serialRaw = material.serialRaw.trim();
  const serialNode = children(head, "Serial")[0] ?? head;
  if (serialRaw === "") warn("serial", "requiredStructureMissing", serialNode);
  else if (!validSerial(serialRaw)) { warn("serial", "requiredStructureInvalid", serialNode); serialRaw = ""; }
  // 保存する ReportRef の byte の上限（Q-ENUM.identity、C11 と同じ文字の形）。
  if (material.reportDateTimeRaw.length > 40 || material.infoTypeRaw.length > 8) return reject("identityInvalid", subject);

  // 存在を全部確かめてから妥当性を見る（Q-ENUM.priorityRule）。
  let missing = false, invalid = false, truncated = false;
  const bound = (value: string, limit: number): string => {
    if (value.length > limit) truncated = true;
    return cut(value, limit);
  };
  // 読めない値は null。site のある読み取りは報を断らず WARN（H51 の B）、無いものは報を断る。
  const fail = (reason: Unreadable, site?: BriefingUnreadableSite, node: XmlElement | null = null, scope?: string): null => {
    if (site != null) warn(site, reason, node, scope);
    else if (reason === "requiredStructureMissing") missing = true;
    else invalid = true;
    return null;
  };
  // 1 個の非空 scalar の名前を読む。無いか空は missing、重複・子要素・制御文字は invalid。
  const name = (parent: XmlElement | null, tag: string, site?: BriefingUnreadableSite, scope?: string): string | null => {
    const nodes = children(parent, tag);
    const text = nodes.length === 0 ? null : scalar(nodes[0]);
    if (nodes.length === 0 || text === "") return fail("requiredStructureMissing", site, parent, scope);
    if (nodes.length > 1 || text == null || !validName(text)) return fail("requiredStructureInvalid", site, nodes.length > 1 ? parent : nodes[0], scope);
    return text;
  };
  // 区域・地点の Code は数字だけ 8 byte 以下（切らない）。
  const code = (parent: XmlElement, site?: BriefingUnreadableSite): string | null => {
    const nodes = children(parent, "Code");
    const text = nodes.length === 0 ? null : scalar(nodes[0]);
    if (nodes.length === 0 || text === "") return fail("requiredStructureMissing", site, parent);
    if (nodes.length > 1 || text == null || !validCode(text)) return fail("requiredStructureInvalid", site, nodes.length > 1 ? parent : nodes[0]);
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
  const office = name(children(material.xml, "Control")[0] ?? null, "EditorialOffice", "editorialOffice");
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
        // 読めない Condition は null（種別 unknown、H51 の B）。
        const readable = conditions.length === 0 || raw != null && validName(raw);
        if (!readable) warn("condition", "requiredStructureInvalid", conditions[0]);
        const condition = !readable || raw == null || raw === "" ? null : bound(raw, BOUNDS.condition);
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

      // Body の観測実況（EventPart・PrecipitationPart・SnowfallDepthPart だけ）。観測実況は所属だけの一覧で、読めない観測は捨てて
      // truncated にする（H51 の B、設計メモ §13 の統合担当の読み）。
      // 観測の part の scope は読めた地点の Code（AC01 (4)）。
      const drop = (node: XmlElement, scope?: string) => { warn("observation", "requiredStructureInvalid", node, scope); truncated = true; };
      const bodies = children(material.xml, "Body");
      if (bodies.length > 1) warn("observation", "requiredStructureInvalid", bodies[1]);
      const observationItems = children(bodies[0] ?? null, "MeteorologicalInfos").flatMap((node) => children(node, "MeteorologicalInfo"))
        .flatMap((node) => children(node, "Item"));
      for (const item of observationItems) {
        const places = [...children(item, "Area"), ...children(item, "Station")];
        if (places.length !== 1) { drop(item); continue; }
        const areaCode = code(places[0], "observation"), areaName = name(places[0], "Name", "observation", areaCode ?? undefined);
        for (const property of children(item, "Kind").flatMap((node) => children(node, "Property"))) {
          const typeNodes = children(property, "Type");
          const propertyType = typeNodes.length === 1 ? scalar(typeNodes[0]) : null;
          for (const [tag, part] of PARTS) {
            const nodes = children(property, tag);
            if (nodes.length > 1) { drop(property, areaCode ?? undefined); continue; }
            if (nodes.length !== 1) continue;
            // event の値は Event の中、雨・雪は要素（jmx_eb:Precipitation・SnowfallDepth）と Part の Time。
            const values = children(nodes[0], part === "event" ? "Event" : VALUE_TAG[part]);
            const element = values[0] ?? null;
            const names = part === "event" ? children(element, "EventName") : [];
            const eventName = names.length === 0 ? null : scalar(names[0]);
            const times = children(part === "event" ? element : nodes[0], "Time");
            const time = times.length === 0 ? "" : scalar(times[0]);
            const valueText = part === "event" || element == null ? "" : scalar(element);
            const unit = part === "event" || element == null ? null : attribute(element, "unit");
            if (values.length > 1 || names.length > 1 || names.length === 1 && eventName == null
              || times.length > 1 || time == null || time !== "" && !validTime(time)
              || valueText == null || valueText !== "" && !validValue(valueText) || unit != null && unit !== "" && !validUnit(unit)) {
              drop(nodes[0], areaCode ?? undefined);
              continue;
            }
            // label は EventName か type 属性。無ければ Property/Type。どれも無い観測はその観測だけを捨てて truncated にする（type は
            // legalMissing、C9〜C11 の fail-bright の先例、統合担当の決定）。
            const labelText = (part === "event" ? eventName : element == null ? null : attribute(element, "type")) || propertyType;
            if (labelText == null || labelText === "") { truncated = true; continue; }
            if (!validName(labelText)) { drop(nodes[0], areaCode ?? undefined); continue; }
            if (areaCode == null || areaName == null) { truncated = true; continue; }
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
  // 情報タグの item が 1 件以上で全部記録雨の VPBS50 も報ごと（EventID の頭の「K」では見分けない）。
  const series = whole || items.length !== 0 && items.every((item) => item.kind === "recordRain") ? eventId : prefix;
  const adopted = `${material.operation}/${headType}/${series}`;
  return { kind: "accepted", diagnostics: [...warnings.values()].map(diagnostic), candidate: { operation: material.operation, headType, series, eventId, subject: adopted,
    source: { inputId: material.inputId, origin: material.origin, operation: material.operation, family: headType, subject: adopted,
      reportDateTimeRaw: material.reportDateTimeRaw, controlDateTimeRaw: controlDateTimeOf(material.controlDateTimeRaw), serialRaw, infoTypeRaw },
    reportDateTimeMs: common.envelope.reportDateTimeMs, infoRank, cancelled, title: bound(title, BOUNDS.title), headline, editorialOffice,
    items, observations, areas, truncated, unreadable: notes.mark(material.xml) } };
}

export { BOUNDS, KINDS, LIMITS, kindOf, parseBriefing, validCode, validHeadline, validSeries, validUnit };
export type { BriefingCandidate };
