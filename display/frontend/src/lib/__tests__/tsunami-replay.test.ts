import { describe, it, expect } from "vitest";
import { buildTsunamiReplayDto, tsunamiReplayGroupKey } from "../tsunami-replay";
import type { DisplayTsunamiStateV1 } from "../protocol";

function tsunamiState(over: Partial<DisplayTsunamiStateV1> = {}): DisplayTsunamiStateV1 {
  return {
    kind: "tsunami",
    level: "majorWarning",
    levelLabel: "大津波警報",
    coasts: [
      { name: "宮崎県", kind: "大津波警報", maxHeight: "10m超", firstHeight: null },
      { name: "高知県", kind: "津波警報", maxHeight: "3m", firstHeight: null },
      { name: "沖縄本島地方", kind: "津波注意報", maxHeight: "1m", firstHeight: null },
    ],
    warningComment: null,
    observations: [],
    reportDateTime: "2026-07-14T14:32:00+09:00",
    updatedAtMs: 111,
    ...over,
  };
}

describe("buildTsunamiReplayDto", () => {
  it("指定レベルの区域を marquee と同じ見出し付き本文で合成する", () => {
    const dto = buildTsunamiReplayDto(tsunamiState(), "warning", 3, 7);
    expect(dto).not.toBeNull();
    expect(dto!.tickerBody).toBe("【津波警報】高知県");
    expect(dto!.tickerSentence).toBe("【津波警報】高知県");
    expect(dto!.summary.text).toBe("【津波警報】高知県");
  });

  it("kind=replay / priority=low / replayGeneration を持つ", () => {
    const dto = buildTsunamiReplayDto(tsunamiState(), "majorWarning", 5, 1);
    expect(dto!.kind).toBe("replay");
    expect(dto!.tickerPriority).toBe("low");
    expect(dto!.replayGeneration).toBe(5);
  });

  it("key は replay:tsunami:<level>:<seq>、groupKey は replay:tsunami:<level>", () => {
    const dto = buildTsunamiReplayDto(tsunamiState(), "advisory", 0, 42);
    expect(dto!.eventKey).toBe("replay:tsunami:advisory:42");
    expect(dto!.id).toBe("replay:tsunami:advisory:42");
    expect(dto!.groupKey).toBe("replay:tsunami:advisory");
    expect(dto!.groupKey).toBe(tsunamiReplayGroupKey("advisory"));
  });

  it("seq が違えば eventKey が毎回ユニークになり過去 replay と衝突しない", () => {
    const a = buildTsunamiReplayDto(tsunamiState(), "warning", 1, 1);
    const b = buildTsunamiReplayDto(tsunamiState(), "warning", 1, 2);
    expect(a!.eventKey).not.toBe(b!.eventKey);
    expect(a!.groupKey).toBe(b!.groupKey); // 同レベルなので連打ガードのキーは同じ
  });

  it("その種別の区域が無ければ null を返す (偽装しない)", () => {
    const noAdvisory = tsunamiState({
      coasts: [{ name: "宮崎県", kind: "大津波警報", maxHeight: "10m超", firstHeight: null }],
    });
    expect(buildTsunamiReplayDto(noAdvisory, "advisory", 1, 1)).toBeNull();
  });

  it("role はレベルに対応する津波ロールになる", () => {
    expect(buildTsunamiReplayDto(tsunamiState(), "majorWarning", 1, 1)!.summary.role).toBe("tsunamiMajor");
    expect(buildTsunamiReplayDto(tsunamiState(), "warning", 1, 1)!.summary.role).toBe("tsunamiWarning");
    expect(buildTsunamiReplayDto(tsunamiState(), "advisory", 1, 1)!.summary.role).toBe("tsunamiAdvisory");
  });
});
