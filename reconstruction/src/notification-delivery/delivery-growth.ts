import type { NotificationIntent } from "../../contracts/p2-shared-runtime.types";

// 配送の更新（NotificationIntentUpdate）で 1 件の JSON が伸びうる byte の最大（作者裁定 2026-10-09、Q-C8-IMPL-AMEND(7)(8)、
// P3-INTENT-UPDATE-RESERVE-001）。値域は狭めず、decode が受ける値の最長に合わせる: attempts は 0 以上の安全な整数（最長 16 桁）、
// nextAttemptAt は有限の数（JSON の最長 25 文字、例 -0.0000018927186924017318。worker の時計は小数になる）、disposition は
// 最長の superseded（pending より 3 文字長い）。受理と decode の両方で pending の byte にこの予約を足して数える。unit によらない式。
// lastAttempt は最長の "started"（null から 5 文字、P3-NL-AC06 (6)）。replayed（false→true）と expiresAt（鳴らし直しの期限は元の期限か
// 整数、notification-delivery.ts）は伸びない（epoch の ms の桁が増える 2286 年までは）。
const ATTEMPTS_CHARS = 16, TIME_CHARS = 25, DISPOSITION_GROWTH = 3, LAST_ATTEMPT_CHARS = 9;
function deliveryGrowth(item: NotificationIntent): number {
  return Math.max(0, ATTEMPTS_CHARS - JSON.stringify(item.attempts).length)
    + Math.max(0, TIME_CHARS - JSON.stringify(item.nextAttemptAt).length) + DISPOSITION_GROWTH
    + Math.max(0, LAST_ATTEMPT_CHARS - JSON.stringify(item.lastAttempt).length);
}

export { deliveryGrowth };
