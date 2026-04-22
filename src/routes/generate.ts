import { Hono } from "hono";
import { z } from "zod";
import { generateBusinessFunction, retryInSession } from "../services/agent.service.js";
import { validateDeployment } from "../services/validator.js";
import { updateOrg, verifyOrg } from "../services/backbone.service.js";
import type { GenerateRequest } from "../types.js";
import { logger } from "../logger.js";

const MAX_RETRIES = 3;

const generateSchema = z.object({
  orgId: z.string().min(1),
  slug: z.string().min(1).max(40).regex(/^[a-z0-9-]+$/, "slug must be lowercase alphanumeric with hyphens"),
  company: z.object({
    name: z.string().min(1),
    address: z.string().optional(),
    phone: z.string().optional(),
    email: z.string().optional(),
    nif: z.string().optional(),
    logo: z.string().optional(),
    web: z.string().optional(),
  }),
  pricing: z.string().min(10, "pricing data must be at least 10 characters"),
  rules: z.string().min(10, "rules must be at least 10 characters"),
  pdfExample: z.string().optional(),
});

export function createGenerateRouter() {
  const router = new Hono();

  router.post("/generate", async (c) => {
    // Parse and validate request
    const raw = await c.req.json();
    const parseResult = generateSchema.safeParse(raw);
    if (!parseResult.success) {
      return c.json({
        error: "Validation",
        message: parseResult.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      }, 400);
    }

    const body: GenerateRequest = parseResult.data;
    logger.info({ orgId: body.orgId, slug: body.slug }, "Starting generation pipeline");

    try {
      // ── FASE 2: Generate via Managed Agent ──
      let result = await generateBusinessFunction(body);

      // ── FASE 3: Validate (deterministic, up to MAX_RETRIES) ──
      let validationPassed = false;
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        logger.info({ attempt, url: result.url }, "Running validation");
        const validation = await validateDeployment(result.url, result.apiKey);

        if (validation.passed) {
          validationPassed = true;
          break;
        }

        logger.warn({ attempt, errors: validation.errors }, "Validation failed");

        if (attempt === MAX_RETRIES - 1) {
          return c.json({
            error: "GenerationFailed",
            message: `Validation failed after ${MAX_RETRIES} attempts`,
            details: validation.errors,
            failedStep: "validation",
            // Include URLs for manual debugging
            deployedUrl: result.url,
            repoUrl: result.repoUrl,
          }, 500);
        }

        // Retry: send errors to the same session
        result = await retryInSession(result.sessionId, validation.errors);
      }

      if (!validationPassed) {
        return c.json({ error: "GenerationFailed", message: "Unexpected validation state", failedStep: "validation" }, 500);
      }

      // ── FASE 4: Update org in agent-api ──
      logger.info({ orgId: body.orgId, url: result.url }, "Connecting to org");
      await updateOrg(body.orgId, result.url, result.apiKey);
      await verifyOrg(body.orgId, result.url, result.apiKey);

      // ── FASE 5: Respond ──
      logger.info({ orgId: body.orgId, url: result.url, repoUrl: result.repoUrl }, "Generation complete");
      return c.json({
        data: {
          orgId: body.orgId,
          businessLogicUrl: result.url,
          repoUrl: result.repoUrl,
          status: "validated" as const,
        },
      }, 201);
    } catch (err) {
      logger.error({ err, orgId: body.orgId, slug: body.slug }, "Generation pipeline failed");
      return c.json({
        error: "GenerationFailed",
        message: err instanceof Error ? err.message : "Unknown error",
        failedStep: "agent_session",
      }, 500);
    }
  });

  return router;
}
