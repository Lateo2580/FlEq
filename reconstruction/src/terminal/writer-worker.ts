import { closeSync, constants, openSync, readlinkSync, writeSync } from "node:fs";
import { isatty } from "node:tty";
import { parentPort, workerData } from "node:worker_threads";

import type { ColorLevel } from "./color";
import { createRenderer } from "./format";
import type { TerminalBatch } from "./format";

// P3-TO-AC02 (1)(2): 端末の writer。main から 1 回分の単位を受け、整形して fd 1 へ同期で書き、書き終わりを返す。
// ここが write(2) の中で止まっても、止まるのはこの thread だけ（main の受信と通知は止まらない、D-WRITER）。
const RETRY_MS = 50;
const level: ColorLevel = [0, 1, 2, 3].find((item): item is ColorLevel => item === workerData?.level) ?? 0;
const renderer = createRenderer(level);
const pause = new Int32Array(new SharedArrayBuffer(4));
// EPIPE など（O10 の stdout の失敗）の後は書かない。返事は返し続けて、main の列を進めて数えるだけにする。
let broken = false;

// 端末（TTY）の fd 1 は blocking なので、端末が詰まると write(2) の中で止まり、process.exit が止まった worker の join を待つ。
// 同じ端末を装置の path で O_NONBLOCK に開き直して書く（新しい open file description なので main の fd 1 は blocking のまま）。
// Linux は /proc/self/fd/1 の指す装置（fd 1 の端末そのもの）、/proc の無い macOS は /dev/tty（/dev/fd/N は description を共有するので使わない）。
// O_NOCTTY は制御端末の無い起動で開いた端末を制御端末にしないため。pipe と file は fd 1 のまま。
// shortcut: macOS で fd 1 が制御端末と別の端末（fleq > /dev/ttys005 など）だと制御端末へ書く。/dev/tty の fstat では見分けられない。
function nonBlocking(path: string): number | null {
  try { return openSync(path, constants.O_WRONLY | constants.O_NONBLOCK | constants.O_NOCTTY); } catch { return null; }
}
function outputFd(): number | null {
  if (!isatty(1)) return 1;
  let device: string | null = null;
  try { device = readlinkSync("/proc/self/fd/1"); } catch { device = null; }
  return (device == null ? null : nonBlocking(device)) ?? nonBlocking("/dev/tty");
}
const fd = outputFd();
// どちらも開けない（制御端末の無い起動の macOS など）ときは blocking の fd 1 へ戻らず、EPIPE の後と同じく書かずに数えるだけにする。
if (fd == null) broken = true;

// 警告は待たずに書けるときだけ 1 回出す（作者裁定 A）。標準エラーの端末は blocking で、詰まっていると worker がここで止まる。
// 端末なら Linux は /proc/self/fd/2 の装置を O_NONBLOCK で開いて 1 回だけ書き、EAGAIN や開けないときは諦める。/proc の無い macOS は出さない。
// 端末でない（pipe は libuv が非 blocking にしている、file は止まらない）なら fd 2 へ 1 回だけ書き、失敗は諦める。
function warnWithoutWaiting(text: string): void {
  if (!isatty(2)) { try { writeSync(2, text); } catch { /* 諦める */ } return; }
  let device: string;
  try { device = readlinkSync("/proc/self/fd/2"); } catch { return; }
  const errorFd = nonBlocking(device);
  if (errorFd == null) return;
  try { writeSync(errorFd, text); } catch { /* 諦める */ } finally { closeSync(errorFd); }
}

function write(fd: number, text: string): void {
  const bytes = Buffer.from(text);
  let offset = 0;
  while (offset < bytes.length) {
    try {
      offset += writeSync(fd, bytes, offset);
    } catch (error) {
      // 非 blocking の fd の EAGAIN は 50 ms 待って同じ所から書き直す（main は待たない）。
      if (error instanceof Error && "code" in error && error.code === "EAGAIN") { Atomics.wait(pause, 0, 0, RETRY_MS); continue; }
      broken = true;
      return;
    }
  }
}

parentPort!.on("message", (batch: TerminalBatch) => {
  if (!broken && fd != null) {
    let text = "";
    // 整形の例外で worker を落とさない（その 1 回分は出さない）。
    try { text = renderer.render(batch); } catch { text = ""; }
    if (text !== "") write(fd, text);
  }
  parentPort!.postMessage("done");
});
// 返事の口を作った後に出す（警告の失敗で返事が止まらないように）。
if (fd == null) warnWithoutWaiting("端末への書き出しを待たずに行えないため、この端末には電文や返事を出しません\n");
