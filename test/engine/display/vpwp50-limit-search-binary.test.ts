import { describe, expect, it } from "vitest";
import type {
  DisplayWeatherWarningForecastGroupV1,
  DisplayWeatherWarningForecastPeriodV1,
  DisplayWeatherWarningForecastTargetV1,
  StandbySeverity,
} from "../../../src/engine/display/protocol";
import type { WeatherWarningForecastState } from "../../../src/engine/display/weather-warning-forecast-active-reducer";
import {
  assertWeatherWarningForecastWireInvariant,
  buildWeatherWarningForecastCard,
  cardConstraintsPass,
  escapePath,
  findEffectiveLimit,
  sortWeatherWarningForecastGroups,
  truncateReasonUnits,
  weatherWarningForecastPeriodCount,
  weatherWarningForecastProjectionLimitReasons,
  WEATHER_WARNING_FORECAST_MAX_GROUPS_PER_SUBJECT,
  WEATHER_WARNING_FORECAST_MAX_PERIODS_PER_CARD,
  WEATHER_WARNING_FORECAST_MAX_PERIODS_PER_SUBJECT,
  WEATHER_WARNING_FORECAST_MAX_PERIODS_PER_TARGET,
  WEATHER_WARNING_FORECAST_MAX_TARGETS_PER_GROUP,
  WEATHER_WARNING_FORECAST_PERIODS_PER_ATOM,
  type Vpwp50ProjectionLimitReasonCode,
} from "../../../src/engine/display/weather-warning-forecast-wire";

// ---------------------------------------------------------------------------
// 参照実装（線形探索）。二分探索の答え合わせにだけ使う。
// ---------------------------------------------------------------------------

/** 0..declaredLimit を全走査して、pass が true になる最大の候補を返す。 */
function linearEffectiveLimit(
  declaredLimit: number,
  pass: (candidate: number) => boolean,
): number | null {
  let effectiveLimit: number | null = null;
  for (let candidate = 0; candidate <= declaredLimit; candidate += 1) {
    if (pass(candidate)) effectiveLimit = candidate;
  }
  return effectiveLimit;
}

// ---------------------------------------------------------------------------
// 合成 state（違反 shape 別）
// ---------------------------------------------------------------------------

const SYNTH_START_MS = Date.parse("2026-01-01T00:00:00.000Z");
const SYNTH_REPORT_MS = Date.parse("2026-01-01T00:00:00.000Z");
const SYNTH_EXPIRES_MS = Date.parse("2026-01-11T17:00:00.000Z");

/** `as` を使わずに pagerSlot の union を得る（tsconfig.test.json 冒頭の方針 4）。 */
function pagerSlotOf(index: number): 0 | 1 | 2 | 3 {
  switch (index % 4) {
    case 1: return 1;
    case 2: return 2;
    case 3: return 3;
    default: return 0;
  }
}

function synthPeriod(
  groupKey: string,
  targetKey: string,
  index: number,
  anchorKeyOverride?: string,
): DisplayWeatherWarningForecastPeriodV1 {
  const startsAt = new Date(SYNTH_START_MS + index * 2 * 60 * 60_000).toISOString();
  const endsAt = new Date(SYNTH_START_MS + index * 2 * 60 * 60_000 + 60 * 60_000).toISOString();
  const pagerAnchorOrdinal = Math.floor(index / 4);
  return {
    key: `period:${groupKey}:${targetKey}:${index}`,
    tsNum: 1,
    series: "3h",
    startsAt,
    endsAt,
    label: `${startsAt}-${endsAt}`,
    pagerAnchorKey: anchorKeyOverride ?? `anchor:${groupKey}:${targetKey}:${pagerAnchorOrdinal}`,
    pagerAnchorOrdinal,
    pagerSlot: pagerSlotOf(index),
  };
}

