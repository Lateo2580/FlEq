import type { ResolvedTheme, ResolvedStyle, RoleName } from "./theme";

/**
 * Night mode overlay: chalk.dim 相当の減光を ResolvedStyle に適用する。
 * 危険色ロールは減光対象外とし、視認性を維持する。
 */

/** 減光を適用しないロール一覧 (critical 級の危険色) */
const EXEMPT_ROLES: ReadonlySet<RoleName> = new Set([
  "frameCritical",
  "tsunamiMajor",
  "eewWarningBanner",
  "volcanoFlashBanner",
  "intensity6Upper",
  "intensity7",
]);

/** RGB 値を減光する (輝度を約50%に落とす) */
function dimRgb(rgb: readonly [number, number, number]): readonly [number, number, number] {
  return [
    Math.round(rgb[0] * 0.5),
    Math.round(rgb[1] * 0.5),
    Math.round(rgb[2] * 0.5),
  ] as const;
}

/** 単一スタイルに dim を適用する */
function dimStyle(style: ResolvedStyle): ResolvedStyle {
  return {
    fg: style.fg ? dimRgb(style.fg) : undefined,
    bg: style.bg ? dimRgb(style.bg) : undefined,
    bold: style.bold,
  };
}

/**
 * ResolvedTheme に night overlay を適用して新しい ResolvedTheme を返す。
 * 元のテーマは変更しない (純粋関数)。
 */
export function applyNightOverlay(theme: ResolvedTheme): ResolvedTheme {
  // パレットも減光
  const palette = { ...theme.palette };
  for (const key of Object.keys(palette) as Array<keyof typeof palette>) {
    palette[key] = dimRgb(palette[key]);
  }

  // ロールスタイルを減光 (危険色ロールは除外)
  const roles = { ...theme.roles };
  for (const key of Object.keys(roles) as RoleName[]) {
    if (!EXEMPT_ROLES.has(key)) {
      roles[key] = dimStyle(roles[key]);
    }
  }

  return { palette, roles };
}

/** 減光対象外のロール名一覧を返す (テスト用) */
export function getExemptRoles(): ReadonlySet<RoleName> {
  return EXEMPT_ROLES;
}
