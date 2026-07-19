import { Hono } from "hono";
import { renderDiff } from "../lib/render-engine";
import { RenderQueueFullError } from "../lib/render-mutex";
import { parseBody } from "./render";

export function diffRoute(): Hono {
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
      const result = await renderDiff(req);
      return c.json(result);
    } catch (err) {
      if (err instanceof RenderQueueFullError) {
        return c.json({ error: err.message }, 429);
      }
      const message = err instanceof Error ? err.message : "不明なエラー";
      if (/未対応|unsupported|見つからない|not found|parse 失敗/i.test(message)) {
        return c.json({ error: message }, 400);
      }
      return c.json({ error: message }, 500);
    }
  });
  return app;
}
