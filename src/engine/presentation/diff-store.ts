import type { PresentationEvent } from "./types";
import type { PresentationDiff, PresentationDiffField } from "./diff-types";

export type { PresentationDiff, PresentationDiffField };

/** PresentationEvent に diff 情報を付与した型 */
export type PresentationEventWithDiff = PresentationEvent & { diff?: PresentationDiff };

/** エントリの最終更新タイムスタンプ付き */
interface DiffEntry {
  event: PresentationEvent;
  updatedAt: number;
}

/** TTL のデフォルト値 (30分) */
const DEFAULT_TTL_MS = 30 * 60 * 1000;

/** プルーニング実行間隔 (apply 呼び出し回数) */
const PRUNE_INTERVAL = 50;

/**
 * PresentationEvent の差分を検出・保持するストア。
 *
 * apply() は PresentationEvent を受け取り、同一 diffKey を持つ直前のイベントとの
 * 差分を検出して diff プロパティを付与して返す。
 *
 * TTL ベースの自動クリーンアップにより、長時間稼働時のメモリ蓄積を防止する。
 */
export class PresentationDiffStore {
  private previous = new Map<string, DiffEntry>();
  private readonly ttlMs: number;
  private applyCount = 0;

  constructor(ttlMs?: number) {
    this.ttlMs = ttlMs ?? DEFAULT_TTL_MS;
  }

  /**
   * イベントを受け取り、差分を検出する。
   * - 初回 (同一 diffKey で初めて) → diff なし
   * - 2回目以降 → diff あり (changed フラグ + summary + fields)
   * - diffKey が解決できないドメイン → diff なし (対象外)
   */
  apply(event: PresentationEvent): PresentationEventWithDiff {
    this.applyCount++;
    if (this.applyCount % PRUNE_INTERVAL === 0) {
      this.prune();
    }

    const diffKey = this.resolveDiffKey(event);
    if (diffKey == null) return event;

    const entry = this.previous.get(diffKey);
    const diff = entry ? this.computeDiff(entry.event, event) : undefined;
    this.previous.set(diffKey, { event, updatedAt: Date.now() });

    return diff ? { ...event, diff } : event;
  }

  /** 指定した diffKey のエントリを削除する */
  remove(diffKey: string): void {
    this.previous.delete(diffKey);
  }

  /** テスト用: ストアをクリアする */
  clear(): void {
    this.previous.clear();
  }

  /** TTL を超過した古いエントリを削除する */
  private prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.previous) {
      if (now - entry.updatedAt > this.ttlMs) {
        this.previous.delete(key);
      }
    }
  }

  // ── diffKey 解決 ──

  private resolveDiffKey(event: PresentationEvent): string | null {
    switch (event.domain) {
      case "eew":
        return event.eventId ? `eew:${event.eventId}` : null;
      case "tsunami":
        return event.type === "VTSE41" ? "tsunami:vtse41" : null;
      case "volcano":
        return event.type === "VFVO50" && event.volcanoCode
          ? `volcano:${event.volcanoCode}`
          : null;
      default:
        return null;
    }
  }

  // ── diff 算出 ──

  private computeDiff(prev: PresentationEvent, curr: PresentationEvent): PresentationDiff {
    const fields: PresentationDiffField[] = [];
    const summary: string[] = [];

    switch (curr.domain) {
      case "eew":
        this.compareEew(prev, curr, fields, summary);
        break;
      case "tsunami":
        this.compareTsunami(prev, curr, fields, summary);
        break;
      case "volcano":
        this.compareVolcano(prev, curr, fields, summary);
        break;
    }

    return {
      changed: fields.length > 0,
      summary,
      fields,
    };
  }

  private compareEew(
    prev: PresentationEvent,
    curr: PresentationEvent,
    fields: PresentationDiffField[],
    summary: string[],
  ): void {
    // magnitude
    if (prev.magnitude !== curr.magnitude) {
      fields.push({
        key: "magnitude",
        previous: prev.magnitude ?? null,
        current: curr.magnitude ?? null,
        significance: "major",
      });
      if (prev.magnitude != null && curr.magnitude != null) {
        summary.push(`M${prev.magnitude}→${curr.magnitude}`);
      }
    }

    // maxInt (forecastMaxInt for EEW)
    const prevInt = prev.forecastMaxInt ?? prev.maxInt;
    const currInt = curr.forecastMaxInt ?? curr.maxInt;
    if (prevInt !== currInt) {
      fields.push({
        key: "maxInt",
        previous: prevInt ?? null,
        current: currInt ?? null,
        significance: "major",
      });
      if (prevInt != null && currInt != null) {
        summary.push(`${prevInt}→${currInt}`);
      }
    }

    // hypocenterName
    if (prev.hypocenterName !== curr.hypocenterName) {
      fields.push({
        key: "hypocenterName",
        previous: prev.hypocenterName ?? null,
        current: curr.hypocenterName ?? null,
        significance: "minor",
      });
      summary.push("震源変更");
    }
  }

  private compareTsunami(
    prev: PresentationEvent,
    curr: PresentationEvent,
    fields: PresentationDiffField[],
    summary: string[],
  ): void {
    if (prev.areaCount !== curr.areaCount) {
      fields.push({
        key: "areaCount",
        previous: prev.areaCount,
        current: curr.areaCount,
        significance: "major",
      });
      summary.push(`${prev.areaCount}区域→${curr.areaCount}区域`);
    }
  }

  private compareVolcano(
    prev: PresentationEvent,
    curr: PresentationEvent,
    fields: PresentationDiffField[],
    summary: string[],
  ): void {
    if (prev.alertLevel !== curr.alertLevel) {
      fields.push({
        key: "alertLevel",
        previous: prev.alertLevel ?? null,
        current: curr.alertLevel ?? null,
        significance: "major",
      });
      if (prev.alertLevel != null && curr.alertLevel != null) {
        summary.push(`Lv${prev.alertLevel}→${curr.alertLevel}`);
      }
    }
  }
}
