import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { ClockReading, JsonValue, SubjectOutcome } from "../../contracts/p2-shared-runtime.types";
import type { EewLogField } from "../../contracts/p3-cli-repl.types";
import { depthText, jsonList, jsonRecord, jsonString, magnitudeText, rawValue } from "./format";

// P3-TO-AC15: EEW ログファイル（互換必須）。書式は旧築 src/engine/eew/eew-logger.ts の写し（file 名・見出し・1 報のブロック・差分・取消・記録終了）。
// 材料は U-E の受信の outcome の facts.report（P3-EEW-FACTS-001）。dmdata の規約で EEW は personal 限定なので、書くのは設定の場所の下だけ（AC15 (5)）。
// RET-01・RES-03: EventID → file の表は 64 件。書き込みの鎖は全体で 1 本（受けた順に 1 つずつ）で、始めていない書き込みは 64 件まで。
// 無いと止まった disk の上で書き込みの待ちが溜まり続ける。1 報は数 KB で多くて毎秒数本なので、EventID ごとに並べて書く利点は無い（統合担当の裁定）。
const LIMIT = 64;
const FIELDS: readonly EewLogField[] = ["hypocenter", "originTime", "coordinates", "magnitude", "forecastIntensity", "maxLgInt", "forecastAreas",
  "lgIntensity", "isPlum", "hasArrived", "diff", "maxIntChangeReason"];
const REASON_LABELS: Readonly<Record<number, string>> = { 0: "不明", 1: "M変化", 2: "震源変化", 3: "M+震源", 4: "深さ変化", 9: "PLUM法" };
// 予測震度の段（旧築 eew-tracker の safety rank の並び）。
const RANKS = ["0", "1", "2", "3", "4", "5-", "5+", "6-", "6+", "7"];

type Json = JsonValue | undefined;
// 同じ EventID・同じ種類（VXSE43・VXSE45）の前の報の値（旧築の差分は同じ種類の続報の間だけ）。
type Previous = Readonly<{ magnitude: string | null; depth: string | null; max: Forecast | null; name: string | null }>;
type Entry = { path: string; previous: Map<string, Previous> };
type Write = Readonly<{ path: string; data: string }>;
type Forecast = Readonly<{ label: string; rank: number | null; upper: boolean }>;

const two = (value: number): string => String(value).padStart(2, "0");
const localTime = (raw: string): string => {
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? raw : `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())}`;
};
const clockText = (ms: number): string => { const at = new Date(ms); return `${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())}`; };
const stamp = (ms: number): string => { const at = new Date(ms); return `${at.getFullYear()}${two(at.getMonth() + 1)}${two(at.getDate())}_${two(at.getHours())}${two(at.getMinutes())}${two(at.getSeconds())}`; };
// file 名に使えない字を除く（旧築の sanitizeEventId、path の外へ出ない）。
const safeEventId = (eventId: string): string => eventId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
const canonical = (raw: string | null): string | null => raw == null ? null : raw.normalize("NFKC").replace(/\s+/g, "");

// 予測震度の From・To の字（旧築 eew-tracker の intensityDetailLabel と safety rank の写し）。
// shortcut: 旧築の特殊値の全部（qualitative・一部不明の印）は写していない。From・To が段の字・over・同じ値の形だけを読む。範囲外の字はそのまま出す。
function forecast(value: Json): Forecast | null {
  const item = jsonRecord(value), from = canonical(jsonString(jsonRecord(item?.from)?.raw)), to = canonical(jsonString(jsonRecord(item?.to)?.raw));
  if (from == null || from === "") return from == null ? null : { label: "空欄", rank: null, upper: false };
  const low = RANKS.indexOf(from), high = to == null ? low : RANKS.indexOf(to);
  if (low < 0) return { label: to == null ? from : `${from}〜${to}`, rank: null, upper: false };
  if (to?.toLowerCase() === "over") return { label: `${from}程度以上`, rank: low, upper: false };
  if (high < 0) return { label: `${from}〜${to}`, rank: null, upper: false };
  return { label: low === high ? from : `${from}〜${to}`, rank: high, upper: true };
}
// 最大予測震度は地域ごとと全体の値のうち段の最も高いもの（同じ段なら範囲を値より先、旧築の higherEewIntensity）。
function maximum(prediction: Readonly<{ [key: string]: JsonValue }> | null): Forecast | null {
  if (prediction == null) return null;
  let best: Forecast | null = null;
  for (const candidate of [...jsonList(prediction.areas).map((area) => forecast(jsonRecord(area)?.intensity)), forecast(prediction.maximum)]) {
    if (candidate == null) continue;
    if (best == null || (candidate.rank ?? -1) > (best.rank ?? -1) || (candidate.rank === best.rank && candidate.label.includes("〜") && !best.label.includes("〜"))) best = candidate;
  }
  return best;
}

