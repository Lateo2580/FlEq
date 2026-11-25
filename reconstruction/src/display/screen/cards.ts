// P4-DISPLAY-SHELL-001（S0）カードの登録。各カードの契約がこの配列へ 1 行ずつ足す（計画 §2.1）。S0 は 0 本。
// max はその source が返すカードの最大の枚数（列のカードの数の上限 K は max の和、P4-DS-D-CARD-BOUND）。
import type { ShellCardEntry } from "../../../contracts/p4-display-shell.types";

const CARD_SOURCES: readonly ShellCardEntry[] = [];

export { CARD_SOURCES };
