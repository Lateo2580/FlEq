import type { ColorLevel } from "./color";
import { createRenderer } from "./format";
import type { TerminalBatch } from "./format";

// P3-TW-AC02: Windows の端末の writer。親の fd 1 を継承して process.stdout.write で書き、書き終わりを返す。
// ここが WriteConsoleW の中で止まっても止まるのはこの process だけで、親は kill で終わらせる（P3-TW-D-WRITER・D-CLOSE）。
const level: ColorLevel = [0, 1, 2, 3].find((item): item is ColorLevel => item === Number(process.argv[2])) ?? 0;
const renderer = createRenderer(level);
const done = () => { process.send?.("done"); };

// P3-TW-D-SIGINT: raw mode の外の Ctrl+C は console の全 process に届く。子の終わりは親の kill と IPC の切断だけで決める。
process.on("SIGINT", () => {});
process.stdout.on("error", () => { process.exit(1); });
process.on("message", (message) => {
  let text = "";
  // 親の output.ts が send する値だけが来る。整形の例外で子を落とさない（その 1 回分は出さない）。
  try { text = renderer.render(message as TerminalBatch); } catch { text = ""; }
  if (text === "") { done(); return; }
  // 列を進めるのは write の完了だけ（戻り値や drain で返すと、詰まった端末へ次を送る）。
  process.stdout.write(text, (error) => { if (error != null) process.exit(1); done(); });
});