function synthTarget(
  groupKey: string,
  name: string,
  periodCount: number,
  anchorKeyOverride?: string,
): DisplayWeatherWarningForecastTargetV1 {
  const key = `target:${groupKey}:${name}`;
  return {
    key,
    scope: "area",
    name,
    parentAreaName: name,
    areaCode: null,
    localCode: null,
    periods: Array.from({ length: periodCount }, (_, index) =>
      synthPeriod(groupKey, key, index, anchorKeyOverride)),
  };
}

function synthGroup(
  significancyCode: string,
  targets: DisplayWeatherWarningForecastTargetV1[],
  severity: StandbySeverity = "warning",
): DisplayWeatherWarningForecastGroupV1 {
  return {
    key: `group:${significancyCode}`,
    phenomenonName: "雨",
    significancyCode,
    forecastLabel: "大雨（区分不明）の予測",
    displaySeverity: "unknown",
    severity,
    targets,
  };
}

function synthState(
  subjectIndex: number,
  groups: DisplayWeatherWarningForecastGroupV1[],
  restored = false,
): WeatherWarningForecastState {
  return {
    subjectKey: `weatherTimeseries:s${subjectIndex}:scope:all`,
    sourceEventId: `e${subjectIndex}`,
    publishingOffice: "office",
    targetAreaName: "area",
    targetAreaCode: null,
    revision: { reportTimeMs: SYNTH_REPORT_MS, serial: "1" },
    appliedSemanticKey: `発表:${"a".repeat(64)}`,
    expiresAtMs: SYNTH_EXPIRES_MS,
    restored,
    groups,
  };
}

/**
 * 自身の階層と、その祖先である periodsPerSubject / periodsPerCard を同時に超える
 * 件数。定数から導くので、上限が動いても shape が「自分の階層しか超えない」形へ
 * 痩せない（2026-09-09 の 128 → 256 引き上げで実際に痩せた）。
 */
const OVER_SUBJECT_PERIODS = WEATHER_WARNING_FORECAST_MAX_PERIODS_PER_SUBJECT + 1;

/** 単一 subject の違反 shape。subjectIndex で複数 subject へ複製できる。 */
function shapeGroupsOver(subjectIndex: number): WeatherWarningForecastState {
  return synthState(subjectIndex, Array.from({ length: OVER_SUBJECT_PERIODS }, (_, index) =>
    synthGroup(`g${subjectIndex}_${index}`, [synthTarget(`group:g${subjectIndex}_${index}`, "a", 1)])));
}

function shapeTargetsOver(subjectIndex: number): WeatherWarningForecastState {
  const significancyCode = `t${subjectIndex}`;
  return synthState(subjectIndex, [synthGroup(significancyCode,
    Array.from({ length: OVER_SUBJECT_PERIODS }, (_, index) =>
      synthTarget(`group:${significancyCode}`, `a${index}`, 1)))]);
}

function shapePeriodsOver(
  subjectIndex: number,
  periodCount = OVER_SUBJECT_PERIODS,
): WeatherWarningForecastState {
  const significancyCode = `p${subjectIndex}`;
  return synthState(subjectIndex, [
    synthGroup(significancyCode, [synthTarget(`group:${significancyCode}`, "a", periodCount)]),
  ]);
}

function shapeAnchorOver(subjectIndex: number): WeatherWarningForecastState {
  const significancyCode = `h${subjectIndex}`;
  return synthState(subjectIndex, [
    synthGroup(significancyCode, [
      synthTarget(`group:${significancyCode}`, "a", 5, `anchor:shared:${subjectIndex}`),
    ]),
  ]);
}

/** 横断集計だけが超える shape（1 subject あたりは全上限内）。 */
function shapeCardOver(subjectCount: number): WeatherWarningForecastState[] {
  const periodsEach = Math.ceil((WEATHER_WARNING_FORECAST_MAX_PERIODS_PER_CARD + 22) / subjectCount);
  return Array.from({ length: subjectCount }, (_, index) => synthState(index, [
    synthGroup(`c${index}`, [synthTarget(`group:c${index}`, "a", periodsEach)]),
  ]));
}

