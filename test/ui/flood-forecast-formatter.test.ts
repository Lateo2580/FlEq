import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { displayFloodForecastInfo } from "../../src/ui/flood-forecast-formatter";
import { parseFloodForecast } from "../../src/dmdata/flood-forecast-parser";
import { createMockWsDataMessage } from "../helpers/mock-message";
import { visualWidth } from "../../src/ui/formatter";

const stripAnsi = (s: string) =>
  // eslint-disable-next-line no-control-regex
  s.replace(/\x1b\[[0-9;]*m/g, "");

let logs: string[];
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logs = [];
  logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map((a) => String(a ?? "")).join(" "));
  });
});
afterEach(() => {
  logSpy.mockRestore();
});

function plainOutput(): string {
  return stripAnsi(logs.join("\n"));
}

// 全 18 fixture を smoke test (parse → display) で回す.
// Task 21 (visual gate) で snapshot 化される前段の最小契約: 例外なく完走できること.
const ALL_FIXTURES_SMOKE = [
  "16_01_01_220728_VXKO50.xml",
  "16_02_01_220728_VXKO50.xml",
  "16_02_02_220728_VXKO50.xml",
  "16_03_01_220728_VXKO50.xml",
  "16_04_01_220728_VXKO50.xml",
  "16_05_01_210630_VXKO50.xml",
  "16_06_01_220728_VXKO50.xml",
  "16_07_01_220728_VXKO50.xml",
  "16_10_01_260312_VXKO50.xml",
  "16_11_01_260312_VXKO50.xml",
  "16_11_02_260312_VXKO50.xml",
  "16_12_01_260312_VXKO50.xml",
  "16_14_01_251222_VXKO50.xml",
  "91_01_01_241031_VXSU50.xml",
  "synthetic_VXKO50_cancel.xml",
  "synthetic_VXKO50_correction.xml",
  "synthetic_VXKO50_code31.xml",
  "synthetic_VXSU50_cancel.xml",
];

describe("displayFloodForecastInfo — 全 18 fixture smoke (parse + display 例外なし)", () => {
  for (const f of ALL_FIXTURES_SMOKE) {
    it(`${f} は parse + display が例外なく完走`, () => {
      const info = parseFloodForecast(createMockWsDataMessage(f))!;
      expect(info).not.toBeNull();
      expect(() => displayFloodForecastInfo(info)).not.toThrow();
      // 最低限、なにか出力されている
      expect(logs.length).toBeGreaterThan(0);
    });
  }
});

// Task 21 通し (visual gate 通し): 全 18 fixture の NO_COLOR 出力を snapshot に固定する.
// 微調整は Display Studio で後日 (spec §18 Followup) 行うため、現時点では「現状のテキスト出力」を
// 確定値として保存する。意図しない描画退行があれば snapshot diff で検出可能.
describe("displayFloodForecastInfo — 全 18 fixture NO_COLOR snapshot (Task 21 通し)", () => {
  for (const f of ALL_FIXTURES_SMOKE) {
    it(`${f} の NO_COLOR 出力 snapshot`, () => {
      const info = parseFloodForecast(createMockWsDataMessage(f))!;
      displayFloodForecastInfo(info);
      expect(plainOutput()).toMatchSnapshot();
    });
  }
});

describe("displayFloodForecastInfo — 取消パス (synthetic_VXKO50_cancel)", () => {
  it("取消電文では『この洪水予報は取り消されました』を出力", () => {
    const info = parseFloodForecast(
      createMockWsDataMessage("synthetic_VXKO50_cancel.xml"),
    )!;
    displayFloodForecastInfo(info);
    const out = plainOutput();
    expect(out).toContain("この洪水予報は取り消されました");
    expect(out).toContain(info.headTitle);
  });

  it("取消電文ではフッタに type / publishingOffice が出る", () => {
    const info = parseFloodForecast(
      createMockWsDataMessage("synthetic_VXKO50_cancel.xml"),
    )!;
    displayFloodForecastInfo(info);
    const out = plainOutput();
    expect(out).toContain("VXKO50");
    expect(out).toContain("気象庁");
  });
});

