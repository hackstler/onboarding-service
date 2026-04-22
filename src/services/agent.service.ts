import { getConfig } from "../config.js";
import { SYSTEM_PROMPT, buildUserPrompt } from "../prompts/system-prompt.js";
import type { GenerateRequest, SessionResult } from "../types.js";
import { logger } from "../logger.js";

const API_BASE = "https://api.anthropic.com/v1";
const BETA_HEADER = "managed-agents-2026-04-01";
const SESSION_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

let agentId: string;
let environmentId: string;

// ── Low-level API helpers ────────────────────────────────────────────────────

function apiHeaders(): Record<string, string> {
  const config = getConfig();
  return {
    "Content-Type": "application/json",
    "x-api-key": config.ANTHROPIC_API_KEY,
    "anthropic-version": "2023-06-01",
    "anthropic-beta": BETA_HEADER,
  };
}

async function apiPost<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: apiHeaders(),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Anthropic API error ${res.status} on POST ${path}: ${text}`);
  }

  return res.json() as Promise<T>;
}

async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "GET",
    headers: apiHeaders(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Anthropic API error ${res.status} on GET ${path}: ${text}`);
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

  const agent = await apiPost<{ id: string }>("/agents", {
    name: "Business Function Generator",
    model: "claude-opus-4-6",
    system: SYSTEM_PROMPT,
    tools: [{ type: "agent_toolset_20260401" }],
  });
  agentId = agent.id;
  logger.info({ agentId }, "Managed Agent created");

  logger.info("Creating Environment...");
  const environment = await apiPost<{ id: string }>("/environments", {
    name: `bf-generator-env-${Date.now()}`,
    config: {
      type: "cloud",
      packages: {
        npm: ["hono", "@hono/node-server", "pdf-lib", "typescript", "esbuild", "tsx", "@types/node"],
      },
      networking: { type: "unrestricted" },
    },
  });
  environmentId = environment.id;
  logger.info({ environmentId }, "Environment created");
}

// ── Session management ───────────────────────────────────────────────────────

/**
 * Generate a business function by creating a session, sending the task,
 * and streaming events until the agent reaches idle state.
 */
export async function generateBusinessFunction(params: GenerateRequest): Promise<SessionResult> {
  const config = getConfig();

  logger.info({ slug: params.slug, orgId: params.orgId }, "Starting business function generation");

  // Create a new session referencing agent + environment
  const session = await apiPost<{ id: string }>("/sessions", {
    agent: agentId,
    environment_id: environmentId,
    title: `Generate BF: ${params.slug}`,
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

  // Send the task and stream until idle
  const result = await sendAndStreamToCompletion(session.id, userPrompt);
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

  const result = await sendAndStreamToCompletion(sessionId, message);
  return { ...result, sessionId };
}

// ── Core: send message via events API, then stream SSE until idle ─────────

async function sendAndStreamToCompletion(
  sessionId: string,
  message: string,
): Promise<Omit<SessionResult, "sessionId">> {
  const config = getConfig();

  // 1. Open SSE stream first (per docs recommendation)
  const streamUrl = `${API_BASE}/sessions/${sessionId}/stream`;
  const streamRes = await fetch(streamUrl, {
    method: "GET",
    headers: {
      ...apiHeaders(),
      "Accept": "text/event-stream",
    },
    signal: AbortSignal.timeout(SESSION_TIMEOUT_MS),
  });

  if (!streamRes.ok) {
    const text = await streamRes.text().catch(() => "");
    throw new Error(`Stream error ${streamRes.status}: ${text}`);
  }

  // 2. Send user message via events endpoint
  await apiPost(`/sessions/${sessionId}/events`, {
    events: [
      {
        type: "user.message",
        content: [{ type: "text", text: message }],
      },
    ],
  });
  logger.info({ sessionId }, "User message sent");

  // 3. Read SSE stream until session.status_idle or session.status_terminated
  let fullText = "";
  const reader = streamRes.body?.getReader();
  if (!reader) throw new Error("No response body for SSE stream");

  const decoder = new TextDecoder();
  let buffer = "";
  let sessionDone = false;

  while (!sessionDone) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // Parse SSE events — split by double newline (event boundary)
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";

    for (const line of parts) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (!data || data === "[DONE]") continue;

      try {
        const event = JSON.parse(data) as {
          type: string;
          content?: Array<{ type: string; text?: string }>;
          stop_reason?: string;
          error?: { message?: string };
        };

        switch (event.type) {
          case "agent.message":
            // Extract text from content blocks
            if (event.content) {
              for (const block of event.content) {
                if (block.type === "text" && block.text) {
                  fullText += block.text;
                }
              }
            }
            break;

          case "session.status_idle":
            logger.info({ sessionId, stopReason: event.stop_reason }, "Session reached idle");
            sessionDone = true;
            break;

          case "session.status_terminated":
            logger.error({ sessionId, event }, "Session terminated");
            throw new Error(`Session terminated: ${event.error?.message ?? "unknown reason"}`);

          case "session.error":
            logger.error({ sessionId, error: event.error }, "Session error");
            throw new Error(`Session error: ${event.error?.message ?? JSON.stringify(event)}`);

          case "agent.tool_use":
          case "agent.tool_result":
            // Built-in tools executing — just log progress
            break;

          default:
            // Ignore other event types (thinking, span, etc.)
            break;
        }
      } catch (e) {
        if (e instanceof SyntaxError) continue;
        throw e;
      }
    }
  }

  // Close the reader
  reader.cancel().catch(() => {});

  // If no text captured from stream, poll session for messages
  if (!fullText) {
    logger.warn({ sessionId }, "No text from stream, polling session...");
    fullText = await pollSessionText(sessionId);
  }

  if (!fullText) {
    throw new Error("Agent completed but produced no text output");
  }

  return extractJsonResult(fullText, sessionId);
}

/**
 * Poll the session endpoint to get the last assistant message text.
 * Fallback when SSE streaming doesn't capture text (e.g. events missed).
 */
async function pollSessionText(sessionId: string): Promise<string> {
  const session = await apiGet<{
    status: string;
    messages?: Array<{
      role: string;
      content: string | Array<{ type: string; text?: string }>;
    }>;
  }>(`/sessions/${sessionId}`);

  const assistantMsgs = session.messages?.filter((m) => m.role === "assistant") ?? [];

  for (const msg of assistantMsgs.reverse()) {
    if (typeof msg.content === "string") return msg.content;
    if (Array.isArray(msg.content)) {
      const texts = msg.content
        .filter((b) => b.type === "text" && b.text)
        .map((b) => b.text!)
        .join("\n");
      if (texts) return texts;
    }
  }

  return "";
}

/**
 * Extract the JSON result line from the agent's output.
 * The system prompt instructs the agent to output a JSON object on the last line.
 */
function extractJsonResult(text: string, sessionId: string): Omit<SessionResult, "sessionId"> {
  const lines = text.trim().split("\n");

  // Search from the end for the JSON result
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line.startsWith("{")) continue;

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

  logger.error(
    { sessionId, outputLength: text.length, lastChars: text.slice(-500) },
    "No valid JSON result found in agent output",
  );
  throw new Error("Agent completed but did not return a valid JSON result. Check session logs.");
}
