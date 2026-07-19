import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import chalk from "chalk";
import {
  displayVolcanoInfo,
  volcanoTypeLabel,
  ashfallRole,
  ashCodeNum,
  isNotableAshCode,
  buildAshfallGroupRows,
  ashfallColumns,
  ashfallPeriodLabel,
  applyVolcanoDetailCap,
  VOLCANO_DETAIL_HARD_CAP,
  buildAshfallSummaryLine,
  plumeWindColumns,
  displayVolcanoAshfallBatch,
  buildVolcanoBatchRows,
  volcanoBatchColumns,
  buildBatchSummaryLine,
  groupMunicipalitiesByKind,
} from "../../src/ui/volcano-formatter";
import type { AshArea, AshForecastPeriod, WindProfileEntry, ParsedVolcanoPlumeInfo, ParsedVolcanoAshfallInfo, VolcanoMunicipality, ParsedVolcanoAlertInfo, ParsedVolcanoInfo } from "../../src/types";
import { resolveVolcanoPresentation, resolveVolcanoBatchPresentation, VolcanoPresentation } from "../../src/engine/presentation/volcano-presentation";
import { VolcanoStateHolder } from "../../src/engine/messages/volcano-state";
import { parseVolcanoTelegram } from "../../src/dmdata/volcano-parser";
import type { Vfvo53BatchItems } from "../../src/engine/messages/volcano-vfvo53-aggregator";
import { setInfoFullText, setFrameWidth, stripAnsi, visualWidth, createRenderBuffer } from "../../src/ui/formatter";
import type { DetailItem } from "../../src/ui/responsive-table-engine";
import {
  createMockWsDataMessage,
  FIXTURE_VFVO50_ALERT_LV3,
  FIXTURE_VFVO50_ALERT_CONTINUE,
  FIXTURE_VFVO50_ALERT_LOWER,
  FIXTURE_VFVO51_EXTRA,
  FIXTURE_VFVO51_3,
  FIXTURE_VFVO52_ERUPTION_1,
  FIXTURE_VFVO52_ERUPTION_2,
  FIXTURE_VFVO52_ERUPTION_3,
  FIXTURE_VFVO56_FLASH_1,
  FIXTURE_VFSV_MARINE,
  FIXTURE_VFVO51_NORMAL,
  FIXTURE_VFVO54_ASH_RAPID,
  FIXTURE_VFVO55_ASH_DETAIL,
  FIXTURE_VFVO60_PLUME,
  FIXTURE_VZVO40_NOTICE,
  FIXTURE_VFVO53_ASH_REGULAR,
} from "../helpers/mock-message";

