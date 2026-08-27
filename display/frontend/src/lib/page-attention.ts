import { SvelteMap, SvelteSet } from "svelte/reactivity";

/**
 * D1-A/D2-A のページ未表示状態。
 *
 * この状態は端末メモリだけに置く。ここでいう「未表示」は、ページが active になったかではなく
 * 通常の保持時間を満了したかで決まる。表示側は page-cycler の onHoldComplete から
 * markHoldComplete() を呼ぶ。
 */

export type AttentionScalar = string | number | boolean | null | undefined;
export type AttentionValue = AttentionScalar | readonly AttentionValue[] | { readonly [key: string]: AttentionValue };

export interface AttentionPage {
  /** 表示順を含む stable page key。namespace を含めて standby と emergency を分離する。 */
  identity: string;
  /** header context と順序付き item identity/content fingerprint から作る値。 */
  fingerprint: string;
}

export interface AttentionGeneration {
  episodeKey: string;
  severityRank: number;
  pages: readonly AttentionPage[];
  /** 実測 partition の再収束では、同じ本文 fingerprint の既読 page を保持する。 */
  preserveStablePages?: boolean;
  /** provisional page が残る間は、消えた既読 fingerprint も最終 partition まで保持する。 */
  partitionPending?: boolean;
}

export interface PageAttentionViewModel {
  page: string | null;
  unseenCount: number;
  text: string;
}

function normalize(value: AttentionValue): AttentionValue {
  if (value == null) return null;
  if (Array.isArray(value)) return value.map(normalize);
  const objectValue = value as { readonly [key: string]: AttentionValue };
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.keys(objectValue).sort().map((key) => [key, normalize(objectValue[key] ?? null)]),
    );
  }
  return value;
}

/** undefined/null の表現差を吸収する、順序固定の canonical JSON。 */
export function canonicalAttentionJson(value: AttentionValue): string {
  return JSON.stringify(normalize(value));
}

/**
 * 依存を増やさない小さな FNV-1a hash。fingerprint の比較だけが目的で、暗号学的用途には使わない。
 */
