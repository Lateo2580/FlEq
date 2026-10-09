// P2-CHROME-EEW-001: ブラウザ (DOM/EventSource/performance) 依存の実装。vitestはこのファイルを import しない。
// 実描画・HTML非解釈・staleの検収は smoke.mjs の実Chromeで行う。

import type { DisplaySnapshot, DisplayWorkerView } from "../../../contracts/p2-snapshot-sse.types";
import type { ChromeClockProbeResponse, ChromeEewMarkerDetail } from "../../../contracts/p2-eew-e01.types";
import {
  buildChannelLines, buildConfirmationLine, buildConnectionLine, buildEewCard, buildNoticeLine, buildSummaryLine,
  buildCapacityExceededLine, buildTsunamiPaint, operationVisible, parseDisplaySnapshot, staleBanner, summaryRowVisible, tsunamiCandidates,
} from "./pure.js";

// AC01: 境界で検証した完全snapshotだけを呼び出し元へ渡す。独自wire schemaは持たない。
// T5 (spec:1113 Chromeが対象snapshotを受け取った時刻) はparse・検証の前、event入口で採る。
function connectDisplaySnapshot(
  url: string, onSnapshot: (snapshot: DisplaySnapshot, receivedAtMonotonicMs: number) => void,
): EventSource {
  const source = new EventSource(url);
  source.addEventListener("snapshot", (event) => {
    const receivedAt = performance.now();
    const snapshot = parseDisplaySnapshot(event.data);
    if (snapshot != null) onSnapshot(snapshot, receivedAt);
  });
  return source;
}

function version(snapshot: DisplaySnapshot) {
  return { streamId: snapshot.streamId, semanticRevision: snapshot.semanticRevision, sequence: snapshot.sequence };
}

// AC06: performance.markの固定名はこの2つだけ。detailはA10のChromeEewMarkerDetail。
function markEewSnapshotReceived(snapshot: DisplaySnapshot, chromeMonotonicMs: number): void {
  const detail: ChromeEewMarkerDetail = { name: "fleq:p2:eew:T5", displayVersion: version(snapshot) };
  performance.mark("fleq:p2:eew:T5", { startTime: chromeMonotonicMs, detail });
}

// card/mapを描いた同じ更新の中で、full配送のEEW毎に候補を1つ出す。区域なし (VXSE45) の空mapも候補にする。
function markEewPaintCandidate(snapshot: DisplaySnapshot, chromeMonotonicMs: number): void {
  const eew = snapshot.current.eew;
  if (eew.delivery !== "full") return;
  for (const current of eew.view.current) {
    const detail: ChromeEewMarkerDetail = {
      name: "fleq:p2:eew:T6-candidate", displayVersion: version(snapshot), operation: current.operation,
      subject: current.subject, cardMarkerId: `card:${current.subject}`, mapMarkerId: `map:${current.subject}`,
      mapAreaCodes: current.prediction.areas.map((area) => area.code),
    };
    performance.mark("fleq:p2:eew:T6-candidate", { startTime: chromeMonotonicMs, detail });
  }
}

// P3-C6-AC04: 津波の T6 候補。カードと海岸線の DOM 更新を終えた後の同じ更新の中で、full 配送の subject ごとに 1 つ、
// 直前に描いていてこの更新で描かなくなった subject に present false の 1 つ（解除の「旧表示の除去」を測るため）。戻り値は今描いた subject。
function markTsunamiPaintCandidate(snapshot: DisplaySnapshot, previousSubjects: ReadonlySet<string>, chromeMonotonicMs: number): ReadonlySet<string> {
  const { details, drawn } = tsunamiCandidates(snapshot, previousSubjects);
  for (const detail of details) performance.mark(detail.name, { startTime: chromeMonotonicMs, detail });
  return drawn;
}

// CDP経由でrunnerが呼ぶ。Chrome受信時刻と返信直前時刻を同じprobeIdで返す。Node側の時刻結合はA10が行う。
function respondClockProbe(probeId: string): ChromeClockProbeResponse {
  const chromeReceivedMonotonicMs = performance.now();
  return { probeId, chromeReceivedMonotonicMs, chromeSentMonotonicMs: performance.now() };
}

// ── 描画 (AC08): wire由来の文字列はtextContentだけで入れる。class名は固定表の値だけ。──

function el(tag: string, className: string, text = ""): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