/**
 * `restored` 混在の横断集計超過。card の `restored` は
 * `states.some((state) => state.restored)` なので、`restored: true` の state が
 * 落ちると `true`（4 文字）→ `false`（5 文字）へ**伸びる**。縮小側が byte を増やす
 * 唯一のフィールドで、単調性が壊れうる唯一の向きなので専用 shape で踏む（spec §5）。
 * restored を末尾 subject に置くことで、切り詰め量に応じて実際に反転が起きる。
 */
function shapeRestoredMix(): WeatherWarningForecastState[] {
  const periodsEach = Math.ceil((WEATHER_WARNING_FORECAST_MAX_PERIODS_PER_CARD + 22) / 3);
  return Array.from({ length: 3 }, (_, index) => synthState(
    index,
    [synthGroup(`r${index}`, [synthTarget(`group:r${index}`, "a", periodsEach)])],
    index === 2,
  ));
}

/**
 * 複合違反。subject 0 の group 超過と subject 1 の period 超過が互いに独立なので、
 * 片方を 0 まで削っても他方が残り、effectiveLimit が null になる code が現れる。
 */
function shapeMixed(): WeatherWarningForecastState[] {
  return [
    synthState(0, Array.from({ length: WEATHER_WARNING_FORECAST_MAX_GROUPS_PER_SUBJECT + 1 }, (_, index) =>
      synthGroup(`m${index}`, [synthTarget(`group:m${index}`, "a", 1)]))),
    synthState(1, [synthGroup("mm", [synthTarget("group:mm", "b", OVER_SUBJECT_PERIODS)])]),
  ];
}

interface Shape {
  name: string;
  states: WeatherWarningForecastState[];
}

const SHAPES: readonly Shape[] = [
  { name: "groupsPerSubject 超過 (1 subject)", states: [shapeGroupsOver(0)] },
  { name: "targetsPerGroup 超過 (1 subject)", states: [shapeTargetsOver(0)] },
  { name: "periodsPerTarget 超過 (1 subject)", states: [shapePeriodsOver(0)] },
  { name: "periodsPerAnchor 超過 (1 subject)", states: [shapeAnchorOver(0)] },
  { name: "横断集計超過 (3 subject)", states: shapeCardOver(3) },
  { name: "横断集計超過 (20 subject)", states: shapeCardOver(20) },
  {
    name: "targetsPerGroup 超過 (3 subject)",
    states: Array.from({ length: 3 }, (_, index) => shapeTargetsOver(index)),
  },
  {
    name: "periodsPerTarget 超過 (20 subject)",
    // 20 subject 分を 0..declaredLimit で全走査する A4 が重いので、この shape だけは
    // periodsPerTarget の直上（129）に留める。祖先込みの被覆は 1 subject 版が持つ。
    states: Array.from({ length: 20 }, (_, index) =>
      shapePeriodsOver(index, WEATHER_WARNING_FORECAST_MAX_PERIODS_PER_TARGET + 1)),
  },
  { name: "横断集計超過 (restored 混在)", states: shapeRestoredMix() },
  { name: "複合違反 (effectiveLimit null を含む)", states: shapeMixed() },
];

// ---------------------------------------------------------------------------
// 探索対象 unit の path 再現（production の countUnits の path 規則を写したもの）
//
// production と同じ paths を作れていることは、参照実装の答えが
// weatherWarningForecastProjectionLimitReasons() の effectiveLimit と一致することで
// 逆に固定される（§A2 の end-to-end 突き合わせ）。
// ---------------------------------------------------------------------------

const DECLARED_LIMITS: Record<Exclude<Vpwp50ProjectionLimitReasonCode, "cardJsonBytes">, number> = {
  groupsPerSubject: WEATHER_WARNING_FORECAST_MAX_GROUPS_PER_SUBJECT,
  targetsPerGroup: WEATHER_WARNING_FORECAST_MAX_TARGETS_PER_GROUP,
  periodsPerTarget: WEATHER_WARNING_FORECAST_MAX_PERIODS_PER_TARGET,
  periodsPerAnchor: WEATHER_WARNING_FORECAST_PERIODS_PER_ATOM,
  periodsPerSubject: WEATHER_WARNING_FORECAST_MAX_PERIODS_PER_SUBJECT,
  periodsPerCard: WEATHER_WARNING_FORECAST_MAX_PERIODS_PER_CARD,
};

