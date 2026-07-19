// backend API クライアント。型は studio/backend/routes/* のレスポンス実形に一致させる

// ThemeFile は backend (src/ui/theme.ts) と同形。frontend は型だけ複製する
// (frontend から ../../src を import すると Vite ビルドに Node 依存が混ざるため)
export type RoleStyleDef = string | { bg?: string; fg?: string; bold?: boolean };

export interface ThemeFile {
  palette?: Partial<Record<string, string>>;
  roles?: Partial<Record<string, RoleStyleDef>>;
}

export interface RoleCategory {
  label: string;
  roles: string[];
}

export interface ThemeCatalog {
  paletteNames: string[];
  roleNames: string[];
  categories: RoleCategory[];
  defaults: ThemeFile;
  saved: ThemeFile | null;
  warnings: string[];
}

export async function getTheme(): Promise<ThemeCatalog> {
  const res = await fetch("/api/theme");
  if (!res.ok) throw new Error(`theme カタログの取得に失敗しました (HTTP ${res.status})`);
  return (await res.json()) as ThemeCatalog;
}

export async function saveTheme(theme: ThemeFile): Promise<{ ok: boolean; warnings: string[] }> {
  const res = await fetch("/api/theme/save", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ theme }),
  });
  if (!res.ok) {
    let message = `保存に失敗しました (HTTP ${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error != null) message = body.error;
    } catch { /* 非 JSON はステータスメッセージ */ }
    throw new Error(message);
  }
  return (await res.json()) as { ok: boolean; warnings: string[] };
}

export interface FixtureSummary {
  id: string;
  type: string;
  label: string;
  supported: boolean;
}

export interface RenderOptions {
  compact: boolean;
  width: number;   // backend は 40-300 の整数のみ受理
  noColor: boolean;
  nightMode: boolean;
}

export interface RenderResult {
  ansi: string;
  warnings: string[];
  durationMs: number;
}

export async function fetchFixtures(): Promise<FixtureSummary[]> {
  const res = await fetch("/api/fixtures");
  if (!res.ok) throw new Error(`fixtures の取得に失敗しました (HTTP ${res.status})`);
  const body = (await res.json()) as { fixtures: FixtureSummary[] };
  return body.fixtures;
}

export interface DisplayReferenceSection {
  heading: string;
  markdown: string;
}

export async function fetchDisplayReference(type: string): Promise<DisplayReferenceSection[]> {
  const res = await fetch(`/api/display-reference?type=${encodeURIComponent(type)}`);
  if (!res.ok) throw new Error(`display-reference の取得に失敗しました (HTTP ${res.status})`);
  const body = (await res.json()) as { sections: DisplayReferenceSection[] };
  return body.sections;
}

export interface DiffResult {
  before: string;
  after: string;
  warnings: string[];
  durationMs: number;
}

export async function renderDiff(
  fixtureId: string,
  options: RenderOptions,
  themeOverride: ThemeFile,
): Promise<DiffResult> {
  const res = await fetch("/api/diff", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fixtureId, themeOverride, options }),
  });
  if (!res.ok) {
    let message = `diff に失敗しました (HTTP ${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error != null) message = body.error;
    } catch { /* 非 JSON */ }
    throw new Error(message);
  }
  return (await res.json()) as DiffResult;
}

export async function renderRoleHighlight(
  fixtureId: string,
  options: RenderOptions,
  themeOverride: ThemeFile,
  roleName: string,
): Promise<DiffResult> {
  const res = await fetch("/api/highlight", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fixtureId, themeOverride, options, roleName }),
  });
  if (!res.ok) throw new Error(`role highlight failed (HTTP ${res.status})`);
  return (await res.json()) as DiffResult;
}

export async function renderFixture(
  fixtureId: string,
  options: RenderOptions,
  themeOverride: ThemeFile = { palette: {}, roles: {} },
): Promise<RenderResult> {
  const res = await fetch("/api/render", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fixtureId, themeOverride, options }),
  });
  if (!res.ok) {
    // backend down 時は proxy が非 JSON を返すため、json() 失敗に備える (レビュー反映)
    let message = `render に失敗しました (HTTP ${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error != null) message = body.error;
    } catch {
      // 非 JSON ボディはそのまま HTTP ステータスのメッセージを使う
    }
    throw new Error(message);
  }
  return (await res.json()) as RenderResult;
}
