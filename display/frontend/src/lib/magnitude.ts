export function isNumericMagnitude(value: string | null | undefined): boolean {
  return value != null && value.trim() !== "" && Number.isFinite(Number(value));
}

export function formatMagnitudeLabel(value: string | null | undefined): string {
  if (value == null || value.trim() === "") return "M不明";
  if (value.trim().toLowerCase() === "nan") return "M不明";
  return isNumericMagnitude(value) ? `M${value}` : value;
}
