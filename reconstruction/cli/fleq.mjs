// 新築の fleq の入口（P3-CLI-REPL-001 AC01）。replay を先に振り分けるのは、replay の --out を commander に解釈させないことと、
// runner（frames.mjs）を通常起動で読み込まないため。
import { realpathSync } from "node:fs";
import dotenv from "dotenv";

if (process.argv[1] != null && realpathSync(process.argv[1]) === import.meta.filename) {
  const argv = process.argv.slice(2);
  let code;
  if (argv[0] === "replay") {
    const { runReplay } = await import("./replay.mjs");
    code = await runReplay(argv.slice(1));
  } else if (argv[0] === "watch") {
    const { runWatch } = await import("./watch.mjs");
    code = await runWatch(argv.slice(1));
  } else {
    process.env.DOTENV_CONFIG_QUIET = "true";
    dotenv.config();
    const { runCli } = await import("../dist/src/cli/cli.js");
    code = await runCli(argv);
  }
  if (process.platform === "win32") process.exit(code); // P3-TW-D-EXIT: Windows の stdout は書く動作が呼び出しの中で終わるので待つ相手が無く、pipe の 0 byte の書き込みは止まらない保証が無い
  process.stdout.write("", () => process.exit(code));
}
