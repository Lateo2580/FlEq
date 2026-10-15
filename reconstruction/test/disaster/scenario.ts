import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Harness } from "../execution-split/owner-harness";
import { synthesize } from "./synth";
import type { Frame } from "./synth";

// P3-DC-SCENARIOS（AC01）: 7 筋書きを流す順の frame の列と digest にする読み手。実電文は dmdata Archive を無改変で展開した
// x-<date>/（telegrams.json と本文の file）を引数の dir から読み、本文の bytes を書き換えない。
// 無いと、実電文の順と時刻と書き換えが固定されず、telegrams.json の時刻や種類が替わっても同じ digest で別の負荷を測れてしまう。

type Checkpoint = Readonly<{ atMs: number; label: string }>;
// 手書きの小さい期待例（P3-DC-ORACLE (6)）。その時刻の harness の state・view と、それまでの容量の欠けで確かめる。
type Expectation = Checkpoint & Readonly<{ check: (h: Harness, losses: readonly Readonly<{ unit: string }>[]) => boolean }>;
type Scenario =
  | Readonly<{ kind: "ready"; id: string; frames: readonly Frame[]; digest: string; startMs: number; endMs: number;
      checkpoints: readonly Checkpoint[]; expectations: readonly Expectation[]; synth: Readonly<{ sourceSha256: string; seed: number }> | null;
      // N1・N2・N3 の t0 と出所（結果の file に書く）。ほかの筋書きは null。
      t0: Readonly<{ atMs: number; source: string }> | null }>
  | Readonly<{ kind: "blocked"; id: string; reason: "dataMissing" | "digestMismatch"; digest: string | null }>;

const MINUTE = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const SYNTH_SOURCE = "reconstruction/test/disaster/synth.ts";
const sha256 = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");
const decoder = new TextDecoder();
const textOf = (body: Uint8Array, tag: string): string | null => new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(decoder.decode(body))?.[1] ?? null;
const midnight = (date: string): number => Date.parse(`${date}T00:00:00+09:00`);
const jstHour = (ms: number): number => Math.floor((ms + 9 * HOUR) / HOUR) * HOUR - 9 * HOUR;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value != null && !Array.isArray(value);

// x-<date>/telegrams.json の format=xml の行を receivedTime の順（同時刻は配列の順）に読む。dir か一覧が無ければ null。
function archiveDay(dataDir: string | null, date: string): Frame[] | null {
  if (dataDir == null) return null;
  const dir = join(dataDir, `x-${date}`), list = join(dir, "telegrams.json");
  if (!existsSync(list)) return null;
  const rows: unknown = JSON.parse(readFileSync(list, "utf8"));
  if (!Array.isArray(rows)) throw new Error(`${list}: not an array`);
  const frames: { frame: Frame; index: number }[] = [];
  rows.forEach((row: unknown, index) => {
    if (!isRecord(row) || row["format"] !== "xml") return;
    const headType = isRecord(row["head"]) ? row["head"]["type"] : null;
    const { receivedTime, filename } = row;
    if (typeof headType !== "string" || typeof receivedTime !== "string" || typeof filename !== "string" || Number.isNaN(Date.parse(receivedTime)))
      throw new Error(`${list}[${index}]: head.type, receivedTime or filename invalid`);
    frames.push({ index, frame: { atMs: Date.parse(receivedTime), headType, body: readFileSync(join(dir, filename)), origin: "real",
      source: `${date}/${filename}`, receivedTime } });
  });
  return frames.sort((a, b) => a.frame.atMs - b.frame.atMs || a.index - b.index).map((item) => item.frame);
}

// 流す順の (receivedTime, headType, 本文の sha256) の列の sha256（P3-DC-AC01 (2)）。実電文は telegrams.json の生の文字列、ほかは ISO 8601。
function digestOf(frames: readonly Frame[]): string {
  const hash = createHash("sha256");
  for (const frame of frames) hash.update(`${frame.receivedTime ?? new Date(frame.atMs).toISOString()}\t${frame.headType}\t${sha256(frame.body)}\n`);
  return hash.digest("hex");
}

// 時刻で併せる。同時刻は合成を先に置き、その中は元の順（P3-DC-AC01 (2)）。
function merge(...lists: readonly (readonly Frame[])[]): Frame[] {
  return lists.flat().map((frame, index) => ({ frame, index }))
    .sort((a, b) => a.frame.atMs - b.frame.atMs || Number(a.frame.origin !== "synthetic") - Number(b.frame.origin !== "synthetic") || a.index - b.index)
    .map((item) => item.frame);
}

