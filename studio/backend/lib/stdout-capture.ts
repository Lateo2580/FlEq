import { Console } from "console";
import { Writable } from "stream";
// 素の "chalk" は studio/node_modules の transitive コピーに解決され、
// src/ui (ルート node_modules の chalk) とは別インスタンスになる。
// level 制御を本番 formatter に効かせるため、ルートのコピーを明示 import する。
import chalk from "../../../node_modules/chalk";

export interface StdoutCaptureOptions {
  noColor: boolean;
}

export async function withStdoutCapture(
  options: StdoutCaptureOptions,
  fn: () => Promise<void> | void,
): Promise<string> {
  const buf: string[] = [];
  const originalWrite = process.stdout.write;
  const originalNoColor = process.env.NO_COLOR;
  const originalForceColor = process.env.FORCE_COLOR;
  const originalLevel = chalk.level;
  const originalConsole = console;

  if (options.noColor) {
    process.env.NO_COLOR = "1";
    delete process.env.FORCE_COLOR;
    chalk.level = 0;
  } else {
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = "3";
    chalk.level = 3;
  }

  // Replace process.stdout.write so direct writes are captured
  process.stdout.write = ((chunk: string | Uint8Array) => {
    const str = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8");
    buf.push(str);
    return true;
  }) as typeof process.stdout.write;

  // Also replace global console with one backed by our buffer stream,
  // because in vitest the global console writes to a custom Writable (not process.stdout).
  const captureStream = new Writable({
    write(chunk: Buffer | string, _encoding: string, callback: () => void) {
      const str = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
      buf.push(str);
      callback();
    },
  });
  (global as { console: Console }).console = new Console({
    stdout: captureStream,
    stderr: captureStream,
  });

  try {
    await fn();
  } finally {
    process.stdout.write = originalWrite;
    (global as { console: Console }).console = originalConsole;
    if (originalNoColor == null) {
      delete process.env.NO_COLOR;
    } else {
      process.env.NO_COLOR = originalNoColor;
    }
    if (originalForceColor == null) {
      delete process.env.FORCE_COLOR;
    } else {
      process.env.FORCE_COLOR = originalForceColor;
    }
    chalk.level = originalLevel;
  }

  return buf.join("");
}