function fingerprint(value: AttentionValue): string {
  let hash = 0x811c9dc5;
  for (const char of canonicalAttentionJson(value)) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return `p${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function pageIdentity(namespace: string, stableKey: string): string {
  return `${namespace}:${stableKey}`;
}

export function itemContentFingerprint(value: AttentionValue): string {
  return fingerprint(value);
}

/** page boundary と header context を含めるため、range 変更も page 変更として扱える。 */
export function pageContentFingerprint(
  headerContext: AttentionValue,
  items: readonly { identity: string; fingerprint: string }[],
): string {
  return fingerprint({ headerContext, items: items.map(({ identity, fingerprint: itemFingerprint }) => [identity, itemFingerprint]) });
}

export function pageAttentionViewModel(input: {
  activeIndex: number;
  pageCount: number;
  unseenCount: number;
}): PageAttentionViewModel {
  const pageCount = Math.max(0, input.pageCount);
  const unseenCount = Math.max(0, input.unseenCount);
  const page = pageCount > 1 ? `${Math.min(Math.max(0, input.activeIndex), pageCount - 1) + 1}/${pageCount}` : null;
  const parts = [page, unseenCount > 0 ? `未表示${unseenCount}` : null].filter((part): part is string => part != null);
  return { page, unseenCount, text: parts.join("・") };
}

/** Pager chrome reservation: final active index and maximum unseen count for this pageCount. */
export function pageAttentionReservationViewModel(pageCount: number): PageAttentionViewModel {
  const normalizedPageCount = Math.max(0, pageCount);
  return pageAttentionViewModel({
    activeIndex: Math.max(0, normalizedPageCount - 1),
    pageCount: normalizedPageCount,
    unseenCount: normalizedPageCount,
  });
}

function sameIdentityOrder(left: readonly AttentionPage[], right: readonly AttentionPage[]): boolean {
  const leftIds = left.map((page) => page.identity);
  const rightIds = right.map((page) => page.identity);
  const rightSet = new Set(rightIds);
  const leftSet = new Set(leftIds);
  return leftIds.filter((identity) => rightSet.has(identity)).join("\u0000")
    === rightIds.filter((identity) => leftSet.has(identity)).join("\u0000");
}

/** 未表示集合の世代管理。コンポーネント unmount 時は dispose() で必ず破棄する。 */
export class PageAttentionState {
  // SvelteMap に置くことで、page 削除など generation 自体の更新も viewModel の読取りを invalidate する。
  private readonly generation = new SvelteMap<"current", AttentionGeneration>();
  private readonly unseenIdentities = new SvelteSet<string>();
  private readonly stableReadFingerprints = new Map<string, true>();

  private replaceUnseen(identities: Iterable<string>): void {
    this.unseenIdentities.clear();
    for (const identity of identities) this.unseenIdentities.add(identity);
  }

  private rememberReadPages(pages: readonly AttentionPage[]): void {
    for (const page of pages) {
      if (!this.unseenIdentities.has(page.identity)) this.stableReadFingerprints.set(page.fingerprint, true);
    }
  }

  sync(next: AttentionGeneration): void {
    const previous = this.generation.get("current") ?? null;
    const nextPages = [...next.pages];
    const episodeChanged = previous == null || previous.episodeKey !== next.episodeKey;
    const severityEscalated = previous != null && next.severityRank > previous.severityRank;
    const identityOrderReplaced = previous != null && !sameIdentityOrder(previous.pages, nextPages);

    if (episodeChanged || severityEscalated) {
      this.stableReadFingerprints.clear();
      this.replaceUnseen(nextPages.map((page) => page.identity));
    } else if (next.preserveStablePages) {
      // provisional range から実測 range へ収束すると page identity/order が一時的に変わり得る。
      // provisional で一時的に消えた既読 page も、最終 range に再出現するまで fingerprint で覚える。
      this.rememberReadPages(previous.pages);
      const previousUnseenFingerprints = new Set(
        previous.pages
          .filter((page) => this.unseenIdentities.has(page.identity))
          .map((page) => page.fingerprint),
      );
      this.replaceUnseen(nextPages
        .filter((page) => previousUnseenFingerprints.has(page.fingerprint) || !this.stableReadFingerprints.has(page.fingerprint))
        .map((page) => page.identity));
      if (!next.partitionPending) {
        const finalFingerprints = new Set(nextPages.map((page) => page.fingerprint));
        for (const fingerprint of this.stableReadFingerprints.keys()) {
          if (!finalFingerprints.has(fingerprint)) this.stableReadFingerprints.delete(fingerprint);
        }
      }
    } else if (identityOrderReplaced) {
      this.stableReadFingerprints.clear();
      this.replaceUnseen(nextPages.map((page) => page.identity));
    } else {
      this.stableReadFingerprints.clear();
      const previousByIdentity = new Map(previous.pages.map((page) => [page.identity, page.fingerprint]));
      const nextIds = new Set(nextPages.map((page) => page.identity));
      for (const identity of this.unseenIdentities) {
        if (!nextIds.has(identity)) this.unseenIdentities.delete(identity);
      }
      for (const page of nextPages) {
        if (previousByIdentity.get(page.identity) !== page.fingerprint) this.unseenIdentities.add(page.identity);
      }
    }
    this.generation.set("current", { ...next, pages: nextPages });
  }

  markHoldComplete(identity: string): void {
    this.unseenIdentities.delete(identity);
    const page = this.generation.get("current")?.pages.find((candidate) => candidate.identity === identity);
    if (page != null) this.stableReadFingerprints.set(page.fingerprint, true);
  }

  unseenCount(): number {
    return this.unseenIdentities.size;
  }

  isUnseen(identity: string): boolean {
    return this.unseenIdentities.has(identity);
  }

  viewModel(activeIndex: number): PageAttentionViewModel {
    return pageAttentionViewModel({
      activeIndex,
      pageCount: this.generation.get("current")?.pages.length ?? 0,
      unseenCount: this.unseenCount(),
    });
  }

  dispose(): void {
    this.generation.clear();
    this.unseenIdentities.clear();
    this.stableReadFingerprints.clear();
  }
}
