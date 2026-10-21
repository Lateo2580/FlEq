import type { ReportRef } from "../../contracts/p2-shared-runtime.types";

// P3-VERSION-MATERIAL-001（K7、spec §16 H14・16.2.5）: 新旧の比べ方・版の鍵・未確認の印の付け外し・ReportRef の読み戻しの正本。
// 無いと 12 の比較関数と 12 の codec が種類の表と印の規則を別々に持ち、表の直しが 12 か所に散る（P3-VM-AC02）。

// P3-VM-D-TABLE=A: Head/ReportDateTime を先に比べ、同じなら Control/DateTime で比べる種類。ほかの種類は Control/DateTime だけで比べる。
const HEAD_THEN_CONTROL: ReadonlySet<string> = new Set(["VPWS50", "VPWW55", "VPWW56", "VPWW57", "VPWW58", "VPWW59", "VPWW60", "VPWW61",
  "VPNO50", "VPWP50", "VPZJ51", "VPCJ51", "VPFJ51", "VMCJ53", "VMCJ54", "VMCJ55", "VPBS50", "VPBS51"]);
// P3-VM-D-SAMETIME=A の例外: EEW は Control/DateTime が同じなら Serial の大きい方を新しい版とする（同じ秒の続報）。
const EEW: ReadonlySet<string> = new Set(["VXSE43", "VXSE44", "VXSE45"]);

type VersionOrder = "older" | "newer" | "same" | "undecidable";
// 比べるのに要る欄だけ（U-N の証拠だけの記録は ReportRef を持たない、P3-AUTH-AC01）。
type VersionRef = Pick<ReportRef, "family" | "reportDateTimeRaw" | "controlDateTimeRaw" | "serialRaw">;

const readable = (raw: string): boolean => Number.isFinite(Date.parse(raw));
const headFirst = (ref: VersionRef): boolean => HEAD_THEN_CONTROL.has(ref.family);

// 比べる時刻を確かめられる版か（AC04 の (a)・(b) の分かれ目。印の理由の欄を持たない代わり）。
function versionTimed(ref: VersionRef): boolean {
  return readable(ref.controlDateTimeRaw) && (!headFirst(ref) || readable(ref.reportDateTimeRaw));
}

// P3-VM-AC02: a は手元の版（無ければ null）、b は受けた報。表の別の側の種類どうしは両方が持つ Control/DateTime だけで比べる。
function compareVersion(a: VersionRef | null, b: VersionRef): VersionOrder {
  const both = headFirst(b) && (a == null || headFirst(a));
  if (both && !readable(b.reportDateTimeRaw)) return "undecidable";
  if (a == null) return both || readable(b.controlDateTimeRaw) ? "newer" : "undecidable";
  if (both && !readable(a.reportDateTimeRaw)) return "newer";
  if (both) {
    const head = Date.parse(b.reportDateTimeRaw) - Date.parse(a.reportDateTimeRaw);
    if (head !== 0) return head > 0 ? "newer" : "older";
  }
  if (!readable(b.controlDateTimeRaw)) return "undecidable";
  if (!readable(a.controlDateTimeRaw)) return "newer";
  const control = Date.parse(b.controlDateTimeRaw) - Date.parse(a.controlDateTimeRaw);
  return control === 0 ? "same" : control > 0 ? "newer" : "older";
}

// P3-VM-AC02: 比べる時刻と Control/DateTime の組（K8 が通知の印の鍵に使う）。報番号・InfoType は入れず、EEW だけ Serial を足す。
function versionKey(ref: VersionRef): string {
  const time = (raw: string) => readable(raw) ? Date.parse(raw) : raw;
  return JSON.stringify([...headFirst(ref) ? [time(ref.reportDateTimeRaw)] : [], time(ref.controlDateTimeRaw),
    ...EEW.has(ref.family) ? [ref.serialRaw.trim()] : []]);
}

// P3-VM-AC08: 印と ReportRef の byte の上界を件数から決めるための、受理と読み戻しの共通の上限（正本）。文字は JSON で 1 文字 1 byte の
// 印字可能な ASCII（引用符とバックスラッシュを除く）。inputId は host の input-N（22 文字）を含む 64 文字（作者裁定の長さの上限 A）で、空白を含まない。
const INPUT_ID_LIMIT = 64;
const jsonText = (raw: string, limit: number): boolean => raw.length <= limit && /^[\x20-\x21\x23-\x5b\x5d-\x7e]*$/.test(raw);
const validInputId = (raw: string): boolean => raw !== "" && !raw.includes(" ") && jsonText(raw, INPUT_ID_LIMIT);

// P3-VM-AC01・AC08: 受けた Control/DateTime を保存の形にそろえる。上限（各 unit の ReportDateTime と同じ値）を越えるか、
// JSON で 1 byte にならない文字を含む値は時刻として読めないので空にする（断らない、P3-VM-D-MISSING=A）。上界は区切りと欄名と引用の 24 byte＋limit。
function controlDateTimeOf(raw: string, limit = 40): string {
  return jsonText(raw, limit) ? raw : "";
}

