import type { WsDataMessage, ParsedWeatherWarning } from "../../../src/types";
import type {
  WeatherOutcome,
  WeatherWarningTimeseriesOutcome,
  TornadoOutcome,
  BriefingOutcome,
  EarlyWeatherOutcome,
  ClimateInfoOutcome,
  WeatherExplanationOutcome,
} from "../../../src/engine/presentation/types";
import { parseWeatherWarning } from "../../../src/dmdata/weather-parser";
import { parseWeatherWarningTimeseries } from "../../../src/dmdata/weather-warning-timeseries-parser";
import { parseTornadoAdvisory } from "../../../src/dmdata/tornado-parser";
import { parseWeatherBriefing } from "../../../src/dmdata/briefing-parser";
import { parseEarlyWeather } from "../../../src/dmdata/early-weather-parser";
import { parseClimateInfo } from "../../../src/dmdata/climate-info-parser";
import { parseWeatherExplanation } from "../../../src/dmdata/weather-explanation-parser";
import { parseFloodForecast } from "../../../src/dmdata/flood-forecast-parser";
import {
  parseTsunamiTelegram,
  parseEarthquakeTelegram,
  parseSeismicTextTelegram,
  parseNankaiTroughTelegram,
  parseLgObservationTelegram,
  parseEewTelegram,
} from "../../../src/dmdata/telegram-parser";
import { parseVolcanoTelegram } from "../../../src/dmdata/volcano-parser";
import type { ParsedEewInfo } from "../../../src/types";
import type { EewOutcome } from "../../../src/engine/presentation/types";
import { displayEewInfo, type EewDisplayContext } from "../../../src/ui/eew-formatter";
import { eewFrameLevel, eewSoundLevel } from "../../../src/engine/presentation/level-helpers";
import { displayWeatherWarningCore } from "../../../src/ui/weather-core-formatter";
import { displayWeatherWarning } from "../../../src/ui/weather-formatter";
import { displayWeatherWarningTimeseriesInfo } from "../../../src/ui/weather-warning-timeseries-formatter";
import { displayTornadoAdvisory } from "../../../src/ui/tornado-formatter";
import { displayWeatherBriefing } from "../../../src/ui/briefing-formatter";
import { displayEarlyWeatherInfo } from "../../../src/ui/early-weather-formatter";
import { displayClimateInfo } from "../../../src/ui/climate-info-formatter";
import { displayWeatherExplanation } from "../../../src/ui/weather-explanation-formatter";
import { displayFloodForecastInfo } from "../../../src/ui/flood-forecast-formatter";
import { displayTsunamiInfo } from "../../../src/ui/tsunami-formatter";
import { displayEarthquakeInfo } from "../../../src/ui/earthquake-info-formatter";
import { displayVolcanoInfo } from "../../../src/ui/volcano-formatter";
import { displaySeismicTextInfo } from "../../../src/ui/seismic-text-formatter";
import { displayNankaiTroughInfo } from "../../../src/ui/nankai-trough-formatter";
import { displayLgObservationInfo } from "../../../src/ui/lg-observation-formatter";
import { resolveVolcanoPresentation } from "../../../src/engine/presentation/volcano-presentation";
import { Vpws50StateHolder } from "../../../src/engine/messages/vpws50-state";
import { Vpww56StateHolder } from "../../../src/engine/messages/vpww56-state";
import { FloodForecastStateHolder } from "../../../src/engine/messages/flood-forecast-state";
import { TsunamiStateHolder } from "../../../src/engine/messages/tsunami-state";
import { VolcanoStateHolder } from "../../../src/engine/messages/volcano-state";
import { processWeather } from "../../../src/engine/presentation/processors/process-weather";
import { processFloodForecast } from "../../../src/engine/presentation/processors/process-flood-forecast";
import { processTsunami } from "../../../src/engine/presentation/processors/process-tsunami";
import { processEarthquake } from "../../../src/engine/presentation/processors/process-earthquake";
import { buildVolcanoOutcome } from "../../../src/engine/presentation/processors/process-volcano";
import { processSeismicText } from "../../../src/engine/presentation/processors/process-seismic-text";
import { processNankaiTrough } from "../../../src/engine/presentation/processors/process-nankai-trough";
import { processLgObservation } from "../../../src/engine/presentation/processors/process-lg-observation";
import { toPresentationEvent } from "../../../src/engine/presentation/events/to-presentation-event";
import { renderSummaryLine } from "../../../src/ui/summary/summary-line";
import {
  weatherFrameLevel,
  weatherWarningTimeseriesFrameLevel,
  tornadoFrameLevel,
  briefingFrameLevel,
  earlyWeatherFrameLevel,
  climateInfoFrameLevel,
  weatherExplanationFrameLevel,
} from "../../../src/engine/presentation/level-helpers";
import { inferType } from "../lib/fixture-loader";

