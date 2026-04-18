import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { EventFileWriter } from "../../src/engine/events/event-file-writer";
import type { EarthquakeOutcome } from "../../src/engine/presentation/types";
import type { WsDataMessage, ParsedEarthquakeInfo } from "../../src/types";

function createMockMsg(overrides?: Partial<WsDataMessage>): WsDataMessage {
  return {
    version: "2.0",
    id: "msg-abc-001",
    classification: "telegram.earthquake",
    format: "xml",
    head: {
      type: "VXSE53",
      author: "気象庁",
      time: "2026-03-10T21:01:00+09:00",
      designation: null,
      test: false,
      xml: true,
    },
    xmlReport: {
      control: {
        title: "震源・震度に関する情報",
        dateTime: "2026-03-10T12:01:00Z",
        status: "通常",
        editorialOffice: "気象庁",
        publishingOffice: "気象庁",
      },
      head: {
        title: "震源・震度に関する情報",
        reportDateTime: "2026-03-10T21:01:00+09:00",
        targetDateTime: "2026-03-10T21:00:00+09:00",
        eventId: "20260310210045",
        serial: null,
        infoType: "発表",
        infoKind: "地震情報",
        infoKindVersion: "1.0.0",
        headline: "10日21時00分ころ、地震がありました。",
      },
    },
    receivedTime: "2026-03-10T21:01:01+09:00",
    body: "<xml>dummy</xml>",
    ...overrides,
  } as unknown as WsDataMessage;
}

function createEarthquakeOutcome(msgOverrides?: Partial<WsDataMessage>): EarthquakeOutcome {
  const parsed: ParsedEarthquakeInfo = {
    type: "VXSE53",
    infoType: "発表",
    title: "震源・震度に関する情報",
    reportDateTime: "2026-03-10T21:01:00+09:00",
    headline: "10日21時00分ころ、地震がありました。",
    publishingOffice: "気象庁",
    eventId: "20260310210045",
    earthquake: {
      originTime: "2026-03-10T21:00:45+09:00",
      hypocenterName: "茨城県南部",
      latitude: "N36.1",
      longitude: "E140.1",
      depth: "50km",
      magnitude: "4.0",
    },
    maxInt: "3",
    observations: [{ prefecture: "茨城県", maxInt: "3", stations: [] }],
    comments: null,
    isTest: false,
  };
  return {
    domain: "earthquake",
    msg: createMockMsg(msgOverrides),
    headType: "VXSE53",
    statsCategory: "earthquake",
    parsed,
    stats: { shouldRecord: true, eventId: "20260310210045" },
    presentation: { frameLevel: "normal" },
  } as EarthquakeOutcome;
}

