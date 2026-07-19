import { expect } from "vitest";

// T8① (spec §3 改訂): 旧「N/M」文字表示 (.page-number) はドットインジケータ (PageDots) に
// 置き換わった。QuakePanel/LatestQuakeCard/TsunamiPanel (予報区・観測) の 4 ページャで共有する
// ため、DOM 検証もここに一元化する。「ドット数 = total」「現在強調のドットが 1 つだけ」
// 「その位置が current1Based-1 と一致」の 3 点を確認する
export function expectCurrentDot(scope: ParentNode | null, current1Based: number, total: number): void {
  const dots = Array.from(scope?.querySelectorAll(".page-dot") ?? []);
  expect(dots.length).toBe(total);
  const currentDots = dots.filter((dot) => dot.classList.contains("current"));
  expect(currentDots.length).toBe(1);
  expect(dots.indexOf(currentDots[0])).toBe(current1Based - 1);
}
