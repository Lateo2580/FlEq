import { Hono } from "hono";
import { render, type RenderRequest } from "../lib/render-engine";
import { RenderQueueFullError } from "../lib/render-mutex";
import { isThemeFileShape } from "../lib/theme-file-guard";

function isRenderOptions(value: unknown): value is RenderRequest["options"] {
  if (typeof value !== "object" || value == null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.compact === "boolean" &&
    typeof v.width === "number" &&
    Number.isInteger(v.width) &&
    v.width >= 40 &&
    v.width <= 300 &&
    typeof v.noColor === "boolean" &&
    typeof v.nightMode === "boolean"
  );
}

export function parseBody(value: unknown): RenderRequest | null {
  if (typeof value !== "object" || value == null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.fixtureId !== "string") return null;
  if (!isThemeFileShape(v.themeOverride)) return null;
  if (!isRenderOptions(v.options)) return null;
  return {
    fixtureId: v.fixtureId,
    themeOverride: v.themeOverride,
    options: v.options,
  };
}

export function renderRoute(): Hono {
  const app = new Hono();
  app.post("/", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Body は valid な JSON である必要があります" }, 400);
    }
    const req = parseBody(body);
    if (req == null) {
      return c.json({ error: "Body フォーマットが不正" }, 400);
    }
    try {
      const result = await render(req);
      return c.json(result);
    } catch (err) {
      if (err instanceof RenderQueueFullError) {
        return c.json({ error: err.message }, 429);
      }
      const message = err instanceof Error ? err.message : "不明なエラー";
      // ビジネスロジック側の既知エラー (未対応 / 見つからない / parse 失敗) は 400
      if (/未対応|unsupported|見つからない|not found|parse 失敗/i.test(message)) {
        return c.json({ error: message }, 400);
      }
      return c.json({ error: message }, 500);
    }
  });
  return app;
}
