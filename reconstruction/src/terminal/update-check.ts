import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { get } from "node:https";
import { join } from "node:path";

import { resolveRepoPath } from "../notification-delivery/adapter";

// P3-TO-AC13: 起動時の update check。確かめ方は旧築 src/engine/startup/update-checker.ts の写し
// （npm の registry、失敗したら GitHub の Releases、24 時間の cache、FLEQ_NO_UPDATE_CHECK、personal の build は確かめない）。
// cache は設定の場所の下（旧築の .update-check と同じ名前、新築の directory の中）。無いと起動のたびに registry へ出る。
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000, REQUEST_TIMEOUT_MS = 3_000;
const GITHUB_REPO = "Lateo2580/FlEq";

type FetchJson = (url: string) => Promise<unknown>;
type UpdateCheck = Readonly<{
  directory: string;
  env: NodeJS.ProcessEnv;
  // 既定は root の package.json の name と version（P3-CLI-D-VERSION と同じ 1 つ）。
  now: () => number;
  // 試験で差し替える（T14）。既定は https の GET で JSON を読む。
  fetchJson?: FetchJson;
  packageName?: string;
  version?: string;
}>;
type UpdateFound = Readonly<{ current: string; latest: string; packageName: string }>;

function httpsJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = get(url, { timeout: REQUEST_TIMEOUT_MS, headers: { "User-Agent": "fleq-update-checker" } }, (response) => {
      if (response.statusCode !== 200) { response.resume(); reject(new Error(`HTTP ${response.statusCode}`)); return; }
      let data = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { data += chunk; });
      response.on("end", () => { try { resolve(JSON.parse(data)); } catch (error) { reject(error); } });
    });
    request.on("error", reject);
    request.on("timeout", () => { request.destroy(new Error("Request timeout")); });
  });
}

// 外の JSON の欄は 1 つずつ確かめて読む（as で言い換えない）。
const versionOf = (data: unknown): string | null => data != null && typeof data === "object" && "version" in data && typeof data.version === "string" ? data.version : null;
const tagOf = (data: unknown): string | null => data != null && typeof data === "object" && "tag_name" in data && typeof data.tag_name === "string" ? data.tag_name : null;
function parts(version: string): readonly [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim().replace(/^v/, ""));
  return match == null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
}
function newer(current: string, latest: string): boolean {
  const left = parts(current), right = parts(latest);
  if (left == null || right == null) return false;
  return right[0] !== left[0] ? right[0] > left[0] : right[1] !== left[1] ? right[1] > left[1] : right[2] > left[2];
}
const disabled = (env: NodeJS.ProcessEnv): boolean =>
  ["1", "true", "yes", "on"].includes((env.FLEQ_NO_UPDATE_CHECK ?? "").toLowerCase());

function packageIdentity(): Readonly<{ name: string; version: string }> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(resolveRepoPath("package.json"), "utf8"));
    return parsed != null && typeof parsed === "object" && "name" in parsed && typeof parsed.name === "string" && "version" in parsed && typeof parsed.version === "string"
      ? { name: parsed.name, version: parsed.version } : null;
  } catch { return null; }
}

/** 新しい版があれば今の版・最新の版・package の名前を返す。失敗・確かめない起動・新しくない版は null（何も出さない、AC13 (2)）。 */
async function checkForUpdate(check: UpdateCheck): Promise<UpdateFound | null> {
  // AC13 (4): FLEQ_WS_URL のある起動（watch の子）は確かめない。
  if (disabled(check.env) || (check.env.FLEQ_WS_URL ?? "") !== "") return null;
  const identity = check.packageName != null && check.version != null ? { name: check.packageName, version: check.version } : packageIdentity();
  // personal の build は公開の版と比べる意味が無い（旧築と同じ）。
  if (identity == null || /-personal\b/i.test(identity.version)) return null;
  const found = (latest: string): UpdateFound | null => newer(identity.version, latest) ? { current: identity.version, latest, packageName: identity.name } : null;
  const fetchJson = check.fetchJson ?? httpsJson;
  const path = join(check.directory, ".update-check");
  try {
    const cached: unknown = JSON.parse(await readFile(path, "utf8"));
    const lastCheck = cached != null && typeof cached === "object" && "lastCheck" in cached && typeof cached.lastCheck === "number" ? cached.lastCheck : null;
    const latest = cached != null && typeof cached === "object" && "latestVersion" in cached && typeof cached.latestVersion === "string" ? cached.latestVersion : null;
    if (lastCheck != null && latest != null && check.now() - lastCheck < CHECK_INTERVAL_MS) return found(latest);
  } catch { /* cache が無いか読めなければ確かめ直す */ }
  try {
    const latest = await fetchJson(`https://registry.npmjs.org/${identity.name.replace("/", "%2F")}/latest`).then(versionOf)
      .then((version) => version ?? Promise.reject(new Error("Unexpected response format")))
      .catch(() => fetchJson(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`).then(tagOf));
    if (latest == null) return null;
    try {
      await mkdir(check.directory, { recursive: true, mode: 0o700 });
      await writeFile(path, JSON.stringify({ lastCheck: check.now(), latestVersion: latest }), "utf8");
    } catch { /* cache を書けなくても知らせは出す（旧築と同じ） */ }
    return found(latest);
  } catch {
    return null;
  }
}

export { checkForUpdate };
export type { FetchJson, UpdateCheck, UpdateFound };
