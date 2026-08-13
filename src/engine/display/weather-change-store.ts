import { randomUUID } from "node:crypto";
import type {
  Vpws50DisplayAreaChange,
  Vpws50DisplayDiff,
  Vpws50DisplayKindTransition,
} from "../../types";
import type { PresentationEvent } from "../presentation/types";
import type {
  DisplayWeatherChangeItemV1,
  DisplayWeatherChangeKindV1,
  DisplayWeatherChangeValueV1,
  DisplayWeatherChangeV1,
} from "./protocol";

export const WEATHER_CHANGE_TTL_MS = 60_000;

interface WeatherChangeRecord {
  dto: DisplayWeatherChangeV1;
  expiresAtMs: number;
}

const CHANGE_KIND_ORDER: readonly DisplayWeatherChangeKindV1[] = [
  "upgraded",
  "added",
  "kindChanged",
  "downgraded",
  "released",
];

function valueOf(
  transition: Vpws50DisplayKindTransition,
  side: "before" | "after",
): DisplayWeatherChangeValueV1 | null {
  if (side === "before") {
    if (transition.prevKindCode == null) return null;
    return {
      kindShortName: transition.prevKindShortName ?? transition.kindShortName,
      kindCode: transition.prevKindCode,
      displaySeverity: transition.prevDisplaySeverity ?? "unknown",
      officialAlertLevel: transition.prevOfficialAlertLevel,
    };
  }
  if (transition.newKindCode == null) return null;
  return {
    kindShortName: transition.kindShortName,
    kindCode: transition.newKindCode,
    displaySeverity: transition.newDisplaySeverity ?? "unknown",
    officialAlertLevel: transition.newOfficialAlertLevel,
  };
}

function displayableKindChanged(area: Vpws50DisplayAreaChange): Vpws50DisplayAreaChange | null {
  const changes = area.changes.filter((change) =>
    change.prevKindShortName != null
    && change.prevKindShortName !== change.kindShortName,
  );
  return changes.length === 0 ? null : { ...area, changes };
}

function itemsFromDiff(diff: Vpws50DisplayDiff): DisplayWeatherChangeItemV1[] {
  const byKind: Record<DisplayWeatherChangeKindV1, readonly Vpws50DisplayAreaChange[]> = {
    upgraded: diff.upgraded,
    added: diff.added,
    kindChanged: diff.kindChanged.flatMap((area) => {
      const displayable = displayableKindChanged(area);
      return displayable == null ? [] : [displayable];
    }),
    downgraded: diff.downgraded,
    released: diff.released,
  };
  const seen = new Set<string>();
  const items: DisplayWeatherChangeItemV1[] = [];
  for (const kind of CHANGE_KIND_ORDER) {
    for (const area of byKind[kind]) {
      for (const transition of area.changes) {
        const key = `${area.areaCode}\u0000${transition.phenomenonKey}`;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({
          areaCode: area.areaCode,
          areaName: area.areaName,
          phenomenonKey: transition.phenomenonKey,
          kind,
          before: valueOf(transition, "before"),
          after: valueOf(transition, "after"),
        });
      }
    }
  }
  return items;
}

/** VPWS50 の受理済み差分だけを保持する、非永続・単一レコードの表示ストア。 */
export class WeatherChangeDisplayStore {
  private readonly bootId = randomUUID();
  private counter = 0;
  private record: WeatherChangeRecord | null = null;

  apply(event: PresentationEvent, nowMs: number): boolean {
    if (event.type !== "VPWS50") return false;

    const diff = event.weatherDiff;
    const displayDiff = event.weatherChangeDiff;
    if (event.weatherConfidence === "unsafe" || diff?.confidence === "unsafe") {
      return this.clear();
    }
    if (event.isCancellation || diff?.isCancelRollback === true || diff?.isFirstReport === true) {
      return this.clear();
    }
    // 権威 flag の無い旧経路・未注入経路は、古い差分を延長も消去もしない。
    // unsafe と cancellation は上で明示的に clear する。
    if (event.weatherStateMutationAccepted !== true) return false;
    if (
      diff == null
      || diff.confidence !== "confirmed"
      || diff.isCancelRollback
      || displayDiff == null
    ) return this.clear();

    const changes = itemsFromDiff(displayDiff);
    if (changes.length === 0) return this.clear();

    const expiresAtMs = nowMs + WEATHER_CHANGE_TTL_MS;
    this.counter += 1;
    this.record = {
      expiresAtMs,
      dto: {
        source: "vpws50",
        changeKey: `${this.bootId}:${this.counter}`,
        reportDateTime: event.reportDateTime,
        issuedAt: new Date(nowMs).toISOString(),
        expiresAt: new Date(expiresAtMs).toISOString(),
        changes,
        omitted: {},
      },
    };
    return true;
  }

  snapshot(nowMs: number): DisplayWeatherChangeV1 | null {
    if (this.record == null) return null;
    // snapshot は投影だけを担う。ここで record を破棄すると、接続時 snapshot が sweep より
    // 先に期限を跨いだ場合、後続 sweep が changed=false となり既存 client へ null を配れない。
    if (nowMs >= this.record.expiresAtMs) return null;
    return this.record.dto;
  }

  sweep(nowMs: number): boolean {
    if (this.record == null || nowMs < this.record.expiresAtMs) return false;
    this.record = null;
    return true;
  }

  private clear(): boolean {
    if (this.record == null) return false;
    this.record = null;
    return true;
  }
}
