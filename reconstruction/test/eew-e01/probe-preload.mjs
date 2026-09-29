// A10 WP3b: 製品 src を変えずに host/旧側の外から GC entry を取る。`node --import <this> ...` で先に読ませる。
// heap の前後は replay 区間で取る（旧側 launcher と host の mem 行）ので、ここでは取らない。
// FLEQ_PROBE_OUT（出力 JSON のパス）が無ければ何もしない。
import { writeFileSync } from "node:fs";
import { PerformanceObserver } from "node:perf_hooks";

const out = process.env.FLEQ_PROBE_OUT;
if (out != null) {
  const probe = { schemaVersion: "p2-probe-v1", nodeVersion: process.version, gc: [] };
  const record = (e) => probe.gc.push({ kind: e.detail?.kind ?? e.kind, startMs: e.startTime, durationMs: e.duration });
  const observer = new PerformanceObserver((list) => list.getEntries().forEach(record));
  observer.observe({ entryTypes: ["gc"] });
  process.on("exit", () => {
    observer.takeRecords().forEach(record);
    writeFileSync(out, JSON.stringify(probe));
  });
}
