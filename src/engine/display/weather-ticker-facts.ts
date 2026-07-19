// 気象警報・注意報 (VPWW55-61 / VPWS50) のテロップ文章化。
// 意味解釈 (発表/継続/解除・一部) は weather-warning-core の WarningEntry.status を
// 唯一の真実源にし、ここでは再発明しない (Codex 対立レビュー反映)。
// 文章化は facts の mode で動詞を選ぶだけに保つ。
import type { ParsedWeatherWarning, WeatherAreaLayer } from "../../types";
import {
  flattenEntries,
  stripKindLevelPrefix,
  type WarningEntry,
} from "../weather/weather-warning-core";
import { DISPLAY_SEVERITY_RANK, type DisplaySeverity } from "../../dmdata/weather-warning-level";
import { formatPrefectureList, prefectureOf } from "./prefecture-format";

export interface WeatherTickerGroup {
  kindName: string;
  displaySeverity: DisplaySeverity;
  areaNames: string[];
  partialOnly: boolean;
}

export interface WeatherTickerFacts {
  mode: "active" | "releaseOnly" | "cancel";
  groups: WeatherTickerGroup[];
  releasedKindNames: string[];
  releasedAreaNames: string[];
  isNationwide: boolean;
}

function isReleased(e: WarningEntry): boolean {
  return e.status === "解除" || e.displaySeverity === "release";
}

/**
 * テロップ用の層選択: 「府県予報区等」層のみを使う。
 * pickStatusLayer (最細層優先) を使うと実電文では市町村層が選ばれ、areaName が
 * 「松江市」等の都道府県接頭辞なしになって集約が機能しない (レビュー R1 critical)。
 * 府県予報区層は Status / FullStatus / Kind を都道府県粒度で持つ。
 */
function pickPrefectureLayer(info: ParsedWeatherWarning): WeatherAreaLayer | undefined {
  return info.layers.find((l) => l.type.includes("府県予報区") && l.items.length > 0);
}

export function analyzeWeatherTickerFacts(info: ParsedWeatherWarning): WeatherTickerFacts | null {
  const isNationwide = info.type === "VPWS50";
  if (info.infoType === "取消") {
    return { mode: "cancel", groups: [], releasedKindNames: [], releasedAreaNames: [], isNationwide };
  }
  const layer = pickPrefectureLayer(info);
  if (layer == null) return null;
  const entries = flattenEntries(layer);
  if (entries.length === 0) return null;

  const active = entries.filter((e) => !isReleased(e));
  const released = entries.filter(isReleased);

  if (active.length === 0 && released.length > 0) {
    const kindNames = [...new Set(released.map((e) => stripKindLevelPrefix(e.lastKindName ?? e.kindName)))];
    const areaNames = [...new Set(released.map((e) => e.areaName))];
    return { mode: "releaseOnly", groups: [], releasedKindNames: kindNames, releasedAreaNames: areaNames, isNationwide };
  }

  const byKind = new Map<string, WeatherTickerGroup>();
  for (const e of active) {
    const kindName = stripKindLevelPrefix(e.kindName);
    const g = byKind.get(kindName) ?? {
      kindName,
      displaySeverity: e.displaySeverity,
      areaNames: [],
      partialOnly: true,
    };
    g.areaNames.push(e.areaName);
    if (e.fullStatus !== "一部") g.partialOnly = false;
    if (DISPLAY_SEVERITY_RANK[e.displaySeverity] > DISPLAY_SEVERITY_RANK[g.displaySeverity]) {
      g.displaySeverity = e.displaySeverity;
    }
    byKind.set(kindName, g);
  }
  const groups = [...byKind.values()].sort(
    (a, b) => DISPLAY_SEVERITY_RANK[b.displaySeverity] - DISPLAY_SEVERITY_RANK[a.displaySeverity],
  );
  return { mode: "active", groups, releasedKindNames: [], releasedAreaNames: [], isNationwide };
}

function areaPhrase(g: WeatherTickerGroup): string | null {
  const list = formatPrefectureList(g.areaNames);
  if (list == null) return null;
  // 単一県の一部だけが対象なら正直に言う (全域に見える短文は嘘になる)
  if (g.partialOnly && g.areaNames.every((n) => prefectureOf(n) != null)) {
    const prefs = new Set(g.areaNames.map((n) => prefectureOf(n)));
    if (prefs.size === 1) return `${list}内の一部`;
  }
  return list;
}

export function buildWeatherTickerSentence(facts: WeatherTickerFacts): string | null {
  if (facts.mode === "cancel") return "この情報は取り消されました。";
  if (facts.mode === "releaseOnly") {
    const kinds = facts.releasedKindNames.join("・");
    const areas = formatPrefectureList(facts.releasedAreaNames);
    if (kinds.length === 0) return null;
    if (areas == null) return `発令されていた${kinds}は解除されました。`;
    return `${areas}に発令されていた${kinds}は解除されました。`;
  }
  if (facts.groups.length === 0) return null;
  if (facts.isNationwide) {
    const parts: string[] = [];
    for (const g of facts.groups) {
      const area = areaPhrase(g);
      if (area == null) continue;
      parts.push(`${g.kindName}が${area}に`);
    }
    if (parts.length === 0) return null;
    return `現在、${parts.join("、")}発表されています。`;
  }
  // 単県 (VPWW55-61): 「{県}に{kind}が発表されています。」の語順。
  // ただし kind ごとに範囲 (全域/一部) が異なる場合、先頭 group の areaPhrase だけを
  // 全 kind に流用すると後続 kind の範囲表現が嘘になる (レビュー指摘)。
  // 全 group の areaPhrase が一致するときだけ圧縮文にし、異なる場合は
  // 全国集約 branch と同じ列挙形式に落とす。
  const areaPhrases = facts.groups.map(areaPhrase);
  if (areaPhrases.some((a) => a == null)) return null;
  const first = areaPhrases[0];
  if (areaPhrases.every((a) => a === first)) {
    const kinds = facts.groups.map((g) => g.kindName).join("・");
    return `${first}に${kinds}が発表されています。`;
  }
  const parts = facts.groups.map((g, i) => `${g.kindName}が${areaPhrases[i]}に`);
  return `現在、${parts.join("、")}発表されています。`;
}
