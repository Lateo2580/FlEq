// P3-CLI-REPL-001（C18）【発注 1】: 新築の設定ファイル（spec:487、§11.5）の中身。置き場は旧築と別の directory（spec §10.2、P3-CLI-D-SETTINGS-PLACE）。
// 旧築の key のうち互換必須の入口が使うものを、旧築と同じ名前・同じ値の形で持つ。効き先は【発注 2】【発注 3】（P3-CLI-D-KEYS）。
import type { DmdataClassification, DmdataConnectFailure, DmdataTestMode } from "./p3-dmdata-connect.types";
import type { NotificationAttempt } from "./p2-notification-delivery.types";
import type { ShutdownSummary } from "./p2-shared-runtime.types";

// 旧築 src/types.ts の NotifyCategory の 18 個。値の形は旧築のまま運び、unit への読み替えと H11 の既定は【発注 2】が決める。
export type LegacyNotifyCategory =
  | "eew" | "earthquake" | "tsunami" | "seismicText" | "nankaiTrough" | "lgObservation" | "volcano" | "weather" | "tornado"
  | "briefing" | "earlyWeather" | "weatherWarningTimeseries" | "climateInfo" | "weatherExplanation" | "heatAlert"
  | "typhoonAnalysis" | "typhoonProbability" | "floodForecast";

// 旧築 src/config.ts の VALID_EEW_LOG_FIELDS の 12 個（REPL の eewlog、【発注 3】）。
export type EewLogField =
  | "hypocenter" | "originTime" | "coordinates" | "magnitude" | "forecastIntensity" | "maxLgInt" | "forecastAreas"
  | "lgIntensity" | "isPlum" | "hasArrived" | "diff" | "maxIntChangeReason";

// H50・spec 16.2.1（2026-10-31 作者）: all＝全部出して「設定した地域は対象外」を添える（暫定の既定）、regionOnly＝設定した地域の情報だけを出す。
// 何を出さなくなるかと見た目は P4 が決める。C18 は値と検査と移行だけを持つ。
export type RegionScope = "all" | "regionOnly";

// 【発注 2】mute の条件 1 つ（P3-CLI-D-O2-MUTE、Q-CLI-O2-AUTHOR-3）。mute の引数でその回だけ付け、その mute と一緒に持ち越す: その分野の通知のうち、音の段が level 以上のもの（normal < warning < critical）。
// 段は各 unit の intent の payload.level で、震度や階級を読み直さない。info と cancel の通知はどの条件にも当たらない。
export type MuteRule = Readonly<{ category: LegacyNotifyCategory; level: "normal" | "warning" | "critical" }>;
// 【発注 2】設定ファイルに持ち越す mute（P3-CLI-D-O2-MUTE-PERSIST=B）。until は終わりの wall の時刻（ms）で、null は mute off まで。
// FleqSettings の mute?: PersistedMute は実装が足す（AC17 の (1)）。実行中の終わりは monotonic で決める（monotonic は再起動を越えない）。
export type PersistedMute = Readonly<{ until: number | null; rules: readonly MuteRule[] }>;

// 設定ファイル（JSON の object 1 つ）の型。欄が無いことは「未設定」で、既定は読む側が当てる（旧築と同じ）。
export type FleqSettings = Readonly<{
  apiKey?: string;
  // 旧築（fleq）とも、旧築の設定の appName とも、ほかの稼働端末とも重ならない名前。既定は置かない（spec §10.1、P3-CLI-D-APPNAME）。
  appName?: string;
  classifications?: readonly DmdataClassification[];
  testMode?: DmdataTestMode;
  display?: boolean;
  // 既定は 7789（旧築の 7788 と分ける、spec §10.2）。旧築の値は移行で写さない（P3-CLI-D-DISPLAY）。
  displayPort?: number;
  // P4 で認証ができるまでは 127.0.0.1 だけ（host が渡せる bind が 127.0.0.1 だけ、P3-CLI-D-DISPLAY）。
  displayHost?: string;
  // 旧築の値は移行で写さない（spec §10.2 の display token の分離）。
  displayToken?: string;
  summaryInterval?: number;
  promptClock?: "elapsed" | "clock" | "uptime";
  waitTipIntervalMin?: number;
  // notify・sound は発注 1 では保存だけで、発注 1 の起動は通知と音を出さない（P3-CLI-D-SILENT）。効くのは発注 2 から。
  notify?: Readonly<Partial<Record<LegacyNotifyCategory, boolean>>>;
  sound?: boolean;
  eewLog?: boolean;
  eewLogFields?: Readonly<Partial<Record<EewLogField, boolean>>>;
  // 自宅の市区町村（spec 16.2.1）。書いた文字をそのまま持ち、区域の対応表の契約がコードの体系と存在の検査を足す。
  region?: string;
  regionScope?: RegionScope;
  // mute の終わりと条件。P3-CLI-D-O2-MUTE-PERSIST=B
  mute?: PersistedMute;
}>;

