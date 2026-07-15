/** ターミナルタイトル操作 (ANSI OSC sequence)。cli-run と monitor の双方から使う共通モジュール */

/** ターミナルタイトルを設定する */
export function setTerminalTitle(title: string): void {
  if (process.stdout.isTTY) {
    process.stdout.write(`\x1b]2;${title}\x07`);
  }
}

/** ターミナルタイトルをリセットする */
export function resetTerminalTitle(): void {
  if (process.stdout.isTTY) {
    // 空文字を設定するとターミナルがデフォルトタイトルに戻る
    process.stdout.write(`\x1b]2;\x07`);
  }
}