/** entry 定義時の generic 形。parse の戻り値型 P が format/compactLine と揃うことを保証する */
interface WeatherEntryDef<P> {
  /** 抽出済み電文タイプ (inferType の結果) に対するアンカー付きマッチ */
  pattern: RegExp;
  label: string;
  parse: (msg: WsDataMessage) => P | null;
  // Phase 2-B で per-call layout 引数 (format(parsed, layout?)) に拡張予定
  format: (parsed: P, eewContext?: EewDisplayContext) => void;
  /** compact (サマリーライン) 1 行。本番 message-router と同じ renderSummaryLine を使う */
  compactLine?: (msg: WsDataMessage, parsed: P, width: number) => string;
  /** EEW 専用 (optional 拡張 — 他 entry の定義に影響させない、spec §7)。
   * msg も受ける: parsed だけでは発表/取消の同一 eventId+serial が衝突しうる (spec 4.6) */
  eewContext?: (msg: WsDataMessage, parsed: P) => EewDisplayContext;
}

/**
 * 消費側 (render-engine) から見た erased 型。
 * format/compactLine には必ず同 entry の parse の戻り値を渡すこと —
 * その対応は defineEntry() が型レベルで保証している。
 */
export interface WeatherEntry {
  pattern: RegExp;
  label: string;
  parse: (msg: WsDataMessage) => unknown;
  format: (parsed: unknown, eewContext?: EewDisplayContext) => void;
  compactLine?: (msg: WsDataMessage, parsed: unknown, width: number) => string;
  eewContext?: (msg: WsDataMessage, parsed: unknown) => EewDisplayContext;
}

/** P を消去して登録する。cast はここ 1 箇所だけ (parse↔format の対応は def 時点で検査済み) */
function defineEntry<P>(def: WeatherEntryDef<P>): WeatherEntry {
  return def as unknown as WeatherEntry;
}

// ── EEW Studio context (fixture 単位の宣言的固定 map。tracker は Studio に持ち込まない — spec 4.6) ──
// キー: `type:eventId:serial:infoType`。連報 fixture に現実的な diff / colorIndex を与える
const EEW_STUDIO_CONTEXTS: Record<string, EewDisplayContext> = {
  "VXSE43:20240417231454:1:発表": { activeCount: 1, colorIndex: 0 },
  // 前報 (37_01_01, serial=1) の実値: M5.8 / 深さ30km / 最大震度5- (愛媛県南予 From5-,To5-)
  "VXSE43:20240417231454:2:発表": { activeCount: 1, colorIndex: 0, diff: { previousMaxInt: "5-", previousMagnitude: "5.8", previousDepth: "30km" } },
  "VXSE43:20240417231454:2:取消": { activeCount: 0, colorIndex: 0 },
  "VXSE44:20240417231454:10:発表": { activeCount: 1, colorIndex: 0 },
  "VXSE45:20240417231454:1:発表": { activeCount: 1, colorIndex: 0 },
  "VXSE45:20240417231454:26:発表": { activeCount: 2, colorIndex: 0, diff: { previousMaxInt: "5+", previousMagnitude: "6.4", previousDepth: "30km" } },
  "VXSE45:20240417231454:32:取消": { activeCount: 0, colorIndex: 0 },
  "VXSE45:20260101090005:3:発表": { activeCount: 1, colorIndex: 0 },
  "VXSE45:20260101090005:10:発表": { activeCount: 2, colorIndex: 1 },
  "VXSE45:20260101120000:30:発表": { activeCount: 1, colorIndex: 0 },
};

