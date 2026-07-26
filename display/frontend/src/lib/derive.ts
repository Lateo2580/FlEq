import type { DisplayClientState } from "./store";
import type { DisplayEmergencyInputV1, DisplayEventDtoV1 } from "./protocol";
import { buildWeatherEmergencyInput, type WeatherEmergencyInputV1 } from "./weather-panel";

export type ScreenMode = "standby" | "emergency";

/** 緊急パネルの入力。wire 由来の 3 種 + フロント合成の気象パネル (weather-panel.ts) */
export type EmergencyPanelInputV1 = DisplayEmergencyInputV1 | WeatherEmergencyInputV1;

export interface EmergencyPanelModel {
  key: string;
  input: EmergencyPanelInputV1;
}

/** switch の網羅を型で強制する (kind 追加時に compile error にする) */
function assertNever(value: never): never {
  throw new Error(`未処理の緊急パネル kind: ${JSON.stringify(value)}`);
}

// 優先順位 (spec C §3、ユーザー決定 2026-07-25):
//   大津波警報 > 津波警報 > 津波注意報 > EEW 警報 > 気象 L5 > 気象 L4 > EEW 予報 > largeQuake
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
      return e.isWarning ? 3 : 6;
    case "weather":
      return e.level === 5 ? 4 : 5;
    case "largeQuake":
      return 7;
    default:
      return assertNever(e);
  }
}

export function deriveEmergencyPanels(s: DisplayClientState): EmergencyPanelModel[] {
  const snap = s.snapshot;
  if (snap == null) return [];
  const panels: EmergencyPanelModel[] = [];
  if (snap.tsunami != null && !snap.tsunami.demoted) {
    panels.push({ key: "tsunami:current", input: snap.tsunami });
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
    panels.push({ key: `quake:${q.eventId ?? `idx${i}`}`, input: q });
  });
  return panels.sort((a, b) => priorityOf(a.input) - priorityOf(b.input));
}

export function deriveMode(s: DisplayClientState): ScreenMode {
  return deriveEmergencyPanels(s).length > 0 ? "emergency" : "standby";
}

export function deriveTickerLines(s: DisplayClientState): DisplayEventDtoV1[] {
  const active = new Set(deriveEmergencyPanels(s).map((p) => p.key));
  // 代表 high (active EEW/津波警報/震度5弱+) は緊急パネルと groupKey が重なっても除外しない:
  // スケジューラの割込み規則 2 のためにテロップへ届ける必要がある (規則 4 の tickerPriority を尊重)
  return s.ticker.filter(
    (e) => e.tickerPriority === "high" || e.groupKey == null || !active.has(e.groupKey),
  );
}
