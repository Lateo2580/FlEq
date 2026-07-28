import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseTokens, buildTokenMap,
  evaluatePairs, computeInputHash, applyAllowlist, auditGate, validateAllowlist,
  ALERT_TEXT_ROLES, ALERT_CHIP_ROLES, ADVISORY_ROLES, HIGH_ROLES,
} from "../../../../scripts/generate-design-docs.mjs";
import { isAlertRole, KNOWN_COLOR_ROLES } from "../alert-roles";
import { resolveChipTokens } from "../ticker-chip";

/** resolveChipTokens の on トークン文字列 `var(--header-<role>-on)` から <role> を抜く。
    header 直参照でない (中立/機械導出) チップは "" を返す */
function headerRoleOf(tokens: { on: string }): string {
  const m = tokens.on.match(/^var\(--header-([A-Za-z]+)-on\)$/);
  return m == null ? "" : m[1];
}

const css = readFileSync(join(__dirname, "..", "theme.css"), "utf-8");
const map = buildTokenMap(parseTokens(css));

describe("evaluatePairs", () => {
  const pairs = evaluatePairs(map);
  const find = (id: string) => pairs.find((p) => p.id === id)!;

  it("静的カテゴリ 1-8 と合成カテゴリ 9-13 の代表 id が揃う", () => {
    for (const id of [
      "base---fg", "int---int-1-on---bg", "int8", "role-critical-on---bg",
      "hdr-eewWarning", "band-eewWarning-bg", "tsunami-purple", "tier---fg-on---surface-high",
      "dim-chip-tsunamiMajor", "overlay---fg-on---surface-high", "overlay-hdr-tsunamiMajor", "dim-high-warning",
      "tsu-heading-大津波警報", "opacity-eew-serial",
      "dim-mid-weatherWarning", "dim-high-quakeMajor",
    ]) {
      expect(find(id), `pair ${id} が無い`).toBeTruthy();
    }
  });
  it("--fg × --bg は PASS (≈19:1)", () => {
    expect(find("base---fg").ratio).toBeGreaterThan(18);
    expect(find("base---fg").pass).toBe(true);
  });
  it("dim×大津波チップはフロアにより PASS (≈10.27:1、旧 FAIL 契約から floor へ移行)", () => {
    expect(find("dim-chip-tsunamiMajor").ratio).toBeCloseTo(10.27, 1);
    expect(find("dim-chip-tsunamiMajor").pass).toBe(true);
    expect(find("dim-chip-tsunamiMajor").state).toBe("dim");
  });
  it("dim×津波注意報チップ (advisory) は 35% 混色継続で FAIL (≈2.41:1)", () => {
    expect(find("dim-chip-tsunamiAdvisory").ratio).toBeCloseTo(2.41, 1);
    expect(find("dim-chip-tsunamiAdvisory").pass).toBe(false);
    expect(find("dim-chip-tsunamiAdvisory").state).toBe("dim");
  });
  it("ヘッダ band は非テキスト 3:1 閾値", () => {
    expect(find("band-eewWarning-bg").threshold).toBe(3);
  });
  it("各カテゴリの件数が実装と一致する (恣意的サンプリング禁止の担保)", () => {
    const counts: Record<string, number> = {};
    for (const p of pairs) counts[p.category] = (counts[p.category] ?? 0) + 1;
    expect(counts).toEqual({
      "1 基本文字色": 3,
      "2 震度rank文字": 42,
      "3 震度rank面": 2,
      // 17 role × 3 面 (--bg / --surface-high / --surface-panel)。--surface-panel は
      // WeatherEmergencyPanel が「面を持つのは詳細一覧だけ」構成になり (2026-07-26)、
      // role 色をパネル地へ直接置くようになったため監査対象に加えた
      "4 role文字色": 51,
      "5 ヘッダ3層": 10,
      "6 ヘッダband": 20,
      "7 JMA文字色": 2,
      "8 tier上書き後": 4,
      "9 dim×tickerチップ": 10,
      // --fg / --role-muted × 3 面 (6) + ヘッダ 10 role (10) + 気象 role × 3 面 (6)。
      // 気象 role のペアは「critical 中は --fg へ退避するので描かれない」組合せを表に残すもの
      // (許容リスト critical-overlay-weather-role-not-used-as-text、2026-07-26)
      "10 critical overlay合成": 22,
      "11 dim×high lane": 10,
      "12 津波ページ二段mix": 6,
      "13 opacity経路": 1,
      "14 dim×通常レーン警報本文": 7,
      // 気象パネルの装飾 (spec 追補 C9、2026-07-27): role 2 種 × (バッジ輪郭 / 下線 /
      // critical 合成後の下線)。「使わない」前提に頼らず、UI が意味色を文字へ流用したら
      // FAIL で気づけるよう表に載せている
      // role 2 種 × (バッジ輪郭 + 下線 × 実描画面 2 種 × 通常/critical 合成)。
      // 面は **--surface-panel-raised / --surface-highest** = 実際に下線が載る面
      // (tier 置換込み)。--surface-panel を見ていた初版は実在しない組合せだった
      // role 2 種 × (バッジ輪郭 + 下線 × 実描画面 4 種 × 通常/critical 合成)。
      // 面は詳細一覧 (--surface-panel-raised / tier で --surface-highest) と
      // 副セクション (--surface-panel / tier で --surface-high) の実在する組合せだけ
      "15 気象パネル装飾": 18,
    });
    expect(pairs.length).toBe(208);
  });
  it("カテゴリ 11 (dim×high lane) は tsunamiMajor を列挙しない (実ペアは cat9)", () => {
    expect(find("dim-high-tsunamiMajor")).toBeUndefined();
    // 大津波警報の走行文字は dim 時も header container/on ペアで上書きされ、lane 面を
    // 文字背景とする cat11 の想定に当てはまらない (TickerLane.svelte の専用規則)。
    expect(find("dim-high-warning")).toBeTruthy();
  });
  it("dim-chip-weatherWarning はフロアにより素の hdr ペアと同じ比になる", () => {
    const dimChip = find("dim-chip-weatherWarning");
    const hdr = find("hdr-weatherWarning");
    expect(dimChip.ratio).toBeCloseTo(hdr.ratio, 2);
  });
  it("生成器の ALERT_TEXT_ROLES は isAlertRole と一致する (tsunamiMajor 専用面を除き)", () => {
    const expected = KNOWN_COLOR_ROLES.filter(
      (r) => isAlertRole(r) && r !== "tsunamiMajor" && !r.startsWith("connection"),
    ); // cat14 対象 = 警報級テキスト role (接続系は ticker 本文 role ではない)
    expect([...ALERT_TEXT_ROLES].sort()).toEqual([...expected].sort());
  });
  it("生成器の ADVISORY_ROLES は cat11 母集合 (HIGH_ROLES、tsunamiMajor 除外後) のうち isAlertRole=false な role 集合と完全一致する", () => {
    // HIGH_ROLES は実際に cat11 が走査する配列そのもの (ADVISORY_ROLES から逆算した配列ではない) を
    // 突き合わせるため、HIGH_ROLES 変更・alert-roles.ts の CALM_ROLES 変更どちらの drift も検出できる
    const cat11Roles = HIGH_ROLES.filter((r: string) => r !== "tsunamiMajor");
    const expected = cat11Roles.filter((r: string) => !isAlertRole(r));
    expect([...ADVISORY_ROLES].sort()).toEqual(expected.sort());
  });
  it("警報級テキスト role のチップ写像先は必ず ALERT_CHIP_ROLES に含まれる", () => {
    for (const r of KNOWN_COLOR_ROLES.filter((x) => isAlertRole(x) && !x.startsWith("connection"))) {
      const headerRole = headerRoleOf(resolveChipTokens(r));
      expect(ALERT_CHIP_ROLES.has(headerRole)).toBe(true);
    }
  });
  it("平常・注意報級 role のチップ写像先は ALERT_CHIP_ROLES に含まれない", () => {
    for (const r of KNOWN_COLOR_ROLES.filter((x) => !isAlertRole(x) && !x.startsWith("connection"))) {
      const headerRole = headerRoleOf(resolveChipTokens(r));
      expect(ALERT_CHIP_ROLES.has(headerRole)).toBe(false);
    }
  });
});

