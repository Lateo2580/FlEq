import { describe, it, expect } from "vitest";
import { createMockWsDataMessage } from "./mock-message";

describe("createMockWsDataMessage — flood type inference", () => {
  it("VXKO50 (public)", () => {
    expect(createMockWsDataMessage("16_01_01_220728_VXKO50.xml").head.type).toBe("VXKO50");
  });
  it("VXSU50 (public)", () => {
    expect(createMockWsDataMessage("91_01_01_241031_VXSU50.xml").head.type).toBe("VXSU50");
  });
  it("synthetic prefix も VXKO50 推定", () => {
    expect(createMockWsDataMessage("synthetic_VXKO50_cancel.xml").head.type).toBe("VXKO50");
    expect(createMockWsDataMessage("synthetic_VXKO50_correction.xml").head.type).toBe("VXKO50");
    expect(createMockWsDataMessage("synthetic_VXKO50_code31.xml").head.type).toBe("VXKO50");
  });
  it("synthetic_VXSU50_cancel.xml", () => {
    expect(createMockWsDataMessage("synthetic_VXSU50_cancel.xml").head.type).toBe("VXSU50");
  });
  it("classification は telegram.weather", () => {
    expect(createMockWsDataMessage("16_01_01_220728_VXKO50.xml").classification).toBe("telegram.weather");
    expect(createMockWsDataMessage("91_01_01_241031_VXSU50.xml").classification).toBe("telegram.weather");
  });
});
