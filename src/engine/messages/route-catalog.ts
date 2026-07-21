import type { StatsCategory } from "./telegram-stats";

// ── Route カタログ ──
//
// 「新しい独立 Route の追加」を 1 エントリの追記に集約するためのカタログ。
// classification / head.type の判定条件・優先順位・統計カテゴリを 1 箇所で持ち、
// `Route` 型・分類関数 (`classifyMessage`)・Route→StatsCategory 対応をすべてここから
// 導出する。
//
// 【新しい Route を足すときに触る場所】
//   1. この `ROUTE_CATALOG` に 1 エントリ追加する (route 名・matcher・statsCategory)。
//   2. presentation 側の `PresentationDomain` / `ProcessOutcome` に対応 outcome を足す。
//   3. `processors/process-message.ts` の `PROCESSOR_TABLE` に adapter を 1 つ足す
//      (linear route の場合)。足し忘れると `satisfies Record<LinearRoute, ...>` が
//      **コンパイルエラー**になる。
//   4. formatter / notifier を実装する。
// カタログに route を足すと `Route` 型が広がるため、Route を網羅している他の表
// (routeToCategory の Record、processor 表) の不足は **コンパイルエラー**として現れる。
//
// 【あえてカタログの外に残す特殊ルート】
//   - volcano: VFVO53 の集約 (volcano-vfvo53-aggregator) を伴う独立ライフサイクルを持ち、
//     線形 processor 表では処理できない (VolcanoRouteHandler が担当)。分類のみカタログに
//     載せ、処理は router 側で分岐する。
//   - ignore: 配信終了予定 + 内容重複のため表示・通知・統計をすべてスキップする特殊ルート。
//     分類のみカタログに載せ、router が早期 return する。
//   - raw: どの route にも当たらなかった電文のフォールバック。matcher は "always"。

/** ルート判定の matcher。宣言的に持ち、`compileMatcher` で高速な述語に変換する。 */
type RouteMatcher =
  | {
      // classification 一致 (指定時) かつ head.type が集合に含まれる。
      readonly kind: "headTypeSet";
      /** null なら classification を問わない (ignore 用) */
      readonly classification: string | null;
      readonly headTypes: readonly string[];
    }
  | {
      // classification 一致かつ head.type が prefix のいずれかで始まる。
      readonly kind: "headTypePrefix";
      readonly classification: string;
      readonly prefixes: readonly string[];
    }
  | {
      // classification が集合に含まれる (head.type は問わない)。
      readonly kind: "classification";
      readonly classifications: readonly string[];
    }
  | {
      // 常に一致 (フォールバック)。
      readonly kind: "always";
    };

interface RouteCatalogEntry {
  readonly route: string;
  readonly statsCategory: StatsCategory;
  readonly matcher: RouteMatcher;
}

/** weather 警報・注意報 (VPWW55-61 / VPWS50) */
const WEATHER_HEAD_TYPES = [
  "VPWW55", "VPWW56", "VPWW57", "VPWW58", "VPWW59", "VPWW60", "VPWW61",
  "VPWS50",
] as const;

/** 気象解説情報 (地方/全般/府県 + 潮位版) */
const WEATHER_EXPLANATION_HEAD_TYPES = [
  "VPCJ51", // 地方気象解説情報
  "VPZJ51", // 全般気象解説情報
  "VPFJ51", // 府県気象解説情報
  "VMCJ53", // 全般気象解説情報（潮位）— 大潮・副振動等
  "VMCJ54", // 地方気象解説情報（潮位）
  "VMCJ55", // 府県気象解説情報（潮位）
] as const;

/**
 * 指定河川洪水予報・水位周知河川 (VXKO50-89 / VXSU50-59)。
 * VXKO は 50 から 89、VXSU は 50 から 59 まで枠取り (現行配信は 50 のみだが将来の
 * 派生 type も同 routing に乗せる)。
 */
const FLOOD_FORECAST_HEAD_TYPES: readonly string[] = [
  ...Array.from({ length: 40 }, (_, i) => `VXKO${50 + i}`),
  ...Array.from({ length: 10 }, (_, i) => `VXSU${50 + i}`),
];