describe("許容リストと入力 hash (合成後色ベース)", () => {
  // floor 導入後は tsunamiMajor が dim35 で混色されなくなり --bg 非依存になるため、
  // 「今も 35% 混色される」advisory ペアを FAIL fixture に使う (main 指摘 2026-07-18)
  const pairs = evaluatePairs(map);
  const failPair = pairs.find((p) => p.id === "dim-chip-tsunamiAdvisory")!;
  const entry = {
    id: "t", pair_ids: ["dim-chip-tsunamiAdvisory"], reason: "テスト", applies_when: "state=dim",
    last_verified_input_hash: "",
  };

  it("computeInputHash は --bg / 混色率が変わると変わる (トートロジーでない)", () => {
    const base = computeInputHash(["dim-chip-tsunamiAdvisory"], pairs);
    // --bg を差し替えた map で評価し直すと dim 合成後色が変わる → hash も変わる
    const map2 = new Map(map);
    map2.set("--bg", "#111111");
    const pairs2 = evaluatePairs(map2);
    expect(computeInputHash(["dim-chip-tsunamiAdvisory"], pairs2)).not.toBe(base);
  });
  it("評価結果に無い pair id を hash 対象にすると throw する", () => {
    expect(() => computeInputHash(["no-such-pair"], pairs)).toThrow("hash 対象ペアが評価結果に無い");
  });
  it("許容リスト無しの FAIL は status=FAIL", () => {
    expect(applyAllowlist([failPair], [])[0].status).toBe("FAIL");
  });
  it("正しい hash の許容は status=ALLOWED", () => {
    const good = { ...entry, last_verified_input_hash: computeInputHash(["dim-chip-tsunamiAdvisory"], pairs) };
    expect(applyAllowlist([failPair], [good])[0].status).toBe("ALLOWED");
  });
  it("hash がずれた許容は status=STALE", () => {
    const stale = { ...entry, last_verified_input_hash: "deadbeef0000" };
    expect(applyAllowlist([failPair], [stale])[0].status).toBe("STALE");
  });
  it("PASS ペアは常に status=PASS", () => {
    const passPair = pairs.find((p) => p.id === "base---fg")!;
    expect(applyAllowlist([passPair], [])[0].status).toBe("PASS");
  });
  it("解釈不能な applies_when (typo) は寛容フォールバックせず throw する", () => {
    const typo = { ...entry, applies_when: "stat=dim" };
    expect(() => applyAllowlist([failPair], [typo])).toThrow("解釈不能な applies_when: stat=dim");
  });
});

