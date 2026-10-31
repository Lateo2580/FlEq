// P3-DMDATA-CONNECT-001（R63・D-P3-3）: 本物の dmdata へつなぐ live 起動入口の入力。
// startP2Host の config に { dmdata } として渡す（{ wsUrl } と排他）。C18 の CLI はこの型を組み立てて渡す。
// apiKey は host の REST 呼出しの Authorization header にだけ使い、診断・snapshot・例外文・観測・標準出力へ出さない（spec §7.9）。

// 旧築の既定購読の 5 区分（src/types.ts:404 の DEFAULT_CONFIG）を閉集合にする。購読区分は今は広げない（R54）。
export type DmdataClassification =
  | "telegram.earthquake" | "eew.forecast" | "eew.warning" | "telegram.volcano" | "telegram.weather";

export type DmdataSubscription = Readonly<{
  apiKey: string;
  // 旧築（fleq）とも、ほかの稼働端末とも重ならない名前（spec §10.1）。空と "fleq" は起動時に拒否する。
  appName: string;
  // 1 件以上・重複なし（host の起動時に検査）。socket start の body へこの順で渡す。
  classifications: readonly DmdataClassification[];
  testMode?: DmdataTestMode;
}>;

// P3-CLI-REPL-001（C18）の --test と設定の testMode。socket start の test にそのまま渡す（P3-CLI-D-TEST）。
// C18（P3-CLI-REPL-001）の発注 1 が DmdataSubscription の classifications の後に testMode?: DmdataTestMode を足した（省略は no）。
export type DmdataTestMode = "no" | "including" | "only";

// P3-DMDATA-CONNECT-002（P3-DC2-D-REASON）: 最後に終わった接続の失敗の理由。HostStatus.lastFailure に載せ、文と手引きは C19 が出す。
// dmdata は dmdata が答えたが受け付けなかった（401・403 以外の非 2xx、形の不正）、network は答えが来なかった（WS の段の失敗を含む）。
export type DmdataConnectFailure = "network" | "dmdata" | "authRejected" | "capacity" | "startUncertain";
