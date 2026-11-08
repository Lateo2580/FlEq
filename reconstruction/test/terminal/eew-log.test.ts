import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SubjectOutcome } from "../../contracts/p2-shared-runtime.types";
import { createEewLog } from "../../src/terminal/eew-log";
import { eewUnits } from "./terminal-fixture";

// 期待の文は旧築の EewEventLogger が同じ fixture で書いた file の中身（2026-11-03 に旧築の src を esbuild で束ね、
// telegram-parser の parseEewTelegram → EewTracker.update → logReport・closeEvent〔process-eew と同じ順〕→ closeAll で 1 回作った）。
// 時刻（記録開始の地方時、ブロックの書いた時刻）は環境の TZ と書いた時刻で変わるので、両方を伏せて比べる。
const LEGACY_CANCEL = `=== 緊急地震速報 EventID: 20240417231454 ===
記録開始: 2024-04-17 23:14:59
--- 第1報 (警報) 13:31:09 ---
震源: 豊後水道
  発生: 2024-04-17 23:14:48
  座標: N33.2 E132.4
M5.8  深さ30km
震度変化理由: 不明 [0]
最大予測震度: 5-
最大予測長周期階級: 1
  注記: {Lx=長周期階級, P=PLUM, A=主要動到達}
  震度5-: 愛媛県南予{L0,A}
  震度4: 高知県西部{L0}, 大分県南部{L0}, 大分県中部{L1}, 愛媛県中予{L0}, 大分県北部{L0}, 愛媛県東予{L0}, 山口県東部{L0}
  震度3〜4: 広島県南西部{L0}
--- 第2報 (取消) 13:31:09 ---
この地震についての緊急地震速報は取り消されました。

--- 記録終了 (取消) 13:31:09 ---
`;
const LEGACY_SERIES = `=== 緊急地震速報 EventID: 20240417231454 ===
記録開始: 2024-04-17 23:14:57
--- 第1報 (予報) 13:31:09 ---
震源: 豊後水道
  発生: 2024-04-17 23:14:47
  座標: N33.1 E132.4
M4.2  深さ40km
最大予測震度: 3
最大予測長周期階級: 0
--- 第3報 (予報) 13:31:09 ---
震源: 豊後水道
  発生: 2024-04-17 23:14:48
  座標: N33.2 E132.4
M5.1  深さ30km
変化:  [M4.2→M5.1, 40km→30km, 震度3→4]
震度変化理由: 不明 [0]
最大予測震度: 4
最大予測長周期階級: 0
  注記: {Lx=長周期階級, P=PLUM, A=主要動到達}
  震度4: 愛媛県南予{L0,A}
--- 第4報 (警報) 13:31:09 ---
震源: 豊後水道
  発生: 2024-04-17 23:14:48
  座標: N33.2 E132.4
M5.8  深さ30km
変化:  [M5.1→M5.8, 震度4→5-]
震度変化理由: 不明 [0]
最大予測震度: 5-
最大予測長周期階級: 1
  注記: {Lx=長周期階級, P=PLUM, A=主要動到達}
  震度5-: 愛媛県南予{L0,A}
  震度4: 高知県西部{L0}, 大分県南部{L0}, 大分県中部{L1}, 愛媛県中予{L0}, 大分県北部{L0}, 愛媛県東予{L0}, 山口県東部{L0}
  震度3〜4: 広島県南西部{L0}
--- 第5報 (警報) 13:31:09 ---
震源: 豊後水道
  発生: 2024-04-17 23:14:47
  座標: N33.2 E132.4
M5.9  深さ40km
変化:  [M5.8→M5.9, 30km→40km]
震度変化理由: 不明 [0]
最大予測震度: 5-
最大予測長周期階級: 1
  注記: {Lx=長周期階級, P=PLUM, A=主要動到達}
  震度5-: 愛媛県南予{L0,A}
  震度4: 高知県西部{L0}, 大分県南部{L0}, 大分県中部{L1}, 愛媛県中予{L0}, 大分県北部{L0}, 愛媛県東予{L0}, 山口県東部{L0}, 宮崎県北部平野部{L0}, 広島県南西部{L0}
  震度3〜4: 山口県中部{L0}, 広島県北部{L0}
--- 第26報 (警報) 13:31:09 ---
震源: 豊後水道
  発生: 2024-04-17 23:14:47
  座標: N33.2 E132.4
M6.7  深さ50km
変化:  [M5.9→M6.7, 40km→50km, 震度5-→6-]
震度変化理由: 不明 [0]
最大予測震度: 6-
最大予測長周期階級: 2
  注記: {Lx=長周期階級, P=PLUM, A=主要動到達}
  震度6-: 愛媛県南予{L1}
  震度5-〜5+: 大分県南部{L1,A}, 愛媛県中予{L0,A}
  震度5+: 高知県西部{L1}
  震度5-: 大分県中部{L2,A}, 宮崎県北部平野部{L1}
  震度4〜5-: 大分県北部{L1,A}, 愛媛県東予{L0,A}, 山口県東部{L1,A}, 広島県南西部{L1,A}
  震度4: 高知県中部{L1,A}, 大分県西部{L1,A}, 山口県中部{L0,A}, 熊本県阿蘇{L1,A}, 宮崎県北部山沿い{L0,A}, 高知県東部{L1,A}, 山口県西部{L0,A}, 福岡県北九州{L0,A}, 島根県西部{L0,A}, 熊本県熊本{L1,A}, 広島県南東部{L0,A}, 広島県北部{L0,A}, 山口県北部{L0,A}, 福岡県筑豊{L0,A}, 福岡県筑後{L1,A}, 宮崎県南部平野部{L0,A}, 岡山県南部{L0,A}, 香川県西部{L0,A}, 徳島県南部{L0,A}, 香川県東部{L0,A}, 福岡県福岡{L0,A}, 佐賀県南部{L1,A}, 長崎県島原半島{L0}, 熊本県天草・芦北{L0}, 鹿児島県薩摩{L1}, 佐賀県北部{L0}
  震度3〜4: 宮崎県南部山沿い{L0,A}, 長崎県南西部{L0}, 岡山県北部{L0}, 鳥取県西部{L1}
  震度3: 徳島県北部{L1,A}, 熊本県球磨{L1,A}, 島根県東部{L1,A}, 大阪府南部{L1}

--- 記録終了 (シャットダウン) 13:31:09 ---
`;
const masked = (text: string): string => text.replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/g, "<datetime>").replace(/\d{2}:\d{2}:\d{2}/g, "<time>");

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
// 試験の時計は止める（同じ秒）。
function logOf(enabled = true) {
  const directory = mkdtempSync(join(tmpdir(), "fleq-eew-log-"));
  directories.push(directory);
  const logs = join(directory, "eew-logs");
  const log = createEewLog({ directory: logs, enabled, fields: {}, clock: () => ({ wallTimeMs: Date.UTC(2026, 10, 3, 12, 0, 0), monotonicMs: 0 }) });
  const files = (): string[] => { try { return readdirSync(logs).sort().map((name) => readFileSync(join(logs, name), "utf8")); } catch { return []; } };
  return { log, files };
}
const subjects = (paths: readonly string[]): SubjectOutcome[] => eewUnits(paths).flat().flatMap((unit) => unit.kind === "eew" ? [unit.subject] : []);
const SERIES = ["77_01_01_240613_VXSE45.xml", "77_01_03_240613_VXSE45.xml", "77_01_04_240613_VXSE45.xml", "77_01_05_240613_VXSE45.xml", "77_01_26_240613_VXSE45.xml"];

