import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * display/dist/index.html の内容ハッシュを返す getter を作る。フロント資産のビルド識別子として
 * snapshot/state に載せ、クライアントが変化を検知して自動リロードする (protocol frontendBuildId)。
 *
 * vite build は資産ハッシュ付きのファイル名を index.html の script/css 参照に埋め込むため、
 * フロントが 1 バイトでも変われば index.html の内容ハッシュが変わる。プロセス再起動なしの
 * display:build 単体反映も検知できるよう、呼び出しごとに mtime を stat し、変化時のみ再ハッシュする
 * (index.html は小さいので毎回フルハッシュでも許容だが、無用な read を避けるため mtime キャッシュ)。
 *
 * dist 未ビルド・read 失敗時は null を返す (クライアントは frontendBuildId 欠落として何もしない)。
 */
export function createFrontendBuildIdReader(distDir: string): () => string | null {
  const indexPath = join(distDir, "index.html");
  let cachedMtimeMs: number | null = null;
  let cachedId: string | null = null;
  return () => {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(indexPath).mtimeMs;
    } catch {
      return null;
    }
    if (mtimeMs === cachedMtimeMs) return cachedId;
    try {
      const buf = readFileSync(indexPath);
      cachedId = createHash("sha256").update(buf).digest("hex").slice(0, 16);
      cachedMtimeMs = mtimeMs;
      return cachedId;
    } catch {
      return null;
    }
  };
}