/**
 * 配信終了予定 + 既存表示と内容重複のため、受信しても無視する head.type。
 * classification を問わず最優先で ignore に倒す (`classification: null`)。
 */
export const IGNORED_HEAD_TYPES = [
  "VPWW53", "VPWW54",            // 旧 気象警報・注意報 (VPWW55-61/VPWS50 と重複)
  "VPNO50",                      // 気象特別警報報知
  "VPOA50",                      // 記録的短時間大雨情報
  "VPZJ50", "VPCJ50", "VPFJ50",  // 旧 気象情報 (VPZJ51/VPCJ51/VPFJ51 と重複)
  "VMCJ50", "VMCJ51", "VMCJ52",  // 潮位情報
  "VXWW50",                      // 土砂災害警戒情報
] as const;

/**
 * ルート判定カタログ。**配列順が判定の優先順位**。上から順に最初に一致した route を返す。
 *
 * 優先順位 (旧 classifyMessage の if 連鎖と 1:1):
 *   0. ignore (classification 非依存・最優先)
 *   1. eew.forecast / eew.warning → eew
 *   2. telegram.volcano → volcano
 *   3-7. telegram.earthquake の head.type 別 (exact 集合を prefix より先に置く)
 *   8-18. telegram.weather の head.type 別
 *   19. raw (フォールバック)
 *
 * exact 集合 (seismicText / lgObservation) を prefix (earthquake=VXSE*) より**前**に
 * 置くことで、VXSE56/60/62 が earthquake に吸われる前に拾われる。旧実装と同順。
 */
const ROUTE_CATALOG = [
  {
    route: "ignore",
    statsCategory: "other",
    matcher: { kind: "headTypeSet", classification: null, headTypes: IGNORED_HEAD_TYPES },
  },
  {
    route: "eew",
    statsCategory: "eew",
    matcher: { kind: "classification", classifications: ["eew.forecast", "eew.warning"] },
  },
  {
    route: "volcano",
    statsCategory: "volcano",
    matcher: { kind: "classification", classifications: ["telegram.volcano"] },
  },
  {
    route: "seismicText",
    statsCategory: "earthquake",
    matcher: {
      kind: "headTypeSet",
      classification: "telegram.earthquake",
      headTypes: ["VXSE56", "VXSE60", "VZSE40"],
    },
  },
  {
    route: "lgObservation",
    statsCategory: "earthquake",
    matcher: {
      kind: "headTypeSet",
      classification: "telegram.earthquake",
      headTypes: ["VXSE62"],
    },
  },
  {
    route: "earthquake",
    statsCategory: "earthquake",
    matcher: { kind: "headTypePrefix", classification: "telegram.earthquake", prefixes: ["VXSE"] },
  },
  {
    route: "tsunami",
    statsCategory: "tsunami",
    matcher: { kind: "headTypePrefix", classification: "telegram.earthquake", prefixes: ["VTSE"] },
  },
  {
    route: "nankaiTrough",
    statsCategory: "nankaiTrough",
    matcher: { kind: "headTypePrefix", classification: "telegram.earthquake", prefixes: ["VYSE"] },
  },
  {
    route: "weather",
    statsCategory: "weather",
    matcher: { kind: "headTypeSet", classification: "telegram.weather", headTypes: WEATHER_HEAD_TYPES },
  },
  {
    route: "tornado",
    statsCategory: "tornado",
    matcher: {
      kind: "headTypeSet",
      classification: "telegram.weather",
      headTypes: ["VPHW50", "VPHW51"],
    },
  },
  {
    route: "briefing",
    statsCategory: "briefing",
    matcher: { kind: "headTypeSet", classification: "telegram.weather", headTypes: ["VPBS50"] },
  },
  {
    route: "earlyWeather",
    statsCategory: "earlyWeather",
    matcher: { kind: "headTypeSet", classification: "telegram.weather", headTypes: ["VPAW51"] },
  },
  {
    route: "weatherWarningTimeseries",
    statsCategory: "weatherWarningTimeseries",
    matcher: { kind: "headTypeSet", classification: "telegram.weather", headTypes: ["VPWP50"] },
  },
  {
    route: "climateInfo",
    statsCategory: "climateInfo",
    matcher: {
      kind: "headTypeSet",
      classification: "telegram.weather",
      headTypes: ["VPZI50", "VPCI50"],
    },
  },
  {
    route: "weatherExplanation",
    statsCategory: "weatherExplanation",
    matcher: {
      kind: "headTypeSet",
      classification: "telegram.weather",
      headTypes: WEATHER_EXPLANATION_HEAD_TYPES,
    },
  },
  {
    route: "heatAlert",
    statsCategory: "heatAlert",
    matcher: { kind: "headTypeSet", classification: "telegram.weather", headTypes: ["VPFT50"] },
  },
  {
    route: "typhoonAnalysis",
    statsCategory: "typhoonAnalysis",
    matcher: {
      kind: "headTypeSet",
      classification: "telegram.weather",
      headTypes: ["VPTW60", "VPTW61", "VPTW62"],
    },
  },
  {
    route: "typhoonProbability",
    statsCategory: "typhoonProbability",
    matcher: { kind: "headTypeSet", classification: "telegram.weather", headTypes: ["VPTA50"] },
  },
  {
    route: "floodForecast",
    statsCategory: "floodForecast",
    matcher: {
      kind: "headTypeSet",
      classification: "telegram.weather",
      headTypes: FLOOD_FORECAST_HEAD_TYPES,
    },
  },
  {
    route: "raw",
    statsCategory: "other",
    matcher: { kind: "always" },
  },
] as const satisfies readonly RouteCatalogEntry[];

