// VPWW55-61 の表示用 entry (1 行 = 1 kind×area) の組み立てと層選択・遷移集計。
// spec: 設計メモ 2026-06-07-vpww-warning-phase-a.md (Phase A.4)
import type {
  WeatherAreaLayer, ParsedWeatherWarning, FrameLevel,
} from "../../types";
import {
  resolveDisplaySeverity,
  resolvePhenomenonFamily,
  DISPLAY_SEVERITY_RANK,
  DISPLAY_SEVERITY_TO_FRAME_LEVEL,
  type DisplaySeverity,
  type OfficialAlertLevel,
  type ResolutionSource,
  type PhenomenonFamily,
} from "../../dmdata/weather-warning-level";

// ── WarningEntry + flattenEntries ──

export interface WarningEntry {
  id: string;
  kindCode: string;
  kindName: string;
  phenomenonFamily: PhenomenonFamily;
  officialAlertLevel: OfficialAlertLevel | null;
  displaySeverity: DisplaySeverity;
  resolutionSource: ResolutionSource;
  status: string;
  lastKindCode?: string;
  lastKindName?: string;
  areaName: string;
  fullStatus?: string;
}

/**
 * Kind 名が内包する「レベル<数字>」接頭を除去する。
 * 例: "レベル３大雨警報" → "大雨警報" / "レベル４土砂災害危険警報" → "土砂災害危険警報"
 * 全角・半角どちらの数字も対象。レベル語が無い名前 (暴風警報 等) は変更しない。
 * ui/weather-warning-level-theme.ts の normalizeKindName と同じ正規表現だが、
 * engine 層から ui 層への依存を作らないためここに複製する
 * (engine/display は ui/ に依存禁止、Task 1 で weather-core を engine へ移した経緯と同じ制約)。
 */
export function stripKindLevelPrefix(kindName: string): string {
  return kindName.replace(/^レベル[0-9０-９]+/, "");
}

/** Head が解除を Name="解除"/Code="00" のプレースホルダに潰した Kind かどうか。
 *  実電文では解除対象の元 Kind (例: 濃霧注意報/20) は Body.Warning 側の Status="解除" +
 *  LastKind にしか残らない (Head は全解除エリアを一律 "解除"/"00" に丸める)。 */
function isReleasePlaceholderKind(kind: { code: string; name: string }): boolean {
  return kind.code === "00" || kind.name === "解除";
}

type WeatherStatusEntry = WeatherAreaLayer["items"][number]["statuses"][number];

/** 1 layer の items を (kind × area) にフラット化する。
 *  Head が解除を Name="解除"/Code="00" のプレースホルダに潰す場合、実際に解除された種別数は
 *  Head の Kind 出現数と一致しない (気象庁 XML は Head 側で 1 個の "解除" Kind しか出さなくても
 *  Body.Warning 側は解除された種別の数だけ Kind/Status="解除" を持ちうる)。そのため placeholder は
 *  「1 item につき 1 グループ」として扱い、Body の Status="解除" を全件展開する
 *  (Head の placeholder Kind が複数並んでいても二重展開しない)。 */
export function flattenEntries(layer: WeatherAreaLayer): WarningEntry[] {
  const out: WarningEntry[] = [];
  for (const item of layer.items) {
    const releasedStatuses = item.statuses.filter((s) => s.status === "解除");

    // family/displaySeverity は Head の Code (解除プレースホルダなら "00") から解決する。
    // ここを実 Kind (例 "20") に差し替えると displaySeverity が "release" から実体の重大度に
    // 変わってしまい、weatherCoreFrameLevel (release-only report → "cancel") が壊れるため、
    // 判定用の code/name は変えない — 表示名 (kindName) だけを実体名に補正する
    const pushEntry = (kind: { code: string; name: string }, status: WeatherStatusEntry | undefined, kindName: string): void => {
      const family = resolvePhenomenonFamily(kind.code, kind.name);
      const r = resolveDisplaySeverity(kind.code, kind.name, family);
      const statusStr = status?.status ?? "発表";
      const id = `${kind.code}|${item.areaName}|${r.displaySeverity}|${statusStr}|${status?.lastKindCode ?? ""}`;
      out.push({
        id,
        kindCode: kind.code,
        kindName,
        phenomenonFamily: family,
        officialAlertLevel: r.officialAlertLevel,
        displaySeverity: r.displaySeverity,
        resolutionSource: r.source,
        status: statusStr,
        lastKindCode: status?.lastKindCode,
        lastKindName: status?.lastKindName,
        areaName: item.areaName,
        fullStatus: item.fullStatus,
      });
    };

    let placeholderHandled = false;
    for (const kind of item.kinds) {
      if (isReleasePlaceholderKind(kind)) {
        if (placeholderHandled) continue; // 同一 item 内の 2 個目以降の placeholder Kind は二重展開しない
        placeholderHandled = true;
        if (releasedStatuses.length > 0) {
          for (const status of releasedStatuses) {
            pushEntry(kind, status, status.lastKindName ?? kind.name);
          }
        } else {
          // Body 側に Status="解除" の対応が無い想定外構造。情報を落とさず placeholder 単体で
          // 1 entry 出す (fail-open)
          const status = item.statuses.find((s) => s.kindCode === kind.code);
          pushEntry(kind, status, kind.name);
        }
        continue;
      }
      const status = item.statuses.find((s) => s.kindCode === kind.code);
      pushEntry(kind, status, kind.name);
    }
  }
  return out;
}

