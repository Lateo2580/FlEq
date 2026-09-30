// A10 本番 a10-p2-20260930b の生データの補足封印（ヘルツ最終確認 指摘 2）。窓記録の raw（c111d843 の hashRaw）は窓 dir 直下と
// heapprofile・診断 JSONL だけを hash していた。ここでは修正後の hashRaw と同じ規則（窓 dir の下の全ファイル、state/ だけ除く）で
// 全窓を hash し、raw-supplement.json に WP2 の sealSelfHash（resultSha256 を 0 置換した bytes の sha256）で封印する。
// あわせて、窓記録に既にある raw の各行が、同じ path の今の bytes と一致することを確かめる（元の封印と補足封印が同じ bytes を指す）。
//
// usage: node seal-raw.mjs --raw <生データの根（~/dev/fleq-a10-runs/a10-p2-20260930b）> [--repo <FlEq checkout>] [--out <書き出し先>]
//   （repo は読むだけ。dist の build が要る。--out を省くと一時 dir に書き、repo の raw-supplement.json は上書きしない）
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const RUN_ID = "a10-p2-20260930b";
const HERE = import.meta.dirname;
const arg = (name, fallback) => { const k = process.argv.indexOf(name); return k > 0 ? process.argv[k + 1] : fallback; };
const RAW_ROOT = arg("--raw", null);
if (RAW_ROOT == null) throw new Error("--raw <生データの根> が要る（例 ~/dev/fleq-a10-runs/a10-p2-20260930b）");
const REPO = arg("--repo", "/Users/sayue/dev/FlEq");
const { ZERO_HASH, sealSelfHash } = await import(join(REPO, "reconstruction/dist/src/measurement/eew-e01/frozen.js"));
const RECORDS = join(REPO, "reconstruction/test/eew-e01/evidence/windows", RUN_ID);

const sha256Hex = (b) => createHash("sha256").update(b).digest("hex");
// 規則は run.mjs の hashRaw と同じ（下位 dir を含む全ファイル、path に state/ を含むものを除く、相対 path の辞書順）。
const hashAll = (dir) => readdirSync(dir, { recursive: true }).map(String).sort()
  .filter((f) => !f.split("/").includes("state") && statSync(join(dir, f)).isFile())
  .map((f) => { const b = readFileSync(join(dir, f)); return { path: f, bytes: b.length, sha256: sha256Hex(b) }; });

const manifest = JSON.parse(readFileSync(join(REPO, "reconstruction/test/eew-e01/evidence/manifest.json"), "utf8"));
const windows = {};
const checks = [];
for (const id of readdirSync(RAW_ROOT).filter((d) => statSync(join(RAW_ROOT, d)).isDirectory()).sort()) {
  const files = hashAll(join(RAW_ROOT, id));
  windows[id] = files;
  const record = JSON.parse(readFileSync(join(RECORDS, `${id}.json`), "utf8"));
  if (record.manifestSha256 !== manifest.manifestSha256 || record.rawDir !== join(RAW_ROOT, id)) throw new Error(`${id}: window record does not point at this raw dir`);
  const byPath = new Map(files.map((f) => [f.path, f]));
  const differ = (record.raw ?? []).filter((r) => byPath.get(r.file)?.sha256 !== r.sha256 || byPath.get(r.file)?.bytes !== r.bytes).map((r) => r.file);
  checks.push({ id, files: files.length, recordRaw: record.raw?.length ?? 0, recordRawDiffer: differ });
}
const body = { schemaVersion: "p2-a10-raw-supplement-v1", manifestId: manifest.manifestId, manifestSha256: manifest.manifestSha256, resultSha256: ZERO_HASH,
  rawRoot: RAW_ROOT,
  rule: "窓 dir の下の全ファイル（下位 dir を含む）。path に state/ を含むもの（checkpoint の slot、測定中に上書きされる作業領域）だけ除く。path は窓 dir からの相対、辞書順",
  recordRawCheck: "各窓記録の raw[] の全行が、同じ path の bytes・sha256 と一致（不一致は recordRawDiffer に列挙）",
  checks, windows };
const out = arg("--out", join(tmpdir(), "raw-supplement.json"));
writeFileSync(out, sealSelfHash(`${JSON.stringify(body, null, 2)}\n`, "resultSha256"));
const total = Object.values(windows).reduce((a, f) => a + f.length, 0);
const bad = checks.filter((c) => c.recordRawDiffer.length > 0);
console.log(`windows=${checks.length} files=${total} recordRawRows=${checks.reduce((a, c) => a + c.recordRaw, 0)} recordRawDiffer=${bad.length} -> ${out}`);
if (bad.length > 0) { console.log(JSON.stringify(bad)); process.exit(1); }