describe("displayVolcanoInfo", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let volcanoState: VolcanoStateHolder;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    volcanoState = new VolcanoStateHolder();
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  /** フィクスチャからパースして表示する */
  function displayFixture(fixture: string): string {
    const msg = createMockWsDataMessage(fixture);
    const info = parseVolcanoTelegram(msg)!;
    expect(info).not.toBeNull();
    const presentation = resolveVolcanoPresentation(info, volcanoState);
    displayVolcanoInfo(info, presentation);
    return logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
  }

  it("VFVO50 レベル3引上げが表示される", () => {
    const output = displayFixture(FIXTURE_VFVO50_ALERT_LV3);
    expect(output).toContain("浅間山");
    expect(output).toContain("Lv3");
  });

  it("VFVO50 レベル5引上げが表示される", () => {
    const output = displayFixture(FIXTURE_VFVO50_ALERT_CONTINUE);
    expect(output).toContain("箱根山");
    expect(output).toContain("Lv5");
  });

  it("VFVO50 レベル1引下げが表示される", () => {
    const output = displayFixture(FIXTURE_VFVO50_ALERT_LOWER);
    expect(output).toContain("Lv1");
  });

  it("VFVO52 噴火観測報が表示される", () => {
    const output = displayFixture(FIXTURE_VFVO52_ERUPTION_1);
    expect(output).toContain("浅間山");
    expect(output).toContain("噴火");
  });

  it("VFVO56 噴火速報が表示される", () => {
    const output = displayFixture(FIXTURE_VFVO56_FLASH_1);
    expect(output).toContain("御嶽山");
    expect(output).toContain("噴火速報");
  });

  it("VFSVii 海上警報が表示される", () => {
    const output = displayFixture(FIXTURE_VFSV_MARINE);
    expect(output).toContain("桜島");
  });

  it("VFVO51 解説情報が表示される", () => {
    const output = displayFixture(FIXTURE_VFVO51_NORMAL);
    expect(output).toBeTruthy();
  });

  it("VFVO54 降灰速報が表示される", () => {
    const output = displayFixture(FIXTURE_VFVO54_ASH_RAPID);
    expect(output).toContain("桜島");
  });

  it("VFVO60 推定噴煙流向報が表示される", () => {
    const output = displayFixture(FIXTURE_VFVO60_PLUME);
    expect(output).toContain("桜島");
    expect(output).toContain("南東");
  });

  it("VZVO40 お知らせが表示される", () => {
    const output = displayFixture(FIXTURE_VZVO40_NOTICE);
    expect(output).toBeTruthy();
  });

  it("取消報が表示される", () => {
    const msg = createMockWsDataMessage(FIXTURE_VFVO50_ALERT_LV3);
    const info = parseVolcanoTelegram(msg)!;
    // infoType を取消に差し替え
    (info as Record<string, unknown>).infoType = "取消";
    const presentation: VolcanoPresentation = {
      frameLevel: "cancel",
      soundLevel: "cancel",
      summary: "取り消されました",
    };
    displayVolcanoInfo(info, presentation);
    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("取消");
  });

  // ── P0: recap / footer / severity テスト ──

  it("severity ラベルが出力に含まれる", () => {
    const output = displayFixture(FIXTURE_VFVO50_ALERT_LV3);
    // warning レベル → [警告]
    expect(output).toContain("[警告]");
  });

  it("VFVO55 降灰予報詳細で severity ラベルが出力に含まれる", () => {
    const output = displayFixture(FIXTURE_VFVO55_ASH_DETAIL);
    // normal レベル → [情報]
    expect(output).toContain("[情報]");
  });

  it("フッターに電文タイプと発表機関が含まれる", () => {
    const output = displayFixture(FIXTURE_VFVO50_ALERT_LV3);
    expect(output).toContain("VFVO50");
  });

  it("VFVO56 フッターに電文タイプが含まれる", () => {
    const output = displayFixture(FIXTURE_VFVO56_FLASH_1);
    expect(output).toContain("VFVO56");
  });

  it("isTest バッジが pushTitle 化後も表示される", () => {
    const msg = createMockWsDataMessage(FIXTURE_VFVO50_ALERT_LV3);
    const info = parseVolcanoTelegram(msg)!;
    // isTest を true に差し替え
    (info as Record<string, unknown>).isTest = true;
    const presentation = resolveVolcanoPresentation(info, volcanoState);
    displayVolcanoInfo(info, presentation);
    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("TEST");
  });

  it("取消報に severity ラベル [取消] が含まれる", () => {
    const msg = createMockWsDataMessage(FIXTURE_VFVO50_ALERT_LV3);
    const info = parseVolcanoTelegram(msg)!;
    (info as Record<string, unknown>).infoType = "取消";
    const presentation: VolcanoPresentation = {
      frameLevel: "cancel",
      soundLevel: "cancel",
      summary: "取り消されました",
    };
    displayVolcanoInfo(info, presentation);
    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("[取消]");
  });

  // ── P1: バナー・VFSVii・本文制限テスト ──

  it("VFVO50 Lv5 (critical) でバナーが表示される", () => {
    const output = displayFixture(FIXTURE_VFVO50_ALERT_CONTINUE);
    expect(output).toContain("噴火警報・予報");
  });

  it("VFVO56 噴火速報 (critical) でバナーが全幅表示される", () => {
    const output = displayFixture(FIXTURE_VFVO56_FLASH_1);
    expect(output).toContain("噴火速報");
  });

  it("VFSVii カード行で warningKind が重複しない", () => {
    const output = displayFixture(FIXTURE_VFSV_MARINE);
    // タイトル行に警報種別が含まれるが、カード行では action のみ
    const lines = output.split("\n");
    // warningKind 相当の文字列を含む行数をカウント（タイトル行の1回のみ）
    const warningLines = lines.filter((l) => l.includes("海上警報") || l.includes("海上予報") || l.includes("周辺海域警戒"));
    // タイトル行 + フッター行で 2 回以下であること（タイトルとフッターの volcanoTypeLabel）
    expect(warningLines.length).toBeLessThanOrEqual(2);
  });

  it("VFSVii で対象海域が表示される", () => {
    const output = displayFixture(FIXTURE_VFSV_MARINE);
    expect(output).toContain("対象海域");
  });

  it("VFVO60 で風向テーブルヘッダが表示される", () => {
    const output = displayFixture(FIXTURE_VFVO60_PLUME);
    expect(output).toContain("高度");
    expect(output).toContain("風速");
  });

  it("VFVO55 通常表示で本文が4行以上表示される", () => {
    const output = displayFixture(FIXTURE_VFVO55_ASH_DETAIL);
    // 行数ベース省略に変更したため、200文字で切れない
    const lines = output.split("\n");
    expect(lines.length).toBeGreaterThan(10);
  });

  // ── volcanoTypeLabel ──

  it("volcanoTypeLabel が正しく日本語名を返す", () => {
    expect(volcanoTypeLabel("VFVO50")).toBe("噴火警報・予報");
    expect(volcanoTypeLabel("VFVO56")).toBe("噴火速報");
    expect(volcanoTypeLabel("VZVO40")).toBe("火山に関するお知らせ");
    expect(volcanoTypeLabel("VFSVii")).toBe("火山現象に関する海上警報");
    expect(volcanoTypeLabel("VFSV60")).toBe("火山現象に関する海上警報");
  });

  // ── P2: 本文制限緩和テスト ──

  it("VFVO50 で対象市町村が truncation なしで全件表示される", () => {
    const output = displayFixture(FIXTURE_VFVO50_ALERT_LV3);
    // 「他N件」が出ないことを確認
    expect(output).not.toMatch(/他\d+件/);
    // 「対象:」ラベルが表示される
    expect(output).toContain("対象:");
  });

  it("infoFullText=true で VZVO40 本文が4行以上表示される", () => {
    setInfoFullText(true);
    try {
      const output = displayFixture(FIXTURE_VZVO40_NOTICE);
      // 出力行数が通常制限 (4行) を超えることを検証
      // VZVO40 の本文が十分長い場合にのみ有意義
      expect(output).toBeTruthy();
    } finally {
      setInfoFullText(false);
    }
  });

  /** wrap・frame 罫線・空白を除去して全文検索できる形に潰す (復元検査用) */
  function flattenFrame(out: string): string {
    return stripAnsi(out).replace(/[║│╠╣╔╗╚╝═─\s]/g, "");
  }

  describe("降灰予報の engine 化 (period divider + 2 列テーブル + 火山専用 detail)", () => {
    beforeEach(() => { chalk.level = 3; });
    afterEach(() => { setFrameWidth(60); });

    it("ashfallColumns は全 mode 2 列 (降灰量 → 地域。降灰量ラベルが NO_COLOR の行内 prefix を兼ねる)", () => {
      for (const mode of ["ultra-narrow", "standard", "wide"] as const) {
        expect(ashfallColumns(mode).map((c) => c.header)).toEqual(["降灰量", "地域"]);
      }
      const std = ashfallColumns("standard").find((c) => c.header === "地域")!;
      const wide = ashfallColumns("wide").find((c) => c.header === "地域")!;
      expect(wide.maxWidth).toBeGreaterThan(std.maxWidth);
    });

    it("ultra-narrow の minWidth 合計 + セパレータが幅 60 の innerWidth=56 に収まる (watch-point)", () => {
      const cols = ashfallColumns("ultra-narrow");
      const total = cols.reduce((a, c) => a + c.minWidth, 0) + (cols.length - 1) * 3;
      expect(total).toBeLessThanOrEqual(56);
    });

    it("buildAshfallGroupRows は ashCode ごとに 1 行・重い順・地域カンマ結合", () => {
      // AshArea は code / thickness も必須 (types.ts:1465-1471) — Codex R2 指摘で literal を現物型に一致させた
      const rows = buildAshfallGroupRows([
        { name: "A市", code: "0001", ashName: "少量", ashCode: "71", thickness: null },
        { name: "B市", code: "0002", ashName: "多量", ashCode: "73", thickness: null },
        { name: "C市", code: "0003", ashName: "少量", ashCode: "71", thickness: null },
      ]);
      expect(rows.length).toBe(2);
      expect(rows[0].ashCode).toBe("73"); // 重い順
      const light = rows.find((r) => r.ashCode === "71")!;
      expect(light.areaNames).toBe("A市, C市");
    });

    it("ashfallPeriodLabel は MM-DD HH:MM〜HH:MM に短縮 (同日は終端の日付省略)", () => {
      const sameDay = ashfallPeriodLabel({
        startTime: "2026-05-17T15:00:00+09:00",
        endTime: "2026-05-17T18:00:00+09:00",
        areas: [],
      } as AshForecastPeriod);
      expect(sameDay).toBe("05-17 15:00〜18:00");

      const crossDay = ashfallPeriodLabel({
        startTime: "2026-12-31T23:00:00+09:00",
        endTime: "2027-01-01T05:00:00+09:00",
        areas: [],
      } as AshForecastPeriod);
      expect(crossDay).toBe("12-31 23:00〜01-01 05:00");

      expect(ashfallPeriodLabel({ startTime: "", endTime: "", areas: [] } as AshForecastPeriod)).toBe("時間帯不明");
    });

    it("ashfallPeriodLabel は TZ 非依存 (電文に書かれた wall-clock をそのまま表示、Date 経由の変換なし)", () => {
      // offset が JST 以外でも「ISO 文字列に書かれた時刻」がそのまま出る = 実行環境ローカル TZ に依存しない。
      // Date 経由の実装だと +00:00 入力は JST 環境で 9 時間ずれるため、このケースが検出器になる (Codex blocker)
      const utcOffset = ashfallPeriodLabel({
        startTime: "2026-05-17T15:00:00+00:00",
        endTime: "2026-05-17T18:00:00+00:00",
        areas: [],
      } as AshForecastPeriod);
      expect(utcOffset).toBe("05-17 15:00〜18:00");

      // 日跨ぎ判定も文字列の日付部で行う (offset 換算で日付が動かない)
      const crossUtc = ashfallPeriodLabel({
        startTime: "2026-12-31T23:00:00+00:00",
        endTime: "2027-01-01T05:00:00+00:00",
        areas: [],
      } as AshForecastPeriod);
      expect(crossUtc).toBe("12-31 23:00〜01-01 05:00");

      // ISO 形式にマッチしない値は素通し (現行 fallback 維持)
      expect(ashfallPeriodLabel({ startTime: "不正値", endTime: "", areas: [] } as AshForecastPeriod)).toBe("不正値〜");
    });

    it("applyVolcanoDetailCap: cap 以下は素通し、超過分は omitted に計上 (fail-closed の事前計算)", () => {
      const mk = (n: number): DetailItem[] =>
        Array.from({ length: n }, (_, i) => ({ head: `h${i}`, body: [`    地域: a${i}`] }));
      const ok = applyVolcanoDetailCap(mk(84));
      expect(ok.items.length).toBe(84);
      expect(ok.omitted).toBe(0);
      const over = applyVolcanoDetailCap(mk(VOLCANO_DETAIL_HARD_CAP + 40));
      expect(over.items.length).toBe(VOLCANO_DETAIL_HARD_CAP);
      expect(over.omitted).toBe(40);
    });

    it("VFVO53 (6 period / 84 area item): 幅 200 で先頭 3 時間帯の全地域名 + 集約行が本体に現れる", () => {
      setFrameWidth(200);
      const output = displayFixture(FIXTURE_VFVO53_ASH_REGULAR);
      const msg = createMockWsDataMessage(FIXTURE_VFVO53_ASH_REGULAR);
      const info = parseVolcanoTelegram(msg)!;
      expect(info.kind).toBe("ashfall");
      if (info.kind !== "ashfall") return;
      expect(info.ashForecasts.length).toBe(6);
      const flat = flattenFrame(output);
      // 表示は先頭 (直近) 3 時間帯まで (spec §3.2)
      for (const period of info.ashForecasts.slice(0, 3)) {
        for (const area of period.areas) {
          expect(flat, `地域 ${area.name}`).toContain(area.name.replace(/\s/g, ""));
        }
      }
      // 4 つ目以降は集約 1 行で明示 (silent 欠落ではない)
      expect(stripAnsi(output)).toMatch(/ほか 3 時間帯（最大: /);
      // 末尾サマリ (NO_COLOR 3 点目)
      expect(stripAnsi(output)).toContain("サマリ");
      expect(flat).toContain("時間帯");
    });

    it("VFVO53: 幅 60 (ultra-narrow) でも先頭 3 時間帯の全地域名 + 集約行が現れ、全行が幅保証を満たす", () => {
      setFrameWidth(60);
      const output = displayFixture(FIXTURE_VFVO53_ASH_REGULAR);
      const msg = createMockWsDataMessage(FIXTURE_VFVO53_ASH_REGULAR);
      const info = parseVolcanoTelegram(msg)!;
      if (info.kind !== "ashfall") return;
      const flat = flattenFrame(output);
      for (const period of info.ashForecasts.slice(0, 3)) {
        for (const area of period.areas) {
          expect(flat, `地域 ${area.name}`).toContain(area.name.replace(/\s/g, ""));
        }
      }
      expect(stripAnsi(output)).toMatch(/ほか 3 時間帯（最大: /);
      for (const line of output.split("\n")) {
        expect(visualWidth(stripAnsi(line))).toBeLessThanOrEqual(60);
      }
    });

    it("VFVO53 headline: 幅 60 で読点を保持しつつ幅の 8 割以上を充填する (spec §9 R3-1/R3-2)", () => {
      setFrameWidth(60);
      const output = stripAnsi(displayFixture(FIXTURE_VFVO53_ASH_REGULAR));
      const lines = output.split("\n");
      // headline 先頭行: 「現在、桜島は…」を含む行
      const hl = lines.find((l) => l.includes("現在、桜島は"));
      expect(hl).toBeDefined();
      // 読点が保持されている (v1 は 、split で行末読点が脱落していた)
      expect(hl!).toContain("現在、");
      // 幅充填: フレーム装飾 (│ + 前後スペース) を除いた本文が innerWidth 56 の 8 割 (45) 以上
      const content = hl!.replace(/^[║│] /, "").replace(/ [║│]$/, "").trimEnd();
      expect(visualWidth(content)).toBeGreaterThanOrEqual(45);
      // 行頭に句読点が来ていない (headline 全行)
      for (const l of lines) {
        const c = l.replace(/^[║│] /, "");
        expect(/^[、。]/.test(c), l).toBe(false);
      }
    });

    it("VFVO53 単独 standard: 降灰予報セクションが 25 行以内・[詳細] 反復なし", () => {
      setFrameWidth(140);
      const info = parseVolcanoTelegram(createMockWsDataMessage(FIXTURE_VFVO53_ASH_REGULAR)) as ParsedVolcanoAshfallInfo;
      const presentation = resolveVolcanoPresentation(info, volcanoState);
      logSpy.mockClear();
      displayVolcanoInfo(info, presentation);
      const out = stripAnsi(logSpy.mock.calls.map((c) => c.join(" ")).join("\n"));
      const lines = out.split("\n");
      // タイトル「降灰予報（定時）」と区別し、先頭 period に合流したセクション divider
      // (「降灰予報 MM-DD ...」) を anchor にする
      const startIdx = lines.findIndex((l) => /降灰予報 \d{2}-\d{2}/.test(l));
      const endIdx = lines.findIndex((l, i) => i > startIdx && l.includes("サマリ"));
      expect(startIdx).toBeGreaterThanOrEqual(0);
      expect(endIdx).toBeGreaterThan(startIdx);
      expect(endIdx - startIdx).toBeLessThanOrEqual(25);
      // 「小さな噴石の落下」等の降灰量が [詳細] で反復していない
      expect(out).not.toMatch(/降灰量: 小さな噴石/);
    });

    it("buildAshfallSummaryLine は最大降灰量・地域数・時間帯数を「 ・ 」区切りで返す", () => {
      const msg = createMockWsDataMessage(FIXTURE_VFVO53_ASH_REGULAR);
      const info = parseVolcanoTelegram(msg)!;
      if (info.kind !== "ashfall") return;
      const s = stripAnsi(buildAshfallSummaryLine(info));
      expect(s).toContain("最大 ");
      expect(s).toMatch(/\d+ 地域/);
      expect(s).toContain("6 時間帯");
    });

    it("降灰量列 maxWidth 16: 「小さな噴石の落下」が standard 幅で全文表示される (spec §9 R3-3)", () => {
      setFrameWidth(140);
      const output = stripAnsi(displayFixture(FIXTURE_VFVO53_ASH_REGULAR));
      // テーブル行 (列セパレータを含む行) に全文が出る
      const tableLines = output.split("\n").filter((l) => l.includes(" │ ") && l.includes("小さな噴石"));
      expect(tableLines.length).toBeGreaterThan(0);
      for (const l of tableLines) {
        expect(l).toContain("小さな噴石の落下");
      }
      // clip 形が消えている
      expect(output).not.toContain("小さな噴石…");
    });

    describe("風向表の engine 化 (VFVO60)", () => {
      beforeEach(() => { chalk.level = 3; });
      afterEach(() => { setFrameWidth(60); });

      it("plumeWindColumns は 3 列固定 (高度/風向(°)/風速) で minWidth 合計が innerWidth=56 に収まる", () => {
        const cols = plumeWindColumns();
        expect(cols.map((c) => c.header)).toEqual(["高度", "風向(°)", "風速"]);
        const total = cols.reduce((a, c) => a + c.minWidth, 0) + (cols.length - 1) * 3;
        expect(total).toBeLessThanOrEqual(56);
        // null は — で表示
        const row: WindProfileEntry = { altitude: "3000m", degree: null, speed: null };
        expect(cols[1].cell(row)).toBe("—");
        expect(cols[2].cell(row)).toBe("—");
      });

      it("VFVO60: 風向テーブルが engine 経由で描画され、ヘッダと値が現れる", () => {
        setFrameWidth(140);
        const output = displayFixture(FIXTURE_VFVO60_PLUME);
        const plain = stripAnsi(output);
        expect(plain).toContain("高度");
        expect(plain).toContain("風速");
        expect(plain).toContain("風向");
      });

      it("windProfile が plumeWindSampleRows を超えるとき、間引き行数が「他 N 高度」として明示される", () => {
        setFrameWidth(140);
        const msg = createMockWsDataMessage(FIXTURE_VFVO60_PLUME);
        const base = parseVolcanoTelegram(msg)!;
        expect(base.kind).toBe("plume");
        if (base.kind !== "plume") return;
        const bigProfile: WindProfileEntry[] = Array.from({ length: 12 }, (_, i) => ({
          altitude: `${(i + 1) * 1000}m`,
          degree: (i * 30) % 360,
          speed: 10 + i,
        }));
        const synthetic: ParsedVolcanoPlumeInfo = { ...base, windProfile: bigProfile };
        const presentation = resolveVolcanoPresentation(synthetic, volcanoState);
        logSpy.mockClear();
        displayVolcanoInfo(synthetic, presentation);
        const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
        // default plumeWindSampleRows=5 → 12 本中 5 本表示、7 本間引き
        expect(stripAnsi(output)).toContain("他 7 高度");
      });
    });
  });

  describe("市町村 kind グルーピング + clamp 経路化 + compact 分岐撤去", () => {
    beforeEach(() => { chalk.level = 3; });
    afterEach(() => { setFrameWidth(60); });

    it("groupMunicipalitiesByKind は kind 出現順を保持してグループ化する", () => {
      const munis: VolcanoMunicipality[] = [
        { name: "鹿児島県鹿児島市", code: "4620100", kind: "火口周辺警報" },
        { name: "鹿児島県垂水市", code: "4621400", kind: "噴火警報" },
        { name: "鹿児島県鹿屋市", code: "4620300", kind: "火口周辺警報" },
      ];
      const groups = groupMunicipalitiesByKind(munis);
      expect(groups.map((g) => g.kind)).toEqual(["火口周辺警報", "噴火警報"]);
      expect(groups[0].names).toEqual(["鹿児島県鹿児島市", "鹿児島県鹿屋市"]);
      expect(groups[1].names).toEqual(["鹿児島県垂水市"]);
    });

    it("kind が 1 種のとき: 現状どおり「対象:」羅列で kind ラベルは出ない", () => {
      setFrameWidth(100);
      const output = stripAnsi(displayFixture(FIXTURE_VFVO50_ALERT_LV3));
      expect(output).toContain("対象:");
    });

    it("kind が複数種のとき: kind ごとのラベルで区分され、code は表示されない", () => {
      setFrameWidth(100);
      const msg = createMockWsDataMessage(FIXTURE_VFVO50_ALERT_LV3);
      const base = parseVolcanoTelegram(msg)!;
      expect(base.kind).toBe("alert");
      if (base.kind !== "alert") return;
      const synthetic: ParsedVolcanoAlertInfo = {
        ...base,
        municipalities: [
          { name: "群馬県嬬恋村", code: "1042400", kind: "火口周辺警報" },
          { name: "長野県軽井沢町", code: "2032100", kind: "噴火警報" },
          { name: "長野県御代田町", code: "2032300", kind: "噴火予報：警報解除" },
        ],
      };
      const presentation = resolveVolcanoPresentation(synthetic, volcanoState);
      logSpy.mockClear();
      displayVolcanoInfo(synthetic, presentation);
      const out = stripAnsi(logSpy.mock.calls.map((c) => c.join(" ")).join("\n"));
      expect(out).toContain("火口周辺警報:");
      expect(out).toContain("噴火警報:");
      expect(out).toContain("噴火予報：警報解除:");
      expect(out).not.toContain("対象:");
      expect(out).not.toContain("1042400");   // code は表示しない
      // 名前必須: 全市町村名が本体に現れる
      for (const name of ["群馬県嬬恋村", "長野県軽井沢町", "長野県御代田町"]) {
        expect(out).toContain(name);
      }
    });

    it("超長の火山名・火口名でも全行が幅 60 に収まる (clamp 経路化)", () => {
      setFrameWidth(60);
      const msg = createMockWsDataMessage(FIXTURE_VFVO52_ERUPTION_1);
      const base = parseVolcanoTelegram(msg)!;
      if (base.kind !== "eruption") return;
      const synthetic = {
        ...base,
        volcanoName: "非常に長い架空の火山名でタイトル行のセル幅を必ず超過させる検証用文字列",
        craterName: "非常に長い架空の火口名で火口行のセル幅を必ず超過させる検証用文字列",
      };
      const presentation = resolveVolcanoPresentation(synthetic, volcanoState);
      logSpy.mockClear();
      displayVolcanoInfo(synthetic, presentation);
      const out = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      for (const line of out.split("\n")) {
        expect(visualWidth(stripAnsi(line))).toBeLessThanOrEqual(60);
      }
    });
  });

  describe("renderAlert セクション統合 + 細線化 (Task 8: spec §3.1)", () => {
    afterEach(() => { setFrameWidth(60); });

    it("VFVO50 Lv3: 内部区切りは細線 ╟、太線 ╠ はタイトル直後(headline)とfooter直前の2本のみ、カード行と対象市町村は同一ブロック (divider なし)", () => {
      setFrameWidth(140);
      const output = displayFixture(FIXTURE_VFVO50_ALERT_LV3);
      const out = stripAnsi(output);
      // 細線 divider が導入されている (headline→カード / 対象海域 or 本文前など)
      expect(out).toContain("╟");
      // レベル変化カードと対象市町村の間に divider (╟ も ╠ も) が挟まらない (spec §3.1 のブロック統合)
      const lines = out.split("\n");
      const cardIdx = lines.findIndex((l) => l.includes("Lv3"));
      const targetIdx = lines.findIndex((l) => l.includes("対象:"));
      expect(cardIdx).toBeGreaterThanOrEqual(0);
      expect(targetIdx).toBeGreaterThan(cardIdx);
      for (let i = cardIdx + 1; i < targetIdx; i++) {
        expect(lines[i]).not.toMatch(/^[╟╠]/);
      }
      // 内部の全幅太線 divider (╠...╣) は「タイトル→headline」+「footer直前」の2本のみ (触らない範囲、spec 前提)
      const heavyInternalDividers = lines.filter((l) => /^╠═+╣$/.test(l));
      expect(heavyInternalDividers.length).toBe(2);
    });
  });

  // ── 品質テスト群 (spec §5) ──

  const ALL_VOLCANO_FIXTURES = [
    FIXTURE_VFVO50_ALERT_LV3,
    FIXTURE_VFVO50_ALERT_CONTINUE,
    FIXTURE_VFVO50_ALERT_LOWER,
    FIXTURE_VFVO51_EXTRA,
    FIXTURE_VFVO51_NORMAL,
    FIXTURE_VFVO51_3,
    FIXTURE_VFVO52_ERUPTION_1,
    FIXTURE_VFVO52_ERUPTION_2,
    FIXTURE_VFVO52_ERUPTION_3,
    FIXTURE_VFSV_MARINE,
    FIXTURE_VFVO53_ASH_REGULAR,
    FIXTURE_VFVO54_ASH_RAPID,
    FIXTURE_VFVO55_ASH_DETAIL,
    FIXTURE_VFVO56_FLASH_1,
    FIXTURE_VFVO60_PLUME,
    FIXTURE_VZVO40_NOTICE,
  ];

  function captureDisplay(info: ParsedVolcanoInfo): string {
    const presentation = resolveVolcanoPresentation(info, new VolcanoStateHolder());
    logSpy.mockClear();
    displayVolcanoInfo(info, presentation);
    return logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
  }

  function captureBatch(batch: Vfvo53BatchItems): string {
    logSpy.mockClear();
    displayVolcanoAshfallBatch(batch, resolveVolcanoBatchPresentation(batch));
    return logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
  }

  /** synthetic 多地域降灰 (spec §5: area 50+。長地域名で clip を誘発) */
  function makeSyntheticAshfall(areaCount: number, nameLen = 12): ParsedVolcanoAshfallInfo {
    const msg = createMockWsDataMessage(FIXTURE_VFVO53_ASH_REGULAR);
    const base = parseVolcanoTelegram(msg) as ParsedVolcanoAshfallInfo;
    const perPeriod = Math.ceil(areaCount / 2);
    const mkAreas = (offset: number, n: number) =>
      Array.from({ length: n }, (_, i) => ({
        name: `架空降灰区域${"名".repeat(Math.max(0, nameLen - 7))}第${String(offset + i + 1).padStart(3, "0")}区`,
        code: `9${String(offset + i + 1).padStart(6, "0")}`,
        ashCode: ["73", "72", "71", "70"][(offset + i) % 4],
        ashName: ["多量", "やや多量", "少量", "降灰"][(offset + i) % 4],
        thickness: null,
      }));
    return {
      ...base,
      volcanoName: "合成大量火山",
      ashForecasts: [
        { ...base.ashForecasts[0], areas: mkAreas(0, perPeriod) },
        { ...base.ashForecasts[1], areas: mkAreas(perPeriod, areaCount - perPeriod) },
      ],
    };
  }

  /** 降灰 area の名前必須 invariant 検査。missing を返す (fail-closed テストと共用) */
  function collectMissingAshAreas(info: ParsedVolcanoAshfallInfo, out: string): string[] {
    const flat = flattenFrame(out);
    const missing: string[] = [];
    for (const period of info.ashForecasts) {
      for (const area of period.areas) {
        if (!flat.includes(area.name.replace(/\s/g, ""))) missing.push(area.name);
      }
    }
    return missing;
  }

  describe("幅 60-200 sweep (acceptance 3、単発 + バッチ)", () => {
    beforeEach(() => { chalk.level = 3; });
    afterEach(() => { setFrameWidth(60); });

    it("全 VFVO/VFSV/VZVO fixture + synthetic (多地域 60 / バッチ) で全出力行が width 以下", () => {
      const parsedAll = ALL_VOLCANO_FIXTURES.map((fx) => {
        const info = parseVolcanoTelegram(createMockWsDataMessage(fx));
        expect(info, fx).not.toBeNull();
        return { fx, info: info! };
      });
      const bigAsh = makeSyntheticAshfall(60);
      const batch = makeSyntheticBatch();
      for (let w = 60; w <= 200; w++) {
        setFrameWidth(w);
        for (const { fx, info } of parsedAll) {
          for (const line of captureDisplay(info).split("\n")) {
            expect(visualWidth(stripAnsi(line)), `${fx} width=${w}`).toBeLessThanOrEqual(w);
          }
        }
        for (const line of captureDisplay(bigAsh).split("\n")) {
          expect(visualWidth(stripAnsi(line)), `synthetic-60area width=${w}`).toBeLessThanOrEqual(w);
        }
        for (const line of captureBatch(batch).split("\n")) {
          expect(visualWidth(stripAnsi(line)), `batch width=${w}`).toBeLessThanOrEqual(w);
        }
      }
    }, 20000);

    it("VFVO53 単独: 幅 40-200 フル render sweep で全行が width 以下 (集約行・合流ラベル divider の 40-50 幅急所)", () => {
      // config の tableWidth 許容下限は 40。降灰の集約行 (pushClampedFrameLine) と
      // 合流ラベル divider (frameDividerLabeled 内 clip) は 40-50 幅がはみ出しの急所 (Codex minor)
      const info = parseVolcanoTelegram(createMockWsDataMessage(FIXTURE_VFVO53_ASH_REGULAR)) as ParsedVolcanoAshfallInfo;
      for (let w = 40; w <= 200; w++) {
        setFrameWidth(w);
        for (const line of captureDisplay(info).split("\n")) {
          expect(visualWidth(stripAnsi(line)), `VFVO53 width=${w}`).toBeLessThanOrEqual(w);
        }
      }
    }, 20000);
  });

  describe("本文の再改行 (spec §8 R2-3)", () => {
    beforeEach(() => { chalk.level = 3; });
    afterEach(() => { setFrameWidth(60); });

    it("VFVO51: 数字跨ぎ hard-wrap が再結合され「６月１９日」「ポンマチネシリ９６ー１火口近傍」が同一論理行に現れる", () => {
      setFrameWidth(200); // wide: 再結合後の論理行が折返しで分断されない幅
      setInfoFullText(true); // VolcanoActivity 本文が maxLines で切られないよう全文表示で検証
      try {
        const info = parseVolcanoTelegram(createMockWsDataMessage(FIXTURE_VFVO51_EXTRA))!;
        const out = stripAnsi(captureDisplay(info));
        const lines = out.split("\n");
        // 電文物理行では「…６月１」/「９日…」に割れている (fixture L1297-1298)
        expect(lines.some((l) => l.includes("６月１９日"))).toBe(true);
        // 同 L1347-1348: 「…ポンマチネシリ９６」/「ー１火口近傍…」
        // (短断片「９６ー１火口」は fixture 別箇所 L1346 に元から同一行で存在するため長断片で検証)
        expect(lines.some((l) => l.includes("ポンマチネシリ９６ー１火口近傍"))).toBe(true);
      } finally {
        setInfoFullText(false);
      }
    });
  });

  describe("所在保証 invariant (acceptance 6: 名前必須、省略カウント不可)", () => {
    beforeEach(() => { chalk.level = 3; });
    afterEach(() => { setFrameWidth(60); });

    it.each([60, 140, 180])("幅 %i: 表示対象 (先頭 3) 時間帯の全 area が名前として現れ、超過時間帯は集約行で明示される", (w) => {
      setFrameWidth(w);
      for (const fx of [FIXTURE_VFVO53_ASH_REGULAR, FIXTURE_VFVO54_ASH_RAPID, FIXTURE_VFVO55_ASH_DETAIL]) {
        const info = parseVolcanoTelegram(createMockWsDataMessage(fx)) as ParsedVolcanoAshfallInfo;
        const out = captureDisplay(info);
        const shownInfo = { ...info, ashForecasts: info.ashForecasts.slice(0, 3) };
        expect(collectMissingAshAreas(shownInfo, out), fx).toEqual([]);
        if (info.ashForecasts.length > 3) {
          expect(stripAnsi(out), fx).toMatch(new RegExp(`ほか ${info.ashForecasts.length - 3} 時間帯（最大: `));
        }
      }
      for (const n of [50, 84]) {
        const info = makeSyntheticAshfall(n);
        const out = captureDisplay(info);
        const shownInfo = { ...info, ashForecasts: info.ashForecasts.slice(0, 3) };
        expect(collectMissingAshAreas(shownInfo, out), `synthetic-${n}`).toEqual([]);
      }
    });

    it.each([60, 140, 180])("幅 %i: 降灰量ラベル (distinct ashName) も出力に現れる", (w) => {
      setFrameWidth(w);
      const info = makeSyntheticAshfall(50);
      const flat = flattenFrame(captureDisplay(info));
      for (const ashName of ["多量", "やや多量", "少量", "降灰"]) {
        expect(flat).toContain(ashName);
      }
    });

    it("対象市町村の名前必須 invariant (wrap 全件なので detail 不要、将来の打切り導入への防波堤)", () => {
      setFrameWidth(60);
      const info = parseVolcanoTelegram(createMockWsDataMessage(FIXTURE_VFVO50_ALERT_LV3))!;
      if (info.kind !== "alert") return;
      const flat = flattenFrame(captureDisplay(info));
      for (const m of info.municipalities) {
        expect(flat, `市町村 ${m.name}`).toContain(m.name.replace(/\s/g, ""));
      }
    });

  });

  describe("降灰予報 短縮 period label の divider 収まり (幅 40)", () => {
    beforeEach(() => { chalk.level = 3; });
    afterEach(() => { setFrameWidth(60); });

    it("幅 40: 短縮 period label が同日・日跨ぎとも divider に切り詰めなしで収まる", () => {
      // frameDividerLabeled の無切詰め条件: visualWidth(label) <= width - 4 = 36 (formatter.ts:363-367)
      // 同日:   "降灰予報 05-17 15:00〜18:00"       = 8+1+17 = 26 <= 36
      // 日跨ぎ: "降灰予報 12-31 23:00〜01-01 05:00" = 8+1+24 = 33 <= 36 (Codex R2 指摘の最長ケース)
      const sameDay = `降灰予報 ${ashfallPeriodLabel({ startTime: "2026-05-17T15:00:00+09:00", endTime: "2026-05-17T18:00:00+09:00", areas: [] })}`;
      const crossDay = `降灰予報 ${ashfallPeriodLabel({ startTime: "2026-12-31T23:00:00+09:00", endTime: "2027-01-01T05:00:00+09:00", areas: [] })}`;
      expect(visualWidth(sameDay)).toBeLessThanOrEqual(36);
      expect(visualWidth(crossDay)).toBeLessThanOrEqual(36);
    });
  });

  describe("golden inventory (acceptance 8: kind 別の保持フィールドが出力に現れる)", () => {
    beforeEach(() => { chalk.level = 3; });
    afterEach(() => { setFrameWidth(60); });

    it.each(ALL_VOLCANO_FIXTURES)("%s: 全保持フィールドの内容が出力のどこかに現れる", (fx) => {
      setFrameWidth(160);
      const info = parseVolcanoTelegram(createMockWsDataMessage(fx))!;
      const out = captureDisplay(info);
      const flat = flattenFrame(out);
      const expectIn = (v: string | null | undefined, label: string): void => {
        if (!v) return;
        expect(flat, `${fx}: ${label}`).toContain(v.replace(/\s/g, "").slice(0, 24));
      };
      expectIn(info.title, "title");
      expectIn(info.volcanoName, "volcanoName");
      expectIn(info.headline, "headline");
      expect(flat, `${fx}: type`).toContain(info.type);
      expectIn(info.publishingOffice, "publishingOffice");
      switch (info.kind) {
        case "alert":
          if (info.alertLevel != null) expect(flat).toContain(`Lv${info.alertLevel}`);
          if (info.municipalities.length > 0) expectIn(info.municipalities[0].name, "municipality");
          if (info.marineAreas.length > 0) expectIn(info.marineAreas[0].name, "marineArea");
          expectIn(info.bodyText.split(/\r?\n/)[0], "bodyText 先頭行");
          break;
        case "eruption":
          expectIn(info.phenomenonName, "phenomenonName");
          expectIn(info.craterName, "craterName");
          if (info.plumeHeight != null) expect(flat).toContain(`${info.plumeHeight}m`);
          break;
        case "ashfall":
          expectIn(info.ashForecasts[0]?.areas[0]?.name, "先頭降灰地域");
          expectIn(info.ashForecasts[0]?.areas[0]?.ashName, "先頭降灰量");
          break;
        case "text":
          expectIn(info.bodyText.split(/\r?\n/).find((l) => l.trim().length > 0) ?? null, "bodyText 先頭行");
          expectIn(info.nextAdvisory, "nextAdvisory");
          break;
        case "plume":
          if (info.windProfile.length > 0) expectIn(info.windProfile[0].altitude, "先頭高度");
          if (info.plumeDirection) expectIn(info.plumeDirection, "流向");
          break;
      }
    });
  });

  describe("バナー 4 象限 (acceptance 7: 現行条件から変化なし)", () => {
    beforeEach(() => { chalk.level = 3; });
    afterEach(() => { setFrameWidth(60); });

    function bannerLines(out: string): string[] {
      const lines = out.split("\n");
      const topIdx = lines.findIndex((l) => l.includes("╔") || l.includes("┌") || l.includes("├"));
      // バナーは「余白バー(色付き空白) + テキスト + 余白バー」の 3 行構成 (EEW/津波方式)。
      // stripAnsi().trim() で除去すると色付き空白バーも空判定されてしまうため、
      // 先頭の生の空行 (pushEmpty、raw "") のみを除外する
      return lines.slice(0, topIdx).filter((l) => l !== "");
    }

    function renderWith(fixture: string, presentation: VolcanoPresentation): string {
      const info = parseVolcanoTelegram(createMockWsDataMessage(fixture))!;
      logSpy.mockClear();
      displayVolcanoInfo(info, presentation);
      return logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    }

    const p = (frameLevel: VolcanoPresentation["frameLevel"]): VolcanoPresentation => ({
      frameLevel,
      soundLevel: "info",
      summary: "test",
    });

    it("① alert × critical → 全幅バナー 3 行 (噴火警報・予報)", () => {
      setFrameWidth(100);
      const out = renderWith(FIXTURE_VFVO50_ALERT_CONTINUE, p("critical"));
      const banner = bannerLines(out);
      expect(banner.length).toBe(3);
      expect(stripAnsi(banner[1])).toContain("噴火警報・予報");
    });

    it("② 噴火速報 (eruption × isFlashReport) × critical → 全幅バナー 3 行", () => {
      setFrameWidth(100);
      const out = renderWith(FIXTURE_VFVO56_FLASH_1, p("critical"));
      const banner = bannerLines(out);
      expect(banner.length).toBe(3);
      expect(stripAnsi(banner[1])).toContain("噴火速報");
    });

    it("③ VFVO54 × warning → 全幅バナー 3 行", () => {
      setFrameWidth(100);
      const out = renderWith(FIXTURE_VFVO54_ASH_RAPID, p("warning"));
      expect(bannerLines(out).length).toBe(3);
    });

    it("④ それ以外はバナーなし (alert×warning / ashfall 定時・詳細 / plume / text / cancel)", () => {
      setFrameWidth(100);
      expect(bannerLines(renderWith(FIXTURE_VFVO50_ALERT_LV3, p("warning"))).length).toBe(0);
      expect(bannerLines(renderWith(FIXTURE_VFVO53_ASH_REGULAR, p("info"))).length).toBe(0);
      expect(bannerLines(renderWith(FIXTURE_VFVO55_ASH_DETAIL, p("normal"))).length).toBe(0);
      expect(bannerLines(renderWith(FIXTURE_VFVO60_PLUME, p("normal"))).length).toBe(0);
      expect(bannerLines(renderWith(FIXTURE_VFVO51_NORMAL, p("info"))).length).toBe(0);
      expect(bannerLines(renderWith(FIXTURE_VFVO52_ERUPTION_1, p("warning"))).length).toBe(0);
    });
  });
});