// ── 層選択 ──

export type DisplayMode = "ultra-narrow" | "standard" | "wide";

// 細かい順 (table/status は最細を優先)
const FINENESS_ORDER = ["市町村等", "市町村等をまとめた地域等", "一次細分区域等", "府県予報区等"];
// 粗い順 (banner 地域名は coarse を優先、ただし 府県予報区 は粗すぎるので 一次細分 を最優先)
const AREA_SUMMARY_ORDER = ["一次細分区域等", "市町村等をまとめた地域等", "市町村等", "府県予報区等"];

function layerHasStatuses(l: WeatherAreaLayer): boolean {
  return l.items.some((it) => it.statuses.length > 0);
}

/** statuses (Status/LastKind) を持つ最細層。遷移判定・table・entry の単一ソース。 */
export function pickStatusLayer(info: ParsedWeatherWarning): WeatherAreaLayer | undefined {
  // statuses 非空の最細層を優先
  for (const t of FINENESS_ORDER) {
    const l = info.layers.find((x) => x.type.includes(t) && layerHasStatuses(x));
    if (l) return l;
  }
  // fallback: items 非空の最細層
  for (const t of FINENESS_ORDER) {
    const l = info.layers.find((x) => x.type.includes(t) && x.items.length > 0);
    if (l) return l;
  }
  return info.layers.find((x) => x.items.length > 0);
}

/** banner 地域名表示用の coarse 層 (一次細分優先)。件数は status 層で数えるため地域名のみ用途。 */
export function pickAreaSummaryLayer(info: ParsedWeatherWarning): WeatherAreaLayer | undefined {
  for (const t of AREA_SUMMARY_ORDER) {
    const l = info.layers.find((x) => x.type.includes(t) && x.items.length > 0);
    if (l) return l;
  }
  return info.layers.find((x) => x.items.length > 0);
}

// ── 遷移集計 (family ベース 新規/昇格/降格/解除) ──

export interface TransitionCount {
  added: number;
  upgraded: number;
  downgraded: number;
  released: number;
}

export function summarizeTransitions(entries: WarningEntry[]): TransitionCount {
  const result: TransitionCount = { added: 0, upgraded: 0, downgraded: 0, released: 0 };
  for (const e of entries) {
    // 解除 (status=解除、または Code 00 等で status が join 失敗した release kind) は released
    if (e.status === "解除" || e.displaySeverity === "release") { result.released++; continue; }
    if (e.status !== "発表") continue;
    if (e.lastKindCode == null || e.lastKindName == null) { result.added++; continue; }
    // 前報 Kind の displaySeverity を推定。LastKind は同一 Kind スロット由来だが、
    // 防御的に lastKind 自身の family で解決する。
    const lastFamily = resolvePhenomenonFamily(e.lastKindCode, e.lastKindName);
    const lastResolved = resolveDisplaySeverity(e.lastKindCode, e.lastKindName, lastFamily);
    const currentRank = DISPLAY_SEVERITY_RANK[e.displaySeverity];
    const lastRank = DISPLAY_SEVERITY_RANK[lastResolved.displaySeverity];
    if (currentRank > lastRank) result.upgraded++;
    else if (currentRank < lastRank) result.downgraded++;
    else result.added++;
  }
  return result;
}

// ── 最大 displaySeverity + frame level (formatter ローカル、level-helpers は触らない) ──

export function weatherCoreDisplaySeverity(info: ParsedWeatherWarning): DisplaySeverity {
  if (info.infoType === "取消") return "release";
  const layer = pickStatusLayer(info);
  if (!layer) return "unknown";
  const entries = flattenEntries(layer);
  if (entries.length === 0) return "unknown";
  let best: DisplaySeverity = entries[0].displaySeverity;
  for (const e of entries) {
    if (DISPLAY_SEVERITY_RANK[e.displaySeverity] > DISPLAY_SEVERITY_RANK[best]) {
      best = e.displaySeverity;
    }
  }
  return best;
}

export function weatherCoreFrameLevel(info: ParsedWeatherWarning): FrameLevel {
  if (info.infoType === "取消") return "cancel";
  return DISPLAY_SEVERITY_TO_FRAME_LEVEL[weatherCoreDisplaySeverity(info)];
}
