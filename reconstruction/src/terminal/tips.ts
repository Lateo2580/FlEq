import { TIP_CATEGORIES } from "./tips-data";

// P3-TO-AC12 (2): tips の選び方は旧築 src/tips/tip-shuffler.ts の写し。分野ごとに混ぜてから、同じ分野が続かないように 1 巡分の山を作り、
// 使い切ったら作り直す。無いと同じ分野の tips が続けて出る（旧築と見え方が変わる）。
function createTipShuffler(random: () => number = Math.random): Readonly<{ next(): string }> {
  let deck: string[] = [];
  const shuffle = <T>(items: T[]): T[] => {
    for (let index = items.length - 1; index > 0; index -= 1) {
      const other = Math.floor(random() * (index + 1));
      [items[index], items[other]] = [items[other], items[index]];
    }
    return items;
  };
  const rebuild = (): void => {
    const queues = new Map<number, string[]>();
    TIP_CATEGORIES.forEach((category, index) => { if (category.tips.length > 0) queues.set(index, shuffle([...category.tips])); });
    deck = [];
    let last = -1;
    while (queues.size > 0) {
      const candidates = [...queues.keys()].filter((key) => key !== last);
      if (candidates.length === 0) {
        // 1 分野しか残っていなければそのまま流し込む（旧築と同じ）。
        const [only] = queues.keys();
        deck.push(...queues.get(only)!);
        break;
      }
      const chosen = candidates[Math.floor(random() * candidates.length)];
      const queue = queues.get(chosen)!;
      deck.push(queue.shift()!);
      last = chosen;
      if (queue.length === 0) queues.delete(chosen);
    }
    // 先頭から取り出すので逆順にして pop で読む（shift は残りの全件を移す）。
    deck.reverse();
  };
  return { next() { if (deck.length === 0) rebuild(); return deck.pop()!; } };
}

export { createTipShuffler };
