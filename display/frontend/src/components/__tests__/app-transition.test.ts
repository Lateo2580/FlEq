import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

// App.svelte は createDisplayConnection() が起動時に EventSource を開くため jsdom で render できない。
// クロスフェード中の入力所有権 (指摘1) と emergency 遷移での overlay 明示クローズ (指摘5) は、
// jsdom がヒットテスト (z-index / pointer-events による当たり判定) を再現しないので、ソース契約で固定する。
const src = readFileSync(join(__dirname, "..", "..", "App.svelte"), "utf-8");

describe("App クロスフェード中の入力所有権 (指摘1 → レビュー再検証)", () => {
  it("pointer-events:none は現 mode と一致しない (退場中の) 層だけに掛かる。常時 none にはしない", () => {
    // main に現 mode を属性化している
    expect(src).toContain("data-mode={mode}");
    // 非活性層のみ無効化するルール (standby 時の緊急層 / emergency 時の待機層)
    expect(src).toMatch(/main\[data-mode="standby"\]\s+\.screen-layer\[data-kind="emergency"\]/);
    expect(src).toMatch(/main\[data-mode="emergency"\]\s+\.screen-layer\[data-kind="standby"\]/);
    // 緊急層を無条件で pointer-events:none にするルールは存在しない (緊急画面の対話を殺すため)
    expect(src).not.toMatch(/\.screen-layer\[data-kind="emergency"\]\s*\{\s*z-index:\s*2;\s*pointer-events:\s*none/);
    // 緊急層の単独ルールは z-index のみ (pointer-events を含まない)
    const emergencyRule = src.match(/\.screen-layer\[data-kind="emergency"\]\s*\{[\s\S]*?\}/)?.[0] ?? "";
    expect(emergencyRule).not.toContain("pointer-events");
  });

  it("減光トグルは <svelte:window> のガード付きハンドラが担う (層に依存しない)", () => {
    // onclick に shouldToggleDimOnClick ガード経由で dim.toggle() を呼ぶ
    expect(src).toMatch(/onclick=\{[^}]*shouldToggleDimOnClick[^}]*dim\.toggle\(\)[^}]*\}/);
    // onkeydown に shouldToggleDimOnKey 経由で dim.toggle() を呼ぶ
    expect(src).toMatch(/onkeydown=\{[^}]*shouldToggleDimOnKey[^}]*dim\.toggle\(\)[^}]*\}/);
  });
});

// Spec C §4: night-dim は engine 算出の weatherL5Active を直接使う。severityTier === "critical" の
// 流用は禁止 (大津波警報など他要因が混入する)。パネル降格後も警報解除まで true なので、フロントは
// 期限計算をしない。App は EventSource を開くため jsdom で render できず、配線をソース契約で固定する
describe("App night-dim の気象 L5 サスペンド (spec C §4)", () => {
  // 判定そのものは computeSnapshotAlertActive の真理値表テスト (dim-interaction.test.ts) が
  // 状態値で固定する。ここは App がその純関数へ snapshot を渡して合成していることだけを見る
  it("snapshot の掲載判定を computeSnapshotAlertActive に委ね、テロップ走行と OR で合成する", () => {
    expect(src).toMatch(/computeSnapshotAlertActive\(connection\.state\.snapshot\)/);
    expect(src).toMatch(
      /computeEffectiveDim\(\s*dim\.requested,\s*tickerAlertActive \|\| snapshotAlertActive,?\s*\)/,
    );
  });

  it("severityTier を減光判定に流用していない (dim は weatherL5Active のみ)", () => {
    expect(src).not.toMatch(/computeEffectiveDim\([^)]*severityTier/);
  });
});

describe("App emergency 遷移での overlay 明示クローズ (指摘5)", () => {
  it("StandbyScreen を bind:this で参照し、mode が standby を離れたら closeQuakeCard を呼ぶ", () => {
    expect(src).toContain("bind:this={standbyRef}");
    // mode !== "standby" で standbyRef?.closeQuakeCard() を呼ぶ $effect がある
    expect(src).toMatch(/mode\s*!==\s*"standby"[\s\S]*?standbyRef\?\.closeQuakeCard\(\)/);
  });
});
