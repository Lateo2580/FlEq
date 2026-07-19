import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createDisplayRequestListener, isLoopbackAddress } from "../../../src/engine/display/http-server";
import { SseClients } from "../../../src/engine/display/sse-clients";
import { DISPLAY_PROTOCOL_VERSION } from "../../../src/engine/display/types";
import type { DisplayStateSnapshotV1 } from "../../../src/engine/display/types";

const log = { info: (): void => {}, warn: (): void => {} };

function snapshot(): DisplayStateSnapshotV1 {
  return {
    version: DISPLAY_PROTOCOL_VERSION, generatedAt: "2026-07-19T12:00:00+09:00", seq: 0,
    activeEews: [], tsunami: null, largeQuakes: [], weatherAlerts: [], recentQuakes: [],
    connection: { dmdata: "connected", lastReceivedAt: null, disconnectedSince: null, reason: null },
    recentTicker: [],
  };
}

interface FakeResponse {
  status: number | null;
  body: string;
  writeHead(status: number, headers?: Record<string, string>): void;
  end(chunk?: unknown): void;
  write(): boolean;
  destroy(): void;
  on(): void;
  once(): void;
}

function fakeReq(url: string, remoteAddress: string): IncomingMessage {
  return { url, socket: { remoteAddress } } as unknown as IncomingMessage;
}

function fakeRes(): FakeResponse {
  const res: FakeResponse = {
    status: null,
    body: "",
    writeHead(status) {
      res.status = status;
    },
    end(chunk) {
      if (typeof chunk === "string") res.body += chunk;
      else if (chunk instanceof Buffer) res.body += chunk.toString("utf8");
    },
    write: () => true,
    destroy: () => {},
    on: () => {},
    once: () => {},
  };
  return res;
}

describe("display http-server のアクセストークン認証", () => {
  let distDir: string;
  let clients: SseClients;

  beforeEach(() => {
    distDir = mkdtempSync(join(tmpdir(), "fleq-display-auth-"));
    writeFileSync(join(distDir, "index.html"), "<html>display</html>");
    clients = new SseClients();
  });

  afterEach(() => {
    clients.closeAll();
    rmSync(distDir, { recursive: true, force: true });
  });

  function listener(token: string | null) {
    return createDisplayRequestListener({ distDir, clients, getSnapshot: snapshot, log, token });
  }

  it("token 未設定 (loopback バインド) では従来どおり認証なしで通る", () => {
    const handle = listener(null);
    const res = fakeRes();
    handle(fakeReq("/", "192.168.1.20"), res as unknown as ServerResponse);
    expect(res.status).toBe(200);
  });

  it("非 loopback からの / はトークンなしだと 401", () => {
    const handle = listener("secret-token");
    const res = fakeRes();
    handle(fakeReq("/", "192.168.1.20"), res as unknown as ServerResponse);
    expect(res.status).toBe(401);
    expect(res.body).toContain("アクセストークン");
  });

  it("非 loopback からの /events もトークンなしだと 401", () => {
    const handle = listener("secret-token");
    const res = fakeRes();
    handle(fakeReq("/events", "10.0.0.5"), res as unknown as ServerResponse);
    expect(res.status).toBe(401);
  });

  it("誤ったトークンは 401", () => {
    const handle = listener("secret-token");
    const res = fakeRes();
    handle(fakeReq("/?token=wrong", "192.168.1.20"), res as unknown as ServerResponse);
    expect(res.status).toBe(401);
  });

  it("正しいトークン付きの / は 200", () => {
    const handle = listener("secret-token");
    const res = fakeRes();
    handle(fakeReq("/?token=secret-token", "192.168.1.20"), res as unknown as ServerResponse);
    expect(res.status).toBe(200);
    expect(res.body).toContain("display");
  });

  it("loopback からの接続はトークン設定時も免除される (kiosk のローカルブラウザを壊さない)", () => {
    const handle = listener("secret-token");
    for (const addr of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      const res = fakeRes();
      handle(fakeReq("/", addr), res as unknown as ServerResponse);
      expect(res.status).toBe(200);
    }
  });

  it("静的アセットと /healthz・/tips はトークン対象外 (ページ内参照が token なしで解決できる)", () => {
    const handle = listener("secret-token");
    writeFileSync(join(distDir, "app.js"), "console.log(1)");
    const asset = fakeRes();
    handle(fakeReq("/app.js", "192.168.1.20"), asset as unknown as ServerResponse);
    expect(asset.status).toBe(200);
    const health = fakeRes();
    handle(fakeReq("/healthz", "192.168.1.20"), health as unknown as ServerResponse);
    expect(health.status).toBe(200);
    const tips = fakeRes();
    handle(fakeReq("/tips", "192.168.1.20"), tips as unknown as ServerResponse);
    expect(tips.status).toBe(200);
  });
});

describe("isLoopbackAddress", () => {
  it("loopback 系を真、それ以外と未定義を偽と判定する", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("127.8.8.8")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("192.168.1.20")).toBe(false);
    expect(isLoopbackAddress("100.64.0.7")).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });
});
