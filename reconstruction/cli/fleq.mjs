// 新築の fleq の入口（P3-CLI-REPL-001 AC01）。replay を先に振り分けるのは、replay の --out を commander に解釈させないことと、
// runner（frames.mjs）を通常起動で読み込まないため。通知と音を止めるのは、発注 1 は notify・sound を効かせる仕組みを持たず、旧築との並走で二重に出るため。
import childProcess from "node:child_process";
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
    // shortcut: OS の通知と音を止める（発注 2 の notify・sound・mute で置き換える）。darwin・linux の backend の spawn だけを止める（win32 では adapter が spawn しない）。
    const spawn = childProcess.spawn;
    childProcess.spawn = (_executable, _argv, options) => spawn("/usr/bin/true", [], options);
    // 静的 import にしない（spawn の差し替えより先に host.js が読まれるため）。
    const { runCli } = await import("../dist/src/cli/cli.js");
    code = await runCli(argv);
  }
  process.stdout.write("", () => process.exit(code));
}
