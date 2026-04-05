import type { CommandEntry } from "./types";
import type { ReplContext } from "./types";
import * as info from "./info-handlers";
import * as settings from "./settings-handlers";
import * as ops from "./operation-handlers";

/** コマンド定義を生成する。ctx は遅延参照されるため、構築時点で ReplContext が完成している必要はない */
export function buildCommandMap(getCtx: () => ReplContext): Record<string, CommandEntry> {
  return {
    help: {
      description: "コマンドの詳細を表示 (例: help notify)",
      detail: "help <command>: コマンドの詳細を表示\n  help <command> <sub>: サブコマンドの詳細を表示\n  一覧は commands コマンドで表示できます。",
      category: "info",
      handler: (args) => info.handleHelp(getCtx(), args),
    },
    commands: {
      description: "コマンド一覧を表示 (例: commands settings)",
      detail: "引数なし: 全コマンドをカテゴリ別に一覧表示\n  commands <category>: カテゴリで絞り込み (info / status / settings / operation)\n  commands <query>: 名前・説明で検索",
      category: "info",
      handler: (args) => info.handleCommands(getCtx(), args),
    },
    "?": {
      description: "help のエイリアス",
      category: "info",
      handler: (args) => info.handleHelp(getCtx(), args),
    },
    history: {
      description: "地震履歴を取得・表示 (例: history 5)",
      detail: "dmdata.jp API から直近の地震履歴を取得します。\n  引数: 件数 (1〜100, デフォルト10)\n  例: history 20",
      category: "info",
      handler: (args) => info.handleHistory(getCtx(), args),
    },
    stats: {
      description: "電文統計を表示",
      category: "info",
      handler: () => info.handleStats(getCtx()),
    },
    colors: {
      description: "カラーパレット・震度色の一覧を表示",
      detail: "CUD (カラーユニバーサルデザイン) パレットと、\n  震度・長周期地震動階級・フレームレベルに対応する色を確認できます。",
      category: "info",
      handler: () => info.handleColors(),
    },
    detail: {
      description: "直近の情報を再表示 (例: detail tsunami, detail volcano)",
      detail: "引数なし: 津波情報を再表示 (デフォルト)\n  detail tsunami: 津波情報を再表示\n  detail volcano: 火山警報状態を再表示",
      category: "info",
      subcommands: {
        tsunami: { description: "津波情報を再表示" },
        volcano: { description: "火山警報状態を再表示" },
      },
      handler: (args) => info.handleDetail(getCtx(), args),
    },
    status: {
      description: "WebSocket 接続状態を表示",
      detail: "現在の WebSocket 接続状態、SocketID、再接続試行回数を表示します。",
      category: "status",
      handler: () => info.handleStatus(getCtx()),
    },
    config: {
      description: "現在の設定を表示",
      detail: "Configファイルに保存された設定を一覧表示します。",
      category: "status",
      handler: () => info.handleConfig(),
    },
    contract: {
      description: "契約区分一覧を表示",
      detail: "dmdata.jp で契約している区分を API から取得して表示します。",
      category: "status",
      handler: () => info.handleContract(getCtx()),
    },
    socket: {
      description: "接続中のソケット一覧を表示",
      detail: "dmdata.jp で現在開いているソケット一覧を表示します。",
      category: "status",
      handler: () => info.handleSocket(getCtx()),
    },
    notify: {
      description: "通知設定の表示・切替 (例: notify eew on)",
      detail: "引数なし: 現在の通知設定を一覧表示\n  notify <category>: トグル切替\n  notify <category> on: 有効にする\n  notify <category> off: 無効にする\n  notify all:on / all:off: 一括操作\n  カテゴリ: eew, earthquake, tsunami, seismicText, nankaiTrough, lgObservation, volcano",
      category: "settings",
      subcommands: {
        "<category>": { description: "トグル切替 / on / off" },
        "all:on": { description: "全カテゴリを有効にする" },
        "all:off": { description: "全カテゴリを無効にする" },
      },
      handler: (args) => settings.handleNotify(getCtx(), args),
    },
    eewlog: {
      description: "EEWログ記録の設定 (例: eewlog on / eewlog fields)",
      detail: "eewlog: 現在のログ記録設定を表示\n  eewlog on: ログ記録を有効にする\n  eewlog off: ログ記録を無効にする\n  eewlog fields: 記録項目の一覧表示 (グループ別)\n  eewlog fields <field>: 項目のトグル切替\n  eewlog fields <field> on/off: 項目の有効/無効\n  [震源] hypocenter, originTime, coordinates\n  [規模] magnitude\n  [変化] diff, maxIntChangeReason\n  [予測概要] forecastIntensity, maxLgInt\n  [予測地域] forecastAreas, lgIntensity, isPlum, hasArrived",
      category: "settings",
      subcommands: {
        on: { description: "ログ記録を有効にする" },
        off: { description: "ログ記録を無効にする" },
        fields: { description: "記録項目の一覧・切替" },
      },
      handler: (args) => settings.handleEewLog(getCtx(), args),
    },
    tablewidth: {
      description: "テーブル幅の表示・変更 (例: tablewidth 80 / tablewidth auto)",
      detail: "引数なし: 現在のテーブル幅を表示\n  tablewidth <40〜200>: テーブル幅を固定値に変更\n  tablewidth auto: ターミナル幅に自動追従 (デフォルト)\n  変更は即座に反映され、Configファイルに保存されます。",
      category: "settings",
      subcommands: {
        "<40-200>": { description: "テーブル幅を固定値に変更" },
        auto: { description: "ターミナル幅に自動追従" },
      },
      handler: (args) => settings.handleTableWidth(getCtx(), args),
    },
    infotext: {
      description: "お知らせ電文の全文/省略切替 (例: infotext full)",
      detail: "infotext full: 全文表示\n  infotext short: 省略表示 (デフォルト)",
      category: "settings",
      subcommands: {
        full: { description: "全文表示" },
        short: { description: "省略表示 (デフォルト)" },
      },
      handler: (args) => settings.handleInfoText(getCtx(), args),
    },
    tipinterval: {
      description: "待機中ヒント表示間隔の表示・変更 (例: tipinterval 15)",
      detail: "tipinterval: 現在のヒント間隔(分)を表示\n  tipinterval <0〜1440>: ヒント間隔を分で変更 (0で無効)",
      category: "settings",
      subcommands: {
        "<0-1440>": { description: "ヒント間隔を分で変更 (0で無効)" },
      },
      handler: (args) => settings.handleTipInterval(getCtx(), args),
    },
    mode: {
      description: "表示モード切替 (例: mode compact)",
      detail: "mode: 現在のモードを表示\n  mode normal: フルフレーム表示 (デフォルト)\n  mode compact: 1行サマリー表示\n  長時間モニタリング時は compact がおすすめです。",
      category: "settings",
      subcommands: {
        normal: { description: "フルフレーム表示 (デフォルト)" },
        compact: { description: "1行サマリー表示" },
      },
      handler: (args) => settings.handleMode(getCtx(), args),
    },
    filter: {
      description: "フィルタの表示・設定 (例: filter set domain = \"eew\")",
      detail: "filter: 現在のフィルタ状態を表示\n  filter set <expr>: フィルタを即時適用\n  filter clear: フィルタを解除\n  filter test <expr>: 構文チェックのみ（適用しない）",
      category: "settings",
      subcommands: {
        set: { description: "フィルタを即時適用" },
        clear: { description: "フィルタを解除" },
        test: { description: "構文チェックのみ" },
      },
      handler: (args) => settings.handleFilter(getCtx(), args),
    },
    focus: {
      description: "focus の表示・設定",
      detail: "focus: 現在の状態表示\n  focus <expr>: 適用\n  focus off: 解除",
      category: "settings",
      subcommands: {
        "<expr>": { description: "focus を適用" },
        off: { description: "focus を解除" },
      },
      handler: (args) => settings.handleFocus(getCtx(), args),
    },
    clock: {
      description: "プロンプト時計の切替 (例: clock / clock uptime)",
      detail: "clock: 経過時間→現在時刻→稼働時間をトグル切替\n  clock elapsed: 経過時間表示 (デフォルト)\n  clock now: 現在時刻表示\n  clock uptime: 稼働時間表示 (DDD:HH:MM:SS)",
      category: "settings",
      subcommands: {
        elapsed: { description: "経過時間表示 (デフォルト)" },
        now: { description: "現在時刻表示" },
        uptime: { description: "稼働時間表示 (DDD:HH:MM:SS)" },
      },
      handler: (args) => settings.handleClock(getCtx(), args),
    },
    night: {
      description: "ナイトモードの切替",
      detail: "night: 現在の状態表示\n  night on: ナイトモード有効\n  night off: ナイトモード無効",
      category: "settings",
      subcommands: {
        on: { description: "有効にする" },
        off: { description: "無効にする" },
      },
      handler: (args) => settings.handleNight(getCtx(), args),
    },
    summary: {
      description: "定期要約の表示・設定 (on [分] で間隔指定可)",
      detail: "summary: 現在の設定を表示\n  summary on [N]: N分間隔で要約 (デフォルト10分)\n  summary off: 停止\n  summary now: 今すぐ要約表示",
      category: "settings",
      subcommands: {
        on: { description: "定期要約を開始" },
        off: { description: "定期要約を停止" },
        now: { description: "今すぐ要約を表示" },
      },
      handler: (args) => settings.handleSummary(getCtx(), args),
    },
    sound: {
      description: "通知音の ON/OFF 切替",
      detail: "sound: 現在の状態を表示\n  sound on: 通知音を有効にする\n  sound off: 通知音を無効にする",
      category: "settings",
      subcommands: {
        on: { description: "通知音を有効にする" },
        off: { description: "通知音を無効にする" },
      },
      handler: (args) => settings.handleSound(getCtx(), args),
    },
    theme: {
      description: "カラーテーマの表示・管理 (例: theme path / theme reload)",
      detail: "theme: テーマ概要を表示\n  theme path: theme.json のパスを表示\n  theme show: 全パレット色・全ロールスタイルを一覧表示\n  theme reset: デフォルト theme.json を書き出し\n  theme reload: theme.json を再読込\n  theme validate: theme.json を検証",
      category: "settings",
      subcommands: {
        path: { description: "theme.json のパスを表示" },
        show: { description: "全パレット色・ロールスタイル一覧" },
        reset: { description: "デフォルト theme.json を書き出し" },
        reload: { description: "theme.json を再読込" },
        validate: { description: "theme.json を検証" },
      },
      handler: (args) => settings.handleTheme(getCtx(), args),
    },
    mute: {
      description: "通知を一時ミュート (例: mute 30m)",
      detail: "mute: 現在のミュート状態を表示\n  mute <duration>: 指定時間ミュート (例: 30m, 1h, 90s)\n  mute off: ミュート解除",
      category: "settings",
      subcommands: {
        "<duration>": { description: "指定時間ミュート (例: 30m, 1h)" },
        off: { description: "ミュート解除" },
      },
      handler: (args) => settings.handleMute(getCtx(), args),
    },
    fold: {
      description: "観測点の表示件数制限 (例: fold 10 / fold off)",
      detail: "fold: 現在の設定を表示\n  fold <N>: 上位N件に制限\n  fold off: 全件表示に戻す",
      category: "settings",
      subcommands: {
        "<N>": { description: "観測点を上位N件に制限 (1〜999)" },
        off: { description: "全件表示に戻す" },
      },
      handler: (args) => settings.handleFold(getCtx(), args),
    },
    limit: {
      description: "省略表示の上限設定 (例: limit volcanoAlertLines 15)",
      detail: "limit: 現在の省略設定を一覧表示\n  limit <key> <N>: 上限値を変更 (1〜999)\n  limit <key> default: デフォルト値に戻す\n  limit reset: 全項目をデフォルトに戻す",
      category: "settings",
      subcommands: {
        "<key> <N>": { description: "上限値を変更 (1〜999)" },
        "<key> default": { description: "デフォルト値に戻す" },
        reset: { description: "全項目をデフォルトに戻す" },
      },
      handler: (args) => settings.handleLimit(getCtx(), args),
    },
    test: {
      description: "テスト機能",
      detail: "test sound [level]: サウンドテスト\n  test table [type] [番号]: 表示形式テスト",
      category: "operation",
      subcommands: {
        sound: {
          description: "サウンドテスト",
          detail: "引数なし: 利用可能なサウンドレベル一覧を表示\n  test sound <level>: 指定レベルのサウンドを再生\n  レベル: critical, warning, normal, info, cancel",
        },
        table: {
          description: "表示形式テスト",
          detail: "引数なし: 利用可能な電文タイプ一覧を表示\n  test table <type>: バリエーション一覧を表示\n  test table <type> <番号>: 指定バリエーションを表示\n  タイプ: earthquake, eew, tsunami, seismicText, nankaiTrough, lgObservation, volcano",
        },
      },
      handler: (args) => ops.handleTest(getCtx(), args),
    },
    clear: {
      description: "ターミナル画面をクリア",
      category: "operation",
      handler: () => ops.handleClear(),
    },
    backup: {
      description: "EEW副回線の起動/停止 (例: backup on)",
      detail: "backup: 副回線の状態を表示\n  backup on: 副回線を起動\n  backup off: 副回線を停止",
      category: "operation",
      subcommands: {
        on: { description: "副回線を起動" },
        off: { description: "副回線を停止" },
      },
      handler: (args) => ops.handleBackup(getCtx(), args),
    },
    retry: {
      description: "WebSocket 再接続を試行",
      detail: "切断中の場合に手動で再接続を試みます。",
      category: "operation",
      handler: () => ops.handleRetry(getCtx()),
    },
    quit: {
      description: "アプリケーションを終了",
      category: "operation",
      handler: () => ops.handleQuit(getCtx()),
    },
    exit: {
      description: "quit のエイリアス",
      category: "operation",
      handler: () => ops.handleQuit(getCtx()),
    },
  };
}
