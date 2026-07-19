import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// 設定ディレクトリをテスト専用 tmp に隔離する。
// resolveConfigDir() は XDG_CONFIG_HOME を最優先で見るため、ここで差し替えれば
// ローカルマシンの実 theme.json (APPDATA/fleq/theme.json) にテストが影響されない。
// theme.ts の getThemePath() は呼び出し時に getConfigDir() を評価する (遅延) ので、
// setup で env を仕込めば後続の import より確実に先行する。
const tmpConfigHome = fs.mkdtempSync(path.join(os.tmpdir(), "fleq-studio-test-"));
process.env.XDG_CONFIG_HOME = tmpConfigHome;
