import { getConfig } from "../config.js";
import { SYSTEM_PROMPT, buildUserPrompt } from "../prompts/system-prompt.js";
import type { GenerateRequest, SessionResult } from "../types.js";
import { logger } from "../logger.js";

const API_BASE = "https://api.anthropic.com/v1";
const BETA_HEADER = "managed-agents-2026-04-01";

let agentId: string;
let environmentId: string;

// ── Low-level API helpers ────────────────────────────────────────────────────

async function apiCall<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const config = getConfig();
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": BETA_HEADER,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Anthropic API error ${res.status}: ${text}`);
  }

  return res.json() as Promise<T>;
}

async function apiGet<T>(path: string): Promise<T> {
  const config = getConfig();
  const res = await fetch(`${API_BASE}${path}`, {
    method: "GET",
    headers: {
      "x-api-key": config.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": BETA_HEADER,
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Anthropic API error ${res.status}: ${text}`);
  }

  return res.json() as Promise<T>;
}

// ── Initialization ───────────────────────────────────────────────────────────

/**
 * Initialize the Managed Agent infrastructure (agent + environment).
 * Called once at startup. Both are persistent and reused across sessions.
 */
export async function initializeAgent(): Promise<void> {
  logger.info("Creating Managed Agent...");

  const agent = await apiCall<{ id: string }>("/agents", {
    name: "Business Function Generator",
    model: "claude-opus-4-6",
    system: SYSTEM_PROMPT,
    tools: [{ type: "agent_toolset_20260401", default_config: { enabled: true } }],
    max_tokens: 16384,
  });
  agentId = agent.id;
  logger.info({ agentId }, "Managed Agent created");

  logger.info("Creating Environment...");
  const environment = await apiCall<{ id: string }>("/environments", {
    name: "bf-generator-env",
    packages: {
      npm: ["hono", "@hono/node-server", "pdf-lib", "typescript", "esbuild", "tsx", "@types/node"],
    },
    networking: { mode: "unrestricted" },
  });
  environmentId = environment.id;
  logger.info({ environmentId }, "Environment created");
}

// ── Session management ───────────────────────────────────────────────────────

/**
 * Generate a business function by creating a session and streaming until completion.
 * The agent generates code, validates locally, pushes to GitHub, deploys to Railway.
 */
export async function generateBusinessFunction(params: GenerateRequest): Promise<SessionResult> {
  const config = getConfig();

  logger.info({ slug: params.slug, orgId: params.orgId }, "Starting business function generation");

  // Create a new session
  const session = await apiCall<{ id: string }>("/sessions", {
    agent_id: agentId,
    environment_id: environmentId,
  });
  logger.info({ sessionId: session.id }, "Session created");

  // Build the user prompt with credentials
  const userPrompt = buildUserPrompt({
    slug: params.slug,
    pricing: params.pricing,
    rules: params.rules,
    company: params.company,
    pdfExample: params.pdfExample,
    githubOrg: config.GITHUB_ORG,
    railwayToken: config.RAILWAY_TOKEN,
    githubToken: config.GITHUB_TOKEN,
  });

  // Send the task and wait for completion
  const result = await sendAndWaitForCompletion(session.id, userPrompt);
  return { ...result, sessionId: session.id };
}

/**
 * Retry within an existing session. Sends validation errors and waits for fixes.
 * Reuses the same container context = same files, cheaper.
 */
export async function retryInSession(sessionId: string, errors: string[]): Promise<SessionResult> {
  logger.info({ sessionId, errorCount: errors.length }, "Retrying in existing session");

  const message = [
    "The deployed business function FAILED validation. Fix the issues, rebuild, redeploy, and return the updated JSON.",
    "",
    "VALIDATION ERRORS:",
    ...errors.map((e, i) => `${i + 1}. ${e}`),
    "",
    "After fixing, output the JSON result on the last line as before.",
  ].join("\n");

  const result = await sendAndWaitForCompletion(sessionId, message);
  return { ...result, sessionId };
}

// ── Core: send message and stream events ─────────────────────────────────────

async function sendAndWaitForCompletion(
  sessionId: string,
  message: string,
): Promise<Omit<SessionResult, "sessionId">> {
  const config = getConfig();

  // Send user message to the session
  await apiCall(`/sessions/${sessionId}/messages`, {
    role: "user",
    content: message,
  });

  // Poll or stream for session completion
  // The Managed Agents API uses SSE streaming for session events
  const streamUrl = `${API_BASE}/sessions/${sessionId}/stream`;
  const res = await fetch(streamUrl, {
    method: "GET",
    headers: {
      "x-api-key": config.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": BETA_HEADER,
      "Accept": "text/event-stream",
    },
    signal: AbortSignal.timeout(15 * 60 * 1000), // 15 minute timeout
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Stream error ${res.status}: ${text}`);
  }

  // Read SSE stream
  let fullText = "";
  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body for SSE stream");

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // Parse SSE events from buffer
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? ""; // Keep incomplete line in buffer

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const data = line.slice(6);
        if (data === "[DONE]") continue;

        try {
          const event = JSON.parse(data) as {
            type: string;
            delta?: { type?: string; text?: string };
            error?: { message?: string };
          };

          if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
            fullText += event.delta.text;
          }
          if (event.type === "error") {
            throw new Error(`Agent session error: ${event.error?.message ?? JSON.stringify(event)}`);
          }
        } catch (e) {
          if (e instanceof SyntaxError) continue; // Ignore malformed JSON
          throw e;
        }
      }
    }
  }

  // If streaming didn't capture text, try polling the session result
  if (!fullText) {
    logger.warn({ sessionId }, "No text captured from stream, polling session...");
    const sessionState = await apiGet<{
      status: string;
      messages?: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>;
    }>(`/sessions/${sessionId}`);

    // Extract text from the last assistant message
    const assistantMessages = sessionState.messages?.filter((m) => m.role === "assistant") ?? [];
    for (const msg of assistantMessages.reverse()) {
      if (typeof msg.content === "string") {
        fullText = msg.content;
        break;
      }
      if (Array.isArray(msg.content)) {
        const textBlock = msg.content.find((b) => b.type === "text" && b.text);
        if (textBlock?.text) {
          fullText = textBlock.text;
          break;
        }
      }
    }
  }

  if (!fullText) {
    throw new Error("Agent completed but produced no text output");
  }

  // Extract the JSON result from the last line
  return extractJsonResult(fullText, sessionId);
}

function extractJsonResult(text: string, sessionId: string): Omit<SessionResult, "sessionId"> {
  const lines = text.trim().split("\n");

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (line.startsWith("{") && line.includes('"status"')) {
      try {
        const result = JSON.parse(line) as {
          status: string;
          url?: string;
          apiKey?: string;
          repoUrl?: string;
          message?: string;
        };

        if (result.status === "ok" && result.url && result.apiKey && result.repoUrl) {
          logger.info({ url: result.url, repoUrl: result.repoUrl }, "Agent returned valid result");
          return { url: result.url, apiKey: result.apiKey, repoUrl: result.repoUrl };
        }
        if (result.status === "error") {
          throw new Error(`Agent reported error: ${result.message ?? "unknown"}`);
        }
      } catch (e) {
        if (e instanceof SyntaxError) continue;
        throw e;
      }
    }
  }

  logger.error({ sessionId, outputLength: text.length, lastChars: text.slice(-500) }, "No valid JSON result found");
  throw new Error("Agent completed but did not return a valid JSON result");
}
