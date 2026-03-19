import * as log from "../logger";

/**
 * dmdata.jp WebSocket エンドポイントのリージョン
 *
 * ws-tokyo.api.dmdata.jp (ws001, ws002) と
 * ws-osaka.api.dmdata.jp (ws003, ws004) の 2 リージョン構成。
 */
type Region = "tokyo" | "osaka";

/** リージョン別エンドポイント (冗長化用) */
const REGION_HOSTS: Record<Region, string> = {
  tokyo: "ws-tokyo.api.dmdata.jp",
  osaka: "ws-osaka.api.dmdata.jp",
};

/** 個別サーバー → リージョンのマッピング */
const SERVER_TO_REGION: Record<string, Region> = {
  "ws001.api.dmdata.jp": "tokyo",
  "ws002.api.dmdata.jp": "tokyo",
  "ws003.api.dmdata.jp": "osaka",
  "ws004.api.dmdata.jp": "osaka",
  "ws-tokyo.api.dmdata.jp": "tokyo",
  "ws-osaka.api.dmdata.jp": "osaka",
};

/** クールダウン初期値 (ミリ秒) */
const INITIAL_COOLDOWN_MS = 120_000;

/** クールダウン上限 (ミリ秒) */
const MAX_COOLDOWN_MS = 900_000;

/** 連続失敗判定の時間窓 (ミリ秒): この時間内に再度失敗するとクールダウンを延長 */
const REPEATED_FAILURE_WINDOW_MS = 600_000;

interface FailureRecord {
  /** 最後に失敗した時刻 (Date.now()) */
  failedAt: number;
  /** 現在のクールダウン期間 (ミリ秒) */
  cooldownMs: number;
}

/**
 * WebSocket エンドポイント選択器
 *
 * 切断時に失敗ホストを記録し、再接続時に別リージョンを優先する。
 * Socket Start レスポンスの URL ホスト名を必要に応じて差し替える。
 */
export class EndpointSelector {
  /** ホストごとの失敗記録 */
  private failures = new Map<string, FailureRecord>();

  /** 直前に接続していたホスト名 */
  private lastConnectedHost: string | null = null;

  /**
   * 接続成功時に呼ぶ。接続先ホストを記録する。
   */
  recordConnected(wsUrl: string): void {
    const host = this.extractHost(wsUrl);
    if (host == null) return;
    this.lastConnectedHost = host;
    log.debug(`EndpointSelector: 接続先を記録: ${host}`);
  }

  /**
   * 切断時に呼ぶ。失敗ホストを記録しクールダウンを設定する。
   */
  recordDisconnected(): void {
    const host = this.lastConnectedHost;
    if (host == null) return;

    const now = Date.now();
    const existing = this.failures.get(host);

    let cooldownMs: number;
    if (
      existing != null &&
      now - existing.failedAt < REPEATED_FAILURE_WINDOW_MS
    ) {
      // 時間窓内の再失敗 → クールダウンを延長 (上限あり)
      cooldownMs = Math.min(existing.cooldownMs * 2.5, MAX_COOLDOWN_MS);
    } else {
      cooldownMs = INITIAL_COOLDOWN_MS;
    }

    this.failures.set(host, { failedAt: now, cooldownMs });
    log.info(
      `EndpointSelector: ${host} を ${(cooldownMs / 1000).toFixed(0)}秒間クールダウン`
    );
  }

  /**
   * Socket Start レスポンスの URL を受け取り、必要に応じてホスト名を差し替える。
   *
   * - 返却ホストがクールダウン中 → 反対リージョンに差し替え
   * - 返却ホストが直前の失敗ホストと同じ → 反対リージョンに差し替え
   * - それ以外 → そのまま返す
   */
  resolveUrl(originalUrl: string): string {
    this.pruneExpiredFailures();

    const host = this.extractHost(originalUrl);
    if (host == null) return originalUrl;

    const shouldAvoid =
      this.isInCooldown(host) || host === this.lastConnectedHost;

    if (!shouldAvoid) {
      log.debug(`EndpointSelector: ${host} をそのまま使用`);
      return originalUrl;
    }

    // 反対リージョンを探す
    const alternativeHost = this.findAlternativeHost(host);
    if (alternativeHost == null) {
      log.debug(
        `EndpointSelector: 代替ホストが見つからないため ${host} をそのまま使用`
      );
      return originalUrl;
    }

    log.info(
      `EndpointSelector: ${host} を回避 → ${alternativeHost} に差し替え`
    );
    return this.replaceHost(originalUrl, alternativeHost);
  }

  /** 指定ホストがクールダウン中かどうか */
  private isInCooldown(host: string): boolean {
    const record = this.failures.get(host);
    if (record == null) return false;
    return Date.now() - record.failedAt < record.cooldownMs;
  }

  /** 期限切れの失敗記録を削除 */
  private pruneExpiredFailures(): void {
    const now = Date.now();
    for (const [host, record] of this.failures) {
      if (now - record.failedAt >= record.cooldownMs) {
        this.failures.delete(host);
      }
    }
  }

  /** 指定ホストの反対リージョンのエンドポイントを返す */
  private findAlternativeHost(currentHost: string): string | null {
    const currentRegion = this.detectRegion(currentHost);

    // 反対リージョンを試す
    const oppositeRegion: Region =
      currentRegion === "tokyo" ? "osaka" : "tokyo";
    const candidate = REGION_HOSTS[oppositeRegion];

    // 反対リージョンもクールダウン中なら諦める
    if (this.isInCooldown(candidate)) {
      log.debug(
        `EndpointSelector: 反対リージョン ${candidate} もクールダウン中`
      );
      return null;
    }

    return candidate;
  }

  /** ホスト名からリージョンを推定する */
  private detectRegion(host: string): Region {
    const mapped = SERVER_TO_REGION[host];
    if (mapped != null) return mapped;

    // ws.api.dmdata.jp や未知のホストはデフォルトで tokyo とみなす
    return "tokyo";
  }

  /** URL からホスト名を抽出する */
  private extractHost(wsUrl: string): string | null {
    try {
      const u = new URL(wsUrl);
      return u.hostname;
    } catch {
      return null;
    }
  }

  /** URL のホスト名を差し替える */
  private replaceHost(originalUrl: string, newHost: string): string {
    try {
      const u = new URL(originalUrl);
      u.hostname = newHost;
      return u.toString();
    } catch {
      return originalUrl;
    }
  }
}
