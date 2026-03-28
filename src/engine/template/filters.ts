// ── Template filter functions ──

type FilterArgs = (string | number | boolean | null)[];

function toString(value: unknown): string {
  if (value == null) return "";
  return String(value);
}

function filterDefault(value: unknown, args: FilterArgs): unknown {
  if (value == null || value === "") {
    return args[0] ?? "";
  }
  return value;
}

function filterTruncate(value: unknown, args: FilterArgs): string {
  const str = toString(value);
  const limit = typeof args[0] === "number" ? args[0] : Number(args[0]);
  if (!Number.isFinite(limit) || str.length <= limit) return str;
  return str.slice(0, limit);
}

function filterPad(value: unknown, args: FilterArgs): string {
  const str = toString(value);
  const width = typeof args[0] === "number" ? args[0] : Number(args[0]);
  if (!Number.isFinite(width)) return str;
  return str.padEnd(width);
}

function filterJoin(value: unknown, args: FilterArgs): string {
  if (!Array.isArray(value)) return toString(value);
  const separator = args[0] != null ? String(args[0]) : ",";
  return value.join(separator);
}

function filterDate(value: unknown, args: FilterArgs): string {
  const format = args[0] != null ? String(args[0]) : "HH:mm";
  const date = value instanceof Date ? value : new Date(String(value));
  if (isNaN(date.getTime())) return toString(value);

  const HH = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  const MM = String(date.getMonth() + 1).padStart(2, "0");
  const DD = String(date.getDate()).padStart(2, "0");

  switch (format) {
    case "HH:mm":
      return `${HH}:${mm}`;
    case "HH:mm:ss":
      return `${HH}:${mm}:${ss}`;
    case "MM/DD HH:mm":
      return `${MM}/${DD} ${HH}:${mm}`;
    default:
      return `${HH}:${mm}`;
  }
}

function filterReplace(value: unknown, args: FilterArgs): string {
  const str = toString(value);
  const search = args[0] != null ? String(args[0]) : "";
  const replacement = args[1] != null ? String(args[1]) : "";
  return str.split(search).join(replacement);
}

function filterUpper(value: unknown): string {
  return toString(value).toUpperCase();
}

function filterLower(value: unknown): string {
  return toString(value).toLowerCase();
}

/**
 * テンプレートフィルタを適用する。
 * 未知のフィルタ名の場合は値をそのまま返す。
 */
export function applyFilter(
  name: string,
  value: unknown,
  args: FilterArgs,
): unknown {
  switch (name) {
    case "default":
      return filterDefault(value, args);
    case "truncate":
      return filterTruncate(value, args);
    case "pad":
      return filterPad(value, args);
    case "join":
      return filterJoin(value, args);
    case "date":
      return filterDate(value, args);
    case "replace":
      return filterReplace(value, args);
    case "upper":
      return filterUpper(value);
    case "lower":
      return filterLower(value);
    default:
      return value;
  }
}
