import { describe, it, expect } from "vitest";
import { withStdoutCapture } from "../lib/stdout-capture";
// stdout-capture が制御するのと同じインスタンス (ルート node_modules の chalk) を使う
import chalk from "../../../node_modules/chalk";

describe("stdout-capture", () => {
  it("console.log の出力を文字列で捕捉する", async () => {
    const captured = await withStdoutCapture({ noColor: true }, async () => {
      console.log("hello");
      console.log("world");
    });
    expect(captured).toBe("hello\nworld\n");
  });

  it("noColor: false 時は chalk が TrueColor (level 3) で着色する", async () => {
    const captured = await withStdoutCapture({ noColor: false }, async () => {
      console.log(chalk.rgb(255, 0, 0)("red text"));
    });
    expect(captured).toContain("\x1b[38;2;255;0;0m");
    expect(captured).toContain("red text");
  });

  it("noColor: true 時は ANSI escape が含まれない", async () => {
    const captured = await withStdoutCapture({ noColor: true }, async () => {
      console.log(chalk.rgb(255, 0, 0)("red text"));
    });
    expect(captured).not.toContain("\x1b[");
    expect(captured).toContain("red text");
  });

  it("関数終了後 process.stdout.write と chalk.level が元に戻る", async () => {
    const originalWrite = process.stdout.write;
    const originalLevel = chalk.level;
    await withStdoutCapture({ noColor: true }, async () => {
      console.log("captured");
    });
    expect(process.stdout.write).toBe(originalWrite);
    expect(chalk.level).toBe(originalLevel);
  });

  it("関数が throw しても process.stdout.write と chalk.level が復元される", async () => {
    const originalWrite = process.stdout.write;
    const originalLevel = chalk.level;
    await expect(
      withStdoutCapture({ noColor: true }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(process.stdout.write).toBe(originalWrite);
    expect(chalk.level).toBe(originalLevel);
  });
});