function violatingPaths(
  states: readonly WeatherWarningForecastState[],
  code: Exclude<Vpwp50ProjectionLimitReasonCode, "cardJsonBytes">,
): Set<string> {
  const limit = DECLARED_LIMITS[code];
  const paths = new Set<string>();
  let cardTotal = 0;
  for (const state of states) {
    const subjectPath = `subjects/${escapePath(state.subjectKey)}`;
    const subjectPeriods = weatherWarningForecastPeriodCount(state.groups);
    cardTotal += subjectPeriods;
    if (code === "groupsPerSubject" && state.groups.length > limit) paths.add(`${subjectPath}/groups`);
    if (code === "periodsPerSubject" && subjectPeriods > limit) paths.add(`${subjectPath}/periods`);
    for (const group of state.groups) {
      const groupPath = `${subjectPath}/groups/${escapePath(group.key)}`;
      if (code === "targetsPerGroup" && group.targets.length > limit) paths.add(`${groupPath}/targets`);
      for (const target of group.targets) {
        const targetPath = `${groupPath}/targets/${escapePath(target.key)}`;
        if (code === "periodsPerTarget" && target.periods.length > limit) paths.add(`${targetPath}/periods`);
        if (code === "periodsPerAnchor") {
          const anchors = new Map<string, number>();
          for (const period of target.periods) {
            anchors.set(period.pagerAnchorKey, (anchors.get(period.pagerAnchorKey) ?? 0) + 1);
          }
          for (const [anchor, actual] of anchors) {
            if (actual > limit) paths.add(`${targetPath}/anchors/${escapePath(anchor)}/periods`);
          }
        }
      }
    }
  }
  if (code === "periodsPerCard" && cardTotal > limit) {
    paths.add("card/weatherWarningForecast:active/periods");
  }
  return paths;
}

/** production の探索述語そのもの。 */
function productionPredicate(
  states: readonly WeatherWarningForecastState[],
  code: Exclude<Vpwp50ProjectionLimitReasonCode, "cardJsonBytes">,
  paths: ReadonlySet<string>,
): (candidate: number) => boolean {
  return (candidate) => cardConstraintsPass(truncateReasonUnits(states, code, paths, candidate));
}

function searchableCodes(shape: Shape): Exclude<Vpwp50ProjectionLimitReasonCode, "cardJsonBytes">[] {
  return weatherWarningForecastProjectionLimitReasons(shape.states)
    .map((reason) => reason.code)
    .filter((code): code is Exclude<Vpwp50ProjectionLimitReasonCode, "cardJsonBytes"> =>
      code !== "cardJsonBytes");
}

// ---------------------------------------------------------------------------
// A5: 述語呼び出し回数
// ---------------------------------------------------------------------------

