import jwt from "jsonwebtoken";
import { getConfig } from "../config.js";
import { logger } from "../logger.js";

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Update an organization's businessLogicUrl and businessLogicApiKey
 * in agent-api via the admin endpoint.
 */
export async function updateOrg(orgId: string, businessLogicUrl: string, businessLogicApiKey: string): Promise<void> {
  const config = getConfig();
  const token = generateAdminToken(config.AGENT_API_JWT_SECRET);

  const url = `${config.AGENT_API_URL}/admin/organizations/${orgId}`;
  logger.info({ url, orgId }, "Updating org with business function URL");

  const res = await fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify({ businessLogicUrl, businessLogicApiKey }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Failed to update org ${orgId}: ${res.status} — ${body}`);
  }

  logger.info({ orgId }, "Org updated successfully");
}

/**
 * Verify that the org's businessLogicUrl was saved correctly.
 */
export async function verifyOrg(orgId: string, expectedUrl: string, expectedApiKey: string): Promise<void> {
  const config = getConfig();
  const token = generateAdminToken(config.AGENT_API_JWT_SECRET);

  const url = `${config.AGENT_API_URL}/admin/organizations/${orgId}`;
  const res = await fetch(url, {
    method: "GET",
    headers: { "Authorization": `Bearer ${token}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`Failed to verify org ${orgId}: ${res.status}`);
  }

  const data = await res.json() as { data?: { businessLogicUrl?: string; businessLogicApiKey?: string } };
  const org = data.data;

  if (org?.businessLogicUrl !== expectedUrl) {
    throw new Error(`Org verification failed: businessLogicUrl is "${org?.businessLogicUrl}", expected "${expectedUrl}"`);
  }
  if (org?.businessLogicApiKey !== expectedApiKey) {
    throw new Error(`Org verification failed: businessLogicApiKey mismatch`);
  }

  logger.info({ orgId }, "Org verification passed");
}

/**
 * Generate a short-lived JWT with super_admin role.
 * Uses the same JWT_SECRET as agent-api for shared auth.
 */
function generateAdminToken(secret: string): string {
  return jwt.sign(
    {
      userId: "onboarding-service",
      orgId: "system",
      role: "super_admin",
      email: "system@onboarding-service",
    },
    secret,
    { expiresIn: "1h" },
  );
}
