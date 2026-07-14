import { describe, it, expect } from "vitest";
import { maskApiKey } from "../../src/utils/secrets";

describe("maskApiKey", () => {
  it("長い文字列は先頭4文字と末尾4文字を表示する", () => {
    expect(maskApiKey("abcdefghijk")).toBe("abcd****hijk");
  });

  it("長さ8の文字列はマスクのみ表示する", () => {
    expect(maskApiKey("abcdefgh")).toBe("****");
  });

  it("長さ9の文字列はマスク形式で表示する", () => {
    expect(maskApiKey("abcdefghi")).toBe("abcd****fghi");
  });

  it("短い文字列はマスクのみ表示する", () => {
    expect(maskApiKey("abc")).toBe("****");
  });

  it("空文字はマスクのみ表示する", () => {
    expect(maskApiKey("")).toBe("****");
  });
});
