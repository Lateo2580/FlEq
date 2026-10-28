import type { Operation } from "./p1-parser-boundary.types";
import type { RuntimeUnitId } from "./p2-shared-runtime.types";
import type { DmdataClassification } from "./p3-dmdata-connect.types";

// P3-RECOVERY-001【発注 1】: 一覧（GET /v2/telegram）の頭と、起動時の辿りとダイジェスト（H32）の型。
// 【発注 2】: 鮮度の突き合わせ（H41）の区分の一覧と位置、切れていた間の EEW の札（H28）の型。

// 一覧の item を境界で確かめて組んだ頭。operation は ingress の WS の枝と同じ写しで作る（P3-REC-AC01）。
export type ListHead = Readonly<{
  id: string;
  unit: RuntimeUnitId;
  headType: string;
  receivedAtMs: number;
  operation: Operation;
  title: string;
  headline: string | null;
  reportDateTime: string | null;
  infoType: string | null;
  // 【発注 3】本文の照合と入力の根拠（P3-REC-AC01・AC05 の (a)）。controlStatus は control.status の生の値で、ingress の根拠の検査へ渡す。
  serial: string | null;
  eventId: string | null;
  controlDateTime: string | null;
  controlStatus: string;
  // 一覧の item の head.test（本文の入力の根拠 headTest へそのまま渡す、P3-REC-AC05・publicFunctions の (d)）。
  test: boolean;
}>;

// types は 1 つの unit の型だけの束（1〜5、P3-REC-D-LIST-QUERY）。cursorToken は前の応答の nextToken をそのまま渡す。
// classification は H41 の区分の一覧で、cursorToken は前回の nextPooling か遡りの nextToken（P3-REC-AC13 (6)）。
export type ListQuery =
  | Readonly<{ types: readonly string[]; cursorToken: string | null }>
  | Readonly<{ classification: DmdataClassification; cursorToken: string | null }>;

export type ListPage =
  // rawCount・oldest/latestRawReceivedAtMs は濾す前の item で数える（dmdata の時刻）。満杯・遡りの止めどころ・位置はこの生の値で決める（P3-REC-AC13 (2)）。
  // refused は本文を流す型の item を境界の検査（url・id の文字）で捨てた unit（その回は fetchFailed、H41 ではその周期に突き合わせない、P3-REC-AC01）。
  | Readonly<{ kind: "ok"; heads: readonly ListHead[]; nextToken: string | null; nextPooling: string | null; nextPoolingInterval: number | null;
      rawCount: number; oldestRawReceivedAtMs: number | null; latestRawReceivedAtMs: number | null; refused: readonly RuntimeUnitId[] }>
  | Readonly<{ kind: "failed" }>
  | Readonly<{ kind: "authRejected" }>
  | Readonly<{ kind: "throttled"; retryAfterMs: number | null }>;

// fetchFromMs より古い item か stopAtId の item に当たったところで束を辿り終える（P3-REC-AC02 (2)(3)）。
export type UnitWalk = Readonly<{ unit: RuntimeUnitId; bundles: readonly (readonly string[])[]; fetchFromMs: number; stopAtId: string | null }>;

export type UnitWalkResult =
  | Readonly<{ unit: RuntimeUnitId; kind: "listed"; heads: readonly ListHead[] }>
  | Readonly<{ unit: RuntimeUnitId; kind: "unsatisfied"; reason: "recoveryLimit" | "fetchFailed" | "authRejected"; listedPages: number }>;

// ダイジェストの 1 件。文字列は 256 byte に切る（P3-REC-RES-06）。receivedAt は dmdata の受信時刻。
export type RecoveryDigestHead = Readonly<{
  headType: string;
  operation: Operation;
  title: string;
  headline: string | null;
  reportDateTime: string | null;
  receivedAt: number;
}>;

// beforeWindow: 「7 日より前は取り直していない」の印。omitted は件数・byte の枠に入らなかった頭の型ごとの件数（P3-REC-AC15 (2)）。
// 辿れなかった unit は件数の欄を持たない（件数不明、0 と出さない、P3-REC-AC15 (3)）。
export type RecoveryDigestUnit = Readonly<{ unit: RuntimeUnitId; beforeWindow: boolean }> & (
  | Readonly<{ kind: "listed"; heads: readonly RecoveryDigestHead[]; omitted: Readonly<Record<string, number>> }>
  | Readonly<{ kind: "unsatisfied"; reason: "recoveryLimit" | "fetchFailed" | "authRejected" }>
);

// units は P3-REC-D-ORDER-AND-LIMIT=A の順で、辿った unit だけ。
export type RecoveryDigestView = Readonly<{ units: readonly RecoveryDigestUnit[] }>;

// H41 の区分の位置。token は前の応答の nextPooling、latestRawReceivedAtMs は前に見た生の item の最も新しい receivedTime（dmdata の時刻）。
export type PoolPosition = Readonly<{ token: string | null; latestRawReceivedAtMs: number | null }>;

// seeded は位置を作っただけで比べない回。unmatched は位置を進めず、その区分の unit をその周期「突き合わせできなかった」にする（P3-REC-AC13 (1)(2)(7)）。
export type PollResult =
  | Readonly<{ kind: "seeded"; position: PoolPosition }>
  | Readonly<{ kind: "ok"; heads: readonly ListHead[]; position: PoolPosition }>
  | Readonly<{ kind: "unmatched"; reason: "fetchFailed" | "authRejected" | "pageLimit" | "throttled" }>;

// 切れていた間の EEW の札（H28）。両端は host の wall（P3-REC-AC14 (1)）。
export type EewWindowCard = Readonly<{ fromWallMs: number; toWallMs: number }>;

// 【発注 3】本文の 1 回の取得（GET data.api.dmdata.jp/v1/{id}、P3-REC-AC01）。bytes は受けたままで text に復号しない。
export type BodyResult =
  | Readonly<{ kind: "ok"; bytes: Uint8Array; contentType: string }>
  | Readonly<{ kind: "failed" }>
  | Readonly<{ kind: "lost" }>
  | Readonly<{ kind: "authRejected" }>
  | Readonly<{ kind: "throttled"; retryAfterMs: number | null }>;

// 【発注 3】unit ごとの取り直しの進み具合（P3-REC-AC11）。reason は unsatisfied のときだけ。
export type RecoveryUnsatisfiedReason = "fetchFailed" | "baseMissing" | "clockEvidenceMissing" | "generationConflict" | "recoveryLimit" | "authRejected"
  | "ownerStopped";
export type RecoveryProgressUnit = Readonly<{ unit: RuntimeUnitId; state: "running" | "recovered" | "notRecovered" }>
  | Readonly<{ unit: RuntimeUnitId; state: "unsatisfied"; reason: RecoveryUnsatisfiedReason }>;