describe("displayFloodForecastInfo — VXKO normal 基本枠 (16_02_01)", () => {
  it("タイトルに infoKind + infoType + severity ラベルが出る", () => {
    const info = parseFloodForecast(
      createMockWsDataMessage("16_02_01_220728_VXKO50.xml"),
    )!;
    displayFloodForecastInfo(info);
    const out = plainOutput();
    expect(out).toContain("指定河川洪水予報");
    expect(out).toContain("発表");
  });

  it("テスト電文のときは『テスト電文』バッジが付く", () => {
    const info = parseFloodForecast(
      createMockWsDataMessage("16_02_01_220728_VXKO50.xml"),
    )!;
    expect(info.isTest).toBe(true);
    displayFloodForecastInfo(info);
    expect(plainOutput()).toContain("テスト電文");
  });

  it("フッタに type と publishingOffice", () => {
    const info = parseFloodForecast(
      createMockWsDataMessage("16_02_01_220728_VXKO50.xml"),
    )!;
    displayFloodForecastInfo(info);
    const out = plainOutput();
    expect(out).toContain("VXKO50");
    expect(out).toContain("気象庁");
  });
});

describe("displayFloodForecastInfo — VXSU 最小 layout (91_01_01) (Task 20d)", () => {
  it("schema=vxsu50 のとき infoKind / headTitle / 警報名が出る", () => {
    const info = parseFloodForecast(
      createMockWsDataMessage("91_01_01_241031_VXSU50.xml"),
    )!;
    displayFloodForecastInfo(info);
    const out = plainOutput();
    expect(out).toContain("水位周知河川に関する情報");
    expect(out).toContain("善川");
  });

  it("VXSU: Headline.kindName (警報名) が出る", () => {
    const info = parseFloodForecast(
      createMockWsDataMessage("91_01_01_241031_VXSU50.xml"),
    )!;
    displayFloodForecastInfo(info);
    const out = plainOutput();
    expect(out).toContain("レベル２氾濫注意報");
  });

  it("VXSU: Headline.headlineText (主旨) が出る", () => {
    const info = parseFloodForecast(
      createMockWsDataMessage("91_01_01_241031_VXSU50.xml"),
    )!;
    displayFloodForecastInfo(info);
    const out = plainOutput();
    expect(out).toContain("氾濫注意水位に到達");
  });

  it("VXSU: 観測所/inundation/雨量予測/氾濫水予報ブロックは出ない", () => {
    const info = parseFloodForecast(
      createMockWsDataMessage("91_01_01_241031_VXSU50.xml"),
    )!;
    displayFloodForecastInfo(info);
    const out = plainOutput();
    expect(out).not.toContain("▸ 観測所");
    expect(out).not.toContain("▸ 浸水想定地区");
    expect(out).not.toContain("▸ 雨量");
    expect(out).not.toContain("▸ 氾濫水の予報");
  });

  it("VXSU: フッタに type と publishingOffice", () => {
    const info = parseFloodForecast(
      createMockWsDataMessage("91_01_01_241031_VXSU50.xml"),
    )!;
    displayFloodForecastInfo(info);
    const out = plainOutput();
    expect(out).toContain("VXSU50");
    expect(out).toContain("気象庁");
  });

  it("synthetic_VXSU50_cancel: 取消パスを通る (displayCancelPath)", () => {
    const info = parseFloodForecast(
      createMockWsDataMessage("synthetic_VXSU50_cancel.xml"),
    )!;
    expect(info.schema).toBe("vxsu50");
    expect(info.infoType).toBe("取消");
    displayFloodForecastInfo(info);
    const out = plainOutput();
    expect(out).toContain("この洪水予報は取り消されました");
  });
});