type EewLog = Readonly<{
  record(subject: SubjectOutcome): void;
  set(enabled: boolean, fields: Readonly<Partial<Record<EewLogField, boolean>>>): void;
  // 開いている EventID を「シャットダウン」で閉じ、書きかけが終わったら resolve する。
  close(): Promise<void>;
  dropped(): number;
}>;

function createEewLog(options: Readonly<{ directory: string; enabled: boolean; fields: Readonly<Partial<Record<EewLogField, boolean>>>;
  clock: () => ClockReading; append?: (path: string, data: string) => Promise<void> }>): EewLog {
  let enabled = options.enabled, dropped = 0;
  let fields = new Set(FIELDS.filter((field) => options.fields[field] !== false));
  const table = new Map<string, Entry>();
  // 試験で差し替える（T16）。既定は設定の場所の下に directory を作って追記する（file を作り直さない、AC15 (3)）。
  const append = options.append ?? ((path: string, data: string) => mkdir(options.directory, { recursive: true }).then(() => appendFile(path, data, "utf8")));
  const pending: Write[] = [];
  let running = false, idle: (() => void) | null = null;

  // AC15 (3): appendFile は一度に 1 つ、受けた順に走らせる。始めた append は最後まで走らせる。
  const run = (): void => {
    const next = pending.shift();
    if (next == null) { running = false; idle?.(); return; }
    running = true;
    void append(next.path, next.data).catch(() => { /* 書けなかった報は捨てる（受信は止めない） */ }).then(run);
  };
  // 始めていない書き込みが 64 件を越えたら、最も古いものを捨てて数える。
  const write = (item: Write): void => {
    pending.push(item);
    if (pending.length > LIMIT) { pending.shift(); dropped += 1; }
    if (!running) run();
  };
  const has = (field: EewLogField): boolean => fields.has(field);

  // 旧築 buildReportBlock の写し。facts.report の字を旧築の ParsedEewInfo の欄に当てる。
  function block(subject: SubjectOutcome, previous: Previous | undefined, now: ClockReading): { text: string; next: Previous } {
    const facts = subject.facts, report = jsonRecord(facts.report), prediction = jsonRecord(facts.prediction);
    const cancelled = subject.informationType === "取消";
    const serial = typeof facts.serial === "number" ? String(facts.serial) : "?";
    const lines = [`--- 第${serial}報 (${cancelled ? "取消" : facts.warningClass === "warning" ? "警報" : "予報"}) ${clockText(now.wallTimeMs)} ---`];
    const name = jsonString(report?.hypocenter), coordinate = rawValue(report?.coordinate), magnitudeValue = rawValue(report?.magnitude);
    const magnitude = magnitudeValue == null ? null : magnitudeText(magnitudeValue);
    const depth = coordinate == null ? null : depthText(coordinate);
    const max = maximum(prediction);
    const next: Previous = { magnitude, depth, max, name };
    // AC15 (4)・Q-TO-L-1: 取消は取消の文だけ（震源も仮定震源の印も書かない）。
    if (cancelled) return { text: [...lines, "この地震についての緊急地震速報は取り消されました。", ""].join("\n"), next };
    const assumed = report?.isAssumedHypocenter === true;
    if (name != null || coordinate != null || magnitudeValue != null) {
      if (has("hypocenter")) lines.push(`震源: ${name ?? ""}`);
      const origin = jsonString(report?.originTimeRaw);
      if (has("hypocenter") && has("originTime") && origin != null && origin !== "") lines.push(`  発生: ${localTime(origin)}`);
      const place = /^([+-][0-9.]+)([+-][0-9.]+)/.exec(coordinate?.raw ?? "");
      if (has("hypocenter") && has("coordinates") && place != null) {
        const lat = Number(place[1]), lon = Number(place[2]);
        lines.push(`  座標: ${lat >= 0 ? "N" : "S"}${Math.abs(lat).toFixed(1)} ${lon >= 0 ? "E" : "W"}${Math.abs(lon).toFixed(1)}`);
      }
      if (assumed) {
        if (has("hypocenter")) lines.push("仮定震源要素 (震源未確定・PLUM法による推定)");
      } else {
        if (has("magnitude")) lines.push(depth == null ? magnitude ?? "M不明" : `${magnitude ?? "M不明"}  深さ${depth}`);
        if (has("diff") && previous != null) {
          const parts: string[] = [];
          if (previous.magnitude !== magnitude) parts.push(`${previous.magnitude ?? "—"}→${magnitude ?? "—"}`);
          if (previous.depth !== depth) parts.push(`${previous.depth ?? "—"}→${depth ?? "—"}`);
          // 最大予測震度は、段が変わり、今の値が上がったか上限の分かる値のときだけ（旧築 computeDiff。下がった「程度以上」で書き換えない）。
          // shortcut: 旧築が覚える「これまでの最大の段」は持たず、前の報の段と比べる。
          if (previous.max != null && max?.rank != null && previous.max.rank !== max.rank && (previous.max.rank == null || max.rank > previous.max.rank || max.upper)) {
            parts.push(`震度${previous.max.label}→${max.label}`);
          }
          if (previous.name != null && name != null && previous.name !== name) parts.push("震源変更");
          if (parts.length > 0) lines.push(`変化:  [${parts.join(", ")}]`);
        }
        const reason = jsonString(report?.maxIntChangeReasonRaw);
        if (has("maxIntChangeReason") && reason != null && reason.trim() !== "" && Number.isFinite(Number(reason))) {
          lines.push(`震度変化理由: ${REASON_LABELS[Number(reason)] ?? "不明"} [${Number(reason)}]`);
        }
      }
    }
    if (prediction != null) {
      if (has("forecastIntensity") && max != null) lines.push(`最大予測震度: ${max.label}`);
      const maxLg = jsonString(jsonRecord(report?.maxLgInt)?.from);
      if (has("forecastIntensity") && has("maxLgInt") && maxLg != null && maxLg !== "") lines.push(`最大予測長周期階級: ${maxLg}`);
      if (has("forecastAreas")) {
        const areas = jsonList(report?.areas), predicted = jsonList(prediction.areas);
        const rows = areas.map((value, index) => {
          const area = jsonRecord(value), intensity = jsonRecord(jsonRecord(predicted[index])?.intensity);
          const condition = canonical(jsonString(intensity?.condition)) ?? "";
          const lg = jsonString(jsonRecord(area?.lgInt)?.from);
          return { name: jsonString(area?.name) ?? "", label: forecast(intensity)?.label ?? "不明",
            lg: lg == null || lg === "" ? null : lg, plum: condition.includes("PLUM法"), arrived: condition.includes("既に主要動到達") };
        });
        const flags = (row: (typeof rows)[number]): string[] => [...has("lgIntensity") && row.lg != null ? [`L${row.lg}`] : [],
          ...has("isPlum") && row.plum ? ["P"] : [], ...has("hasArrived") && row.arrived ? ["A"] : []];
        if (rows.some((row) => flags(row).length > 0)) {
          lines.push(`  注記: {${[...has("lgIntensity") ? ["Lx=長周期階級"] : [], ...has("isPlum") ? ["P=PLUM"] : [], ...has("hasArrived") ? ["A=主要動到達"] : []].join(", ")}}`);
        }
        const groups = new Map<string, string[]>();
        for (const row of rows) {
          const marks = flags(row);
          const label = marks.length > 0 ? `${row.name}{${marks.join(",")}}` : row.name;
          const group = groups.get(row.label);
          if (group == null) groups.set(row.label, [label]); else group.push(label);
        }
        for (const [label, names] of groups) lines.push(`  震度${label}: ${names.join(", ")}`);
      }
    }
    const advisory = jsonString(report?.nextAdvisory);
    if (advisory != null && advisory !== "") lines.push(advisory);
    lines.push("");
    return { text: lines.join("\n"), next };
  }

  const closeEvent = (eventId: string, reason: string): void => {
    const entry = table.get(eventId);
    if (entry == null) return;
    table.delete(eventId);
    write({ path: entry.path, data: `\n--- 記録終了 (${reason}) ${clockText(options.clock().wallTimeMs)} ---\n` });
  };

  return {
    record(subject) {
      const eventId = safeEventId(jsonString(subject.facts.eventId) || "unknown");
      if (enabled) {
        const now = options.clock(), family = jsonString(subject.facts.family) ?? subject.source?.family ?? "";
        let entry = table.get(eventId), data = "";
        if (entry == null) {
          // 閉じた EventID と表から外した EventID の続報も、旧築どおり見出しから旧築の命名の path に書く（同じ秒なら同じ file に追記で続く）。
          entry = { path: join(options.directory, `eew_${eventId}_${stamp(now.wallTimeMs)}.log`), previous: new Map() };
          table.set(eventId, entry);
          if (table.size > LIMIT) table.delete(table.keys().next().value!);
          const reported = subject.source?.reportDateTimeRaw ?? "";
          data = `=== 緊急地震速報 EventID: ${eventId} ===\n記録開始: ${localTime(reported)}\n`;
        }
        const { text, next } = block(subject, entry.previous.get(family), now);
        entry.previous.set(family, next);
        write({ path: entry.path, data: data + text });
      }
      // 閉じるきっかけは取消と最終報（旧築 process-eew と同じ順: 報を書いてから閉じる）。期限では閉じない（AC15 (1)）。
      if (subject.informationType === "取消") closeEvent(eventId, "取消");
      else if ((jsonString(jsonRecord(subject.facts.report)?.nextAdvisory) ?? "") !== "") closeEvent(eventId, "最終報");
    },
    set(next, nextFields) {
      enabled = next;
      fields = new Set(FIELDS.filter((field) => nextFields[field] !== false));
    },
    close() {
      for (const eventId of [...table.keys()]) closeEvent(eventId, "シャットダウン");
      return running ? new Promise<void>((resolve) => { idle = resolve; }) : Promise.resolve();
    },
    dropped: () => dropped,
  };
}

export { createEewLog };
export type { EewLog };
