import type { DisplayTsunamiStateV1 } from "./protocol";
import { groupCoastsByLevel, highestTsunamiLevel } from "./tsunami-banner";

/** scan viewport の保証済み最小幅 7em に合わせた、全角相当の静止ページ上限。 */
export const TSUNAMI_STATIC_PAGE_MAX_CHARS = 7;

/** 静的アンカーと reduce 時の 1 行ページを、動く補助レーンと別に組み立てる。 */
export function tsunamiAnchor(coasts: DisplayTsunamiStateV1["coasts"], fallbackLevel: DisplayTsunamiStateV1["level"]): string {
  if (coasts.length === 0) return "";
  const groups = groupCoastsByLevel(coasts);
  const highest = highestTsunamiLevel(groups.filter((group) => group.level != null).map((group) => ({
    level: group.level!, label: group.label!, count: group.names.length,
  })), fallbackLevel);
  const first = groups.find((group) => group.level === highest)?.names[0] ?? coasts[0]?.name ?? "表示領域不足";
  const rest = coasts.length - 1;
  return `対象 ${coasts.length}予報区・先頭 ${first}${rest > 0 ? `（ほか${rest}）` : ""}`;
}

/** scan viewport の最低幅を残すため、先頭予報区名だけを段階的に短縮する。 */
export function tsunamiAnchorCandidates(
  coasts: DisplayTsunamiStateV1["coasts"],
  fallbackLevel: DisplayTsunamiStateV1["level"],
): string[] {
  const full = tsunamiAnchor(coasts, fallbackLevel);
  if (coasts.length === 0) return [full];
  const groups = groupCoastsByLevel(coasts);
  const highest = highestTsunamiLevel(groups.filter((group) => group.level != null).map((group) => ({
    level: group.level!, label: group.label!, count: group.names.length,
  })), fallbackLevel);
  const name = groups.find((group) => group.level === highest)?.names[0] ?? coasts[0]?.name ?? "";
  const rest = coasts.length - 1;
  const suffix = rest > 0 ? `（ほか${rest}）` : "";
  const candidates = [full];
  for (let length = Math.min(name.length - 1, 12); length >= 1; length -= 1) {
    candidates.push(`対象 ${coasts.length}予報区・先頭 ${name.slice(0, length)}…${suffix}`);
  }
  candidates.push(`表示領域不足・対象 ${coasts.length}予報区`);
  return [...new Set(candidates)];
}

function splitStaticPageText(text: string): string[] {
  const chars = Array.from(text);
  const pages: string[] = [];
  for (let start = 0; start < chars.length; start += TSUNAMI_STATIC_PAGE_MAX_CHARS) {
    pages.push(chars.slice(start, start + TSUNAMI_STATIC_PAGE_MAX_CHARS).join(""));
  }
  return pages;
}

/**
 * 区分ラベルと予報区名を別の短い静止ページにする。各ページは scan の最小 7em 内に収まり、
 * label → name の順序で対応を読み取れる。長い予報区名も終端まで分割して巡回する。
 */
export function tsunamiStaticPages(coasts: DisplayTsunamiStateV1["coasts"]): string[] {
  return groupCoastsByLevel(coasts).flatMap((group) => group.names.flatMap((name) => [
    ...(group.label == null ? [] : splitStaticPageText(`【${group.label}】`)),
    ...splitStaticPageText(name),
  ]));
}

export function heatAnchor(areaNames: readonly string[], visibleCount: number): string {
  const total = areaNames.length;
  if (total === 0) return "対象 0府県";
  const count = Math.max(1, Math.min(visibleCount, total));
  const names = areaNames.slice(0, count).join("・");
  const rest = total - count;
  return `${names}（対象${total}府県${rest > 0 ? `、ほか${rest}` : ""}）`;
}

/** 1 項目ずつなら行高を増やさず、reduce 時にも終端を捨てない。 */
export function staticNamePages(names: readonly string[]): string[] {
  return [...names];
}
