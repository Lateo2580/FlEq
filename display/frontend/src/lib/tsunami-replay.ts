// 津波継続バナー (TsunamiStandbyBanner.svelte) の種別チップクリックで、その種別のテロップを
// Ticker に再放送するための合成 DTO を組み立てる純関数 (2026-07-14 津波チップ再生)。
// 本文はバナー marquee と同じ区域データ生成ロジック (groupCoastsByLevel → 見出し付き連結) を
// 再利用し、表示の二重定義を避ける。合成 DTO は kind="replay"・tickerPriority="low" で、正規電文
// と同格にしない (電文が居る間はそもそも tip 同様に後回しになる)。
import { DISPLAY_PROTOCOL_VERSION } from "./protocol";
import type { DisplayTsunamiLevel, DisplayTsunamiStateV1 } from "./protocol";
import type { DisplayTickerDtoV1 } from "./ticker-schedule";
import { groupCoastsByLevel } from "./tsunami-banner";
import { buildMarqueeSegments } from "./tsunami-marquee-sequence";

/** replay の groupKey (=レベル識別子)。連打ガード・世代 purge が同レベルの replay を束ねる。 */
export function tsunamiReplayGroupKey(level: DisplayTsunamiLevel): string {
  return `replay:tsunami:${level}`;
}

/**
 * 指定レベルの津波テロップ再生 DTO を組み立てる。そのレベルに属する海岸が無ければ null
 * (チップは summaries 由来なので通常は存在するが、防御的に null を返す)。
 * @param seq クリックごとに単調増加する連番。eventKey を毎回ユニークにし、過去 replay と衝突させない。
 * @param generation 投入時点の津波 snapshot 世代。Ticker が世代不一致 purge に使う。
 */
export function buildTsunamiReplayDto(
  tsunami: DisplayTsunamiStateV1,
  level: DisplayTsunamiLevel,
  generation: number,
  seq: number,
): DisplayTickerDtoV1 | null {
  const groups = groupCoastsByLevel(tsunami.coasts);
  const segment = buildMarqueeSegments(groups).find((s) => s.level === level);
  if (segment == null || segment.text.length === 0) return null;
  const groupKey = tsunamiReplayGroupKey(level);
  const eventKey = `${groupKey}:${seq}`;
  return {
    version: DISPLAY_PROTOCOL_VERSION,
    seq: 0, // hub 採番なし → Ticker 側 fallbackSeq (toTickerJob 第2引数) が振られる
    kind: "replay",
    replayGeneration: generation,
    id: eventKey,
    eventKey,
    groupKey, // 同レベル replay の識別子 (連打ガード・世代 purge)。coalescing は連打ガードで到達不能
    domain: "tsunami",
    type: "tsunami-replay",
    infoType: "発表",
    reportDateTime: tsunami.reportDateTime,
    title: "津波情報",
    headline: null,
    publishingOffice: "気象庁",
    isTest: false,
    frameLevel: level === "advisory" ? "warning" : "critical",
    isCancellation: false,
    summary: { text: segment.text, role: tsunamiRole(level) },
    emergency: null,
    recentQuake: null,
    latestQuake: null,
    tickerDetail: null,
    tickerCategory: tsunamiCategory(level),
    tickerSentence: segment.text,
    tickerPriority: "low",
    tickerBody: segment.text,
  };
}

function tsunamiRole(level: DisplayTsunamiLevel): DisplayTickerDtoV1["summary"]["role"] {
  if (level === "majorWarning") return "tsunamiMajor";
  if (level === "warning") return "tsunamiWarning";
  return "tsunamiAdvisory";
}

function tsunamiCategory(level: DisplayTsunamiLevel): string {
  if (level === "majorWarning") return "大津波警報";
  if (level === "warning") return "津波警報";
  return "津波注意報";
}