describe("displayFloodForecastInfo — 氾濫水予報 (Task 20c)", () => {
  it("16_04_01 (Code 53): 氾濫水予報ブロックが出る", () => {
    const info = parseFloodForecast(
      createMockWsDataMessage("16_04_01_220728_VXKO50.xml"),
    )!;
    expect(info.floodAssumptions.length).toBe(5);
    displayFloodForecastInfo(info);
    const out = plainOutput();
    expect(out).toContain("氾濫水");
    expect(out).toContain("○市市役所"); // assumptionAreaName
  });

  it("16_04_01: 氾濫水予報は主文の直後 (観測所より前)", () => {
    const info = parseFloodForecast(
      createMockWsDataMessage("16_04_01_220728_VXKO50.xml"),
    )!;
    displayFloodForecastInfo(info);
    const out = plainOutput();
    const assumptionIdx = out.indexOf("氾濫水");
    const stationIdx = out.indexOf("▸ 観測所");
    expect(assumptionIdx).toBeGreaterThan(-1);
    expect(stationIdx).toBeGreaterThan(-1);
    expect(assumptionIdx).toBeLessThan(stationIdx);
  });

  it("16_12_01: floodAssumptions.length=1 (Code 53 でも assumptions あり)", () => {
    const info = parseFloodForecast(
      createMockWsDataMessage("16_12_01_260312_VXKO50.xml"),
    )!;
    expect(info.floodAssumptions.length).toBe(1);
    displayFloodForecastInfo(info);
    const out = plainOutput();
    expect(out).toContain("本庄市"); // assumptionAreaName
  });

  it("16_02_01: floodAssumptions が空なら block は出ない", () => {
    const info = parseFloodForecast(
      createMockWsDataMessage("16_02_01_220728_VXKO50.xml"),
    )!;
    expect(info.floodAssumptions.length).toBe(0);
    displayFloodForecastInfo(info);
    const out = plainOutput();
    expect(out).not.toContain("▸ 氾濫水");
  });
});

describe("displayFloodForecastInfo — 雨量予測 (Task 20b)", () => {
  it("16_01_01: 流域名 + 48H 累積 + 短時間予測", () => {
    const info = parseFloodForecast(
      createMockWsDataMessage("16_01_01_220728_VXKO50.xml"),
    )!;
    displayFloodForecastInfo(info);
    const out = plainOutput();
    expect(out).toContain("鬼怒川流域");
    expect(out).toContain("220"); // 48H 累積
    expect(out).toContain("50"); // 3H 短時間予測
  });

  it("16_02_01: rainfall block の存在 (label '雨量')", () => {
    const info = parseFloodForecast(
      createMockWsDataMessage("16_02_01_220728_VXKO50.xml"),
    )!;
    displayFloodForecastInfo(info);
    const out = plainOutput();
    expect(out).toContain("雨量");
  });
});

describe("displayFloodForecastInfo — 浸水想定地区 (Task 20a)", () => {
  it("16_01_01: 浸水想定地区 (4 件) が表示される", () => {
    const info = parseFloodForecast(
      createMockWsDataMessage("16_01_01_220728_VXKO50.xml"),
    )!;
    displayFloodForecastInfo(info);
    const out = plainOutput();
    expect(out).toContain("浸水想定");
    expect(out).toContain("○○○水位観測所");
    expect(out).toContain("□□□水位観測所");
  });

  it("16_04_01: variant=氾濫発生情報 のグループ見出しが出る", () => {
    const info = parseFloodForecast(
      createMockWsDataMessage("16_04_01_220728_VXKO50.xml"),
    )!;
    displayFloodForecastInfo(info);
    const out = plainOutput();
    expect(out).toContain("氾濫発生情報");
  });

  it("16_12_01: 33 件すべてが県別グループで表示される (truncation 廃止後)", () => {
    const info = parseFloodForecast(
      createMockWsDataMessage("16_12_01_260312_VXKO50.xml"),
    )!;
    expect(info.inundationAreas.length).toBe(33);
    displayFloodForecastInfo(info);
    const out = plainOutput();
    // Task 2 (2026-06-18) で truncation 廃止: variant → prefName 2 層グループ化 +
    // comma wrapping removes the need for the former first-N cap and omission note.
    // 旧仕様の遺物が出現しないことを negative assertion で確認。
    expect(out).not.toContain("先頭");
    // variant header (◇) と prefecture header (○) は plainOutput で生 char として出現
    expect(out).toContain("◇");
    expect(out).toContain("○");
    // Codex review 2026-06-19 反映: 末尾側 item が描画されていることと、全行 visualWidth が
    // frame width 以内であることを確認 (truncation 廃止後の item 欠落 / overflow 防止)。
    // 末尾 areaName を出力中に検索 (cityName or areaName fallback / prefName prefix 剥がし考慮)
    const lastArea = info.inundationAreas[info.inundationAreas.length - 1];
    const lastDisplayName = lastArea.cityName ?? lastArea.areaName;
    const lastStripped = lastArea.prefName !== "" && lastDisplayName.startsWith(lastArea.prefName)
      ? lastDisplayName.slice(lastArea.prefName.length)
      : lastDisplayName;
    expect(out).toContain(lastStripped);
    // 全行 visualWidth が frame width (60) 以内であることを確認
    const lines = out.split("\n");
    const overlongLines = lines.filter((l) => visualWidth(l) > 60);
    expect(overlongLines).toEqual([]);
  });

  it("16_12_01: 注釈が出ても info.inundationAreas (33) は変異しない", () => {
    const info = parseFloodForecast(
      createMockWsDataMessage("16_12_01_260312_VXKO50.xml"),
    )!;
    const before = info.inundationAreas.length;
    displayFloodForecastInfo(info);
    expect(info.inundationAreas.length).toBe(before);
  });
});

