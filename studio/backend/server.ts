import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { fixturesRoute } from "./routes/fixtures";
import { renderRoute } from "./routes/render";
import { diffRoute } from "./routes/diff";
import { highlightRoute } from "./routes/highlight";
import { themeRoute } from "./routes/theme";
import { displayReferenceRoute } from "./routes/display-reference";

const PORT = 7787;
const HOST = "127.0.0.1";

function buildApp(): Hono {
  const app = new Hono();
  app.get("/api/health", (c) => c.json({ ok: true, phase: "1" }));
  app.route("/api/fixtures", fixturesRoute());
  app.route("/api/render", renderRoute());
  app.route("/api/diff", diffRoute());
  app.route("/api/highlight", highlightRoute());
  app.route("/api/theme", themeRoute());
  app.route("/api/display-reference", displayReferenceRoute());
  return app;
}

function main(): void {
  const app = buildApp();
  serve(
    { fetch: app.fetch, port: PORT, hostname: HOST },
    (info) => {
      console.error(`[studio] backend listening on http://${HOST}:${info.port}`);
      console.error(`[studio] phase: 1 (Phase 1 complete — fixture preview / theme edit / display options / diff)`);
      console.error(`[studio] try: curl http://${HOST}:${info.port}/api/fixtures`);
    },
  );
}

if (require.main === module) {
  main();
}

export { buildApp };
