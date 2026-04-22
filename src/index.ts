import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { initializeAgent } from "./services/agent.service.js";
import { createGenerateRouter } from "./routes/generate.js";
import { logger } from "./logger.js";

// ── Load and validate config ──
const config = loadConfig();

const app = new Hono();

// ── Auth middleware ──
app.use("*", async (c, next) => {
  if (c.req.path === "/health") return next();
  const key = c.req.header("X-Api-Key");
  if (key !== config.SERVICE_API_KEY) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  return next();
});

// ── Health ──
app.get("/health", (c) => c.json({ status: "ok" }));

// ── Generate route ──
const generateRouter = createGenerateRouter();
app.route("/", generateRouter);

// ── Startup ──
async function start() {
  logger.info("Initializing Managed Agent infrastructure...");
  await initializeAgent();

  logger.info({ port: config.PORT }, "Starting onboarding-service");
  serve({ fetch: app.fetch, port: config.PORT });
  logger.info({ port: config.PORT }, "onboarding-service ready");
}

start().catch((err) => {
  logger.fatal({ err }, "Failed to start onboarding-service");
  process.exit(1);
});
