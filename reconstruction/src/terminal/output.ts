import type { Interface } from "node:readline";
import { Writable } from "node:stream";
import { Worker } from "node:worker_threads";

import chalk from "chalk";

import type { OwnerReply } from "../../contracts/p3-execution-split.types";
import { resolveRepoPath } from "../notification-delivery/adapter";
import { colorLevel } from "./color";
import type { TerminalBatch, TerminalUnit } from "./format";

// P3-TO-AC02（O02、D-WRITER・D-DROP）: main は材料と行を有界の列に積み、worker の手が空いたら頭からまとめて 1 回送るだけ。
// 整形と fs.writeSync(1, …) は writer の worker が行う。無いと SSH の向こうの端末が止まったとき main の write(2) が止まり、受信と通知が止まる。
// RES-01: 列は 1 本で上限は 1 MiB の 1 つ。worker への 1 回の送りは 64 KiB まで（1 単位がそれより大きければその 1 単位だけ）。
// DLV-02: 停止の後は列の残りを最長 1 秒書かせる。
const QUEUE_BYTES = 1024 * 1024, SEND_BYTES = 64 * 1024, CLOSE_MS = 1_000;

type InputDone = Extract<OwnerReply, { kind: "inputDone" }>;
// AC01 (4): host の config の terminal。返信を受けて列に積むだけ（AC08 (1)）。
type TerminalSink = Readonly<{ inputDone(reply: InputDone): void }>;
// AC02 (5): 試験で差し替える writer。done を呼ぶまで次を送らない。
type TerminalWriter = (batch: TerminalBatch, done: () => void) => void;
type TerminalOutput = Readonly<{
  sink: TerminalSink;
  // readline の output（AC02 (4)）。write は readline の echo と prompt で、D-DROP で数えない。
  output: NodeJS.WritableStream;
  // 数える 1 行（REPL の返事・起動の後の行）。
  line(text: string): void;
  // 電文のブロックの後に書き直す prompt と入力中の文字を、積む時に readline から写す。
  bind(readline: Interface): void;
  close(): Promise<void>;
  // 試験の口（T06）: 列の配列がまだ参照している単位の数。
  held(): number;
}>;

// AC08 (1): 積む時に 1 回だけ見積もる（JSON にしない）。文字列は UTF-8 の byte、ほかの値と入れ物は 8 byte。
// TerminalReport は件数の上限（RES-02）があり、EEW の facts は 1 報分なので、1 単位の中を辿るだけで受信 1 回の仕事は有界。
function estimate(value: unknown): number {
  if (typeof value === "string") return Buffer.byteLength(value);
  if (value == null || typeof value !== "object") return 8;
  let total = 8;
  for (const [key, item] of Object.entries(value)) total += Buffer.byteLength(key) + estimate(item);
  return total;
}
const counted = (unit: TerminalUnit): boolean => unit.kind !== "echo";