function eewStudioContext(msg: WsDataMessage, parsed: ParsedEewInfo): EewDisplayContext {
  const key = `${msg.head.type}:${parsed.eventId ?? ""}:${parsed.serial ?? ""}:${parsed.infoType}`;
  return EEW_STUDIO_CONTEXTS[key] ?? { activeCount: 1, colorIndex: 0 };
}

const ENTRIES: WeatherEntry[] = [
  defineEntry({
    // display-adapter.ts の VPWW_CORE_TYPES と同じ 7 タイプ。
    // 本番経路 (displayWeatherWarningCore) と同じ formatter を使うこと。
    pattern: /^VPWW(5[5-9]|6[01])$/,
    label: "気象警報・注意報 (VPWW55-61)",
    parse: parseWeatherWarning,
    format: (parsed) => displayWeatherWarningCore(parsed),
    compactLine: (msg, parsed, width) => {
      // 本番では processWeather が ProcessOutcome を組む。Studio は同じ意味論の
      // 最小 WeatherOutcome を構築する (fromWeatherOutcome は msg/parsed/domain に加え
      // headType / presentation.frameLevel / msg.xmlReport / msg.id / msg.head.test も読む)。
      // 既知の限界: fixture-loader の合成 xmlReport は title が "Studio preview" のため、
      // entries が 0 件の電文では compact のタイプ表示がこの文字列にフォールバックする
      const outcome: WeatherOutcome = {
        domain: "weather",
        msg,
        headType: msg.head.type,
        statsCategory: "weather",
        stats: { shouldRecord: false },
        presentation: { frameLevel: weatherFrameLevel(parsed) }, // 本番 processWeather と同じ関数
        parsed,
      };
      return renderSummaryLine(toPresentationEvent(outcome), width);
    },
  }),
  defineEntry({
    pattern: /^VPWS50$/,
    label: "気象警報・注意報 全国 (VPWS50)",
    parse: parseWeatherWarning,
    format: (parsed) => {
      // Studio はステートレス: 毎 render 新品の Holder で「初回受信 (isFirstReport)」を再現する。
      // 差分表示 (added/upgraded 等) は前回電文の state が必要なため Studio では扱わない (spec §10.2 解決)。
      // 取消は本番 process-weather と同じ rollback 分岐 — 新品 holder では history 空の
      // log.warn が preview に混ざるが、本番のコールドスタート取消と同一挙動 (忠実)。
      // messageId は履歴記録にしか使われないため固定 prefix で足りる
      const holder = new Vpws50StateHolder();
      const messageId = `studio-${parsed.reportDateTime}`;
      const diff = parsed.infoType === "取消"
        ? holder.rollback(messageId)
        : holder.diffAndUpdate(parsed, messageId);
      displayWeatherWarning(parsed, diff ?? undefined);
    },
    compactLine: (msg, _parsed, width) => {
      // VPWS50 だけは processor に diff 駆動の昇格ロジック (unsafe→warning 等) があるため、
      // 手組み Outcome ではなく本番 processWeather をそのまま呼ぶ (Codex レビュー W2 反映)。
      // msg の再 parse が走るが compact プレビュー時のみのコスト
      const result = processWeather(msg, {
        vpws50State: new Vpws50StateHolder(),
        vpww56State: new Vpww56StateHolder(),
      });
      if (result.kind !== "ok") throw new Error("VPWS50 の parse に失敗しました");
      return renderSummaryLine(toPresentationEvent(result.outcome), width);
    },
  }),
  defineEntry({
    pattern: /^VPWP50$/,
    label: "気象警報・注意報時系列情報 (VPWP50)",
    parse: parseWeatherWarningTimeseries,
    format: (parsed) => displayWeatherWarningTimeseriesInfo(parsed),
    compactLine: (msg, parsed, width) => {
      const outcome: WeatherWarningTimeseriesOutcome = {
        domain: "weatherWarningTimeseries",
        msg,
        headType: msg.head.type,
        statsCategory: "weatherWarningTimeseries",
        stats: { shouldRecord: false },
        presentation: { frameLevel: weatherWarningTimeseriesFrameLevel(parsed) },
        parsed,
      };
      return renderSummaryLine(toPresentationEvent(outcome), width);
    },
  }),
  defineEntry({
    pattern: /^VPHW5[01]$/,
    label: "竜巻注意情報 (VPHW50/51)",
    parse: parseTornadoAdvisory,
    format: (parsed) => displayTornadoAdvisory(parsed),
    compactLine: (msg, parsed, width) => {
      const outcome: TornadoOutcome = {
        domain: "tornado",
        msg,
        headType: msg.head.type,
        statsCategory: "tornado",
        stats: { shouldRecord: false },
        presentation: { frameLevel: tornadoFrameLevel(parsed) },
        parsed,
      };
      return renderSummaryLine(toPresentationEvent(outcome), width);
    },
  }),
  defineEntry({
    pattern: /^VPBS50$/,
    label: "気象防災速報 (VPBS50)",
    parse: parseWeatherBriefing,
    format: (parsed) => displayWeatherBriefing(parsed),
    compactLine: (msg, parsed, width) => {
      const outcome: BriefingOutcome = {
        domain: "briefing",
        msg,
        headType: msg.head.type,
        statsCategory: "briefing",
        stats: { shouldRecord: false },
        presentation: { frameLevel: briefingFrameLevel(parsed) },
        parsed,
      };
      return renderSummaryLine(toPresentationEvent(outcome), width);
    },
  }),
  defineEntry({
    pattern: /^VPAW51$/,
    label: "早期天候情報 (VPAW51)",
    parse: parseEarlyWeather,
    format: (parsed) => displayEarlyWeatherInfo(parsed),
    compactLine: (msg, parsed, width) => {
      const outcome: EarlyWeatherOutcome = {
        domain: "earlyWeather",
        msg,
        headType: msg.head.type,
        statsCategory: "earlyWeather",
        stats: { shouldRecord: false },
        presentation: { frameLevel: earlyWeatherFrameLevel(parsed) },
        parsed,
      };
      return renderSummaryLine(toPresentationEvent(outcome), width);
    },
  }),
  defineEntry({
    pattern: /^VPZI50$/,
    label: "全般天候情報 (VPZI50)",
    parse: parseClimateInfo,
    format: (parsed) => displayClimateInfo(parsed),
    compactLine: (msg, parsed, width) => {
      const outcome: ClimateInfoOutcome = {
        domain: "climateInfo",
        msg,
        headType: msg.head.type,
        statsCategory: "climateInfo",
        stats: { shouldRecord: false },
        presentation: { frameLevel: climateInfoFrameLevel(parsed) },
        parsed,
      };
      return renderSummaryLine(toPresentationEvent(outcome), width);
    },
  }),
  defineEntry({
    pattern: /^VP(CJ|ZJ|FJ)51$/,
    label: "気象解説情報 (VPCJ51/VPZJ51/VPFJ51)",
    parse: parseWeatherExplanation,
    format: (parsed) => displayWeatherExplanation(parsed),
    compactLine: (msg, parsed, width) => {
      const outcome: WeatherExplanationOutcome = {
        domain: "weatherExplanation",
        msg,
        headType: msg.head.type,
        statsCategory: "weatherExplanation",
        stats: { shouldRecord: false },
        presentation: { frameLevel: weatherExplanationFrameLevel(parsed) },
        parsed,
      };
      return renderSummaryLine(toPresentationEvent(outcome), width);
    },
  }),
  defineEntry({
    // 指定河川洪水予報 (VXKO50-89) と水位周知河川 (VXSU50-59) を 1 entry で扱う。
    // parser は schema 分岐で同一型に正規化、formatter 内で VXKO full / VXSU minimal を切替。
    pattern: /^(VXKO[5-8]\d|VXSU5\d)$/,
    label: "指定河川洪水予報・水位周知河川 (VXKO50-89 / VXSU50-59)",
    parse: parseFloodForecast,
    format: (parsed) => displayFloodForecastInfo(parsed),
    compactLine: (msg, _parsed, width) => {
      // Studio はステートレス: 毎 render 新品の Holder で「初回 (new) 扱い」を再現する。
      // 取消の rollback は履歴が空でも safe (FloodForecastStateHolder.rollback は no-op)。
      // VPWS50 と同じく processor をそのまま呼び、本番と同じ frame/sound/suppressNotify を得る。
      const outcome = processFloodForecast(msg, {
        floodForecastState: new FloodForecastStateHolder(),
      });
      if (outcome == null) throw new Error("VXKO/VXSU の parse に失敗しました");
      return renderSummaryLine(toPresentationEvent(outcome), width);
    },
  }),
  defineEntry({
    // 津波警報・注意報・予報 / 津波情報 / 沖合の津波情報。
    // registry は weather 前提の命名 (WeatherEntry) だが Phase 1 は最小変更 (entry 追加のみ)。
    // 一般化リネームは地震・火山追加時に判断する (spec §7)。
    pattern: /^VTSE(41|51|52)$/,
    label: "津波警報・注意報・予報／津波情報 (VTSE41/51/52)",
    parse: parseTsunamiTelegram,
    format: (parsed) => displayTsunamiInfo(parsed),
    compactLine: (msg, _parsed, width) => {
      // Studio はステートレス: 毎 render 新品の TsunamiStateHolder で初回受信を再現する。
      // flood entry と同じく本番 processor をそのまま呼び、本番と同じ frame/sound を得る。
      const result = processTsunami(msg, new TsunamiStateHolder());
      if (result.kind !== "ok") throw new Error("VTSE の parse に失敗しました");
      return renderSummaryLine(toPresentationEvent(result.outcome), width);
    },
  }),
  defineEntry({
    // 地震情報 (震度速報 / 震源 / 震源・震度 / 顕著な地震の震源要素更新)。
    pattern: /^VXSE(51|52|53|61)$/,
    label: "地震情報 (VXSE51/52/53/61)",
    parse: parseEarthquakeTelegram,
    format: (parsed) => displayEarthquakeInfo(parsed),
    compactLine: (msg, _parsed, width) => {
      // 地震に state holder は無い (processEarthquake は msg のみ受ける)。
      // 本番 processor をそのまま呼び、本番と同じ frame/sound を得る (津波 entry と同型)。
      const outcome = processEarthquake(msg);
      if (outcome == null) throw new Error("VXSE の parse に失敗しました");
      return renderSummaryLine(toPresentationEvent(outcome), width);
    },
  }),
  defineEntry({
    // 火山情報 (噴火警報・予報 / 解説 / 観測報 / 降灰予報 / 噴火速報 / 噴煙流向 / お知らせ / 海上警報)。
    // VFSVii はリテラル (fixture-loader の TYPE_REGEX も volcano-parser の switch も VFSVii 前提)。
    // displayVolcanoInfo は isMarine alert (VFSVii) を既に表示可能。
    // 注: Studio は「初回状態 (isRenotification=false) のプレビュー」— 毎 render 新品の
    // VolcanoStateHolder を使うため、継続報の warning/normal 降格 (再通知判定) は Studio では
    // 見えない (本番 parity の既知の限界)。
    // VFVO53 バッチ (Vfvo53BatchItems) は集約結果のため 1 電文 → parse → format 契約の
    // Studio では見られない。代替担保: CLI test-samples バッチ variant + NO_COLOR snapshot ×3 幅
    // + 幅 sweep / unit テスト。theme の最終判断は CLI snapshot / visual-gate に寄せる。
    pattern: /^(VFVO5[0-6]|VFVO60|VZVO40|VFSVii)$/,
    label: "火山情報 (VFVO50-56/60, VZVO40, VFSVii)",
    parse: parseVolcanoTelegram,
    format: (parsed) => displayVolcanoInfo(parsed, resolveVolcanoPresentation(parsed, new VolcanoStateHolder())),
    compactLine: (msg, parsed, width) => {
      // 本番 volcano-route-handler と同じ buildVolcanoOutcome 経路で frame/sound/summary を得る
      const outcome = buildVolcanoOutcome(msg, parsed, new VolcanoStateHolder());
      return renderSummaryLine(toPresentationEvent(outcome), width);
    },
  }),
  defineEntry({
    // 地震活動テキスト (spec §6。state 依存なし — EEW と違い tracker 不要)。
    // compactLine は本番 processor (processSeismicText) をそのまま呼ぶ (津波・地震 entry と同型)
    pattern: /^(VXSE56|VXSE60|VZSE40)$/,
    label: "地震活動テキスト (VXSE56/VXSE60/VZSE40)",
    parse: parseSeismicTextTelegram,
    format: (parsed) => displaySeismicTextInfo(parsed),
    compactLine: (msg, _parsed, width) => {
      const outcome = processSeismicText(msg);
      if (outcome == null) throw new Error("VXSE56/60/VZSE40 の parse に失敗しました");
      return renderSummaryLine(toPresentationEvent(outcome), width);
    },
  }),
  defineEntry({
    // 南海トラフ関連情報 (VYSE50/51/52) + 北海道・三陸沖後発地震注意情報 (VYSE60)
    pattern: /^(VYSE5[012]|VYSE60)$/,
    label: "南海トラフ関連情報 (VYSE50/51/52/60)",
    parse: parseNankaiTroughTelegram,
    format: (parsed) => displayNankaiTroughInfo(parsed),
    compactLine: (msg, _parsed, width) => {
      const outcome = processNankaiTrough(msg);
      if (outcome == null) throw new Error("VYSE の parse に失敗しました");
      return renderSummaryLine(toPresentationEvent(outcome), width);
    },
  }),
  defineEntry({
    // 長周期地震動に関する観測情報
    pattern: /^VXSE62$/,
    label: "長周期地震動観測情報 (VXSE62)",
    parse: parseLgObservationTelegram,
    format: (parsed) => displayLgObservationInfo(parsed),
    compactLine: (msg, _parsed, width) => {
      const outcome = processLgObservation(msg);
      if (outcome == null) throw new Error("VXSE62 の parse に失敗しました");
      return renderSummaryLine(toPresentationEvent(outcome), width);
    },
  }),
  defineEntry({
    // 緊急地震速報。VXSE44 は本番 routing (process-eew.ts の常時抑制) では表示されない —
    // Studio 登録は formatter parity の確認用 (本番で表示される画面ではない)
    pattern: /^VXSE4[345]$/,
    label: "緊急地震速報 (VXSE43/44/45) ※VXSE44 は本番 routing では常時抑制",
    parse: parseEewTelegram,
    format: (parsed, eewCtx) => displayEewInfo(parsed, eewCtx),
    eewContext: eewStudioContext,
    compactLine: (msg, parsed, width) => {
      // 独自の最大震度計算は持たない — toPresentationEvent → fromEewOutcome の共有経路を使う
      // (To 基準の最大震度を独自算出せず、共有経路に委譲して算出箇所の増殖を防ぐ)
      const ctx = eewStudioContext(msg, parsed);
      const isCancelled = parsed.infoType === "取消";
      const outcome: EewOutcome = {
        domain: "eew",
        msg,
        headType: msg.head.type,
        statsCategory: "eew",
        stats: { shouldRecord: false },
        presentation: {
          frameLevel: eewFrameLevel(parsed),
          soundLevel: eewSoundLevel(parsed),
          notifyCategory: "eew",
        },
        parsed,
        state: { activeCount: ctx.activeCount, colorIndex: ctx.colorIndex ?? 0, isCancelled, diff: ctx.diff },
        eewResult: {
          isNew: ctx.diff == null && !isCancelled,
          isDuplicate: false,
          isCancelled,
          isSuppressed: false,
          isUpgradeToWarning: false,
          activeCount: ctx.activeCount,
          diff: ctx.diff,
          colorIndex: ctx.colorIndex ?? 0,
        },
      };
      return renderSummaryLine(toPresentationEvent(outcome), width);
    },
  }),
];

export function findWeatherEntry(fixtureId: string): WeatherEntry | null {
  // fixtureId 全体への部分マッチだと、ファイル名に別タイプ名が混在したとき
  // inferType (先頭マッチ) と判定がずれる。抽出した type に対して判定する
  const type = inferType(fixtureId);
  if (type == null) return null;
  for (const e of ENTRIES) {
    if (e.pattern.test(type)) return e;
  }
  return null;
}

export function listWeatherEntries(): WeatherEntry[] {
  return [...ENTRIES];
}
