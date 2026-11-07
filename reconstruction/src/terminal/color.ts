import chalk from "chalk";

import type { TerminalBandLevel } from "../../contracts/p3-terminal-output.types";

// P3-TO-AC03: 色の役目と実際の色（cli-terminal-output.md §3.1 の表の写し）。整形は役目の名前で引き、RGB を直に書かない。
// 震度と長周期の段は旧築 src/ui/theme.ts の DEFAULT_ROLES を写す。
type ColorLevel = 0 | 1 | 2 | 3;
type Style = Readonly<{ fg?: string; bg?: string; bold?: true }>;
// P3-TL2-AC02: 字と縦線は Nightfox の地と 4.5 以上（BLUE のリフト・VERMILLION_LIFT・PURPLE_LIFT）、面は地と 3 以上。
const GRAY = "#84919e", SKY = "#56b4e9", BLUE = "#3193db", BLUE_GREEN = "#009e73", YELLOW = "#f0e442", ORANGE = "#e69f00",
  VERMILLION = "#d55e00", VERMILLION_LIFT = "#e56910", RASPBERRY = "#cc79a7", PURPLE = "#b23ab2", PURPLE_LIFT = "#c46bde", WHITE = "#ffffff", BLACK = "#000000",
  CREAM = "#ffff99", LIGHT_GREEN = "#87e7b0";
const ROLES = {
  bandTop: { bg: WHITE, fg: BLACK, bold: true }, bandPurple: { bg: PURPLE, fg: WHITE, bold: true }, rulePurple: { fg: PURPLE_LIFT },
  bandWarning: { bg: VERMILLION, fg: BLACK, bold: true }, ruleWarning: { fg: VERMILLION_LIFT },
  bandCaution: { fg: YELLOW, bold: true }, ruleCaution: { fg: YELLOW },
  bandPlain: { bold: true }, rulePlain: { fg: GRAY },
  bandCancel: { bg: RASPBERRY, fg: BLACK, bold: true }, ruleCancel: { fg: RASPBERRY },
  // 帯の下の縦線（地の色で塗った空白 1 桁、P3-TL-AC03 (3)）。
  barPurple: { bg: PURPLE_LIFT }, barWarning: { bg: VERMILLION_LIFT }, barCaution: { bg: YELLOW }, barPlain: { bg: GRAY }, barCancel: { bg: RASPBERRY },
  connLost: { fg: CREAM }, connRestored: { fg: LIGHT_GREEN },
  arrived: { fg: VERMILLION_LIFT }, slightForecast: { fg: SKY }, dim: { fg: GRAY }, strong: { bold: true },
  int1: { fg: GRAY }, int2: { fg: SKY }, int3: { fg: BLUE }, int4: { fg: BLUE_GREEN }, int5Lower: { fg: YELLOW }, int5Upper: { fg: ORANGE },
  int6Lower: { fg: VERMILLION_LIFT, bold: true }, int6Upper: { bg: VERMILLION, fg: BLACK, bold: true }, int7: { bg: WHITE, fg: BLACK, bold: true },
  lg0: { fg: GRAY }, lg1: { fg: SKY }, lg2: { fg: YELLOW }, lg3: { fg: ORANGE }, lg4: { bg: VERMILLION, fg: BLACK, bold: true },
} as const satisfies Record<string, Style>;
type Role = keyof typeof ROLES;

// fill は帯を幅いっぱいに地の色で塗る段（警報以上と取消。注意は字と罫線の色だけ、P3-TL-AC03 (1)）。
type BandRoles = Readonly<{ band: Role; rule: Role; bar: Role; fill: boolean }>;
const BAND_ROLES: Readonly<Record<TerminalBandLevel, BandRoles>> = {
  top: { band: "bandTop", rule: "rulePurple", bar: "barPurple", fill: true },
  purple: { band: "bandPurple", rule: "rulePurple", bar: "barPurple", fill: true },
  warning: { band: "bandWarning", rule: "ruleWarning", bar: "barWarning", fill: true },
  caution: { band: "bandCaution", rule: "ruleCaution", bar: "barCaution", fill: false },
  plain: { band: "bandPlain", rule: "rulePlain", bar: "barPlain", fill: false },
  cancel: { band: "bandCancel", rule: "ruleCancel", bar: "barCancel", fill: true },
};
const INTENSITY_ROLES: Readonly<Record<string, Role>> = {
  1: "int1", 2: "int2", 3: "int3", 4: "int4", "5弱": "int5Lower", "5強": "int5Upper", "6弱": "int6Lower", "6強": "int6Upper", 7: "int7",
};
const LG_ROLES: Readonly<Record<string, Role>> = { 0: "lg0", 1: "lg1", 2: "lg2", 3: "lg3", 4: "lg4" };

// P3-TO-AC03 (2): main が起動の時に 1 回決める（worker の process.stdout は端末でないので、worker の chalk は判定できない）。
// 1・2 を 3 に引き上げるのは旧築 src/index.ts と同じ（Windows PowerShell などで判定が外れる）。
function colorLevel(noColor: string | undefined, isTTY: boolean, detected: ColorLevel): ColorLevel {
  if (noColor != null && noColor !== "") return 0;
  if (!isTTY) return detected;
  return detected === 1 || detected === 2 ? 3 : detected;
}

type Paint = (role: Role | null, text: string) => string;
function painter(level: ColorLevel): Paint {
  const instance = new chalk.Instance({ level });
  const styled = new Map<Role, chalk.Chalk>();
  return (role, text) => {
    if (role == null || text === "") return text;
    let paint = styled.get(role);
    if (paint == null) {
      const style: Style = ROLES[role];
      paint = instance;
      if (style.fg != null) paint = paint.hex(style.fg);
      if (style.bg != null) paint = paint.bgHex(style.bg);
      if (style.bold === true) paint = paint.bold;
      styled.set(role, paint);
    }
    return paint(text);
  };
}

export { BAND_ROLES, INTENSITY_ROLES, LG_ROLES, colorLevel, painter };
export type { BandRoles, ColorLevel, Paint, Role };
