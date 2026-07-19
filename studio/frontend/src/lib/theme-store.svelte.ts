import type { RoleStyleDef, ThemeCatalog, ThemeFile } from "./api";

/**
 * 編集中テーマの中央 store (Svelte 5 runes)。
 * edit は「デフォルトとの差分 (override)」のみ保持し、そのまま /api/render の
 * themeOverride と /api/theme/save の theme になる。
 */
export class ThemeStore {
  catalog = $state<ThemeCatalog | null>(null);
  edit = $state<ThemeFile>({ palette: {}, roles: {} });
  baseline = $state<ThemeFile>({ palette: {}, roles: {} });

  init(catalog: ThemeCatalog): void {
    this.catalog = catalog;
    const saved: ThemeFile = catalog.saved ?? {};
    this.edit = { palette: { ...saved.palette }, roles: { ...saved.roles } };
    this.baseline = { palette: { ...saved.palette }, roles: { ...saved.roles } };
  }

  get dirty(): boolean {
    return JSON.stringify(this.edit) !== JSON.stringify(this.baseline);
  }

  // ── palette ──

  setPaletteColor(name: string, hex: string): void {
    // デフォルトと同値なら override を持たない (RoleEditor の同値削除と同じセマンティクス)
    const def = this.catalog?.defaults.palette?.[name];
    if (def != null && def.toLowerCase() === hex.toLowerCase()) {
      this.resetPaletteColor(name);
      return;
    }
    this.edit.palette = { ...this.edit.palette, [name]: hex };
  }

  resetPaletteColor(name: string): void {
    const next = { ...this.edit.palette };
    delete next[name];
    this.edit.palette = next;
  }

  isPaletteOverridden(name: string): boolean {
    return this.edit.palette?.[name] != null;
  }

  /** UI 表示用の実効値 (override ?? default) */
  effectivePaletteHex(name: string): string {
    return this.edit.palette?.[name] ?? this.catalog?.defaults.palette?.[name] ?? "#000000";
  }

  // ── roles ──

  setRole(name: string, def: RoleStyleDef): void {
    this.edit.roles = { ...this.edit.roles, [name]: def };
  }

  resetRole(name: string): void {
    const next = { ...this.edit.roles };
    delete next[name];
    this.edit.roles = next;
  }

  resetRoles(names: string[]): void {
    const targets = new Set(names);
    const next = Object.fromEntries(
      Object.entries(this.edit.roles ?? {}).filter(([name]) => !targets.has(name)),
    );
    this.edit.roles = next;
  }

  isRoleOverridden(name: string): boolean {
    return this.edit.roles?.[name] != null;
  }

  defaultRoleDef(name: string): RoleStyleDef | undefined {
    return this.catalog?.defaults.roles?.[name];
  }

  // ── save ──

  markSaved(): void {
    this.baseline = { palette: { ...this.edit.palette }, roles: { ...this.edit.roles } };
  }
}

export const themeStore = new ThemeStore();
