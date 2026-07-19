import { describe, it, expect } from "vitest";
import { isLoopbackHost } from "../../../src/engine/display/transport";

describe("isLoopbackHost", () => {
  it.each([
    ["127.0.0.1", true],
    ["::1", true],
    ["localhost", true],
    ["0.0.0.0", false],
    ["192.168.1.10", false],
    ["10.0.0.5", false],
  ])("%s → %s", (host, expected) => {
    expect(isLoopbackHost(host)).toBe(expected);
  });
});
