/**
 * discriminated union の網羅性をコンパイル時に強制するためのヘルパー。
 * すべての case を処理していれば `value` は `never` に絞り込まれ、到達しない。
 * union に新メンバーが増えて未処理の case が残ると、呼び出し側で型エラーになる。
 */
export function assertNever(value: never): never {
  throw new Error(`Unhandled discriminated union member: ${JSON.stringify(value)}`);
}
