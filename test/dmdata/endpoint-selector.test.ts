import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EndpointSelector } from "../../src/dmdata/endpoint-selector";

describe("EndpointSelector", () => {
  let selector: EndpointSelector;

  beforeEach(() => {
    selector = new EndpointSelector();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const tokyoServerUrl =
    "wss://ws001.api.dmdata.jp/v2/websocket?ticket=abc123";
  const osakaServerUrl =
    "wss://ws003.api.dmdata.jp/v2/websocket?ticket=abc123";
  const defaultUrl =
    "wss://ws.api.dmdata.jp/v2/websocket?ticket=abc123";
  const tokyoRegionUrl =
    "wss://ws-tokyo.api.dmdata.jp/v2/websocket?ticket=abc123";

  describe("resolveUrl", () => {
    it("初回接続時はURLをそのまま返す", () => {
      expect(selector.resolveUrl(tokyoServerUrl)).toBe(tokyoServerUrl);
    });

    it("切断後、同じホストのURLは反対リージョンに差し替える", () => {
      // ws001 (東京) に接続 → 切断
      selector.recordConnected(tokyoServerUrl);
      selector.recordDisconnected();

      // 再度 ws001 が返ってきた場合 → 大阪リージョンに差し替え
      const resolved = selector.resolveUrl(tokyoServerUrl);
      expect(resolved).toContain("ws-osaka.api.dmdata.jp");
      expect(resolved).toContain("ticket=abc123");
    });

    it("切断後、異なるホストのURLはそのまま返す", () => {
      // ws001 (東京) に接続 → 切断
      selector.recordConnected(tokyoServerUrl);
      selector.recordDisconnected();

      // ws003 (大阪) が返ってきた場合 → そのまま使う
      expect(selector.resolveUrl(osakaServerUrl)).toBe(osakaServerUrl);
    });

    it("クールダウン中のホストを回避する", () => {
      // ws001 に接続 → 切断 (クールダウン開始)
      selector.recordConnected(tokyoServerUrl);
      selector.recordDisconnected();

      // ws001 が返ってきた → 大阪へ差し替え
      const resolved = selector.resolveUrl(tokyoServerUrl);
      expect(resolved).toContain("ws-osaka.api.dmdata.jp");
    });

    it("クールダウン期限後は同じホストを受け入れる", () => {
      selector.recordConnected(tokyoServerUrl);
      selector.recordDisconnected();

      // 120秒後 (初期クールダウン超過)
      vi.advanceTimersByTime(120_001);

      // 改めて接続成功 → lastConnectedHost がリセットされる
      selector.recordConnected(
        "wss://ws003.api.dmdata.jp/v2/websocket?ticket=xyz"
      );

      // ws001 が返ってきた → クールダウン切れなのでそのまま
      expect(selector.resolveUrl(tokyoServerUrl)).toBe(tokyoServerUrl);
    });

    it("URLのパスとクエリパラメータを保持する", () => {
      selector.recordConnected(tokyoServerUrl);
      selector.recordDisconnected();

      const resolved = selector.resolveUrl(tokyoServerUrl);
      const u = new URL(resolved);
      expect(u.pathname).toBe("/v2/websocket");
      expect(u.searchParams.get("ticket")).toBe("abc123");
    });

    it("ws.api.dmdata.jp (デフォルト) は前回と同じなら大阪へ差し替え", () => {
      selector.recordConnected(defaultUrl);
      selector.recordDisconnected();

      // 同じ ws.api.dmdata.jp が返ってきた
      const resolved = selector.resolveUrl(defaultUrl);
      expect(resolved).toContain("ws-osaka.api.dmdata.jp");
    });

    it("大阪サーバーから切断された場合は東京へ差し替え", () => {
      selector.recordConnected(osakaServerUrl);
      selector.recordDisconnected();

      const resolved = selector.resolveUrl(osakaServerUrl);
      expect(resolved).toContain("ws-tokyo.api.dmdata.jp");
    });
  });

  describe("クールダウンの段階的延長", () => {
    it("連続失敗でクールダウンが延長される", () => {
      // 1回目: ws001 に接続 → 切断 (120秒クールダウン)
      selector.recordConnected(tokyoServerUrl);
      selector.recordDisconnected();

      // 60秒後に再接続試行 (まだクールダウン中) → 大阪に接続
      vi.advanceTimersByTime(60_000);
      selector.recordConnected(osakaServerUrl);
      selector.recordDisconnected();

      // ws001 はまだクールダウン中
      const resolved1 = selector.resolveUrl(tokyoServerUrl);
      expect(resolved1).toContain("ws-osaka.api.dmdata.jp");

      // ws003 もクールダウン中 → 両方ダメなら大阪もクールダウン中だが
      // ws003 が返ってきた場合
      const resolved2 = selector.resolveUrl(osakaServerUrl);
      // ws003 もクールダウン中、反対の東京 (ws-tokyo) を試すが
      // ws001 のクールダウンとは別物 (ws-tokyo は未記録)
      expect(resolved2).toContain("ws-tokyo.api.dmdata.jp");
    });

    it("時間窓内の再失敗でクールダウンが2.5倍になる", () => {
      // 1回目: 120秒クールダウン
      selector.recordConnected(tokyoServerUrl);
      selector.recordDisconnected();

      // 121秒後: クールダウン解除
      vi.advanceTimersByTime(121_000);

      // 2回目: 時間窓 (10分) 内なので 120 * 2.5 = 300秒に延長
      selector.recordConnected(tokyoServerUrl);
      selector.recordDisconnected();

      // 121秒後: まだクールダウン中 (300秒 > 121秒)
      vi.advanceTimersByTime(121_000);
      const resolved = selector.resolveUrl(tokyoServerUrl);
      expect(resolved).toContain("ws-osaka.api.dmdata.jp");

      // さらに180秒後 (合計301秒): クールダウン解除
      vi.advanceTimersByTime(180_000);
      // 別ホストに接続成功して lastConnectedHost をリセット
      selector.recordConnected(osakaServerUrl);
      expect(selector.resolveUrl(tokyoServerUrl)).toBe(tokyoServerUrl);
    });
  });

  describe("両リージョンがクールダウン中", () => {
    it("代替がない場合は元のURLをそのまま返す", () => {
      // 東京に接続 → 切断
      selector.recordConnected(tokyoServerUrl);
      selector.recordDisconnected();

      // 大阪リージョンに接続 → 切断
      const osakaRegionUrl =
        "wss://ws-osaka.api.dmdata.jp/v2/websocket?ticket=def456";
      selector.recordConnected(osakaRegionUrl);
      selector.recordDisconnected();

      // 東京が返ってきた → 大阪もクールダウン中 → 元のURLを使う
      const resolved = selector.resolveUrl(tokyoRegionUrl);
      // ws-tokyo は未記録だが lastConnectedHost が ws-osaka なので
      // ws-tokyo は lastConnectedHost と違う → そのまま返る
      // ただし ws001 が返ってきた場合はクールダウン中
      const resolved2 = selector.resolveUrl(tokyoServerUrl);
      // ws001 はクールダウン中、反対は ws-osaka でこれもクールダウン中
      // → 元の URL をそのまま返す
      expect(resolved2).toBe(tokyoServerUrl);
    });
  });

  describe("recordConnected / recordDisconnected", () => {
    it("接続せずに切断を記録しても例外を投げない", () => {
      expect(() => selector.recordDisconnected()).not.toThrow();
    });

    it("不正なURLでも例外を投げない", () => {
      expect(() => selector.recordConnected("not-a-url")).not.toThrow();
      expect(selector.resolveUrl("not-a-url")).toBe("not-a-url");
    });
  });
});
