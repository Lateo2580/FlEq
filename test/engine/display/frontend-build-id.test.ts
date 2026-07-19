import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFrontendBuildIdReader } from "../../../src/engine/display/frontend-build-id";

describe("createFrontendBuildIdReader", () => {
  let dir: string;
  let indexPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fleq-buildid-"));
    indexPath = join(dir, "index.html");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("index.html が無ければ null を返す (dist 未ビルド)", () => {
    const read = createFrontendBuildIdReader(dir);
    expect(read()).toBeNull();
  });

  it("同一内容の間は安定した非空ハッシュを返す", () => {
    writeFileSync(indexPath, "<html>v1</html>");
    const read = createFrontendBuildIdReader(dir);
    const first = read();
    expect(first).not.toBeNull();
    expect(first).toBe(read());
  });

  it("内容が変わると (mtime も変わると) 値が変わる", () => {
    writeFileSync(indexPath, "<html>v1</html>");
    const read = createFrontendBuildIdReader(dir);
    const v1 = read();

    writeFileSync(indexPath, "<html>v2 different asset hash</html>");
    // 同一秒内書き込みで mtime が変わらない環境向けに mtime を明示的に進める
    const future = new Date(Date.now() + 5_000);
    utimesSync(indexPath, future, future);
    const v2 = read();

    expect(v2).not.toBeNull();
    expect(v2).not.toBe(v1);
  });

  it("mtime が据え置かれれば内容を裏で変えても再ハッシュせずキャッシュ値を返す", () => {
    writeFileSync(indexPath, "<html>v1</html>");
    const stamp = new Date(Date.now() - 10_000);
    utimesSync(indexPath, stamp, stamp);
    const read = createFrontendBuildIdReader(dir);
    const cached = read(); // この mtime とハッシュをキャッシュさせる

    // 内容を差し替えても mtime を同じ値に戻せば、mtime 一致でキャッシュヒット → 旧ハッシュのまま
    writeFileSync(indexPath, "<html>v1 tampered with a very different body</html>");
    utimesSync(indexPath, stamp, stamp);
    expect(read()).toBe(cached);
  });
});
