import type { Operation } from "../../contracts/p1-parser-boundary.types";

// unit ごとに写していた codec の状態を持たない検査（P3-XML-READERS-001、計画 §9）。
// 無いと、Operation に値を足したとき 9 つの operationOf のどれかを直し忘れ、その unit の復元だけが新しい値の記録を黙って断る。
// byte を数える encoder・bytes・listBytes は byteCache を unit が直に書くので寄せない（D-CODEC）。
type Fields = Readonly<Record<string, unknown>>;
function record(value: unknown): Fields | null {
  return value != null && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : null;
}
const isText = (value: unknown): value is string => typeof value === "string";
const bounded = (value: unknown, limit: number): value is string => isText(value) && value.length <= limit;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
function operationOf(value: unknown): Operation | null {
  return value === "normal" || value === "training" || value === "test" ? value : null;
}
function list<T>(value: unknown, item: (entry: unknown) => T | null, limit = Infinity): T[] | null {
  if (!Array.isArray(value) || value.length > limit) return null;
  const result: T[] = [];
  for (const entry of value) { const parsed = item(entry); if (parsed == null) return null; result.push(parsed); }
  return result;
}

export { bounded, count, finite, isText, list, operationOf, record };
