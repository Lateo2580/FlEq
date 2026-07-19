import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/svelte";
import ConnectionBadge from "../ConnectionBadge.svelte";
import type { DisplayConnectionStateV1 } from "../../lib/protocol";

function connection(over: Partial<DisplayConnectionStateV1> = {}): DisplayConnectionStateV1 {
  return {
    dmdata: "connected",
    lastReceivedAt: "2026-07-07T01:23:00+09:00",
    disconnectedSince: null,
    reason: null,
    ...over,
  };
}

describe("ConnectionBadge", () => {
  it("① sseConnected=false なら dmdata が connected でも「切断されています」+ 最終受信時刻を出す", () => {
    render(ConnectionBadge, { connection: connection(), sseConnected: false });
    expect(screen.getByText("切断されています")).toBeTruthy();
    expect(screen.getByText(/最終受信/)).toBeTruthy();
  });

  it("② sseConnected=true かつ dmdata=connected なら何も render しない (常時ドット廃止)", () => {
    const { container } = render(ConnectionBadge, { connection: connection(), sseConnected: true });
    expect(container.querySelector(".connection-badge")).toBeFalsy();
  });

  it("sseConnected=true でも dmdata=disconnected なら「切断されています」を出す (既存挙動の維持)", () => {
    render(ConnectionBadge, {
      connection: connection({ dmdata: "disconnected", disconnectedSince: "t" }),
      sseConnected: true,
    });
    expect(screen.getByText("切断されています")).toBeTruthy();
  });
});
