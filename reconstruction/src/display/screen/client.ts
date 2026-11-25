// P4-DISPLAY-SHELL-001（S0）snapshot client の状態遷移（D02、表 §2.3）。ブラウザの API を触らない。
// 持つのは最新の snapshot 1 個・開いている詳細 1 件（P4-DS-RET-01）。旧版・差分・通知の履歴は持たない。

import type { DisplayWireSnapshot, WireDetailRequest } from "../../../contracts/p4-display-wire.types";
import type { ShellClientState, ShellDetail, ShellDetailAnswer, ShellDomainKey } from "../../../contracts/p4-display-shell.types";

const WIRE_VERSION = "p4-display-wire-v3";

// 12 分野の key。unit の名前では分岐しない（P4-DW-AC11）ので、unit は snapshot の欄どうしで照らす。
const DOMAIN_KEYS: readonly ShellDomainKey[] = ["eew", "tsunami", "earthquake", "weatherCurrent", "weatherTimeseries", "nankai",
  "volcano", "landslide", "flood", "briefing", "localBulletins", "typhoon"];

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value);

// 外形の確かめ（schemaVersion・streamId・sequence・semanticRevision と、12 分野の unit・contentRevision が字であること）。費用は 12 分野の数。
// unit の値の照合は、その分野を読むカードの契約が持つ（P4-DW-AC11 が src/display の unit 名の字を禁じるため）。
function isWireSnapshot(value: unknown): value is DisplayWireSnapshot {
  if (!isRecord(value) || value.schemaVersion !== WIRE_VERSION || typeof value.streamId !== "string"
    || typeof value.sequence !== "number" || !Number.isSafeInteger(value.sequence) || typeof value.semanticRevision !== "string") return false;
  const current = value.current;
  return isRecord(current) && DOMAIN_KEYS.every((key) => {
    const domain = current[key];
    return isRecord(domain) && typeof domain.unit === "string" && typeof domain.contentRevision === "string";
  });
}

function acceptSnapshot(state: ShellClientState, data: string): ShellClientState {
  let parsed: unknown;
  try { parsed = JSON.parse(data); } catch { return state; }
  if (!isRecord(parsed) || typeof parsed.schemaVersion !== "string") return state;
  // 版が違うときは描かず、非対応の札を出す（spec:1391）。持っている snapshot は変えない
  if (parsed.schemaVersion !== WIRE_VERSION) return state.unsupported ? state : { ...state, unsupported: true };
  if (!isWireSnapshot(parsed)) return state;
  const previous = state.snapshot;
  const sameStream = previous != null && previous.streamId === parsed.streamId;
  if (sameStream && parsed.sequence <= previous.sequence) return state;
  const changed = DOMAIN_KEYS.filter((key) => !sameStream || previous.current[key].contentRevision !== parsed.current[key].contentRevision);
  // 詳細は、同じ unit の分野が新しい snapshot にあり、その内容版が変わっていないときだけ保つ（unit が無いときも取り直し）
  const detail = state.detail;
  const key = detail == null ? undefined : DOMAIN_KEYS.find((candidate) => parsed.current[candidate].unit === detail.request.unit);
  const kept = sameStream && key != null && !changed.includes(key);
  return { snapshot: parsed, unsupported: false, changed, detail: detail != null && !kept ? { ...detail, status: "refetch" } : detail };
}

function detailRequested(state: ShellClientState, request: WireDetailRequest): ShellClientState {
  const detail: ShellDetail = { request, streamId: state.snapshot?.streamId ?? "", status: "loading", response: null };
  return { ...state, detail };
}

// 応答は、asked がまだ今の詳細で、要求した時の stream が今と同じときだけ採る（旧い stream の遅れた応答を捨てる）。
function detailAnswered(state: ShellClientState, asked: ShellDetail, answer: ShellDetailAnswer): ShellClientState {
  if (state.detail !== asked || state.snapshot == null || asked.streamId !== state.snapshot.streamId) return state;
  if (answer.kind === "ok") return { ...state, detail: { ...asked, status: "ready", response: answer } };
  const refetch = answer.kind === "error" && answer.reason === "versionChanged";
  return { ...state, detail: { ...asked, status: refetch ? "refetch" : "failed", response: null } };
}

export { acceptSnapshot, detailAnswered, detailRequested };
