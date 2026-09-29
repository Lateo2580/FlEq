// P2-CHROME-EEW-001 ブラウザ入口。index.htmlから <script type="module" src="./chrome-eew/main.js"> で読み込む。
// native EventSourceで足りる。独自SSE client、state manager、router、framework は追加しない。

import type { DisplaySnapshot, DisplayWorkerView } from "../../../contracts/p2-snapshot-sse.types";
import {
  connectDisplaySnapshot, markEewPaintCandidate, markEewSnapshotReceived, renderEew, renderStatus, respondClockProbe,
} from "./client.js";
import { eewContentChanged, parseHeartbeatWorker, replaceDisplaySnapshot } from "./pure.js";

// AC09: 最終有効snapshot/heartbeatの受信から45秒無受信でstale。検査周期は最大15秒。
const STALE_THRESHOLD_MS = 45_000;
const STALE_CHECK_INTERVAL_MS = 15_000;

function requireElement(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (node == null) throw new Error(`missing element #${id}`);
  return node;
}

const cards = requireElement("cards");
const map = requireElement("map");
const status = {
  capacity: requireElement("capacity"), notices: requireElement("notices"), channels: requireElement("channels"),
  confirmation: requireElement("confirmation"), connection: requireElement("connection"), banner: requireElement("banner"),
};

// RET-01: 保持するのは描画に成功した最新の完全snapshot 1枚だけ。
let latest: DisplaySnapshot | null = null;
// heartbeatが運ぶ明示的なworker状態。受理したsnapshotのworkerで上書きされる。
let worker: DisplayWorkerView["state"] | null = null;
// 初回未受信の起点は接続開始時刻。
let lastEventAt = performance.now();
let stale = false;

function refreshStatus(): void {
  renderStatus(status, latest, worker ?? latest?.worker.state ?? null, stale);
}

function onSnapshot(snapshot: DisplaySnapshot, receivedAt: number): void {
  lastEventAt = receivedAt;
  stale = false;
  const next = replaceDisplaySnapshot(latest, snapshot);
  // 重複・旧版 (再接続時の再送を含む) は表示もworkerも変えず、T5も打たない。受信した事実でstaleだけ解く。
  if (next === latest) return refreshStatus();
  markEewSnapshotReceived(next, receivedAt);
  if (latest == null || eewContentChanged(latest, next)) {
    renderEew(cards, map, next);
    // T6候補はcardとmapのDOM更新を終えた後、同じ更新の中で打つ。
    markEewPaintCandidate(next, performance.now());
  }
  renderStatus(status, next, next.worker.state, stale);
  // 描画に失敗したsnapshotは保持しない (次の受信で描き直せるように、代入は描画の後)。
  latest = next;
  worker = next.worker.state;
}

function onHeartbeat(event: MessageEvent<string>): void {
  const next = parseHeartbeatWorker(event.data);
  if (next == null) return;
  lastEventAt = performance.now();
  stale = false;
  worker = next;
  refreshStatus();
}

function connect(): EventSource {
  const source = connectDisplaySnapshot("/events", onSnapshot);
  source.addEventListener("heartbeat", onHeartbeat);
  return source;
}

let source = connect();

// AC09: 45秒無受信でstaleにし、旧EventSourceを閉じて張り直す。stale中に接続がCLOSED (503等) になっていたら
// 次の検査でも張り直す。周期検査と前景復帰の両方がここを通る。
function checkNow(): void {
  const nowStale = performance.now() - lastEventAt >= STALE_THRESHOLD_MS;
  if (nowStale && (!stale || source.readyState === EventSource.CLOSED)) {
    source.close();
    source = connect();
  }
  stale = nowStale;
  refreshStatus();
}

refreshStatus();
setInterval(checkNow, STALE_CHECK_INTERVAL_MS);
// 背景→前景復帰はtimerを待たず直ちに確認する。
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") checkNow();
});

// runnerがCDP (Runtime.evaluate) 経由で呼ぶ唯一の入口。独自trace/manifestは作らない。
Object.assign(window, { fleqRespondClockProbe: respondClockProbe });
