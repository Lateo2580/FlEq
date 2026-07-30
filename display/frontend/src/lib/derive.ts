import type { DisplayClientState } from "./store";
import type {
  DisplayEmergencyInputV1,
  DisplayEventDtoV1,
  DisplayLargeQuakeInputV1,
  DisplayQuakeMapEventV1,
  DisplayTsunamiStateV1,
} from "./protocol";
import { buildWeatherEmergencyInput, type WeatherEmergencyInputV1 } from "./weather-panel";

export type ScreenMode = "standby" | "quakeMap" | "emergency";

/** 緊急パネルの入力。wire 由来の 3 種 + フロント合成の気象パネル (weather-panel.ts) */
export type EmergencyPanelInputV1 = DisplayEmergencyInputV1 | WeatherEmergencyInputV1;

export interface EmergencyPanelModel {
  key: string;
  input: EmergencyPanelInputV1;
  quakeMap?: DisplayQuakeMapEventV1;
}

/** 旧 server が送るフィールドの読み取り専用互換。現行 wire 型には含めない。 */
type LegacyTsunamiCompat = DisplayTsunamiStateV1 & { demoted?: boolean };

/** switch の網羅を型で強制する (kind 追加時に compile error にする) */
function assertNever(value: never): never {
  throw new Error(`未処理の緊急パネル kind: ${JSON.stringify(value)}`);
}

function comparableMagnitude(value: string | null): number {
  if (value == null) return Number.NEGATIVE_INFINITY;
  const normalized = value.trim();
  if (normalized.length === 0) return Number.NEGATIVE_INFINITY;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function matchingQuakeMap(
  quake: DisplayLargeQuakeInputV1,
  events: DisplayQuakeMapEventV1[],
): DisplayQuakeMapEventV1 | undefined {
  if (
    quake.mapEventKey == null
    || quake.mapSourceType == null
    || quake.mapRevision == null
  ) {
    return undefined;
  }
  return events.find((event) =>
    event.eventKey === quake.mapEventKey
    && event.sourceType === quake.mapSourceType
    && event.revision.reportTimeMs === quake.mapRevision?.reportTimeMs
    && event.revision.serial === quake.mapRevision?.serial);
}

// 優先順位 (spec C §3、ユーザー決定 2026-07-25):
//   大津波警報 > 津波警報 > 津波注意報 > EEW 警報 > EEW 予報 > largeQuake > 気象 (L5/L4)
// 津波カードは情報量が最も多く警報が長時間継続するため、存在時は必ず主役スロット (左列) に固定する
// — 右列 compact に入る事態そのものを無くす (ユーザー決定 2026-07-13)。この一般化により
// 「EEW 警報 + 津波注意報」の共存でも津波が主役になる (EEW 警報が右 compact)。
// kind は明示 switch + assertNever で網羅する (フォールスルーで weather が largeQuake 扱いに
// 落ちる事故を型で塞ぐ、spec §3)。
function priorityOf(e: EmergencyPanelInputV1): number {
  switch (e.kind) {
    case "tsunami":
      if (e.level === "majorWarning") return 0;
      if (e.level === "warning") return 1;
      return 2; // advisory
    case "eew":
      return e.isWarning ? 3 : 4;
    case "weather":
      // 緊急画面では気象カードを常に右下（末尾）へ置く。L5/L4 の差はカード内で表す。
      return 6;
    case "largeQuake":
      return 5;
    default:
      return assertNever(e);
  }
}

/**
 * 緊急パネルの安定順。EEW 同士だけは強い予測を先頭にし、同値なら M、発生時刻、eventId で決める。
 * 種別をまたぐ優先順位は従来どおり priorityOf が権威である。
 */
export function compareEmergencyPanels(a: EmergencyPanelModel, b: EmergencyPanelModel): number {
  const priority = priorityOf(a.input) - priorityOf(b.input);
  if (priority !== 0) return priority;
  if (a.input.kind !== "eew" || b.input.kind !== "eew") return a.key.localeCompare(b.key);

  const rank = (b.input.forecastMaxIntRank ?? -1) - (a.input.forecastMaxIntRank ?? -1);
  if (rank !== 0) return rank;
  const aMagnitude = comparableMagnitude(a.input.magnitude);
  const bMagnitude = comparableMagnitude(b.input.magnitude);
  if (aMagnitude !== bMagnitude) return bMagnitude > aMagnitude ? 1 : -1;
  const time = (a.input.originTime ?? "").localeCompare(b.input.originTime ?? "");
  if (time !== 0) return time;
  return (a.input.eventId ?? "").localeCompare(b.input.eventId ?? "");
}

export function deriveEmergencyPanels(s: DisplayClientState): EmergencyPanelModel[] {
  const snap = s.snapshot;
  if (snap == null) return [];
  const panels: EmergencyPanelModel[] = [];
  const tsunami = snap.tsunami as LegacyTsunamiCompat | null;
  if (tsunami != null && tsunami.demoted !== true) {
    panels.push({ key: "tsunami:current", input: tsunami });
  }
  // 気象警報の昇格は engine が権威 (weatherPromotion)。パネルは source 横断で全体 1 枚、key は
  // 固定 (`weather:current`) にして再昇格でも再マウントさせない (spec C §3)
  const weather = buildWeatherEmergencyInput(snap);
  if (weather != null) {
    panels.push({ key: "weather:current", input: weather });
  }
  // eventId null は index で fallback して key を一意にする (Svelte keyed each の重複 key クラッシュ予防)
  snap.activeEews.forEach((eew, i) => {
    panels.push({ key: `eew:${eew.eventId ?? `idx${i}`}`, input: eew });
  });
  snap.largeQuakes.forEach((q, i) => {
    const quakeMap = matchingQuakeMap(q, snap.mapLayers?.quake?.events ?? []);
    panels.push({
      key: `quake:${q.eventId ?? `idx${i}`}`,
      input: q,
      ...(quakeMap == null ? {} : { quakeMap }),
    });
  });
  return panels.sort(compareEmergencyPanels);
}

export function deriveQuakeMapHostEvent(
  s: DisplayClientState,
  nowMs: number,
): DisplayQuakeMapEventV1 | undefined {
  const quake = s.snapshot?.mapLayers?.quake;
  const host = quake?.nonEmergencyHost;
  if (host == null || nowMs >= host.expiresAtMs) return undefined;
  return quake?.events.find((event) => event.eventKey === host.eventKey);
}

export function deriveMode(s: DisplayClientState, nowMs: number = Date.now()): ScreenMode {
  if (deriveEmergencyPanels(s).length > 0) return "emergency";
  return deriveQuakeMapHostEvent(s, nowMs) == null ? "standby" : "quakeMap";
}

export function deriveTickerLines(s: DisplayClientState): DisplayEventDtoV1[] {
  const active = new Set(deriveEmergencyPanels(s).map((p) => p.key));
  // 代表 high (active EEW/津波警報/震度5弱+) は緊急パネルと groupKey が重なっても除外しない:
  // スケジューラの割込み規則 2 のためにテロップへ届ける必要がある (規則 4 の tickerPriority を尊重)
  return s.ticker.filter(
    (e) => e.tickerPriority === "high" || e.groupKey == null || !active.has(e.groupKey),
  );
}