describe("findEffectiveLimit — 探索回数 (A5)", () => {
  it("declaredLimit=128 で述語呼び出しは 8 回以下になる", () => {
    // 述語自身が数える。module 内部呼び出しは spy で差し替わらないため
    // vi.spyOn では検査にならない（spec §4.2）。
    for (let threshold = 0; threshold <= 128; threshold += 1) {
      let calls = 0;
      const found = findEffectiveLimit(128, (candidate) => {
        calls += 1;
        return candidate <= threshold;
      });
      expect(found).toBe(threshold);
      expect(calls).toBeLessThanOrEqual(8);
    }
  });

  it("どの候補も通らない場合も 8 回以下で null を返す", () => {
    let calls = 0;
    const found = findEffectiveLimit(128, (_candidate) => {
      calls += 1;
      return false;
    });
    expect(found).toBeNull();
    expect(calls).toBeLessThanOrEqual(8);
  });

  it("実際の探索経路でも declaredLimit ごとの二分探索上界に収まる", () => {
    // 0..declaredLimit の二分探索は ceil(log2(declaredLimit + 2)) 回で尽きる
    // (128 なら 8 回、256 なら 9 回)。階層ごとに declaredLimit が違うので、
    // 128 の階層だけを拾う skip ではなく上界そのものを式で書く。
    let checkedCodes = 0;
    for (const shape of SHAPES) {
      for (const code of searchableCodes(shape)) {
        const paths = violatingPaths(shape.states, code);
        const declaredLimit = DECLARED_LIMITS[code];
        const bound = Math.ceil(Math.log2(declaredLimit + 2));
        const pass = productionPredicate(shape.states, code, paths);
        let calls = 0;
        findEffectiveLimit(declaredLimit, (candidate) => {
          calls += 1;
          return pass(candidate);
        });
        expect(calls, `${shape.name} / ${code} (declaredLimit=${declaredLimit})`)
          .toBeLessThanOrEqual(bound);
        checkedCodes += 1;
      }
    }
    // 空振り防止: shape 群が探索を実際に踏んでいること
    expect(checkedCodes).toBeGreaterThanOrEqual(15);
  });
});

// ---------------------------------------------------------------------------
// A2: 参照実装（線形）との一致
// ---------------------------------------------------------------------------

