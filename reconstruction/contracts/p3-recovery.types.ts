import type { Operation } from "./p1-parser-boundary.types";
import type { RuntimeUnitId } from "./p2-shared-runtime.types";

// P3-RECOVERY-001【発注 1】: 一覧（GET /v2/telegram）の頭と、起動時の辿りとダイジェスト（H32）の型。

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
}>;

// types は 1 つの unit の型だけの束（1〜5、P3-REC-D-LIST-QUERY）。cursorToken は前の応答の nextToken をそのまま渡す。
export type ListQuery = Readonly<{ types: readonly string[]; cursorToken: string | null }>;

export type ListPage =
  | Readonly<{ kind: "ok"; heads: readonly ListHead[]; nextToken: string | null; nextPooling: string | null }>
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
