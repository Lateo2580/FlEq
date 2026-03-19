import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { EewEventLogger } from "../../src/engine/eew/eew-logger";
import { EewUpdateResult } from "../../src/engine/eew/eew-tracker";
import { ParsedEewInfo } from "../../src/types";

/** テスト用の ParsedEewInfo を生成する */
function createEewInfo(overrides: Partial<ParsedEewInfo> = {}): ParsedEewInfo {
  return {
    type: "VXSE45",
    infoType: "発表",
    title: "緊急地震速報（地震動予報）",
    reportDateTime: "2024-04-17T23:14:57+09:00",
    headline: null,
    publishingOffice: "気象庁",
    serial: "1",
    eventId: "20240417231454",
    earthquake: {
      originTime: "2024-04-17T23:14:47+09:00",
      hypocenterName: "豊後水道",
      latitude: "N33.1",
      longitude: "E132.4",
      depth: "40km",
      magnitude: "4.2",
    },
    forecastIntensity: {
      areas: [
        { name: "愛媛県", intensity: "3" },
        { name: "大分県", intensity: "3" },
      ],
    },
    isAssumedHypocenter: false,
    isTest: false,
    isWarning: false,
    ...overrides,
  };
}

function createUpdateResult(
  overrides: Partial<EewUpdateResult> = {}
): EewUpdateResult {
  return {
    isNew: true,
    isDuplicate: false,
    isCancelled: false,
    activeCount: 1,
    ...overrides,
  };
}

