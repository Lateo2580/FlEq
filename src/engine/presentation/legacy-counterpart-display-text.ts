const ANSI_OSC_PATTERN = /(?:\x1B\]|\x9D)[^\x07\x1B\x9C]*(?:\x07|\x1B\\|\x9C)/g;
const ANSI_CSI_PATTERN = /(?:\x1B\[|\x9B)[0-?]*[ -/]*[@-~]/g;
const ANSI_FE_PATTERN = /\x1B[@-_]/g;
const LINE_SEPARATOR_PATTERN = /[\r\n\u2028\u2029]+/g;
const CONTROL_PATTERN = /[\x00-\x1F\x7F-\x9F]/g;

/** 旧形式電文から表示面へ出す文字列を ANSI・制御文字なしの単一行へ正規化する。 */
export function normalizeLegacyCounterpartDisplayText(value: string): string {
  return value
    .replace(ANSI_OSC_PATTERN, "")
    .replace(ANSI_CSI_PATTERN, "")
    .replace(ANSI_FE_PATTERN, "")
    .replace(LINE_SEPARATOR_PATTERN, " ")
    .replace(CONTROL_PATTERN, "");
}
