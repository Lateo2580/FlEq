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
  } else {
    process.env.DOTENV_CONFIG_QUIET = "true";
    dotenv.config();
    const { runCli } = await import("../dist/src/cli/cli.js");
    code = await runCli(argv);
  }
  process.stdout.write("", () => process.exit(code));
}