describe("findEffectiveLimit — 線形参照実装との一致 (A2)", () => {
  it("単調な合成述語について、全 declaredLimit・全閾値で線形探索と一致する", () => {
    for (let declaredLimit = 0; declaredLimit <= 40; declaredLimit += 1) {
      for (let threshold = -1; threshold <= declaredLimit + 1; threshold += 1) {
        const pass = (candidate: number): boolean => candidate <= threshold;
        expect(
          findEffectiveLimit(declaredLimit, pass),
          `declaredLimit=${declaredLimit} threshold=${threshold}`,
        ).toBe(linearEffectiveLimit(declaredLimit, pass));
      }
    }
  });

  it("全 shape・全 code で production の述語について線形探索と一致する", () => {
    let nullCases = 0;
    let checkedCodes = 0;
    for (const shape of SHAPES) {
      const reasons = weatherWarningForecastProjectionLimitReasons(shape.states);
      for (const reason of reasons) {
        if (reason.code === "cardJsonBytes") continue;
        const code = reason.code;
        const paths = violatingPaths(shape.states, code);
        const declaredLimit = DECLARED_LIMITS[code];
        expect(declaredLimit, `${shape.name} / ${code} declaredLimit`).toBe(reason.declaredLimit);
        const pass = productionPredicate(shape.states, code, paths);
        const expected = linearEffectiveLimit(declaredLimit, pass);
        // 二分探索と線形探索が同じ述語で一致する
        expect(findEffectiveLimit(declaredLimit, pass), `${shape.name} / ${code}`).toBe(expected);
        // 本番関数の返り値とも一致する（テスト側の paths 再現が production と同じである証拠）
        expect(reason.effectiveLimit, `${shape.name} / ${code} end-to-end`).toBe(expected);
        checkedCodes += 1;
        if (expected == null) nullCases += 1;
      }
    }
    // shape 群が探索を実際に踏んでいること、null 分岐も含むことを固定する
    expect(checkedCodes).toBeGreaterThanOrEqual(15);
    expect(nullCases).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// A4: 単調性そのもの
// ---------------------------------------------------------------------------

describe("cardConstraintsPass ∘ truncateReasonUnits の単調性 (A4)", () => {
  it("k で通るなら k-1 でも通る（0..declaredLimit の全 k）", () => {
    let checkedCodes = 0;
    for (const shape of SHAPES) {
      for (const code of searchableCodes(shape)) {
        const paths = violatingPaths(shape.states, code);
        const declaredLimit = DECLARED_LIMITS[code];
        const pass = productionPredicate(shape.states, code, paths);
        let previous = pass(0);
        for (let candidate = 1; candidate <= declaredLimit; candidate += 1) {
          const current = pass(candidate);
          if (current) {
            expect(previous, `${shape.name} / ${code} / k=${candidate} が通るのに k=${candidate - 1} が通らない`).toBe(true);
          }
          previous = current;
        }
        checkedCodes += 1;
      }
    }
    // 空振り防止: shape 群が探索対象 code を実際に生んでいること
    expect(checkedCodes).toBeGreaterThanOrEqual(15);
  });

  it("restored 混在 shape で、切り詰めが実際に restored を true→false へ反転させる", () => {
    // この反転が起きない shape だと、単調性の唯一の逆向き（+1 byte）を踏めない。
    const states = shapeRestoredMix();
    const paths = violatingPaths(states, "periodsPerCard");
    expect(paths.size).toBeGreaterThan(0);

    const restoredAt = (candidate: number): boolean | null => {
      const card = buildWeatherWarningForecastCard(
        truncateReasonUnits(states, "periodsPerCard", paths, candidate));
      return card == null ? null : card.restored;
    };
    // 全 subject が残る大きい k では true、末尾 subject が落ちる小さい k では false。
    expect(restoredAt(WEATHER_WARNING_FORECAST_MAX_PERIODS_PER_CARD)).toBe(true);
    expect(restoredAt(1)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A3: 単調性が依存している前提（spec §5）
// ---------------------------------------------------------------------------

describe("単調性の前提 (A3)", () => {
  it("severity の rank 降順と文字列長の降順が一致する", () => {
    const severities: readonly StandbySeverity[] = ["info", "normal", "warning", "critical"];
    expect(severities.map((severity) => severity.length)).toEqual([4, 6, 7, 8]);

    // rank 順は sortWeatherWarningForecastGroups の並び（rank 降順）で観測する。
    const groups = severities.map((severity, index) =>
      synthGroup(`rank${index}`, [synthTarget(`group:rank${index}`, "a", 1)], severity));
    const sorted = sortWeatherWarningForecastGroups(groups);
    expect(sorted.map((group) => group.severity)).toEqual(["critical", "warning", "normal", "info"]);

    // rank が高いほど文字列が長い＝period を削って severity が下がると byte は増えない。
    const lengths = sorted.map((group) => group.severity.length);
    for (let index = 1; index < lengths.length; index += 1) {
      expect(lengths[index]!).toBeLessThan(lengths[index - 1]!);
    }
  });

  it("updatedAt と expiresAt は常に 24 文字である", () => {
    const card = buildWeatherWarningForecastCard([synthState(0, [
      synthGroup("iso", [synthTarget("group:iso", "a", 2)]),
    ])]);
    expect(card).not.toBeNull();
    expect(card!.updatedAt).toHaveLength(24);
    expect(card!.expiresAt).toHaveLength(24);
    expect(new Date(SYNTH_REPORT_MS).toISOString()).toHaveLength(24);
    expect(new Date(SYNTH_EXPIRES_MS).toISOString()).toHaveLength(24);
  });
});

// ---------------------------------------------------------------------------
// A7: invariant assert が不変であること
// ---------------------------------------------------------------------------

describe("assertWeatherWarningForecastWireInvariant (A7)", () => {
  it("上限内の projection では throw しない", () => {
    expect(() => assertWeatherWarningForecastWireInvariant([synthState(0, [
      synthGroup("ok", [synthTarget("group:ok", "a", 4)]),
    ])])).not.toThrow();
  });

  it("上限超過では reasons を JSON にしたメッセージで throw する", () => {
    const states = [shapePeriodsOver(0)];
    const reasons = weatherWarningForecastProjectionLimitReasons(states);
    expect(() => assertWeatherWarningForecastWireInvariant(states))
      .toThrow(`VPWP50 projection wire invariant failed: ${JSON.stringify(reasons)}`);
  });
});