function createTerminalOutput(options: Readonly<{ write?: TerminalWriter }> = {}): TerminalOutput {
  const tty = process.stdout.isTTY === true;
  // 送った・落とした枠は undefined にして単位の参照を残さない（残すと送り終えた材料が列の配列に溜まる）。
  const queue: ({ unit: TerminalUnit; bytes: number } | undefined)[] = [];
  let head = 0, bytes = 0, dropped = 0, inFlight = false, failed = false;
  let readline: Interface | null = null, idle: (() => void) | null = null, closing: Promise<void> | null = null;
  let pending: (() => void) | null = null;
  let worker: Worker | null = null;
  const fail = () => {
    if (failed) return;
    // AC02 (2): worker が落ちても process は落とさず、受信も止めない。以後は積まずに数えるだけ。
    failed = true;
    inFlight = false;
    pending = null;
    for (let index = head; index < queue.length; index += 1) if (counted(queue[index]!.unit)) dropped += 1;
    queue.length = 0;
    head = 0;
    bytes = 0;
    idle?.();
  };
  if (options.write == null) {
    worker = new Worker(resolveRepoPath("reconstruction/dist/src/terminal/writer-worker.js"),
      { workerData: { level: colorLevel(process.env.NO_COLOR, tty, chalk.level) } });
    worker.unref();
    worker.on("message", () => { const done = pending; pending = null; done?.(); });
    worker.on("error", fail);
    worker.on("exit", fail);
  }
  const write: TerminalWriter = options.write ?? ((batch, done) => { pending = done; worker!.postMessage(batch); });
  // 頭の index で読み、半分を越えて読んだら詰める（落とす・送るたびに配列の先頭を消すと全件の移し替えになる）。
  const compact = () => {
    if (head > 1024 && head * 2 > queue.length) { queue.splice(0, head); head = 0; }
  };
  const take = (): { unit: TerminalUnit; bytes: number } => {
    const item = queue[head]!;
    queue[head] = undefined;
    head += 1;
    bytes -= item.bytes;
    if (head === queue.length) { queue.length = 0; head = 0; }
    return item;
  };
  const kick = (): void => {
    if (inFlight) return;
    if (failed || head === queue.length) { idle?.(); return; }
    const units: TerminalUnit[] = [];
    let size = 0;
    while (head < queue.length && (units.length === 0 || size + queue[head]!.bytes <= SEND_BYTES)) {
      const item = take();
      units.push(item.unit);
      size += item.bytes;
    }
    compact();
    // AC04 (1): 桁数は送る時に読む（無ければ 80）。途中で端末の大きさが変われば次の送りから合う。
    const batch: TerminalBatch = { columns: process.stdout.columns || 80, dropped, units };
    dropped = 0;
    inFlight = true;
    write(batch, () => { inFlight = false; kick(); });
  };
  // D-DROP: 越えたら種類によらず古い単位から丸ごと落とす。上限より大きい 1 単位は積まずに落とす。echo と prompt は数えない。
  const push = (unit: TerminalUnit): void => {
    const size = failed ? 0 : estimate(unit);
    if (failed || size > QUEUE_BYTES) { if (counted(unit)) dropped += 1; return; }
    while (bytes + size > QUEUE_BYTES) if (counted(take().unit)) dropped += 1;
    queue.push({ unit, bytes: size });
    bytes += size;
    compact();
    kick();
  };
  const promptOf = (): string | null => tty && readline != null ? readline.getPrompt() + readline.line : null;
  const output = new Writable({ decodeStrings: false, write(chunk: string | Buffer, _encoding, callback) {
    push({ kind: "echo", text: String(chunk) });
    callback();
  } });
  // readline は isTTY で行編集の形を、columns で折り返しを決める（process.stdout の値を返す）。
  Object.defineProperties(output, { isTTY: { value: tty }, columns: { get: () => process.stdout.columns }, rows: { get: () => process.stdout.rows } });
  const resize = () => { output.emit("resize"); };
  process.stdout.on("resize", resize);
  return {
    sink: { inputDone(reply) {
      // AC08 (1): 返信の terminal の参照と、その返信の outcomes のうち U-E のもの（facts.report を持つ）を積むだけ。
      const prompt = promptOf();
      if (reply.terminal != null) push({ kind: "report", report: reply.terminal, prompt });
      for (const { unit, outcome } of reply.output.outcomes) {
        if (unit !== "U-E" || outcome.kind !== "accepted" || outcome.change === "deliveryOnly") continue;
        for (const subject of outcome.subjects) if (subject.facts.report != null) push({ kind: "eew", subject, prompt });
      }
    } },
    output,
    line: (text) => { push({ kind: "line", text }); },
    held: () => queue.filter((item) => item != null).length,
    bind(next) {
      readline = next;
      next.once("close", () => { if (readline === next) readline = null; });
    },
    // AC02 (6): 列の残りを最長 1 秒書かせる。返事が来なければ（worker が同期の write(2) の中で止まっている）待たずに終える。
    close() {
      closing ??= new Promise<void>((resolve) => {
        process.stdout.off("resize", resize);
        const end = (drained: boolean) => {
          clearTimeout(timer);
          idle = null;
          queue.length = 0;
          head = 0;
          bytes = 0;
          if (worker == null) { resolve(); return; }
          worker.off("exit", fail);
          if (drained) { worker.terminate().then(() => resolve(), () => resolve()); return; }
          worker.unref();
          worker.terminate().catch(() => {});
          resolve();
        };
        const timer = setTimeout(() => end(false), CLOSE_MS);
        idle = () => end(true);
        if (failed || (!inFlight && head === queue.length)) end(true);
      });
      return closing;
    },
  };
}

export { createTerminalOutput, estimate };
export type { TerminalOutput, TerminalSink, TerminalWriter };