const operationOf = (body: Uint8Array): string => {
  const status = textOf(body, "Status");
  return status === "通常" ? "normal" : status === "訓練" ? "training" : "test";
};
const eventIdOf = (frames: readonly Frame[], headType: string, fromMs: number): string =>
  textOf(frames.find((frame) => frame.headType === headType && frame.atMs >= fromMs)!.body, "EventID")!;

const nankaiStatus = (h: Harness, status: string) => h.unit("U-N").currents.some((item) =>
  item.operation === "normal" && item.line === "nankai" && "status" in item && item.status === status);
const quakeShown = (h: Harness, eventId: string) => {
  const view = h.root.state.mirror["U-Q"].view;
  return view.unit === "U-Q" && view.earthquakes.some((item) => item.eventId === eventId);
};
const forecastAreas = (h: Harness, subject: string) => h.unit("U-T").forecasts.find((item) => item.subject === subject)?.areas.length ?? -1;

const W1_DAYS = ["2026-06-03", "2026-06-26", "2026-09-21"] as const;
const W2_FAMILIES = ["VPWW55", "VPWW57", "VPWW58", "VPWW59", "VPWW60", "VPWW61", "VPNO50"];
const RANK = ["0", "1", "2", "3", "4", "5-", "5+", "6-", "6+", "7"];
const QUAKE_2011 = Date.parse("2011-03-11T14:46:00+09:00");
const SUBJECT_2011 = "20110311144640";

