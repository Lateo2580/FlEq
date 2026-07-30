import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

// モーション振り付け spec (2026-07-10) の frame-1 可視・配線のソース検査 (§3 検証 2 / §5 / §6)。
// DOM に文字があることは可視の証明にならない (opacity:0 でも DOM に在る) ため、opacity-0 入場経路の
// 撤去と生成時 snapshot 配線を文字列で固定する。transition css 関数の純関数検証は transitions.test.ts。
const SRC = join(__dirname, "..");
function read(rel: string): string {
  return readFileSync(join(SRC, rel), "utf-8");
}
const app = read("../App.svelte");
const preview = read("../preview/PreviewApp.svelte");
const emg = read("EmergencyScreen.svelte");
const quake = read("QuakePanel.svelte");
const tsu = read("TsunamiPanel.svelte");

describe("frame-1 可視: opacity-0 入場撤去 + 生成時キー snapshot 配線 (spec §3 検証 2)", () => {
  it("画面/パネル入場の opacity:0 keyframe を撤去し、生成時 const snapshot で初期/後発を判定する", () => {
    // 画面レベル: screen-in keyframe 撤去、emergencyEnter へ転換
    expect(app).not.toContain("@keyframes screen-in");
    expect(app).toContain("emergencyEnter");
    // パネルレベル: panel-in/hero-in keyframe 撤去
    expect(emg).not.toContain("@keyframes panel-in");
    expect(emg).not.toContain("@keyframes hero-in");
    // QuakePanel は行全体でなく個別要素キーで持つ (最終改稿 1)
    expect(quake).toMatch(/const initialHas(LgInt|Chips)\b/);
    expect(quake).toMatch(/const initialElementKeys = new Set/);
    // TsunamiPanel は初期 snapshot と render で同じ純関数 (keyCoastRows) を通す (最終改稿 2)
    expect(tsu).toMatch(/const initialCoastKeys = new Set\(/);
    expect(tsu).toMatch(/keyCoastRows\(input\.coasts\)/);
    expect(tsu).toMatch(/coastRows = \$derived\(keyCoastRows\(/);
    // 用途別の data-motion-reveal (rAF ゲートの検査対象マーク、最終改稿 3)
    for (const s of [emg, quake, tsu]) expect(s).toMatch(/data-motion-reveal="(height|scale)"/);
  });

  it("旧・opacity 0 スタートの 3 入場経路 (screen-in/panel-in/hero-in) が全滅している", () => {
    expect(app).not.toContain("screen-in");
    expect(emg).not.toContain("panel-in");
    expect(emg).not.toContain("hero-in");
  });

  it("緊急パネルの入場経路は opacity を変更しない — 外枠 revealScaleIn を撤去しグリッド track 補間で表現する (spec §2)", () => {
    // revealScaleIn は t=0 で opacity 0 になる実装 (transitions.ts) で frame-1 可視規範と矛盾していた。
    // EmergencyScreen の外枠からは撤去し、枚数増減はグリッド展開 (grid-template の CSS transition) で表す。
    expect(emg).not.toContain("revealScaleIn");
    // in: トランジションで opacity を触る入場を持たない (関数名でなく振る舞いを固定)
    expect(emg).not.toMatch(/in:[^\s]*[\s\S]*opacity/);
    // グリッド track 補間は motion トークン (spring-spatial-quick) 参照で行う (duration 直値は撒かない)
    expect(emg).toContain("grid-template-columns");
    expect(emg).toContain("grid-template-rows");
    expect(emg).toContain("var(--spring-spatial-quick-dur)");
    expect(emg).toContain("var(--spring-spatial-quick)");
  });
});

describe("duration 直値を撒かない (spec §5): 時間は motion トークン由来", () => {
  // transition の duration は SPRING_*_MS / EXIT_MS 由来か reduced-motion の 0。2 桁以上の
  // 手書き数値リテラル (duration: 142 等) を撒いていないことを検査する
  it("App/EmergencyScreen/QuakePanel/TsunamiPanel は duration に 2 桁以上の数値直値を持たない", () => {
    for (const s of [app, emg, quake, tsu]) {
      expect(s).not.toMatch(/duration:\s*[1-9][0-9]/);
    }
  });

  it("画面遷移の duration は motion トークン (SPRING_SPATIAL_QUICK_MS / SPRING_EFFECTS_SLOW_MS / EXIT_MS) から取る", () => {
    expect(app).toMatch(/SPRING_SPATIAL_QUICK_MS/);
    expect(app).toMatch(/SPRING_EFFECTS_SLOW_MS/);
    expect(app).toMatch(/EXIT_MS/);
  });
});

describe("App.svelte と PreviewApp.svelte の screen-layer stacking (spec §6 / quakeMap §7.4)", () => {
  it("本番は緊急3 > 地震図2 > 待機1、preview は緊急2 > 待機1を明示する", () => {
    expect(app).toMatch(/data-kind="emergency"/);
    expect(app).toMatch(/data-kind="quakeMap"/);
    expect(app).toMatch(/data-kind="standby"/);
    expect(app).toMatch(/\.screen-layer\[data-kind="emergency"\]\s*\{\s*z-index:\s*3;/);
    expect(app).toMatch(/\.screen-layer\[data-kind="quakeMap"\]\s*\{\s*z-index:\s*2;/);
    expect(app).toMatch(/\.screen-layer\[data-kind="standby"\]\s*\{\s*z-index:\s*1;/);

    expect(preview).toMatch(/data-kind="emergency"/);
    expect(preview).toMatch(/data-kind="standby"/);
    expect(preview).toMatch(/\.screen-layer\[data-kind="emergency"\]\s*\{\s*z-index:\s*2;/);
    expect(preview).toMatch(/\.screen-layer\[data-kind="standby"\]\s*\{\s*z-index:\s*1;/);
    // 緊急入りは transform のみの emergencyEnter
    expect(app).toContain("in:emergencyEnter");
    expect(preview).toContain("in:emergencyEnter");
  });
});

describe("reduced-motion 配線 (spec §4-b): 切替後開始分を 0ms にする", () => {
  it("App/EmergencyScreen/PreviewApp は reducedMotion を matchMedia で購読する", () => {
    for (const s of [app, emg, preview]) {
      expect(s).toContain('matchMedia("(prefers-reduced-motion: reduce)")');
    }
  });

  it("QuakePanel/TsunamiPanel は page-cycler の reducedMotion を共有して reveal を 0ms にする", () => {
    expect(quake).toContain("cycler.reducedMotion");
    expect(tsu).toContain("pageCycler.reducedMotion");
  });
});

describe("PreviewApp rAF 自己検査ゲート (spec §5 / §3 検証 3)", () => {
  it("#motion-enter で mode 緊急化後に 1 回だけ rAF し data-motion-gate 属性 + console に結果を残す", () => {
    expect(preview).toContain("requestAnimationFrame");
    expect(preview).toContain('setAttribute("data-motion-gate"');
    expect(preview).toContain("runMotionGate");
    // 用途別属性を検査する: scale は computed opacity===1、height は rect.height が 0 でない
    expect(preview).toContain('[data-motion-reveal="scale"]');
    expect(preview).toContain('[data-motion-reveal="height"]');
    expect(preview).toContain(".screen-area");
  });

  it("3 つのモーションシーンが SCENARIOS に登録されている", () => {
    for (const hash of ["motion-enter", "motion-panels", "motion-card-grow"]) {
      expect(preview).toContain(`"${hash}"`);
    }
  });
});
