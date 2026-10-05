export type ModelContext = {
  sessionId?: string;
  runId?: string;
  operation?: "recap" | "names";
  phase?: "extraction" | "consolidation" | "writing" | "name_check";
  level?: number;
  part?: number;
  parts?: number;
  modelAttempt?: number;
  maxCompletionTokens?: number;
};

export type HttpMetadata = { status: number; requestId?: string };

type Diagnostic = ModelContext & Partial<HttpMetadata> & {
  event: "azure_http_retry" | "azure_http_error" | "model_response" | "model_error" | "model_validation_retry" | "model_validation_error";
  callId: string;
  durationMs?: number;
  httpAttempt?: number;
  retryDelayMs?: number;
  errorCode?: string;
  errorKind?: "timeout" | "network" | "http" | "invalid_envelope" | "invalid_json" | "invalid_schema";
  finishReason?: string;
  refusal?: boolean;
  contentPresent?: boolean;
  filteredCategories?: string[];
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
};

export function diagnosticToken(value: string | null | undefined): string | undefined {
  return value && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value) ? value : undefined;
}

// Only typed metadata belongs here: never log request/response bodies, URLs, or error messages.
export function logDiagnostic(diagnostic: Diagnostic) {
  const entry = JSON.stringify({ timestamp: new Date().toISOString(), ...diagnostic });
  if (diagnostic.event === "model_response" && diagnostic.finishReason === "stop" && !diagnostic.refusal && diagnostic.contentPresent) {
    console.log(entry);
  } else {
    console.warn(entry);
  }
}
