import type { RoleStyleDef, ThemeFile } from "../../../src/ui/theme";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

const ROLE_DEF_KEYS = new Set(["bg", "fg", "bold"]);

/** RoleStyleDef の形チェック (string か、bg/fg/bold のみを持つオブジェクト) */
function isRoleStyleDefShape(value: unknown): value is RoleStyleDef {
  if (typeof value === "string") return true;
  if (!isPlainObject(value)) return false;
  if (!Object.keys(value).every((k) => ROLE_DEF_KEYS.has(k))) return false;
  return (
    (value.bg == null || typeof value.bg === "string") &&
    (value.fg == null || typeof value.fg === "string") &&
    (value.bold == null || typeof value.bold === "boolean")
  );
}

/**
 * HTTP body の ThemeFile 形チェック。
 * palette は string 値、roles は RoleStyleDef 形まで検証する (型として壊れた値は保存させない)。
 * 不正 HEX 等「文字列としては正しい形」の値はここでは弾かない — spec の「警告つき継続」
 * (loadTheme が warnings を返し UI に表示) に委ねる。
 */
export function isThemeFileShape(value: unknown): value is ThemeFile {
  if (!isPlainObject(value)) return false;
  const { palette, roles } = value;
  if (palette != null) {
    if (!isPlainObject(palette)) return false;
    if (!Object.values(palette).every((v) => typeof v === "string")) return false;
  }
  if (roles != null) {
    if (!isPlainObject(roles)) return false;
    if (!Object.values(roles).every(isRoleStyleDefShape)) return false;
  }
  return true;
}

/** 保存用に palette/roles 以外の未知キーを落とした ThemeFile を返す */
export function normalizeThemeFile(value: ThemeFile): ThemeFile {
  return { palette: { ...value.palette }, roles: { ...value.roles } };
}
