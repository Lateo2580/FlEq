import chalk from "chalk";

import type { TerminalBandLevel } from "../../contracts/p3-terminal-output.types";

// P3-TO-AC03: 色の役目と実際の色（cli-terminal-output.md §3.1 の表の写し）。整形は役目の名前で引き、RGB を直に書かない。
// 震度と長周期の段は旧築 src/ui/theme.ts の DEFAULT_ROLES を写す。
type ColorLevel = 0 | 1 | 2 | 3;
type Style = Readonly<{ fg?: string; bg?: string; bold?: true }>;
const GRAY = "#84919e", SKY = "#56b4e9", BLUE = "#0072b2", BLUE_GREEN = "#009e73", YELLOW = "#f0e442", ORANGE = "#e69f00",
  VERMILLION = "#d55e00", RASPBERRY = "#cc79a7", DARK_RED = "#7a1e00", PURPLE = "#b23ab2", WHITE = "#ffffff", BLACK = "#000000";
const ROLES = {
  bandPurple: { bg: PURPLE, fg: WHITE, bold: true }, rulePurple: { fg: PURPLE }, bandPurpleShort: { bg: WHITE, fg: BLACK, bold: true },
  bandWarning: { bg: DARK_RED, fg: WHITE, bold: true }, ruleWarning: { fg: VERMILLION },
  bandCaution: { bg: YELLOW, fg: BLACK }, ruleCaution: { fg: YELLOW },
  bandPlain: { bold: true }, rulePlain: { fg: GRAY },
  bandCancel: { bg: RASPBERRY, fg: BLACK, bold: true }, ruleCancel: { fg: RASPBERRY },
  arrived: { fg: VERMILLION }, dim: { fg: GRAY }, strong: { bold: true },
  int1: { fg: GRAY }, int2: { fg: SKY }, int3: { fg: BLUE }, int4: { fg: BLUE_GREEN }, int5Lower: { fg: YELLOW }, int5Upper: { fg: ORANGE },
  int6Lower: { fg: VERMILLION, bold: true }, int6Upper: { bg: VERMILLION, fg: BLACK, bold: true }, int7: { bg: DARK_RED, fg: WHITE, bold: true },
  lg0: { fg: GRAY }, lg1: { fg: SKY }, lg2: { fg: YELLOW }, lg3: { fg: ORANGE }, lg4: { bg: VERMILLION, fg: BLACK, bold: true },
} as const satisfies Record<string, Style>;
type Role = keyof typeof ROLES;

const BAND_ROLES: Readonly<Record<TerminalBandLevel, Readonly<{ band: Role; rule: Role }>>> = {
  purple: { band: "bandPurple", rule: "rulePurple" }, warning: { band: "bandWarning", rule: "ruleWarning" },
  caution: { band: "bandCaution", rule: "ruleCaution" }, plain: { band: "bandPlain", rule: "rulePlain" },
  cancel: { band: "bandCancel", rule: "ruleCancel" },
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
export type { ColorLevel, Paint, Role };