/** 電文の処理ルート。カタログの route 名から導出する (追加は ROUTE_CATALOG への 1 エントリ)。 */
export type Route = (typeof ROUTE_CATALOG)[number]["route"];

/**
 * 線形 processor 表 (`PROCESSOR_TABLE`) が扱う route。
 * 独立ライフサイクルの volcano・早期 return する ignore・フォールバックの raw を除く。
 */
export type LinearRoute = Exclude<Route, "volcano" | "ignore" | "raw">;

/** Route → StatsCategory 対応。カタログから導出するため Route を網羅していることが保証される。 */
export const ROUTE_TO_STATS_CATEGORY = Object.fromEntries(
  ROUTE_CATALOG.map((e) => [e.route, e.statsCategory]),
) as Record<Route, StatsCategory>;

// ── matcher のコンパイル (Set 化して O(1) 判定) ──

type CompiledMatcher = (classification: string, headType: string) => boolean;

function compileMatcher(matcher: RouteMatcher): CompiledMatcher {
  switch (matcher.kind) {
    case "headTypeSet": {
      const headTypes = new Set(matcher.headTypes);
      const classification = matcher.classification;
      return (c, h) => (classification == null || c === classification) && headTypes.has(h);
    }
    case "headTypePrefix": {
      const prefixes = matcher.prefixes;
      const classification = matcher.classification;
      return (c, h) => c === classification && prefixes.some((p) => h.startsWith(p));
    }
    case "classification": {
      const classifications = new Set(matcher.classifications);
      return (c) => classifications.has(c);
    }
    case "always":
      return () => true;
  }
}

interface CompiledEntry {
  readonly route: Route;
  readonly test: CompiledMatcher;
}

const COMPILED_CATALOG: readonly CompiledEntry[] = ROUTE_CATALOG.map((e) => ({
  route: e.route,
  test: compileMatcher(e.matcher),
}));

/**
 * classification と head.type から処理ルートを判定する。
 * カタログを上から走査し、最初に一致した route を返す。raw エントリ ("always") が
 * 末尾にあるため必ず一致する。
 */
export function classifyMessage(classification: string, headType: string): Route {
  for (const entry of COMPILED_CATALOG) {
    if (entry.test(classification, headType)) {
      return entry.route;
    }
  }
  return "raw"; // 到達不能: raw エントリの matcher は "always"
}