describe("validateAllowlist (PASS/FAIL に依らないエントリ単位の hash 再審査)", () => {
  // 合成した評価結果: 対象ペアは pass=true (色改善で一時 PASS した状態を模す)。
  // integer rgb で computeInputHash の丸めに依存しない。
  const passEvaluated = [
    { id: "p1", state: "dim", pass: true, fg: { r: 0, g: 0, b: 0 }, bg: { r: 255, g: 255, b: 255 } },
    { id: "p2", state: "dim", pass: true, fg: { r: 10, g: 10, b: 10 }, bg: { r: 240, g: 240, b: 240 } },
  ];

  it("全ペアが PASS でもエントリ hash 不一致なら STALE を検出する (色を戻す bypass の防御)", () => {
    const entry = {
      id: "grp", pair_ids: ["p1", "p2"], reason: "x", applies_when: "state=dim",
      last_verified_input_hash: "old000000000", // 旧色時代の hash (現評価と不一致)
    };
    // applyAllowlist は pass→PASS で hash を検査しない → auditGate はすり抜ける (bypass の再現)
    expect(auditGate(applyAllowlist(passEvaluated, [entry]))).toEqual([]);
    // validateAllowlist は pass に依らず hash を検査する → STALE を検出
    const violations = validateAllowlist([entry], passEvaluated);
    expect(violations.length).toBe(1);
    expect(violations[0]).toContain("grp");
  });

  it("hash 一致 + state 整合なら違反ゼロ", () => {
    const good = {
      id: "grp", pair_ids: ["p1", "p2"], reason: "x", applies_when: "state=dim",
      last_verified_input_hash: computeInputHash(["p1", "p2"], passEvaluated),
    };
    expect(validateAllowlist([good], passEvaluated)).toEqual([]);
  });

  it("評価結果に無い pair_ids を含むエントリは missing 違反 (id を含む)", () => {
    const entry = {
      id: "grp", pair_ids: ["p1", "no-such"], reason: "x", applies_when: "state=dim",
      last_verified_input_hash: "x",
    };
    const violations = validateAllowlist([entry], passEvaluated);
    expect(violations.length).toBe(1);
    expect(violations[0]).toContain("grp");
    expect(violations[0]).toContain("no-such");
  });

  it("applies_when=state=dim なのに base state のペアを含むと state 不整合違反", () => {
    const mixed = [
      { id: "p1", state: "dim", pass: true, fg: { r: 0, g: 0, b: 0 }, bg: { r: 255, g: 255, b: 255 } },
      { id: "p3", state: "base", pass: true, fg: { r: 0, g: 0, b: 0 }, bg: { r: 255, g: 255, b: 255 } },
    ];
    const entry = {
      id: "grp", pair_ids: ["p1", "p3"], reason: "x", applies_when: "state=dim",
      last_verified_input_hash: computeInputHash(["p1", "p3"], mixed),
    };
    const violations = validateAllowlist([entry], mixed);
    expect(violations.some((v: string) => v.includes("grp") && v.includes("p3"))).toBe(true);
  });
});
