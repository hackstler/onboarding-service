import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  ANTHROPIC_API_KEY: z.string().min(1),
  AGENT_API_URL: z.string().url(),
  AGENT_API_JWT_SECRET: z.string().min(10),
  RAILWAY_TOKEN: z.string().min(1),
  GITHUB_TOKEN: z.string().min(1),
  SERVICE_API_KEY: z.string().min(1),
  GITHUB_ORG: z.string().default("hackstler"),
});

export type Config = z.infer<typeof envSchema>;

let _config: Config | null = null;

export function loadConfig(): Config {
  if (_config) return _config;
  _config = envSchema.parse(process.env);
  return _config;
}

export function getConfig(): Config {
  if (!_config) throw new Error("Config not loaded. Call loadConfig() first.");
  return _config;
}
