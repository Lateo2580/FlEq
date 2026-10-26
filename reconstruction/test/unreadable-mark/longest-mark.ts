import type { UnreadableMark, UnreadablePart } from "../../contracts/p2-shared-runtime.types";

// P3-UM-AC03 (6): 静的上界の試験で、全部の見える記録に読み戻しの上限いっぱいの印（16 part、scope は JSON で 128 byte、compare、一覧の欄の
// part は compareKeys 128 件、旗 2 つ）を付け、原文（欠片 1 つは JSON で 1,536 byte）は予算いっぱいまで前の記録から順に入れる。
// site は呼ぶ側がその unit の表で JSON の byte が最も長いものを渡す（r1 ヘルツ: 短い site では最悪の形にならない）。compareKeys は一覧の欄の
// site（listSites）ごとに 1 件だけ持てる（codec、Q-UM-PRECHECK-2 (8)(a)）ので、先頭の part をその site にする。
const PART_LIMIT = 16, RAW = 1_536;
const hex = (index: number) => index.toString(16).padStart(16, "0");
function longestMarks(count: number, site: string, listSites: readonly string[], budget: number): readonly UnreadableMark[] {
  let rest = budget;
  return Array.from({ length: count }, () => ({
    parts: Array.from({ length: PART_LIMIT }, (_, index): UnreadablePart => {
      const size = Math.min(rest, RAW);
      // JSON の引用符 2 byte を除いた長さの ASCII の文字列（2 byte に満たない残りは入れない）。
      const raw = size >= 2 ? "a".repeat(size - 2) : null;
      if (raw != null) rest -= size;
      return { site: listSites[index] ?? site, reason: "requiredStructureInvalid", scope: String(index).padStart(126, "s"), compare: hex(index),
        ...index < listSites.length ? { compareKeys: Array.from({ length: 128 }, (_, key) => hex(key)) } : {}, raw };
    }),
    headline: null, rawDropped: true, partsCut: true,
  }));
}
// records の順に、印を持てる記録（holds）にだけ印を付ける（key は記録の印の欄の名）。
function withLongestMarks<T extends object>(records: readonly T[], site: string, listSites: readonly string[], budget: number,
  holds: (record: T) => boolean = () => true, key: "unreadable" | "marineUnreadable" = "unreadable"): T[] {
  const marks = longestMarks(records.length, site, listSites, budget);
  let next = 0;
  return records.map((record) => holds(record) ? { ...record, [key]: marks[next++] } : record);
}

export { longestMarks, withLongestMarks };
