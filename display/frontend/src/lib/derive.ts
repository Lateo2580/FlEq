import type { DisplayClientState } from "./store";
import type { DisplayEmergencyInputV1, DisplayEventDtoV1 } from "./protocol";

export type ScreenMode = "standby" | "emergency";

export interface EmergencyPanelModel {
  key: string;
  input: DisplayEmergencyInputV1;
}

// 優先順位: 津波 (大津波警報 > 津波警報 > 津波注意報) > EEW (警報 > 予報) > largeQuake。
// 津波カードは 3 パネル中もっとも情報量が多く、警報が長時間継続するため、存在時は必ず主役スロット
// (左列) に固定する — 右列 compact に入る事態そのものを無くす (ユーザー決定 2026-07-13)。
// この一般化により「EEW 警報 + 津波注意報」の共存でも津波が主役になる (EEW 警報が右 compact)。
function priorityOf(e: DisplayEmergencyInputV1): number {
  if (e.kind === "tsunami") {
    if (e.level === "majorWarning") return 0;
    if (e.level === "warning") return 1;
    return 2; // advisory
  }
  if (e.kind === "eew") return e.isWarning ? 3 : 4;
  return 5; // largeQuake
}

export function deriveEmergencyPanels(s: DisplayClientState): EmergencyPanelModel[] {
  const snap = s.snapshot;
  if (snap == null) return [];
  const panels: EmergencyPanelModel[] = [];
  if (snap.tsunami != null && !snap.tsunami.demoted) {
    panels.push({ key: "tsunami:current", input: snap.tsunami });
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