// card/mapを作り直す。呼び出し元はEEWの内容版が変わった回だけ呼ぶ (AC04)。
// R59: 最新snapshotに無いEEWのcardと塗りは作り直しで消え、残存対象だけが描かれる。
function renderEew(cards: HTMLElement, map: HTMLElement, snapshot: DisplaySnapshot): void {
  const eew = snapshot.current.eew;
  const cardNodes: HTMLElement[] = [];
  const mapNodes: HTMLElement[] = [];
  if (eew.delivery === "full") {
    for (const current of eew.view.current) {
      const card = buildEewCard(current);
      const wrap = el("div", `eew-card ${card.maximumSeverityClass}`);
      wrap.append(el("div", "eew-card-head", card.head), el("div", "eew-card-time", card.reportTimeDisplay));
      for (const area of card.areas) {
        wrap.append(el("div", `eew-card-area ${area.severityClass}`, `${area.code}: ${area.display}`));
        if (area.rect == null) continue;
        const [x, y, w, h] = area.rect;
        const rect = el("div", `map-area ${area.severityClass}`);
        rect.style.left = `${x}px`;
        rect.style.top = `${y}px`;
        rect.style.width = `${w}px`;
        rect.style.height = `${h}px`;
        mapNodes.push(rect);
      }
      cardNodes.push(wrap);
    }
  } else {
    // summaryへ切り替わったら旧塗りを除去し、operation別の要約だけを出す。無発令へ変換しない。
    for (const item of eew.items)
      if (summaryRowVisible(item)) cardNodes.push(el("div", "eew-summary", buildSummaryLine(item)));
  }
  cards.replaceChildren(...cardNodes);
  map.replaceChildren(...mapNodes);
}

// P3-C6-AC03: 津波のカードと海岸線を作り直す。呼び出し元は津波の配送か contentRevision が変わった回だけ呼ぶ。
// summary 配送では旧カード・旧海岸線を除き、operation 別の要約行を出す（無発令に見せない）。
function renderTsunami(cards: HTMLElement, coast: HTMLElement, snapshot: DisplaySnapshot): void {
  const tsunami = snapshot.current.tsunami;
  const cardNodes: HTMLElement[] = [];
  const coastNodes: HTMLElement[] = [];
  if (tsunami.delivery === "full") {
    const paint = buildTsunamiPaint(tsunami.view.forecasts);
    for (const card of paint.cards) {
      const wrap = el("div", `tsu-card ${card.className}`);
      wrap.append(el("div", "tsu-card-head", card.head), el("div", "tsu-card-time", card.reportTimeDisplay));
      for (const area of card.areas) wrap.append(el("div", area.className, area.text));
      cardNodes.push(wrap);
    }
    if (paint.missingCoastCount > 0) cardNodes.push(el("div", "tsu-missing", `海岸線の資材なし ${paint.missingCoastCount} 区域`));
    for (const segment of paint.segments) {
      const [x, y, w, h] = segment.rect;
      const rect = el("div", `coast-area ${segment.className}${segment.blink ? " tsu-blink" : ""}`);
      rect.style.left = `${x}px`;
      rect.style.top = `${y}px`;
      rect.style.width = `${w}px`;
      rect.style.height = `${h}px`;
      coastNodes.push(rect);
    }
  } else {
    for (const item of tsunami.items) if (summaryRowVisible(item)) cardNodes.push(el("div", "tsu-summary", buildSummaryLine(item)));
  }
  cards.replaceChildren(...cardNodes);
  coast.replaceChildren(...coastNodes);
}

export type StatusElements = Readonly<{
  capacity: HTMLElement; notices: HTMLElement; channels: HTMLElement; confirmation: HTMLElement;
  connection: HTMLElement; banner: HTMLElement;
}>;

// 状態行 (R40〜R42とU-Eの容量超過件数)。snapshotを受けるたびとheartbeat・stale検査のたびに作り直す。
// 初回snapshot前 (snapshot=null) も接続・stale・heartbeat由来のworkerを出す。
function renderStatus(
  elements: StatusElements, snapshot: DisplaySnapshot | null, worker: DisplayWorkerView["state"] | null, browserStale: boolean,
): void {
  const items = snapshot?.current.eew.items ?? [];
  elements.capacity.replaceChildren(...items.flatMap((item) => {
    const line = buildCapacityExceededLine(item);
    return line == null ? [] : [el("div", "eew-capacity", line)];
  }));
  elements.notices.replaceChildren(...(snapshot?.notices ?? []).map((notice) => el("div", "notice", buildNoticeLine(notice))));
  elements.channels.replaceChildren(...(snapshot == null ? [] : buildChannelLines(snapshot.channels))
    .map((line) => el("div", "channel", line)));
  elements.confirmation.replaceChildren(...(snapshot == null ? [] : items.filter((item) => operationVisible(snapshot, item)))
    .map((item) => el("div", "confirmation", buildConfirmationLine(item.operation, item.confirmation))));
  elements.connection.textContent = buildConnectionLine(snapshot?.connection ?? null, worker, browserStale);
  elements.banner.textContent = staleBanner(browserStale, worker);
}

export {
  connectDisplaySnapshot, markEewPaintCandidate, markEewSnapshotReceived, markTsunamiPaintCandidate, renderEew, renderStatus, renderTsunami,
  respondClockProbe,
};
