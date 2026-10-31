import type { NotificationAttempt } from "../../contracts/p2-notification-delivery.types";
import type { ClockReading, UnitId } from "../../contracts/p2-shared-runtime.types";
import type { LegacyNotifyCategory, MuteRule, NotificationGate, NotificationGateVerdict } from "../../contracts/p3-cli-repl.types";

// P3-CLI-AC13: notify・sound・mute を効かせる通知の門（P3-CLI-D-O2-GATE）と、試行から旧築の 18 分野を引く表（P3-CLI-D-O2-CATEGORY）。

// CLI が持つ通知の設定。REPL が書き換え、門はその場で読む（REPL の変更は次の試行から効く）。
type NotificationSettings = {
  // 欄の無い分野は既定（AC13 (2)）。REPL で変えた分野と、設定ファイルから読んだ分野だけを持つ。
  notify: Partial<Record<LegacyNotifyCategory, boolean>>;
  sound: boolean;
  // 実行中の終わりは monotonic（null は mute off まで）、until は保存する wall の時刻（P3-CLI-D-O2-MUTE-PERSIST=B）。rules が空なら完全 mute。
  mute: Readonly<{ endsAtMonotonicMs: number | null; until: number | null; rules: readonly MuteRule[] }> | null;
  // 起動から REPL で通知の設定を変えた回数（P3-CLI-D-O2-SETTINGS-VERSION）。
  version: number;
};

// unit で決まる分野。U-W・U-F は C20 まで intent を作らない。
const UNIT_CATEGORIES: ReadonlyMap<UnitId, LegacyNotifyCategory> = new Map<UnitId, LegacyNotifyCategory>([
  ["U-E", "eew"], ["U-T", "tsunami"], ["U-N", "nankaiTrough"], ["U-V", "volcano"], ["U-L", "weather"], ["U-R", "floodForecast"],
  ["U-W", "weather"], ["U-F", "weatherWarningTimeseries"],
]);
// subject（<operation>/<family など>/…）の 2 つ目で決まる分野。書式は各 domain が組む（AC13 (1) の evidenceRefs）。
const SUBJECT_CATEGORIES: ReadonlyMap<UnitId, ReadonlyMap<string, LegacyNotifyCategory>> = new Map<UnitId, ReadonlyMap<string, LegacyNotifyCategory>>([
  ["U-Q", new Map<string, LegacyNotifyCategory>([["VXSE62", "lgObservation"], ["VXSE51", "earthquake"], ["VXSE52", "earthquake"], ["VXSE53", "earthquake"],
    ["VXSE61", "earthquake"], ["capacityRejected", "earthquake"]])],
  ["U-M", new Map<string, LegacyNotifyCategory>([["tornado", "tornado"], ["VPAW51", "earlyWeather"], ["VPFT50", "heatAlert"], ["VXSE56", "seismicText"],
    ["VXSE60", "seismicText"], ["VZSE40", "seismicText"], ["VPZI50", "climateInfo"], ["VPCI50", "climateInfo"], ["VPZJ51", "weatherExplanation"],
    ["VPCJ51", "weatherExplanation"], ["VPFJ51", "weatherExplanation"], ["VMCJ53", "weatherExplanation"], ["VMCJ54", "weatherExplanation"],
    ["VMCJ55", "weatherExplanation"]])],
  ["U-Y", new Map<string, LegacyNotifyCategory>([["typhoonAnalysis", "typhoonAnalysis"], ["typhoonProbability", "typhoonProbability"]])],
  ["U-B", new Map<string, LegacyNotifyCategory>([["VPBS50", "briefing"], ["VPOA50", "weather"]])],
]);
// 欄の無い分野で on のもの。weather は C20 の配送まで off（P3-CLI-D-O2-WEATHER-NOW=B）、残りの 10 分野も off。
const ON_BY_DEFAULT: ReadonlySet<LegacyNotifyCategory> = new Set<LegacyNotifyCategory>([
  "eew", "earthquake", "tsunami", "seismicText", "nankaiTrough", "lgObservation", "volcano",
]);
const LEVEL_RANK: Readonly<Record<MuteRule["level"], number>> = { normal: 1, warning: 2, critical: 3 };

/** 試行の分野。表に無い unit・2 つ目は null（分野の on/off で止めず、mute の条件にも当たらない）。 */
function categoryOf(attempt: Pick<NotificationAttempt, "unit" | "subject">): LegacyNotifyCategory | null {
  return UNIT_CATEGORIES.get(attempt.unit) ?? SUBJECT_CATEGORIES.get(attempt.unit)?.get(attempt.subject.split("/", 2)[1] ?? "") ?? null;
}

const notifyEnabled = (settings: Readonly<NotificationSettings>, category: LegacyNotifyCategory): boolean =>
  settings.notify[category] ?? ON_BY_DEFAULT.has(category);

const muteActive = (settings: Readonly<NotificationSettings>, monotonicMs: number): boolean =>
  settings.mute != null && (settings.mute.endsAtMonotonicMs == null || monotonicMs < settings.mute.endsAtMonotonicMs);

/** 門は試行 1 つに表の引き 1 回と条件の走査 1 回（P3-CLI-RES-04）。順は sound → 分野 → mute（AC13 (3)）。 */
function createNotificationGate(settings: Readonly<NotificationSettings>, clock: () => ClockReading): NotificationGate {
  return (attempt): NotificationGateVerdict => {
    const stop = (stage: "sound" | "category" | "mute"): NotificationGateVerdict => ({ allow: false, stage, settingsVersion: settings.version });
    if (attempt.channel === "sound" && !settings.sound) return stop("sound");
    const category = categoryOf(attempt);
    // P3-CLI-D-O2-CRITICAL=A: 分野を切った通知は critical でも止める。
    if (category != null && !notifyEnabled(settings, category)) return stop("category");
    const mute = settings.mute;
    if (mute != null && muteActive(settings, clock().monotonicMs)) {
      const level = attempt.payload.level;
      // info・cancel・5 つの外の段はどの条件にも当たらない（取消も黙る、Q-CLI-O2-AUTHOR-3 の問い 2=A）。
      const rank = level === "normal" || level === "warning" || level === "critical" ? LEVEL_RANK[level] : 0;
      if (category == null || rank === 0 || !mute.rules.some((rule) => rule.category === category && rank >= LEVEL_RANK[rule.level])) return stop("mute");
    }
    return { allow: true };
  };
}

export { categoryOf, createNotificationGate, muteActive, notifyEnabled };
export type { NotificationSettings };
