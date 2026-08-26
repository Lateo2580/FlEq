import type {
  DetailProvider,
  DetailSnapshotOf,
  ParsedTornadoAdvisory,
} from "../../types";

/** 直近に受理された竜巻注意情報を detail コマンドへ渡す。 */
export class TornadoDetailProvider implements DetailProvider<"tornado"> {
  readonly category = "tornado";
  readonly emptyMessage = "竜巻注意情報はまだ受信していません";
  private latest: ParsedTornadoAdvisory | null = null;

  rememberLatest(info: ParsedTornadoAdvisory): void {
    this.latest = info;
  }

  getDetail(): DetailSnapshotOf<"tornado"> | null {
    return this.latest == null ? null : { kind: "tornado", info: this.latest };
  }
}