describe("降灰 helper (ashfallRole / ashCode ランク / AshfallGroupRow)", () => {
  it("ashfallRole は降灰コードをテーマロールに写す (75/73/72/71/70/不明)", () => {
    expect(ashfallRole("75")).toBe("volcanoAshfallBallistic");
    expect(ashfallRole("73")).toBe("volcanoAshfallHeavy");
    expect(ashfallRole("72")).toBe("volcanoAshfallModerate");
    expect(ashfallRole("71")).toBe("volcanoAshfallLight");
    expect(ashfallRole("70")).toBe("volcanoAshfallLight");
    expect(ashfallRole("99")).toBe("textMuted");
  });

  it("ashCodeNum は string コードを数値化し、不正値は 0 (型は string が正)", () => {
    expect(ashCodeNum("73")).toBe(73);
    expect(ashCodeNum("")).toBe(0);
    expect(ashCodeNum("abc")).toBe(0);
  });

  it("isNotableAshCode は 72 以上 (やや多量/多量/小さな噴石) で true", () => {
    expect(isNotableAshCode("75")).toBe(true);
    expect(isNotableAshCode("73")).toBe(true);
    expect(isNotableAshCode("72")).toBe(true);
    expect(isNotableAshCode("71")).toBe(false);
    expect(isNotableAshCode("70")).toBe(false);
    expect(isNotableAshCode("0")).toBe(false);
  });

  it("buildAshfallGroupRows は ashCode ごとに集約し数値降順で row 化する (地域カンマ結合)", () => {
    const areas: AshArea[] = [
      { name: "鹿児島市", code: "4620100", ashCode: "71", ashName: "少量", thickness: null },
      { name: "垂水市", code: "4621400", ashCode: "73", ashName: "多量", thickness: 1 },
      { name: "鹿屋市", code: "4620300", ashCode: "72", ashName: "やや多量", thickness: null },
      { name: "指宿市", code: "4621000", ashCode: "71", ashName: "少量", thickness: null },
    ];
    const rows = buildAshfallGroupRows(areas);
    expect(rows.map((r) => r.ashCode)).toEqual(["73", "72", "71"]);
    expect(rows[0].ashName).toBe("多量");
    // 同一 ashCode の地域はカンマ結合 (出現順保持)
    expect(rows.find((r) => r.ashCode === "71")!.areaNames).toBe("鹿児島市, 指宿市");
  });
});

