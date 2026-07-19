import { Hono } from "hono";
import { listWeatherFixtures } from "../lib/fixture-loader";
import { findWeatherEntry } from "../registry/weather-registry";

export function fixturesRoute(): Hono {
  const app = new Hono();
  app.get("/", (c) => {
    const fixtures = listWeatherFixtures().map((f) => ({
      id: f.id,
      type: f.type,
      label: f.label,
      supported: findWeatherEntry(f.id) != null,
    }));
    return c.json({ fixtures });
  });
  return app;
}
