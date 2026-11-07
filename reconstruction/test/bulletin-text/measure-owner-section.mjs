// P3-BT-RES-06: urgent の owner が本文の要求 1 件で占める区間（detailOwner の呼び出しと返信の postMessage）を測る。
// 本文が 4,096＋512 字の記録が 64 件ある state の最後の記録を、U-V と U-N で 5,000 回ずつ読む。判定は p99 に当て、1 ms を越えれば rc 1。
// 使い方: tsc --project reconstruction/tsconfig.json の後に、repo の root で node reconstruction/test/bulletin-text/measure-owner-section.mjs
import { hostname } from "node:os";
import { performance } from "node:perf_hooks";
import { MessageChannel } from "node:worker_threads";

import ownerRuntime from "../../dist/src/runtime/owner-runtime.js";

const { detailOwner, initialUnits } = ownerRuntime;
const ROUNDS = 5_000, WARM_UP = 500, LIMIT_MS = 1;
const text = "あ".repeat(4_096), nextAdvisory = "い".repeat(512);
const source = (subject, index) => ({ inputId: `input-${index}`, origin: "live", operation: "normal", family: subject.split("/")[1], subject,
  reportDateTimeRaw: "2020-05-12T16:30:00+09:00", controlDateTimeRaw: "2020-05-12T07:30:05Z", serialRaw: "1", infoTypeRaw: "発表" });
const records = (family) => Array.from({ length: 64 }, (_, index) => {
  const subject = `normal/${family}/${String(index).padStart(64, "0")}`;
  return { subject, family, eventId: String(index), operation: "normal", source: source(subject, index), retainUntil: 0, effective: "active", title: "題", headline: null, truncated: false, text, nextAdvisory };
});

const { port1, port2 } = new MessageChannel();
port2.on("message", () => {});
function measure(unit, list, state) {
  const last = list.at(-1);
  const request = { unit, part: "text", id: last.subject, revision: JSON.stringify([last.source.inputId, last.source.reportDateTimeRaw, last.source.controlDateTimeRaw]) };
  const times = [];
  for (let round = 0; round < WARM_UP + ROUNDS; round += 1) {
    const started = performance.now();
    const response = detailOwner(state, request);
    port1.postMessage({ kind: "detailDone", response });
    const elapsed = performance.now() - started;
    if (response.kind !== "ok") throw new Error(`${unit} did not answer ok`);
    if (round >= WARM_UP) times.push(elapsed);
  }
  times.sort((left, right) => left - right);
  return { unit, rounds: ROUNDS, p50Ms: times[Math.floor(ROUNDS * 0.5)], p99Ms: times[Math.ceil(ROUNDS * 0.99) - 1], maxMs: times[ROUNDS - 1] };
}

const bulletins = records("VFVO51"), information = records("VYSE50");
const results = [measure("U-V", bulletins, { units: { "U-V": { ...initialUnits["U-V"], bulletins } } }),
  measure("U-N", information, { units: { "U-N": { ...initialUnits["U-N"], information } } })];
console.log(JSON.stringify({ host: hostname(), node: process.version, limitMs: LIMIT_MS, results }, null, 2));
port1.close();
process.exitCode = results.every((item) => item.p99Ms <= LIMIT_MS) ? 0 : 1;
