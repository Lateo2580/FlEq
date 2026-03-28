export class FilterSyntaxError extends Error {
  constructor(
    public readonly source: string,
    public readonly position: number,
    message: string,
  ) {
    super(message);
    this.name = "FilterSyntaxError";
  }

  /** 位置付きフォーマット済みエラー表示 */
  format(): string {
    const pointer = " ".repeat(this.position) + "^";
    return `フィルタ構文エラー: ${this.position + 1}文字目${this.message}\n${this.source}\n${pointer}`;
  }
}

export class FilterTypeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FilterTypeError";
  }
}

export class FilterFieldError extends Error {
  constructor(
    public readonly fieldName: string,
    public readonly availableFields: string[],
  ) {
    super(`未知のフィールド: ${fieldName}`);
    this.name = "FilterFieldError";
  }

  format(): string {
    const examples = this.availableFields.slice(0, 6).join(", ");
    return `未知のフィールド: ${this.fieldName}\n使える例: ${examples}`;
  }
}
