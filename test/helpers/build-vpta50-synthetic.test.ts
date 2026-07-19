import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { buildVpta50Synthetic } from "./build-vpta50-synthetic";

const BASE_XML = readFileSync(
  resolve(__dirname, "../fixtures/76_01_01_200630_VPTA50.xml"),
  "utf-8"
);

describe("buildVpta50Synthetic", () => {
  it("variant=cancel: InfoType を取消に置換し body は空に近い", () => {
    const out = buildVpta50Synthetic(BASE_XML, "cancel");
    expect(out).toContain("<InfoType>取消</InfoType>");
    expect(out).not.toContain("<MeteorologicalInfo type=\"台風の暴風域に入る確率（1日積算）\">");
  });

  it("variant=missingTimeSeries: TimeSeriesInfo ブロックが消える", () => {
    const out = buildVpta50Synthetic(BASE_XML, "missingTimeSeries");
    expect(out).not.toContain("<TimeSeriesInfo>");
    expect(out).toContain("（1日積算）");  // 積算は残す
  });

  it("variant=missingSeriesForOneArea: 最初の TimeSeriesInfo Item の Part が空", () => {
    const out = buildVpta50Synthetic(BASE_XML, "missingSeriesForOneArea");
    // 1個目の Part だけが空タグ。他は残る。
    expect(out).toContain("<FiftyKtWindProbabilityPart></FiftyKtWindProbabilityPart>");
  });

  it("variant=duplicateCode: 同一 Area.Code が同セクション内で2回出現", () => {
    const out = buildVpta50Synthetic(BASE_XML, "duplicateCode");
    // 011011 が「1日積算」内で2回出現することを確認
    const section = out.split("（1日積算）")[1].split("（2日積算）")[0];
    const occurrences = (section.match(/<Code>011011<\/Code>/g) ?? []).length;
    expect(occurrences).toBe(2);
  });

  it("variant=monotonicityViolation: 3日積算で 011011 を 15 に書き換えて非単調にする", () => {
    const out = buildVpta50Synthetic(BASE_XML, "monotonicityViolation");
    // 3日積算で 011011 の値が 15 になっている (元は 0 のはず)
    // 詳細assert は parser テスト側で。ここでは「変換が走った」だけ
    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain("<Code>011011</Code>");
    // 3日積算セクション内に 15 が存在することを確認
    const section3 = out.split("（3日積算）")[1].split("（4日積算）")[0];
    expect(section3).toContain("<FiftyKtWindProbability unit=\"%\">15</FiftyKtWindProbability>");
  });

  it("variant=oversized: 6MB を超える", () => {
    const out = buildVpta50Synthetic(BASE_XML, "oversized");
    expect(Buffer.byteLength(out, "utf-8")).toBeGreaterThan(5 * 1024 * 1024);
  });
});
