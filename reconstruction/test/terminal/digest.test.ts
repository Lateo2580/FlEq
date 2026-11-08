import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { RecoveryDigestView } from "../../contracts/p3-recovery.types";
import { rowsByHeadType } from "../../src/runtime/unit-coverage";
import { painter } from "../../src/terminal/color";
import { createRenderer, typeName } from "../../src/terminal/format";
import { harness } from "./terminal-fixture";

// spec §6.6 の図の値に、0 件の分野（U-W）、同じ題名の 2 つの VXKO（U-R）、表に無い種類と取り直しの上限で切れた題名（U-V）を足した digest。
const head = (title: string, time: string) => ({ headType: "VXSE53", operation: "normal" as const, title, headline: "見出し文",
  reportDateTime: `2026-11-03T${time}:00+09:00`, receivedAt: 0 });
const DIGEST: RecoveryDigestView = { units: [
  { unit: "U-T", beforeWindow: false, kind: "unsatisfied", reason: "fetchFailed" },
  { unit: "U-Q", beforeWindow: true, kind: "listed", heads: [head("震源・震度に関する情報", "06:12"), head("震度速報", "04:40"), head("震度速報", "02:31")],
    omitted: { VXSE52: 2 } },
  { unit: "U-W", beforeWindow: false, kind: "listed", heads: [], omitted: {} },
  { unit: "U-V", beforeWindow: false, kind: "listed", heads: [head("降灰予報（定時）[truncated:fieldLimit]", "05:00")], omitted: { VFVO52: 1, VFVO53: 300, VXXX99: 2 } },
  { unit: "U-R", beforeWindow: false, kind: "listed", heads: [], omitted: { VXKO50: 2, VXKO61: 3 } },
] };

describe("P3-TO-T15 起動時のまとめ（spec §6.6、AC14）", () => {
  // P3-TL7-T01（受入条件 P3-TL7-AC01・AC02）
  it("最初の digest だけを図の形で出し、digest の無い snapshot と 2 枚目以後は何も出さない", async () => {
    const h = harness();
    h.output.sink.digest(null);
    expect(h.lines).toEqual([]);
    h.output.sink.digest(DIGEST);
    h.output.sink.digest(DIGEST);
    expect(h.lines).toEqual([
      `━ 止まっていた間に出た情報（7 日前まで） ${"━".repeat(80 - 38 - 3)}`,
      "7 日より前の情報は取り直していません",
      "津波       取り直せませんでした",
      "地震         5 件",
      "  06:12  震源・震度に関する情報",
      "  04:40  震度速報",
      "  02:31  震度速報",
      "  ほか 震源に関する情報 2 件",
      "火山       304 件",
      "  05:00  降灰予報（定時）…",
      "  ほか 降灰予報（定時） 300 件　その他 2 件　噴火に関する火山観測報 1 件",
      "洪水         5 件",
      "  ほか 指定河川洪水予報 5 件",
    ]);
    await h.output.close();
    // 分野の名前は太字（Q-TO8-DIGEST）。
    const strong = painter(3)("strong", "地震");
    expect(createRenderer(3).render({ columns: 80, dropped: 0, units: [{ kind: "notice", notice: { kind: "digest", digest: DIGEST }, prompt: null }] })).toContain(strong);
  });
});

// P3-TL7-T02（契約境界 P3-TL7-AC01）
describe("P3-TL7-T02 まとめの題名の表", () => {
  it("まとめに載る分野の ready の型は全部表で引け、実物の電文の Control の Title から版の印と末尾の a を除いた名前と一致する", () => {
    const listed = [...rowsByHeadType].filter(([, row]) => row.status === "ready" && row.unit !== "U-E").map(([type]) => type);
    expect(listed.filter((type) => typeName(type) === "その他")).toEqual([]);
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]);
    let compared = 0;
    for (const path of files("test/fixtures").filter((name) => name.endsWith(".xml"))) {
      const type = /_(V[A-Z]{3}\d\d)/.exec(path)?.[1], title = /<Control>[\s\S]*?<Title>(.*?)<\/Title>/.exec(readFileSync(path, "utf8"))?.[1];
      if (type == null || title == null || !listed.includes(type)) continue;
      expect(typeName(type), path).toBe(title.replace(/（Ｒ０６）|（Ｈ３０）/g, "").replace(/a$/, ""));
      compared += 1;
    }
    expect(compared).toBeGreaterThan(100);
  });
});