// P3-VM-AC01: 12 unit の codec の ReportRef の読み戻し。型と値域の共通の検査をして項目ごとに組み立てる。時刻の形・Serial・InfoType・
// family・subject の一致は各 unit の検査が今の位置で行う。controlDateTimeRaw は受理と同じ形（controlDateTimeOf）、inputId は受理と同じ上限
// （validInputId）だけを受ける。
function readReportRef(value: unknown, limit = 40): ReportRef | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  const row: Readonly<Record<string, unknown>> = Object.fromEntries(Object.entries(value));
  const { inputId, origin, operation, family, subject, reportDateTimeRaw, controlDateTimeRaw, serialRaw, infoTypeRaw } = row;
  if (origin !== "live" && origin !== "recovery" && origin !== "replay"
    || operation !== "normal" && operation !== "training" && operation !== "test"
    || typeof inputId !== "string" || !validInputId(inputId) || typeof family !== "string" || typeof subject !== "string" || typeof reportDateTimeRaw !== "string"
    || typeof controlDateTimeRaw !== "string" || controlDateTimeOf(controlDateTimeRaw, limit) !== controlDateTimeRaw
    || typeof serialRaw !== "string" || typeof infoTypeRaw !== "string") return null;
  return { inputId, origin, operation, family, subject, reportDateTimeRaw, controlDateTimeRaw, serialRaw, infoTypeRaw };
}

// P3-VM-AC03・AC04 の判定（U-E は D-SAMETIME=A の Serial の例外を、取消の優先の当たらない同じ時刻にだけ当てる）。無いと印の付け外しの規則が unit ごとに写される。
// - older: stale。duplicate: same で中身が同じ（印は再送で外さない）。
// - held: 手元の版を残す。mark はこの後の印で、変えないときは渡した mark と同じ参照。missing は比べる時刻を欠く報（WARN
//   requiredStructureMissing）、でなければ同じ時刻の食い違い（unit の食い違いの WARN）。
// - adopt: 採る。mark は採用の後の印。missing は手元の版の無い比べる時刻を欠く報（D-MISSING=A の (2)、WARN を添える）。
// 印の外し方: 時刻の読める印（a）は newer の採用で外し、時刻の無い印（b）は外さない（取り直し C16 か、系列が期限か取消で消えたときだけ）。
// current は手元の版（version は比べる欄、source は時刻の無い版を置き換えたときに印にする ReportRef、cancelled は手元の版が取消か）。
// ends は受けた報が取消か。同じ時刻（同じ Control/DateTime）の取消は取消でない報に勝つ（作者裁定 2026-10-21 昼、全分野）。
// 取消の採用で系列の印は外れ、取消の後の同じ時刻の取消でない報は older（取消が勝ったまま）。時刻の無い報は取消の後も印を残す（AC04 の (b)）。
type VersionStep =
  | Readonly<{ kind: "older" }> | Readonly<{ kind: "duplicate" }>
  | Readonly<{ kind: "held"; mark: ReportRef | null; missing: boolean }> | Readonly<{ kind: "adopt"; mark: ReportRef | null; missing: boolean }>;
function stepVersion(current: Readonly<{ version: VersionRef; source: ReportRef | null; cancelled: boolean }> | null,
  mark: ReportRef | null, candidate: ReportRef, sameContent: () => boolean, ends: boolean): VersionStep {
  let order = compareVersion(current?.version ?? null, candidate);
  // 取消かどうかが食い違う同じ時刻は、Serial の例外より先に取消の優先で決める（取消どうし・取消でないどうしだけ Serial で比べる）。
  if (order === "same" && current != null && EEW.has(candidate.family) && ends === current.cancelled) {
    const serial = Number(candidate.serialRaw.trim()) - Number(current.version.serialRaw.trim());
    if (serial !== 0) order = serial > 0 ? "newer" : "older";
  }
  if (current == null) return { kind: "adopt", mark: null, missing: order === "undecidable" };
  if (order === "same") {
    if (sameContent()) return { kind: "duplicate" };
    if (ends !== current.cancelled) order = ends ? "newer" : "older";
  }
  if (order === "older") return { kind: "older" };
  if (order === "newer") return { kind: "adopt", missing: false, mark: ends ? null : mark != null && !versionTimed(mark) ? mark
    : !versionTimed(current.version) ? current.source : null };
  return { kind: "held", mark: nextMark(mark, candidate), missing: order === "undecidable" };
}
// 印を付ける報を受けたときの次の印。印と同じ versionKey の報と、時刻の無い印（b）への時刻の読める報では書き換えない（AC04）。
function nextMark(mark: ReportRef | null, candidate: ReportRef): ReportRef {
  return mark != null && (versionKey(mark) === versionKey(candidate) || !versionTimed(mark) && versionTimed(candidate)) ? mark : candidate;
}

export { INPUT_ID_LIMIT, compareVersion, controlDateTimeOf, jsonText, nextMark, readReportRef, stepVersion, validInputId, versionKey, versionTimed };
export type { VersionOrder, VersionRef, VersionStep };