describe("EewEventLogger", () => {
  let tmpDir: string;
  let logger: EewEventLogger;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eew-logger-test-"));
    logger = new EewEventLogger(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("logReport", () => {
    it("第1報でログファイルを作成する", async () => {
      const info = createEewInfo({ serial: "1", eventId: "ev001" });
      const result = createUpdateResult({ isNew: true });

      logger.logReport(info, result);
      await logger.flush();

      const files = fs.readdirSync(tmpDir);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/^eew_ev001_\d{8}_\d{6}\.log$/);

      const content = fs.readFileSync(path.join(tmpDir, files[0]), "utf-8");
      expect(content).toContain("=== 緊急地震速報 EventID: ev001 ===");
      expect(content).toContain("第1報 (予報)");
      expect(content).toContain("震源: 豊後水道");
      expect(content).toContain("M4.2");
      expect(content).toContain("深さ40km");
      expect(content).toContain("最大予測震度: 3");
      expect(content).toContain("愛媛県");
    });

    it("続報を同一ファイルに追記する", async () => {
      const info1 = createEewInfo({ serial: "1", eventId: "ev002" });
      const result1 = createUpdateResult({ isNew: true });
      logger.logReport(info1, result1);

      const info2 = createEewInfo({
        serial: "2",
        eventId: "ev002",
        earthquake: {
          originTime: "2024-04-17T23:14:47+09:00",
          hypocenterName: "豊後水道",
          latitude: "N33.1",
          longitude: "E132.4",
          depth: "35km",
          magnitude: "4.5",
        },
      });
      const result2 = createUpdateResult({
        isNew: false,
        diff: { previousMagnitude: "4.2", previousDepth: "40km" },
      });
      logger.logReport(info2, result2);
      await logger.flush();

      const files = fs.readdirSync(tmpDir);
      expect(files).toHaveLength(1);

      const content = fs.readFileSync(path.join(tmpDir, files[0]), "utf-8");
      expect(content).toContain("第1報 (予報)");
      expect(content).toContain("第2報 (予報)");
      expect(content).toContain("M4.2→M4.5");
      expect(content).toContain("40km→35km");
    });

    it("警報を正しく記録する", async () => {
      const info = createEewInfo({
        serial: "1",
        eventId: "ev003",
        isWarning: true,
      });
      const result = createUpdateResult({ isNew: true });
      logger.logReport(info, result);
      await logger.flush();

      const files = fs.readdirSync(tmpDir);
      const content = fs.readFileSync(path.join(tmpDir, files[0]), "utf-8");
      expect(content).toContain("第1報 (警報)");
    });

    it("仮定震源要素ではMと深さを出力しない", async () => {
      const info = createEewInfo({
        serial: "3",
        eventId: "ev003a",
        isAssumedHypocenter: true,
        earthquake: {
          originTime: "2024-04-17T23:14:47+09:00",
          hypocenterName: "test-hypocenter",
          latitude: "N33.1",
          longitude: "E132.4",
          depth: "10km",
          magnitude: "1.0",
        },
      });
      const result = createUpdateResult({ isNew: true });
      logger.logReport(info, result);
      await logger.flush();

      const files = fs.readdirSync(tmpDir);
      const content = fs.readFileSync(path.join(tmpDir, files[0]), "utf-8");
      expect(content).toContain("仮定震源要素");
      expect(content).not.toContain("M1.0");
      expect(content).not.toContain("深さ10km");
    });

    it("取消報を記録する", async () => {
      const info = createEewInfo({
        serial: "5",
        eventId: "ev004",
        infoType: "取消",
        earthquake: undefined,
        forecastIntensity: undefined,
      });
      const result = createUpdateResult({ isNew: false, isCancelled: true });

      // まず第1報を作成
      const info1 = createEewInfo({ serial: "1", eventId: "ev004" });
      logger.logReport(info1, createUpdateResult({ isNew: true }));

      // 取消報を追記
      logger.logReport(info, result);
      await logger.flush();

      const files = fs.readdirSync(tmpDir);
      const content = fs.readFileSync(path.join(tmpDir, files[0]), "utf-8");
      expect(content).toContain("第5報 (取消)");
      expect(content).toContain("取り消されました");
    });
  });

  describe("nextAdvisory (最終報)", () => {
    it("最終報テキストがログに含まれる", async () => {
      const info = createEewInfo({
        serial: "10",
        eventId: "ev-final",
        nextAdvisory: "この情報をもって、緊急地震速報：最終報とします。",
      });
      const result = createUpdateResult({ isNew: true });
      logger.logReport(info, result);
      await logger.flush();

      const files = fs.readdirSync(tmpDir);
      const content = fs.readFileSync(path.join(tmpDir, files[0]), "utf-8");
      expect(content).toContain("この情報をもって、緊急地震速報：最終報とします。");
    });
  });

  describe("closeEvent", () => {
    it("記録終了行を追記する", async () => {
      const info = createEewInfo({ serial: "1", eventId: "ev005" });
      logger.logReport(info, createUpdateResult({ isNew: true }));

      logger.closeEvent("ev005", "取消");
      await logger.flush();

      const files = fs.readdirSync(tmpDir);
      const content = fs.readFileSync(path.join(tmpDir, files[0]), "utf-8");
      expect(content).toContain("記録終了 (取消)");
    });

    it("存在しない eventId では何もしない", () => {
      // エラーが発生しないことを確認
      logger.closeEvent("nonexistent", "タイムアウト");
    });
  });

  describe("closeAll", () => {
    it("全アクティブイベントを閉じる", async () => {
      const info1 = createEewInfo({ serial: "1", eventId: "ev006" });
      const info2 = createEewInfo({ serial: "1", eventId: "ev007" });
      logger.logReport(info1, createUpdateResult({ isNew: true }));
      logger.logReport(info2, createUpdateResult({ isNew: true }));

      logger.closeAll();
      await logger.flush();

      const files = fs.readdirSync(tmpDir).sort();
      expect(files).toHaveLength(2);

      for (const file of files) {
        const content = fs.readFileSync(path.join(tmpDir, file), "utf-8");
        expect(content).toContain("記録終了 (シャットダウン)");
      }
    });
  });

  describe("逐次書き込み", () => {
    it("各報が即座にファイルに反映される", async () => {
      const eventId = "ev008";
      const info1 = createEewInfo({ serial: "1", eventId });
      logger.logReport(info1, createUpdateResult({ isNew: true }));
      await logger.flush();

      // 第1報の時点でファイルが読める
      const files = fs.readdirSync(tmpDir);
      const filePath = path.join(tmpDir, files[0]);
      const content1 = fs.readFileSync(filePath, "utf-8");
      expect(content1).toContain("第1報");

      // 第2報を追記
      const info2 = createEewInfo({ serial: "2", eventId });
      logger.logReport(info2, createUpdateResult({ isNew: false }));
      await logger.flush();

      const content2 = fs.readFileSync(filePath, "utf-8");
      expect(content2).toContain("第1報");
      expect(content2).toContain("第2報");
    });
  });
});