describe("displayFloodForecastInfo — 観測所ブロック (Task 19b)", () => {
  it("16_02_01: 河川名 divider + 観測所名が出る", () => {
    const info = parseFloodForecast(
      createMockWsDataMessage("16_02_01_220728_VXKO50.xml"),
    )!;
    displayFloodForecastInfo(info);
    const out = plainOutput();
    // 観測所名 (3 station 全部)
    expect(out).toContain("○○○水位観測所");
    // 河川名 divider
    expect(out).toContain("○○川");
  });

  it("16_02_01: Criteria L1-L4 の値が出る", () => {
    const info = parseFloodForecast(
      createMockWsDataMessage("16_02_01_220728_VXKO50.xml"),
    )!;
    displayFloodForecastInfo(info);
    const out = plainOutput();
    expect(out).toContain("L1");
    expect(out).toContain("L2");
    expect(out).toContain("L3");
    expect(out).toContain("L4");
    // 実値 (criteria.L2=142.5 等)
    expect(out).toContain("142.5");
  });

  it("16_02_01: 現況値と矢印 (現況 143 / 上昇 = ↗)", () => {
    const info = parseFloodForecast(
      createMockWsDataMessage("16_02_01_220728_VXKO50.xml"),
    )!;
    displayFloodForecastInfo(info);
    const out = plainOutput();
    expect(out).toContain("143");
    expect(out).toContain("↗"); // condition=上昇
  });

  it("16_01_01: 全時刻欠測の station は『全時刻欠測』表示", () => {
    const info = parseFloodForecast(
      createMockWsDataMessage("16_01_01_220728_VXKO50.xml"),
    )!;
    displayFloodForecastInfo(info);
    const out = plainOutput();
    // 旧実装は `?` (value null + condition arrow `?`) だったが、Task 1 で日本語ラベル化
    // (Findings 3-1 #7): allMissing station は `全時刻欠測`、それ以外の value=null cell は
    // `欠測` / `未計算` / `無効` / `不明` の condition 名。
    expect(out).toContain("全時刻欠測");
  });

  it("16_10_01: 複数河川 (緑川/浜戸川/加勢川/御船川) が divider に表示される", () => {
    const info = parseFloodForecast(
      createMockWsDataMessage("16_10_01_260312_VXKO50.xml"),
    )!;
    displayFloodForecastInfo(info);
    const out = plainOutput();
    expect(out).toContain("緑川");
    expect(out).toContain("城南"); // 観測所名
  });
});

describe("displayFloodForecastInfo — 主文ブロック (Task 19a)", () => {
  it("16_02_01: scope=河川 の headlineText の主旨が出る (wrap 込み)", () => {
    const info = parseFloodForecast(
      createMockWsDataMessage("16_02_01_220728_VXKO50.xml"),
    )!;
    displayFloodForecastInfo(info);
    const out = plainOutput();
    // 折り返しに耐える分割 assert
    expect(out).toContain("○○川上流では");
    expect(out).toContain("氾濫危険水位");
  });

  it("16_10_01: scope=河川 の areas (河川名複数) と主文の主旨が出る", () => {
    const info = parseFloodForecast(
      createMockWsDataMessage("16_10_01_260312_VXKO50.xml"),
    )!;
    displayFloodForecastInfo(info);
    const out = plainOutput();
    expect(out).toContain("緑川");
    expect(out).toContain("氾濫のおそれあり");
  });

  it("16_14_01 (解除): scope=河川 の headlineText の主旨が出る", () => {
    const info = parseFloodForecast(
      createMockWsDataMessage("16_14_01_251222_VXKO50.xml"),
    )!;
    displayFloodForecastInfo(info);
    const out = plainOutput();
    expect(out).toContain("常呂川");
    expect(out).toContain("氾濫注意水位を下回る");
  });
});
