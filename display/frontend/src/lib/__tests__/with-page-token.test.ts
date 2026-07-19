// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { withPageToken } from "../connection.svelte";

describe("withPageToken: ページ URL の ?token= を SSE 接続へ引き継ぐ", () => {
  afterEach(() => {
    history.replaceState({}, "", "/");
  });

  it("token なしのページでは URL を変えない (loopback アクセス)", () => {
    history.replaceState({}, "", "/");
    expect(withPageToken("/events")).toBe("/events");
  });

  it("ページ URL の token を /events に付与する", () => {
    history.replaceState({}, "", "/?token=abc123");
    expect(withPageToken("/events")).toBe("/events?token=abc123");
  });

  it("既にクエリを持つ URL には & で連結する", () => {
    history.replaceState({}, "", "/?token=abc123");
    expect(withPageToken("/events?x=1")).toBe("/events?x=1&token=abc123");
  });

  it("token はエンコードして付与する", () => {
    history.replaceState({}, "", "/?token=a%2Fb");
    expect(withPageToken("/events")).toBe("/events?token=a%2Fb");
  });
});