// N1・N2・N3 の t0: 06-26 の受信が最も多い 1 時間の始まりの 12 時間前（後発をその 1 時間の始まりに置く）。3 筋書きが同じ t0 を使う
// ように、採取物が無ければ 3 つとも blocked にする（既定の t0 は常時の試験だけが自分で決める）。
function t0Of(day: readonly Frame[]): number {
  const counts = new Map<number, number>();
  for (const frame of day) counts.set(jstHour(frame.atMs), (counts.get(jstHour(frame.atMs)) ?? 0) + 1);
  const [busiest] = [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
  return busiest - 12 * HOUR;
}

type Built = Omit<Extract<Scenario, { kind: "ready" }>, "kind" | "id" | "digest" | "synth" | "t0"> & Readonly<{ synthesized: boolean;
  t0?: Extract<Scenario, { kind: "ready" }>["t0"] }>;

function build(id: string, dataDir: string | null, seed: number): Built | "dataMissing" {
  const day = (date: string) => archiveDay(dataDir, date);
  if (id.startsWith("W1:")) {
    const date = id.slice(3);
    const frames = W1_DAYS.some((item) => item === date) ? day(date) : null;
    if (frames == null) return "dataMissing";
    const start = midnight(date);
    // 期待例: 日の終わりに、その日に VPWP50 を出した官署の U-F の subject が全部ある。
    const subjects = new Set(frames.filter((frame) => frame.headType === "VPWP50")
      .map((frame) => `${operationOf(frame.body)}/VPWP50/${textOf(frame.body, "EditorialOffice")}`));
    return { frames, startMs: start, endMs: start + DAY, synthesized: false,
      checkpoints: [6, 12, 18, 24].map((hour) => ({ atMs: start + hour * HOUR, label: `${date} ${hour}:00` })),
      expectations: [{ atMs: start + DAY, label: "VPWP50 の官署の U-F subject が全部ある", check: (h) => {
        const held = new Set(h.unit("U-F").subjects.map((item) => item.subject));
        return [...subjects].every((subject) => held.has(subject));
      } }] };
  }
  if (id === "W2") {
    const days = W1_DAYS.map(day);
    if (days.some((item) => item == null)) return "dataMissing";
    const real = days.flatMap((item) => item!);
    const frames = merge(real, synthesize("W2", seed, { real }));
    // 区切り: 各日の終わりと、鍵（family × 官署、通常）が 128・256・鍵の空間の上界に達した時刻。
    const keys = new Set<string>();
    const reached: Checkpoint[] = [];
    for (const frame of frames) {
      if (!W2_FAMILIES.includes(frame.headType) || operationOf(frame.body) !== "normal") continue;
      const office = textOf(frame.body, "EditorialOffice") ?? "";
      const before = keys.size;
      keys.add(`${frame.headType}\u0000${office}`);
      if (keys.size !== before && (keys.size === 128 || keys.size === 256)) reached.push({ atMs: frame.atMs, label: `keys ${keys.size}` });
    }
    const last = frames.at(-1)!.atMs;
    reached.push({ atMs: last, label: `keys ${keys.size}` });
    return { frames, startMs: midnight(W1_DAYS[0]), endMs: Math.max(last, midnight(W1_DAYS[2]) + DAY), synthesized: true,
      checkpoints: [...W1_DAYS.map((date) => ({ atMs: midnight(date) + DAY, label: `${date} end` })), ...reached],
      // 期待例: 06-03 の U-F の subject が 06-26 に 7 日の回収で消えていても欠けにならない（容量の診断の無い step で消える）。
      expectations: [{ atMs: midnight(W1_DAYS[1]) + DAY, label: "U-F の 7 日の回収は欠けにならない", check: (_h, losses) => losses.every((item) => item.unit !== "U-F") }] };
  }
  if (id === "R1") {
    const days = ["2024-01-01", "2024-01-02"].map(day);
    if (days.some((item) => item == null)) return "dataMissing";
    const real = days.flatMap((item) => item!);
    const frames = merge(real, synthesize("R1", seed, { real }));
    const start = midnight("2024-01-01");
    const at = (iso: string) => Date.parse(`${iso}+09:00`);
    // 本震（1/1 16:10 頃の M7.6）: 1/1 16:00〜16:20 の発生で最大震度の最も大きい EventID。大津波警報: 1/1 16:22 に最も近い VTSE41。
    const quakes = real.filter((frame) => frame.headType === "VXSE53" && operationOf(frame.body) === "normal").map((frame) => {
      const xml = decoder.decode(frame.body);
      return { eventId: textOf(frame.body, "EventID")!, origin: Date.parse(textOf(frame.body, "OriginTime") ?? ""),
        max: /<Observation>[\s\S]*?<MaxInt>([^<]*)<\/MaxInt>/.exec(xml)?.[1] ?? "" };
    }).filter((item) => item.origin >= at("2024-01-01T16:00:00") && item.origin < at("2024-01-01T16:20:00"))
      .sort((a, b) => RANK.indexOf(b.max) - RANK.indexOf(a.max) || a.origin - b.origin);
    const warning = real.filter((frame) => frame.headType === "VTSE41" && operationOf(frame.body) === "normal" && decoder.decode(frame.body).includes("大津波警報"))
      .sort((a, b) => Math.abs(a.atMs - at("2024-01-01T16:22:00")) - Math.abs(b.atMs - at("2024-01-01T16:22:00")))[0];
    const main = quakes[0]?.eventId ?? "", tsunami = warning == null ? "" : `normal/VTSE41/${textOf(warning.body, "EventID")}`;
    return { frames, startMs: start, endMs: start + 2 * DAY, synthesized: true,
      checkpoints: ["2024-01-01T16:20:00", "2024-01-01T17:00:00", "2024-01-01T22:00:00", "2024-01-02T06:00:00", "2024-01-02T12:00:00", "2024-01-03T00:00:00"]
        .map((iso) => ({ atMs: at(iso), label: iso })),
      expectations: [
        { atMs: at("2024-01-02T16:09:00"), label: `本震 ${main} の event が U-Q にある`, check: (h) => h.unit("U-Q").earthquakes.some((item) => item.eventId === main) },
        { atMs: at("2024-01-01T20:00:00"), label: `大津波警報 ${tsunami} が U-T にある`, check: (h) => forecastAreas(h, tsunami) >= 0 },
      ] };
  }
  if (id === "R2" || id === "R2S") {
    const frames = synthesize(id, seed);
    const forecast = `normal/VTSE41/${SUBJECT_2011}`, coastal = `normal/tsunamiObservation:VTSE51/${SUBJECT_2011}`;
    const offshore = `normal/tsunamiObservation:VTSE52/${SUBJECT_2011}`;
    const at = (iso: string) => Date.parse(`${iso}+09:00`);
    const observation = (h: Harness, subject: string) => h.unit("U-T").observations.find((item) => item.subject === subject);
    if (id === "R2S") {
      // T02: 観測の subject は最新の報時刻（VTSE51 15:01・VTSE52 14:55）＋24 時間を過ぎた最初の格子の tick で expired になる。
      const live = (subject: string) => (h: Harness) => observation(h, subject)?.effective === "active";
      const expired = (subject: string) => (h: Harness) => observation(h, subject)?.effective === "expired" && observation(h, subject)?.stations.length === 0;
      return { frames, startMs: QUAKE_2011, endMs: QUAKE_2011 + 30 * HOUR, synthesized: true, checkpoints: [],
        expectations: [
          { atMs: at("2011-03-12T14:54:59"), label: "VTSE52 は期限の 1 秒前に active", check: live(offshore) },
          { atMs: at("2011-03-12T14:55:00"), label: "VTSE52 は期限の格子で expired", check: expired(offshore) },
          { atMs: at("2011-03-12T15:00:59"), label: "VTSE51 は期限の 1 秒前に active", check: live(coastal) },
          { atMs: at("2011-03-12T15:01:00"), label: "VTSE51 は期限の格子で expired", check: expired(coastal) },
        ] };
    }
    return { frames, startMs: QUAKE_2011, endMs: at("2011-03-14T00:00:00"), synthesized: true,
      checkpoints: ["2011-03-11T15:00:00", "2011-03-11T16:00:00", "2011-03-12T03:30:00", "2011-03-12T15:00:00", "2011-03-13T18:00:00", "2011-03-14T00:00:00"]
        .map((iso) => ({ atMs: at(iso), label: iso })),
      expectations: [
        { atMs: at("2011-03-13T07:00:00"), label: "3/12 03:20 の VTSE41（66 区域）が U-T にある", check: (h) => forecastAreas(h, forecast) === 66 },
        // 合成の VTSE51 の版 5 は版 4 の観測点 20102 を落とすが、観測点は累積する（P3-C5-OBS-MERGE）。
        { atMs: at("2011-03-11T16:00:00"), label: "落とした観測点 20102 が残る", check: (h) => observation(h, coastal)?.stations.some((item) => item.code === "20102") === true },
      ] };
  }
  if (id === "N1" || id === "N2" || id === "N3") {
    const weather = day(W1_DAYS[1]);
    if (weather == null) return "dataMissing";
    const t0 = t0Of(weather);
    const origin = { atMs: t0, source: `x-${W1_DAYS[1]} の受信が最も多い 1 時間の始まりの 12 時間前` };
    const synthetic = synthesize(id === "N1" ? "N1" : "N2", seed, { t0Ms: t0 });
    const frames = id === "N3" ? merge(synthetic, weather) : synthetic;
    const e0 = eventIdOf(synthetic, "VXSE51", t0);
    const offsets = (list: readonly number[]) => list.map((offset) => ({ atMs: t0 + offset, label: `t0+${offset / MINUTE}m` }));
    if (id === "N1") return { frames, startMs: t0, endMs: t0 + 48 * HOUR, synthesized: true, t0: origin,
      checkpoints: offsets([10 * MINUTE, HOUR, 6 * HOUR, 12 * HOUR, 24 * HOUR, 48 * HOUR]),
      expectations: [
        { atMs: t0 + 23 * HOUR + 59 * MINUTE, label: "E0 の event が U-Q の view にある", check: (h) => quakeShown(h, e0) },
        { atMs: t0 + 12 * HOUR, label: "E0 の VTSE41 の 66 区域が U-T にある", check: (h) => forecastAreas(h, `normal/VTSE41/${e0}`) === 66 },
        { atMs: t0 + 2 * HOUR + MINUTE, label: "U-N の現況が巨大地震警戒", check: (h) => nankaiStatus(h, "megaquakeWarning") },
      ] };
    const e1 = eventIdOf(synthetic, "VXSE51", t0 + 12 * HOUR);
    return { frames, startMs: t0, endMs: t0 + 8 * DAY, synthesized: true, t0: origin,
      checkpoints: offsets([10 * MINUTE, 2 * HOUR, 12 * HOUR - MINUTE, 12 * HOUR + 10 * MINUTE, 13 * HOUR, 18 * HOUR, 24 * HOUR, 36 * HOUR, 7 * DAY, 8 * DAY]),
      expectations: [
        { atMs: t0 + 12 * HOUR + 10 * MINUTE, label: "E0 と E1 の event が両方 U-Q にある", check: (h) => [e0, e1].every((eventId) =>
          h.unit("U-Q").earthquakes.some((item) => item.eventId === eventId)) },
        { atMs: t0 + 7 * DAY + MINUTE, label: "U-N の現況が巨大地震注意", check: (h) => nankaiStatus(h, "megaquakeAdvisory") },
      ] };
  }
  throw new Error(`unknown scenario ${id}`);
}

// 筋書きの読み手: 筋書きの id と外部の採取物の dir を受け、流す順の frame の列と digest を返す。期待の digest と違えば走らせない。
function readScenario(input: Readonly<{ id: string; dataDir: string | null; expectedDigest: string | null; seed?: number }>): Scenario {
  const seed = input.seed ?? 1;
  const built = build(input.id, input.dataDir, seed);
  if (built === "dataMissing") return { kind: "blocked", id: input.id, reason: "dataMissing", digest: null };
  const digest = digestOf(built.frames);
  if (input.expectedDigest != null && input.expectedDigest !== digest) return { kind: "blocked", id: input.id, reason: "digestMismatch", digest };
  const { synthesized, t0, ...rest } = built;
  return { kind: "ready", id: input.id, digest, ...rest, t0: t0 ?? null,
    synth: synthesized ? { sourceSha256: sha256(readFileSync(SYNTH_SOURCE)), seed } : null };
}

export { readScenario };
export type { Checkpoint, Expectation, Scenario };
