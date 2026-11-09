import { describe, expect, it } from "vitest";

import type { PersistenceStatus } from "../../contracts/p2-shared-runtime.types";
import { width } from "../../src/terminal/format";
import { TIP_CATEGORIES } from "../../src/terminal/tips-data";
import { harness, inputDoneOf, plain, reportOf, reportUnit, terminal } from "./terminal-fixture";

// P3-TERMINAL-LAYOUT-013 の試験。
const tip = (text: string, columns: number, level: 0 | 3 = 0): string[] =>
  terminal(columns, level)([{ kind: "notice", notice: { kind: "tip", text }, prompt: null }]).map(plain);

describe("P3-TL13 台風の帯の版の印・種類の分からない電文・tips の形", () => {
  // P3-TL13-T01 acceptance / AC01
  it("T01 台風の帯の題名から版の印「（Ｈ３０）」を除く", () => {
    const band = terminal()([reportUnit(reportOf("synthetic_VPTW60_cancel.xml", "U-Y"))])[1];
    expect(band).toMatch(/^━ 台風解析・予報情報（５日予報） 取消 台風発生予想 ━/);
    expect(band).not.toContain("（Ｈ３０）");
  });

  // P3-TL13-T02 contractBoundary / AC02
  it("T02 何も出さなかった入力の U-M の view の unknownType のカードは出さず、unreadable のカードは帯を出す", async () => {
    const SAVED: PersistenceStatus = { kind: "saved", currentGeneration: 0, savedGeneration: 0, savedCapturedAt: null, savedAckAt: null, dirtySince: null };
    const card = { kind: "unknownType", inputId: "w1", headType: "WTJP31", operation: "normal", receivedAt: Date.now(), reason: "routeUnlisted",
      title: null, headline: null, reportDateTimeRaw: null, rawCut: false, count: 1, hasRaw: true } as const;
    const lines = async (kind: "unknownType" | "unreadable"): Promise<string[]> => {
      const h = harness();
      h.output.sink.inputDone(inputDoneOf("w1", null, [], [{ unit: "U-M", persistence: SAVED, pendingIntents: null,
        view: { unit: "U-M", semanticRevision: "", contentRevision: "", subjects: [], tornado: [], heat: [], transient: [], unreadableCards: [{ ...card, kind }] } }]));
      await h.output.close();
      return h.lines.filter((text) => text !== "");
    };
    expect(await lines("unknownType")).toEqual([]);
    expect((await lines("unreadable")).some((text) => text.startsWith("━ 処理できなかった電文 WTJP31 "))).toBe(true);
  });

  // P3-TL13-T03 acceptance / AC03
  it("T03 tips は前に空行、幅に入らなければ句点で分け、まだ入らない文は幅の中の最後の読点の後で折って続きを 4 桁下げる", () => {
    // (a)
    expect(tip("Tip: notify eew on のように分野ごとに通知を変えられます。", 100)).toEqual(["", "  Tip: notify eew on のように分野ごとに通知を変えられます。"]);
    // (b)
    expect(tip("Tip: 阪神・淡路大震災では、住民による救助や炊き出しが大きな役割を果たしました。公的支援が届くまでの地域の助け合いも備えの一部です。", 100)).toEqual(["",
      "  Tip: 阪神・淡路大震災では、住民による救助や炊き出しが大きな役割を果たしました。", "  公的支援が届くまでの地域の助け合いも備えの一部です。"]);
    // (c) 実不具合: 写しの 151〜152 行の「計／算されます。」
    expect(tip("Tip: WBGTは1954年にアメリカ軍が熱中症予防のために開発した指標で、乾球・湿球・黒球の3つの温度から計算されます。", 100)).toEqual(["",
      "  Tip: WBGTは1954年にアメリカ軍が熱中症予防のために開発した指標で、", "    乾球・湿球・黒球の3つの温度から計算されます。"]);
    // (d) 幅の中に読点が無い文: 字の境目で折り、行頭の「。」は前の字といっしょに送る。
    const noComma = tip(`Tip: ${"震".repeat(46)}。`, 100);
    expect(noComma).toEqual(["", `  Tip: ${"震".repeat(45)}`, "    震。"]);
    // (e) どの tips も 56・80・100 桁・色 0 と 3 で桁数を越えない。
    const all = TIP_CATEGORIES.flatMap((category) => category.tips);
    for (const columns of [56, 80, 100]) for (const level of [0, 3] as const) {
      expect(all.flatMap((text) => tip(text, columns, level)).filter((text) => width(text) > columns), `${columns}/${level}`).toEqual([]);
    }
    // (f) ちょうど 98 桁は 100 桁・色 3 で 1 行（本文の幅 ctx.body から引くと折れる）。
    const exact = `Tip:${"震".repeat(46)}。`;
    expect(width(exact)).toBe(98);
    expect(tip(exact, 100, 3)).toEqual(["", `  ${exact}`]);
  });
});
