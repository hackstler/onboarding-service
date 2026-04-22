import type { ValidationResult } from "../types.js";
import { logger } from "../logger.js";

const HEALTH_RETRIES = 3;
const HEALTH_RETRY_DELAY_MS = 5_000;
const REQUEST_TIMEOUT_MS = 15_000;

interface ConfigResponse {
  version?: string;
  businessType?: string;
  displayName?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, { type: string; enum?: string[]; minimum?: number; default?: unknown }>;
    required?: string[];
  };
  agentInstructions?: Record<string, string>;
  toolDescriptions?: { calculate?: string; listCatalog?: string };
}

interface CalculateResponse {
  rows?: Array<{ itemName?: string; breakdown?: unknown; subtotal?: number; vat?: number; total?: number }>;
  representativeTotals?: { subtotal?: number; vat?: number; total?: number };
}

/**
 * Validate a deployed business function deterministically.
 * 5 sequential checks — no LLM involved.
 */
export async function validateDeployment(url: string, apiKey: string): Promise<ValidationResult> {
  const errors: string[] = [];
  const baseUrl = url.replace(/\/+$/, "");

  // ── Check 1: GET /health ──
  const healthOk = await checkHealth(baseUrl, errors);
  if (!healthOk) {
    return { passed: false, errors };
  }

  // ── Check 2: GET /config ──
  const config = await checkConfig(baseUrl, apiKey, errors);

  // ── Check 3: GET /catalog ──
  await checkCatalog(baseUrl, apiKey, errors);

  // ── Check 4: POST /calculate ──
  let calculateResult: CalculateResponse | null = null;
  if (config) {
    calculateResult = await checkCalculate(baseUrl, apiKey, config, errors);
  } else {
    errors.push("/calculate: skipped because /config failed");
  }

  // ── Check 5: POST /pdf ──
  if (calculateResult) {
    await checkPdf(baseUrl, apiKey, calculateResult, errors);
  } else {
    errors.push("/pdf: skipped because /calculate failed");
  }

  logger.info({ url, passed: errors.length === 0, errorCount: errors.length }, "Validation complete");
  return { passed: errors.length === 0, errors };
}

// ── Individual checks ────────────────────────────────────────────────────────

async function checkHealth(baseUrl: string, errors: string[]): Promise<boolean> {
  for (let attempt = 0; attempt < HEALTH_RETRIES; attempt++) {
    try {
      const res = await fetchWithTimeout(`${baseUrl}/health`, {});
      if (res.ok) {
        const body = await res.json() as { status?: string };
        if (body.status === "ok") return true;
        errors.push(`/health: responded 200 but body.status is "${body.status}", expected "ok"`);
        return false;
      }
      if (attempt < HEALTH_RETRIES - 1) {
        await sleep(HEALTH_RETRY_DELAY_MS);
        continue;
      }
      errors.push(`/health: returned status ${res.status} after ${HEALTH_RETRIES} attempts (cold start?)`);
    } catch (err) {
      if (attempt < HEALTH_RETRIES - 1) {
        await sleep(HEALTH_RETRY_DELAY_MS);
        continue;
      }
      errors.push(`/health: unreachable after ${HEALTH_RETRIES} attempts — ${String(err)}`);
    }
  }
  return false;
}

async function checkConfig(baseUrl: string, apiKey: string, errors: string[]): Promise<ConfigResponse | null> {
  try {
    const res = await fetchWithTimeout(`${baseUrl}/config`, {
      headers: { "X-Api-Key": apiKey },
    });
    if (!res.ok) {
      errors.push(`/config: returned status ${res.status}`);
      return null;
    }

    const config = await res.json() as ConfigResponse;

    if (!config.version || typeof config.version !== "string") {
      errors.push("/config: missing or invalid 'version' field");
    }
    if (!config.businessType || typeof config.businessType !== "string") {
      errors.push("/config: missing or invalid 'businessType' field");
    }
    if (!config.displayName || typeof config.displayName !== "string") {
      errors.push("/config: missing or invalid 'displayName' field");
    }
    if (config.inputSchema?.type !== "object") {
      errors.push("/config: inputSchema.type must be 'object'");
    }
    if (!config.inputSchema?.properties || Object.keys(config.inputSchema.properties).length === 0) {
      errors.push("/config: inputSchema.properties is empty or missing");
    }
    if (!config.inputSchema?.required || config.inputSchema.required.length === 0) {
      errors.push("/config: inputSchema.required is empty or missing");
    }
    if (!config.agentInstructions?.es || config.agentInstructions.es.length < 50) {
      errors.push("/config: agentInstructions.es is missing or too short (< 50 chars)");
    }
    if (!config.toolDescriptions?.calculate) {
      errors.push("/config: toolDescriptions.calculate is missing");
    }

    return errors.length === 0 ? config : config; // Return config even with errors for downstream checks
  } catch (err) {
    errors.push(`/config: request failed — ${String(err)}`);
    return null;
  }
}

