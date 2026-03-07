import { describe, it, expect } from "vitest";
import {
  isNewerVersion,
  isUpdateCheckDisabled,
} from "../../src/engine/update-checker";

describe("isNewerVersion", () => {
  it("メジャーバージョンが大きい場合 true", () => {
    expect(isNewerVersion("1.17.0", "2.0.0")).toBe(true);
  });

  it("マイナーバージョンが大きい場合 true", () => {
    expect(isNewerVersion("1.17.0", "1.18.0")).toBe(true);
  });

  it("パッチバージョンが大きい場合 true", () => {
    expect(isNewerVersion("1.17.0", "1.17.1")).toBe(true);
  });

  it("同じバージョンの場合 false", () => {
    expect(isNewerVersion("1.17.0", "1.17.0")).toBe(false);
  });

  it("古いバージョンの場合 false", () => {
    expect(isNewerVersion("1.17.0", "1.16.0")).toBe(false);
  });

  it("メジャーが小さくマイナーが大きい場合 false", () => {
    expect(isNewerVersion("2.0.0", "1.99.99")).toBe(false);
  });

  it("v プレフィックス付きでも正しく比較できる", () => {
    expect(isNewerVersion("v1.17.0", "v1.18.0")).toBe(true);
    expect(isNewerVersion("v1.18.0", "v1.17.0")).toBe(false);
  });

  it("プレリリースサフィックス付きでも数値部分で比較できる", () => {
    expect(isNewerVersion("1.17.0", "1.18.0-beta.1")).toBe(true);
    expect(isNewerVersion("1.18.0-beta.1", "1.17.0")).toBe(false);
  });

  it("不正な形式の場合 false を返す", () => {
    expect(isNewerVersion("invalid", "1.18.0")).toBe(false);
    expect(isNewerVersion("1.17.0", "invalid")).toBe(false);
    expect(isNewerVersion("", "")).toBe(false);
    expect(isNewerVersion("1.2", "1.3.0")).toBe(false);
  });
});

describe("isUpdateCheckDisabled", () => {
  it("未設定なら false", () => {
    expect(isUpdateCheckDisabled({})).toBe(false);
  });

  it("truthy な値なら true", () => {
    expect(isUpdateCheckDisabled({ FLEQ_NO_UPDATE_CHECK: "1" })).toBe(true);
    expect(isUpdateCheckDisabled({ FLEQ_NO_UPDATE_CHECK: "true" })).toBe(true);
    expect(isUpdateCheckDisabled({ FLEQ_NO_UPDATE_CHECK: "ON" })).toBe(true);
  });

  it("それ以外は false", () => {
    expect(isUpdateCheckDisabled({ FLEQ_NO_UPDATE_CHECK: "0" })).toBe(false);
    expect(isUpdateCheckDisabled({ FLEQ_NO_UPDATE_CHECK: "false" })).toBe(false);
  });
});
