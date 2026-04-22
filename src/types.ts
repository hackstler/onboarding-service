/** POST /generate request body */
export interface GenerateRequest {
  orgId: string;
  slug: string;
  company: {
    name: string;
    address?: string;
    phone?: string;
    email?: string;
    nif?: string;
    logo?: string;
    web?: string;
  };
  pricing: string;
  rules: string;
  pdfExample?: string;
}

/** Result returned by the Managed Agent session */
export interface SessionResult {
  sessionId: string;
  url: string;
  apiKey: string;
  repoUrl: string;
}

/** Result of the deterministic validation pipeline */
export interface ValidationResult {
  passed: boolean;
  errors: string[];
}

/** Final response from POST /generate */
export interface GenerateResponse {
  orgId: string;
  businessLogicUrl: string;
  repoUrl: string;
  status: "validated";
}
