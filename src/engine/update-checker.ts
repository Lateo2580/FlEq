import * as https from "https";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import chalk from "chalk";
import * as log from "../logger";

/** チェック結果のキャッシュファイルパス */
const CACHE_DIR = path.join(os.homedir(), ".config", "fleq");
const CACHE_PATH = path.join(CACHE_DIR, ".update-check");

/** チェック間隔: 24時間 */
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** npm registry へのリクエストタイムアウト: 3秒 */
const REQUEST_TIMEOUT_MS = 3000;

interface UpdateCheckCache {
  lastCheck: number;
  latestVersion: string;
}

/** 環境変数で更新確認を無効化しているか */
export function isUpdateCheckDisabled(env = process.env): boolean {
  const raw = env.FLEQ_NO_UPDATE_CHECK;
  if (raw == null) return false;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

/** キャッシュを読み込む。無効ならnullを返す */
function readCache(): UpdateCheckCache | null {
  try {
    if (!fs.existsSync(CACHE_PATH)) return null;
    const raw = fs.readFileSync(CACHE_PATH, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed != null &&
      "lastCheck" in parsed &&
      "latestVersion" in parsed &&
      typeof (parsed as UpdateCheckCache).lastCheck === "number" &&
      typeof (parsed as UpdateCheckCache).latestVersion === "string"
    ) {
      return parsed as UpdateCheckCache;
    }
    return null;
  } catch (err) {
    log.debug(`update check cache read failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** キャッシュを書き込む */
function writeCache(cache: UpdateCheckCache): void {
  try {
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache), { encoding: "utf-8" });
  } catch (err) {
    log.debug(`update check cache write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** npm registry から最新バージョンを取得する */
function fetchLatestVersion(packageName: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = `https://registry.npmjs.org/${packageName}/latest`;
    const req = https.get(url, { timeout: REQUEST_TIMEOUT_MS }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }

      let data = "";
      res.setEncoding("utf-8");
      res.on("data", (chunk: string) => {
        data += chunk;
      });
      res.on("end", () => {
        try {
          const parsed: unknown = JSON.parse(data);
          if (
            typeof parsed === "object" &&
            parsed != null &&
            "version" in parsed &&
            typeof (parsed as { version: string }).version === "string"
          ) {
            resolve((parsed as { version: string }).version);
          } else {
            reject(new Error("Unexpected response format"));
          }
        } catch {
          reject(new Error("JSON parse error"));
        }
      });
    });

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });
  });
}

/**
 * バージョン文字列を [major, minor, patch] に正規化する。
 * 不正な形式の場合は null を返す。
 */
function normalizeVersion(v: string): [number, number, number] | null {
  const m = v.trim().replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)/);
  if (m == null) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * セマンティックバージョンを比較する。
 * latest が current より新しければ true を返す。
 * いずれかが不正な形式の場合は false を返す。
 */
export function isNewerVersion(current: string, latest: string): boolean {
  const c = normalizeVersion(current);
  const l = normalizeVersion(latest);
  if (c == null || l == null) return false;

  if (l[0] !== c[0]) return l[0] > c[0];
  if (l[1] !== c[1]) return l[1] > c[1];
  return l[2] > c[2];
}

/**
 * 新しいバージョンが利用可能か非同期でチェックし、あればコンソールに通知する。
 * 起動をブロックしないよう、エラーは全て黙って無視する。
 */
export function checkForUpdates(
  packageName: string,
  currentVersion: string
): void {
  if (isUpdateCheckDisabled()) {
    log.debug("update check skipped by FLEQ_NO_UPDATE_CHECK");
    return;
  }

  // キャッシュが有効なら registry にアクセスしない
  const cache = readCache();
  if (cache != null && Date.now() - cache.lastCheck < CHECK_INTERVAL_MS) {
    if (isNewerVersion(currentVersion, cache.latestVersion)) {
      printUpdateNotice(currentVersion, cache.latestVersion, packageName);
    }
    return;
  }

  // 非同期で最新バージョンを取得
  fetchLatestVersion(packageName)
    .then((latestVersion) => {
      writeCache({ lastCheck: Date.now(), latestVersion });
      if (isNewerVersion(currentVersion, latestVersion)) {
        printUpdateNotice(currentVersion, latestVersion, packageName);
      }
    })
    .catch((err: unknown) => {
      log.debug(`update check failed: ${err instanceof Error ? err.message : String(err)}`);
    });
}

/** 更新通知を表示する */
function printUpdateNotice(
  current: string,
  latest: string,
  packageName: string
): void {
  console.log(
    chalk.yellow(
      `  Update available: v${current} → v${latest}  ` +
        chalk.gray(`npm install -g ${packageName}@latest`)
    )
  );
}