describe("P3-TO-T16 EEW ログ（spec §7、AC15）", () => {
  it("取消と続報の file の中身が旧築と同じで、取消のブロックに震源と仮定震源の印が無く、取消の後の報は見出しから", async () => {
    const cancel = logOf();
    const [first, cancelled] = subjects(["37_01_01_240613_VXSE43.xml", "37_01_03_240613_VXSE43.xml"]);
    cancel.log.record(first);
    cancel.log.record(cancelled);
    await cancel.log.close();
    expect(cancel.files().map(masked)).toEqual([masked(LEGACY_CANCEL)]);
    expect(cancel.files()[0].split("--- 第2報 (取消)")[1]).not.toMatch(/震源/);
    // 記録終了の後に同じ EventID の報が来たら、見出しから書く（同じ秒なので同じ file に追記で続く）。
    expect(masked(cancel.files()[0]).endsWith("--- 記録終了 (取消) <time> ---\n")).toBe(true);
    const again = logOf();
    again.log.record(first);
    again.log.record(cancelled);
    again.log.record(first);
    await again.log.close();
    expect(again.files()[0].split("=== 緊急地震速報 EventID: 20240417231454 ===")).toHaveLength(3);

    const series = logOf();
    for (const subject of subjects(SERIES)) series.log.record(subject);
    await series.log.close();
    expect(series.files().map(masked)).toEqual([masked(LEGACY_SERIES)]);
  });

  it("eewLog が off の間は file を作らない", async () => {
    const off = logOf(false);
    for (const subject of subjects(SERIES)) off.log.record(subject);
    await off.log.close();
    expect(off.files()).toEqual([]);
  });

  it("64 件より多い EventID で表から外した EventID の続報は、同じ path に見出しから追記し、前の中身を残す", async () => {
    const many = logOf();
    const [report] = subjects(["77_01_01_240613_VXSE45.xml"]);
    const withEvent = (eventId: string): SubjectOutcome => ({ ...report, facts: { ...report.facts, eventId } });
    for (let index = 0; index <= 64; index += 1) many.log.record(withEvent(`2024041723${String(index).padStart(4, "0")}`));
    // 報は数秒おきに届く。書き込みが進んでから続報を流す（同時に積むと、鎖の上限で始めていない書き込みを捨てる、AC15 (3)）。
    await vi.waitFor(() => { expect(many.files()).toHaveLength(65); }, { timeout: 10_000 });
    many.log.record(withEvent("20240417230000"));
    await vi.waitFor(() => { expect(many.files()[0].split("=== 緊急地震速報 EventID: 20240417230000 ===")).toHaveLength(3); }, { timeout: 10_000 });
    await many.log.close();
    expect(many.files()[0].split("--- 第1報 (予報)")).toHaveLength(3);
    expect(many.log.dropped()).toBe(0);
  });

  // 実不具合の再発防止（r0 のレビュー）: EventID ごとの鎖と待ちの列では続報が待ちを追い越し、上限も鎖の数にしか効かなかった。
  it("書き込みが終わらない間に 2 つの EventID の報を 70 件積むと、受けた順に書き、始めていない書き込みは 64 件で古い 5 件を捨てて数える", async () => {
    const written: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const log = createEewLog({ directory: "unused", enabled: true, fields: {}, clock: () => ({ wallTimeMs: 0, monotonicMs: 0 }),
      append: async (_path, data) => { written.push(/第(\d+)報/.exec(data)?.[1] ?? "close"); await gate; } });
    const [report] = subjects(["77_01_01_240613_VXSE45.xml"]);
    for (let index = 0; index < 70; index += 1) {
      log.record({ ...report, facts: { ...report.facts, serial: index, eventId: index % 2 === 0 ? "20240417230000" : "20240417230001" } });
    }
    expect([written, log.dropped()]).toEqual([["0"], 5]);
    release();
    // 始めた 0 番は最後まで書き、1〜5 番を捨て、6〜69 番を受けた順に書く。
    await vi.waitFor(() => { expect(written).toEqual(["0", ...Array.from({ length: 64 }, (_, index) => String(index + 6))]); });
    await log.close();
    expect([written.slice(65), log.dropped()]).toEqual([["close", "close"], 5]);
  });
});