describe("EventFileWriter", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "event-file-writer-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("write", () => {
    it("有効時に JSON ファイルを書き出す", async () => {
      const writer = new EventFileWriter({ outputDir: tmpDir, enabled: true });
      writer.write(createEarthquakeOutcome());
      await writer.flush();

      const files = fs.readdirSync(tmpDir);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/^\d{8}T\d{9}_earthquake_20260310210045_msg-abc-001_\d{6}\.json$/);

      const content = JSON.parse(fs.readFileSync(path.join(tmpDir, files[0]), "utf-8"));
      expect(content.version).toBe(1);
      expect(content.exportedAt).toBeDefined();
      expect(content.event.domain).toBe("earthquake");
      expect(content.event.title).toBe("震源・震度に関する情報");
    });

    it("無効時にファイルを書き出さない", async () => {
      const writer = new EventFileWriter({ outputDir: tmpDir, enabled: false });
      writer.write(createEarthquakeOutcome());
      await writer.flush();
      expect(fs.readdirSync(tmpDir)).toHaveLength(0);
    });

    it("デフォルトで raw が null になる", async () => {
      const writer = new EventFileWriter({ outputDir: tmpDir, enabled: true });
      writer.write(createEarthquakeOutcome());
      await writer.flush();

      const files = fs.readdirSync(tmpDir);
      const content = JSON.parse(fs.readFileSync(path.join(tmpDir, files[0]), "utf-8"));
      expect(content.event.raw).toBeNull();
    });

    it("includeRaw=true で raw が入る", async () => {
      const writer = new EventFileWriter({ outputDir: tmpDir, enabled: true, includeRaw: true });
      writer.write(createEarthquakeOutcome());
      await writer.flush();

      const files = fs.readdirSync(tmpDir);
      const content = JSON.parse(fs.readFileSync(path.join(tmpDir, files[0]), "utf-8"));
      expect(content.event.raw).not.toBeNull();
      expect(content.event.raw.earthquake.hypocenterName).toBe("茨城県南部");
    });

    it("eventId が null のとき unknown にフォールバック", async () => {
      const writer = new EventFileWriter({ outputDir: tmpDir, enabled: true });
      const outcome = createEarthquakeOutcome();
      (outcome.parsed as unknown as { eventId: string | null }).eventId = null;
      (outcome.msg as unknown as { xmlReport: { head: { eventId: string | null } } }).xmlReport.head.eventId = null;
      writer.write(outcome);
      await writer.flush();

      const files = fs.readdirSync(tmpDir);
      expect(files[0]).toContain("_unknown_");
    });

    it("msg.id がファイル名に含まれる（衝突回避）", async () => {
      const writer = new EventFileWriter({ outputDir: tmpDir, enabled: true });
      writer.write(createEarthquakeOutcome({ id: "dup-1" }));
      writer.write(createEarthquakeOutcome({ id: "dup-2" }));
      await writer.flush();

      const files = fs.readdirSync(tmpDir).sort();
      expect(files).toHaveLength(2);
      expect(files.some((f) => f.includes("_dup-1_"))).toBe(true);
      expect(files.some((f) => f.includes("_dup-2_"))).toBe(true);
    });

    it("同一 msg.id が連続しても異なるファイル名になる（連番付与）", async () => {
      const writer = new EventFileWriter({ outputDir: tmpDir, enabled: true });
      writer.write(createEarthquakeOutcome({ id: "same-id" }));
      writer.write(createEarthquakeOutcome({ id: "same-id" }));
      writer.write(createEarthquakeOutcome({ id: "same-id" }));
      await writer.flush();

      const files = fs.readdirSync(tmpDir);
      expect(files).toHaveLength(3);
      // すべて _same-id_{seq}.json パターン
      expect(files.every((f) => /_same-id_\d{6}\.json$/.test(f))).toBe(true);
    });

    it("書き込み中に .tmp ファイルが残らない（アトミック書き込み）", async () => {
      const writer = new EventFileWriter({ outputDir: tmpDir, enabled: true });
      writer.write(createEarthquakeOutcome());
      await writer.flush();

      const files = fs.readdirSync(tmpDir);
      expect(files.every((f) => !f.endsWith(".tmp"))).toBe(true);
      expect(files).toHaveLength(1);
    });
  });

  describe("setEnabled / setIncludeRaw", () => {
    it("setEnabled で切替できる", async () => {
      const writer = new EventFileWriter({ outputDir: tmpDir, enabled: false });
      writer.write(createEarthquakeOutcome());
      await writer.flush();
      expect(fs.readdirSync(tmpDir)).toHaveLength(0);

      writer.setEnabled(true);
      writer.write(createEarthquakeOutcome({ id: "msg-on-001" }));
      await writer.flush();
      expect(fs.readdirSync(tmpDir)).toHaveLength(1);
    });

    it("setIncludeRaw で raw 出力を切替できる", async () => {
      const writer = new EventFileWriter({ outputDir: tmpDir, enabled: true, includeRaw: false });
      writer.write(createEarthquakeOutcome({ id: "msg-r1" }));
      await writer.flush();

      let files = fs.readdirSync(tmpDir);
      let content = JSON.parse(fs.readFileSync(path.join(tmpDir, files[0]), "utf-8"));
      expect(content.event.raw).toBeNull();

      writer.setIncludeRaw(true);
      writer.write(createEarthquakeOutcome({ id: "msg-r2" }));
      await writer.flush();

      files = fs.readdirSync(tmpDir).sort();
      const r2 = files.find((f) => f.includes("msg-r2"))!;
      content = JSON.parse(fs.readFileSync(path.join(tmpDir, r2), "utf-8"));
      expect(content.event.raw).not.toBeNull();
    });
  });

  describe("cleanup", () => {
    it("maxFiles 超過時に古いファイルを削除", async () => {
      const writer = new EventFileWriter({ outputDir: tmpDir, enabled: true, maxFiles: 5 });

      for (let i = 0; i < 6; i++) {
        writer.write(createEarthquakeOutcome({ id: `msg-${String(i).padStart(3, "0")}` }));
      }
      await writer.flush();
      await writer.triggerCleanup();

      const files = fs.readdirSync(tmpDir);
      expect(files.length).toBeLessThanOrEqual(5);
    });

    it("高頻度書き込みでも cleanup 発動後は maxFiles を守る", async () => {
      // maxFiles=5 で 30 件書く。cleanup は 10/20/30 回目に発動。
      // 修正前は 10% しか消えず増え続けたが、修正後は overflow 分を確実に削除する。
      const writer = new EventFileWriter({ outputDir: tmpDir, enabled: true, maxFiles: 5 });

      for (let i = 0; i < 30; i++) {
        writer.write(createEarthquakeOutcome({ id: `bulk-${String(i).padStart(3, "0")}` }));
      }
      await writer.flush();

      const files = fs.readdirSync(tmpDir);
      // 最終 cleanup 後は maxFiles 以下
      expect(files.length).toBeLessThanOrEqual(5);
    });

    it("maxFiles=0 は DEFAULT へフォールバックしてクリーンアップが破綻しない", async () => {
      const writer = new EventFileWriter({ outputDir: tmpDir, enabled: true, maxFiles: 0 });
      // 15 件書く (10 件目で cleanup 発動)。DEFAULT=1000 なので削除は走らない。
      for (let i = 0; i < 15; i++) {
        writer.write(createEarthquakeOutcome({ id: `m-${i}` }));
      }
      await writer.flush();
      expect(fs.readdirSync(tmpDir).length).toBe(15);
    });
  });

  describe("エラーハンドリング", () => {
    it("無効なパスでもエラーをスローしない", async () => {
      const writer = new EventFileWriter({
        outputDir: path.join(tmpDir, "..", "this-is-a-file-not-a-dir"),
        enabled: true,
      });
      fs.writeFileSync(writer.getOutputDir(), "block");
      expect(() => writer.write(createEarthquakeOutcome())).not.toThrow();
      await writer.flush();
      fs.rmSync(writer.getOutputDir(), { force: true });
    });
  });
});
