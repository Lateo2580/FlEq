// P3-EXPIRY-FORM-001（K10）: 時計の根拠ごとの期限の当て方の共通の部品。無いと 12 unit が同じ cache の作り方と印の byte を別々に持つ。

// P3-EF-AC11 (2): 期限の種類ごとに別の cache で、配列に結び付けた最小を持つ。既存の minOf は配列だけで cache するので、同じ配列に
// 別の式（表示の期限・回収の期限・保留）を当てると最初の式の値が返る。
function cachedMin<T extends object>(at: (value: T) => number): (values: readonly T[]) => number {
  const cache = new WeakMap<readonly T[], number>();
  return (values) => {
    let min = cache.get(values);
    if (min == null) { min = values.reduce((least, item) => Math.min(least, at(item)), Infinity); cache.set(values, min); }
    return min;
  };
}

// Q-EF-BYTES: 期限切れの保留の印 ,"expiryPending":true の byte。U-T・U-F は見える記録ごとにこの分を受理と復元の境界で予約する（P3-EF-AC10 (5)）。
const PENDING_MARK_BYTES = new TextEncoder().encode(',"expiryPending":true').byteLength;

export { PENDING_MARK_BYTES, cachedMin };