async function checkCatalog(baseUrl: string, apiKey: string, errors: string[]): Promise<void> {
  try {
    const res = await fetchWithTimeout(`${baseUrl}/catalog`, {
      headers: { "X-Api-Key": apiKey },
    });
    if (!res.ok) {
      errors.push(`/catalog: returned status ${res.status}`);
      return;
    }

    const data = await res.json() as { items?: Array<{ code?: string; name?: string; description?: string; unit?: string }> };

    if (!Array.isArray(data.items) || data.items.length === 0) {
      errors.push("/catalog: items[] is empty or missing");
      return;
    }

    for (let i = 0; i < Math.min(data.items.length, 3); i++) {
      const item = data.items[i]!;
      if (!item.code || !item.name || !item.description) {
        errors.push(`/catalog: item[${i}] missing code, name, or description`);
        break;
      }
    }
  } catch (err) {
    errors.push(`/catalog: request failed — ${String(err)}`);
  }
}

async function checkCalculate(
  baseUrl: string,
  apiKey: string,
  config: ConfigResponse,
  errors: string[],
): Promise<CalculateResponse | null> {
  try {
    const testInput = buildTestInput(config);
    const testCompany = {
      name: "Test Company",
      address: "Test Address",
      phone: "000000000",
      email: "test@test.com",
      nif: "B00000000",
      logo: null,
      vatRate: 0.21,
      currency: "\u20ac",
      web: "https://test.com",
    };

    const res = await fetchWithTimeout(`${baseUrl}/calculate`, {
      method: "POST",
      headers: { "X-Api-Key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ input: testInput, company: testCompany }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      errors.push(`/calculate: returned status ${res.status} — ${body.slice(0, 200)}`);
      return null;
    }

    const result = await res.json() as CalculateResponse;

    if (!Array.isArray(result.rows) || result.rows.length === 0) {
      errors.push("/calculate: rows[] is empty or missing");
      return null;
    }

    // Validate first row structure
    const row = result.rows[0]!;
    if (typeof row.itemName !== "string" || !row.itemName) {
      errors.push("/calculate: rows[0].itemName is missing or not a string");
    }
    if (typeof row.subtotal !== "number") {
      errors.push("/calculate: rows[0].subtotal is not a number");
    }
    if (typeof row.vat !== "number") {
      errors.push("/calculate: rows[0].vat is not a number");
    }
    if (typeof row.total !== "number") {
      errors.push("/calculate: rows[0].total is not a number");
    }
    if (typeof row.subtotal === "number" && typeof row.vat === "number" && typeof row.total === "number") {
      if (Math.abs(row.total - (row.subtotal + row.vat)) > 0.02) {
        errors.push(`/calculate: rows[0].total (${row.total}) !== subtotal (${row.subtotal}) + vat (${row.vat})`);
      }
    }

    if (!result.representativeTotals) {
      errors.push("/calculate: representativeTotals is missing");
    } else {
      if (typeof result.representativeTotals.subtotal !== "number") {
        errors.push("/calculate: representativeTotals.subtotal is not a number");
      }
      if (typeof result.representativeTotals.total !== "number") {
        errors.push("/calculate: representativeTotals.total is not a number");
      }
    }

    return result;
  } catch (err) {
    errors.push(`/calculate: request failed — ${String(err)}`);
    return null;
  }
}

async function checkPdf(
  baseUrl: string,
  apiKey: string,
  calculateResult: CalculateResponse,
  errors: string[],
): Promise<void> {
  try {
    const res = await fetchWithTimeout(`${baseUrl}/pdf`, {
      method: "POST",
      headers: { "X-Api-Key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteNumber: "TEST-001",
        date: "17/04/2026",
        company: {
          name: "Test Company",
          address: "Test Address",
          phone: "000000000",
          email: "test@test.com",
          nif: "B00000000",
          logo: null,
          vatRate: 0.21,
          currency: "\u20ac",
          web: "https://test.com",
        },
        clientName: "Test Client",
        clientAddress: "Test Client Address",
        result: calculateResult,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      errors.push(`/pdf: returned status ${res.status} — ${body.slice(0, 200)}`);
      return;
    }

    const data = await res.json() as { pdf?: string };

    if (!data.pdf || typeof data.pdf !== "string") {
      errors.push("/pdf: missing 'pdf' field in response");
      return;
    }

    if (!data.pdf.startsWith("JVBERi")) {
      errors.push("/pdf: base64 string does not start with PDF magic bytes (JVBERi)");
      return;
    }

    if (data.pdf.length < 1000) {
      errors.push(`/pdf: base64 string too short (${data.pdf.length} chars) — likely empty/broken PDF`);
    }
  } catch (err) {
    errors.push(`/pdf: request failed — ${String(err)}`);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build test input from the config's inputSchema.
 * Fills required fields with reasonable test values based on type.
 */
function buildTestInput(config: ConfigResponse): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  const props = config.inputSchema?.properties ?? {};
  const required = new Set(config.inputSchema?.required ?? []);

  for (const [key, prop] of Object.entries(props)) {
    // Only fill required fields + a few optional ones
    if (!required.has(key) && prop.default === undefined) continue;

    if (prop.default !== undefined) {
      input[key] = prop.default;
      continue;
    }

    switch (prop.type) {
      case "string":
        if (prop.enum && prop.enum.length > 0) {
          input[key] = prop.enum[0];
        } else {
          input[key] = key.toLowerCase().includes("name") ? "Test Client" :
                       key.toLowerCase().includes("address") ? "Calle Test 123, Madrid" :
                       "Test Value";
        }
        break;
      case "number":
      case "integer":
        input[key] = prop.minimum !== undefined ? prop.minimum + 10 : 10;
        break;
      case "boolean":
        input[key] = false;
        break;
      default:
        input[key] = "test";
    }
  }

  return input;
}

function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, {
    ...init,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
