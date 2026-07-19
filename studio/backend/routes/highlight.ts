import { Hono } from "hono";
import { renderRoleHighlight } from "../lib/render-engine";
import { RenderQueueFullError } from "../lib/render-mutex";
import { parseBody } from "./render";

export function highlightRoute(): Hono {
  const app = new Hono();
  app.post("/", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Body is not valid JSON" }, 400);
    }
    const req = parseBody(body);
    const roleName = typeof (body as { roleName?: unknown } | null)?.roleName === "string"
      ? (body as { roleName: string }).roleName
      : null;
    if (req == null || roleName == null || roleName.length === 0) {
      return c.json({ error: "Body format is invalid" }, 400);
    }
    try {
      return c.json(await renderRoleHighlight(req, roleName));
    } catch (err) {
      if (err instanceof RenderQueueFullError) {
        return c.json({ error: err.message }, 429);
      }
      const message = err instanceof Error ? err.message : "Unexpected error";
      return c.json({ error: message }, 500);
    }
  });
  return app;
}
