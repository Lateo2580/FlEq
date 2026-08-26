import { describe, expect, it, vi } from "vitest";
import { TornadoDetailProvider } from "../../../src/engine/messages/tornado-detail-provider";
import { parseTornadoAdvisory } from "../../../src/dmdata/tornado-parser";
import { processMessage } from "../../../src/engine/presentation/processors/process-message";
import { handleDetail } from "../../../src/ui/repl-handlers/info-handlers";
import {
  createMockWsDataMessage,
  FIXTURE_VPHW50_TOKYO,
} from "../../helpers/mock-message";
import { makeProcessDeps } from "../../helpers/process-deps";

describe("TornadoDetailProvider", () => {
  it("受理済み電文を detail tornado に供給する", () => {
    const provider = new TornadoDetailProvider();
    const info = parseTornadoAdvisory(createMockWsDataMessage(FIXTURE_VPHW50_TOKYO))!;
    info.layers = [{
      type: "竜巻注意情報（市町村等）",
      areas: Array.from({ length: 31 }, (_, index) => ({
        name: `検証区域${String(index + 1).padStart(2, "0")}`,
        code: String(index + 1),
        status: "active" as const,
      })),
    }];
    provider.rememberLatest(info);

    expect(provider.getDetail()?.kind).toBe("tornado");
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((value: unknown) => {
      logs.push(String(value));
    });
    try {
      handleDetail({ detailProviders: [provider] } as never, "tornado");
    } finally {
      spy.mockRestore();
    }
    expect(logs.join("\n")).toContain("検証区域31");
  });

  it("受理された竜巻電文だけを provider へ記録する", () => {
    const provider = new TornadoDetailProvider();
    const outcome = processMessage(
      createMockWsDataMessage(FIXTURE_VPHW50_TOKYO),
      "tornado",
      makeProcessDeps({ tornadoDetailProvider: provider }),
    );
    expect(outcome).not.toBeNull();
    expect(provider.getDetail()?.info.type).toBe("VPHW50");
  });
});