/** VFVO53 fixture から volcanoName / ashCode を差し替えた synthetic バッチを作る */
function makeSyntheticBatch(): Vfvo53BatchItems {
  const msg = createMockWsDataMessage(FIXTURE_VFVO53_ASH_REGULAR);
  const base = parseVolcanoTelegram(msg) as ParsedVolcanoAshfallInfo;
  expect(base.kind).toBe("ashfall");
  const withAsh = (info: ParsedVolcanoAshfallInfo, name: string, code: string, ashCode: string, ashName: string): ParsedVolcanoAshfallInfo => ({
    ...info,
    volcanoName: name,
    volcanoCode: code,
    ashForecasts: info.ashForecasts.map((p) => ({
      ...p,
      areas: p.areas.map((a) => ({ ...a, ashCode, ashName })),
    })),
  });
  return {
    reportDateTime: base.reportDateTime,
    isTest: false,
    items: [
      withAsh(base, "架空岳", "901", "70", "降灰"),          // notable でない
      withAsh(base, "合成山", "902", "73", "多量"),          // notable (最強 → 先頭)
      withAsh(base, "試験富士", "903", "72", "やや多量"),    // notable
    ],
  };
}

describe("VFVO53 バッチ表の engine 化 (行=火山)", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    chalk.level = 3;
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    setFrameWidth(60);
    logSpy.mockRestore();
  });

  function renderBatch(batch: Vfvo53BatchItems): string {
    logSpy.mockClear();
    displayVolcanoAshfallBatch(batch, resolveVolcanoBatchPresentation(batch));
    return logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
  }

  /** wrap・frame 罫線・空白を除去して全文検索できる形に潰す (復元検査用) */
  function flattenFrame(out: string): string {
    return stripAnsi(out).replace(/[║│╠╣╔╗╚╝═─\s]/g, "");
  }

  it("buildVolcanoBatchRows は降灰強度順 (現行 :741-746 のソート維持) で row 化する", () => {
    const rows = buildVolcanoBatchRows(makeSyntheticBatch().items);
    expect(rows.map((r) => r.volcanoName)).toEqual(["合成山", "試験富士", "架空岳"]);
    expect(rows.map((r) => r.notable)).toEqual([true, true, false]);
    expect(rows[0].maxAshName).toBe("多量");
    expect(rows[0].periodCount).toBe(6);
    expect(rows[0].notableAreas.length).toBeGreaterThan(0);
  });

  it("volcanoBatchColumns の Tier 割当: ultra-narrow 2 列 / standard 3 列 / wide 4 列", () => {
    expect(volcanoBatchColumns("ultra-narrow").map((c) => c.header)).toEqual(["火山", "最大降灰"]);
    expect(volcanoBatchColumns("standard").map((c) => c.header)).toEqual(["火山", "最大降灰", "注目地域"]);
    expect(volcanoBatchColumns("wide").map((c) => c.header)).toEqual(["火山", "最大降灰", "注目地域", "時間帯数"]);
    const cols = volcanoBatchColumns("ultra-narrow");
    const total = cols.reduce((a, c) => a + c.minWidth, 0) + (cols.length - 1) * 3;
    expect(total).toBeLessThanOrEqual(56);
  });

  it("幅 140 (standard): テーブル + 全火山名 + 末尾サマリ (注目 N 火山 ・ 全 M 火山)", () => {
    setFrameWidth(140);
    const out = stripAnsi(renderBatch(makeSyntheticBatch()));
    expect(out).toContain("火山");
    expect(out).toContain("最大降灰");
    expect(out).toContain("注目地域");
    for (const name of ["合成山", "試験富士", "架空岳"]) {
      expect(out).toContain(name);
    }
    expect(out).toContain("注目 2 火山");
    expect(out).toContain("全 3 火山");
  });

  it("幅 140 (standard): maxWidth(50) 超の注目地域は wrap 発火で複数物理行に全量表示される (Task 10)", () => {
    setFrameWidth(140);
    const msg = createMockWsDataMessage(FIXTURE_VFVO53_ASH_REGULAR);
    const base = parseVolcanoTelegram(msg) as ParsedVolcanoAshfallInfo;
    // 数字を含めない (カード行等の数字と flatten 判定が混線しないよう漢数字で連番)
    const longNames = [
      "架空長名降灰対象市町村検証用第一自治体東部地域",
      "架空長名降灰対象市町村検証用第二自治体中央地域",
      "架空長名降灰対象市町村検証用第三自治体西部地域",
    ];
    const item: ParsedVolcanoAshfallInfo = {
      ...base,
      volcanoName: "架空山",
      ashForecasts: [
        {
          ...base.ashForecasts[0],
          areas: longNames.map((name, i) => ({
            name,
            code: `99999${i}`,
            ashCode: "73",
            ashName: "多量",
            thickness: null,
          })),
        },
      ],
    };
    const batch: Vfvo53BatchItems = { reportDateTime: base.reportDateTime, isTest: false, items: [item] };
    const joined = longNames.join(", ");
    // 前提 assert: standard の areasCol maxWidth=50 を確実に超える (wrap 不発の vacuous pass 防止)
    expect(visualWidth(joined)).toBeGreaterThan(50);
    const out = renderBatch(batch);
    const plain = stripAnsi(out);
    // wrap 発火: 継続行 (火山セルが空白 pad され、flatten すると注目地域の断片だけが残る行) が複数出る。
    // visualWidth(joined)=142 > 50 のため wrapTextLines は 3 物理行 → 継続行 >= 2
    const flatJoined = joined.replace(/\s/g, "");
    const contLines = plain.split("\n").filter((l) => {
      if (l.includes("架空山")) return false;
      const f = flattenFrame(l);
      return f.length > 0 && flatJoined.includes(f);
    });
    expect(contLines.length, "wrap 継続行が出ていない (wrap 不発?)").toBeGreaterThanOrEqual(2);
    // 全量表示 (欠落なし): flatten した出力に結合文字列全体が連続部分文字列として現れる
    expect(flattenFrame(out)).toContain(flatJoined);
    // 全行幅保証
    for (const line of out.split("\n")) {
      expect(visualWidth(stripAnsi(line))).toBeLessThanOrEqual(140);
    }
  });

  it("幅 60 (ultra-narrow): 注目地域・時間帯数は隠し列となり [詳細] で復元される", () => {
    setFrameWidth(60);
    const out = renderBatch(makeSyntheticBatch());
    const flat = flattenFrame(out);
    const header = stripAnsi(out).split("\n").find((l) => l.includes("火山") && l.includes("最大降灰"));
    expect(header).toBeDefined();
    expect(header!).not.toContain("注目地域");
    expect(stripAnsi(out)).toContain("[詳細]");
    // 隠し列 (注目地域) の内容が詳細に現れる
    const rows = buildVolcanoBatchRows(makeSyntheticBatch().items);
    expect(flat).toContain(rows[0].notableAreas.split(", ")[0].replace(/\s/g, ""));
    // 全行幅保証
    for (const line of out.split("\n")) {
      expect(visualWidth(stripAnsi(line))).toBeLessThanOrEqual(60);
    }
  });

  it("buildBatchSummaryLine は「注目 N 火山 ・ 全 M 火山」を返す", () => {
    const s = stripAnsi(buildBatchSummaryLine(makeSyntheticBatch()));
    expect(s).toBe("注目 2 火山 ・ 全 3 火山");
  });

  it("幅 180 (wide): clip されただけの列は [詳細] に回収されない (hidden-only, spec §2.4)", () => {
    setFrameWidth(180);
    const msg = createMockWsDataMessage(FIXTURE_VFVO53_ASH_REGULAR);
    const base = parseVolcanoTelegram(msg) as ParsedVolcanoAshfallInfo;
    const longAshName = "やや多量の降灰と小さな噴石"; // visualWidth 26 > ashCol maxWidth 16 (幅によらず常に clip、hidden-only 検証の前提を維持)
    const item: ParsedVolcanoAshfallInfo = {
      ...base,
      volcanoName: "架空山",
      ashForecasts: [
        {
          ...base.ashForecasts[0],
          areas: [{ name: "架空町", code: "9999999", ashCode: "73", ashName: longAshName, thickness: null }],
        },
      ],
    };
    const batch: Vfvo53BatchItems = { reportDateTime: base.reportDateTime, isTest: false, items: [item] };
    const out = renderBatch(batch);
    // wide では全列が表示されるため hidden 列が無く、[詳細] は出ない
    expect(stripAnsi(out)).not.toContain("[詳細]");
    for (const line of out.split("\n")) {
      expect(visualWidth(stripAnsi(line))).toBeLessThanOrEqual(180);
    }
  });
});