// 【発注 2】B12（spec:381）の typed command。REPL の 1 行はこの型に 1 か所（parseReplLine）で変え、変えられない行は副作用の無い invalid にする。
export type ReplCommand =
  | Readonly<{ kind: "help"; topic: string | null; sub: string | null }>
  | Readonly<{ kind: "commands"; query: string | null }>
  | Readonly<{ kind: "status" }>
  | Readonly<{ kind: "config" }>
  | Readonly<{ kind: "notify"; action: Readonly<{ kind: "show" }> | Readonly<{ kind: "all"; enabled: boolean }>
      | Readonly<{ kind: "category"; category: LegacyNotifyCategory; enabled: boolean | "toggle" }> }>
  | Readonly<{ kind: "sound"; enabled: boolean | null }>
  // mute の on: durationMs が null なら mute off まで、rules が空なら完全 mute（Q-CLI-O2-AUTHOR-3）。
  | Readonly<{ kind: "mute"; action: Readonly<{ kind: "off" }> | Readonly<{ kind: "on"; durationMs: number | null; rules: readonly MuteRule[] }> }>
  | Readonly<{ kind: "retry" }>
  | Readonly<{ kind: "display"; action: "status" | "on" | "off" }>
  | Readonly<{ kind: "quit" }>;
export type ReplParse = Readonly<{ kind: "empty" }> | Readonly<{ kind: "command"; command: ReplCommand }> | Readonly<{ kind: "invalid"; message: string }>;

// 【発注 2】通知の門（P3-CLI-D-O2-GATE）。host は試行を adapter へ渡す直前に 1 回だけ聞き、allow が false なら子を作らずに delivered で終える。
// stage は止めた段、settingsVersion は判定した時の通知の設定の版（起動から REPL で通知の設定を変えた回数、起動は 0）。spec:487 の説明に使う（P3-CLI-D-O2-SETTINGS-VERSION）。
export type NotificationGateVerdict = Readonly<{ allow: true }> | Readonly<{ allow: false; stage: "sound" | "category" | "mute"; settingsVersion: number }>;
export type NotificationGate = (attempt: NotificationAttempt) => NotificationGateVerdict;

export type HostStatus = Readonly<{
  connection: "connected" | "connecting" | "disconnected";
  // host が今持つ自分の socket の id（P3-C2-OWNERSHIP の ownSocketId）。無ければ null。
  socketId: number | null;
  // 繋ぎ直しの数 n（繋ぎ直しの timer を張った数。60 秒以上続いた確立した接続を失うと 0 から数え直す）。確立している間は 0（旧築の「再接続試行」、P3-DC2-AC02）。
  failedAttempts: number;
  // 最後に終わった接続の失敗の理由。形の正しい start の受理（{ wsUrl } は open）で null（P3-DC2-AC03）。
  lastFailure: DmdataConnectFailure | null;
  // ping を含む最後の frame の wall。起動から 1 つも受けていなければ null で、切断で消さない（P3-DC2-AC04）。
  lastFrameWallMs: number | null;
  // 確立した接続（start を受理した。{ wsUrl } は open した）を失った数。run の中で 0 から増えるだけ（P3-DC2-AC09）。
  lostConnections: number;
  display: Readonly<{ port: number; clients: number }> | null;
}>;

// 【発注 2】command port（P3-CLI-D-O2-COMMAND）。startP2Host の戻り値。domain の state を変える口は持たない。
export type HostCommandPort = Readonly<{
  displayPort: number | null;
  stop(): Promise<ShutdownSummary>;
  // 切れている間だけ、待ちの timer を止めて今すぐ繋ぎ直す。繋がっている・試している・受信の待ちの片付け中・停止中は何もしない。
  // openDisplay・closeDisplay は host の中で 1 本に並べ、閉じている途中の openDisplay はその close の終わりを待ってから開く。
  reconnect(): "started" | "connected" | "connecting" | "draining" | "stopping";
  openDisplay(port: number): Promise<Readonly<{ kind: "opened" | "alreadyOpen"; port: number }> | Readonly<{ kind: "portInUse" | "failed" | "stopping" }>>;
  closeDisplay(): Promise<"closed" | "notOpen">;
  status(): HostStatus;
}>;
