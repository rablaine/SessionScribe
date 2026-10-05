import { z } from "zod";
import { config } from "./config.js";
import { AzureHttpError, requestJson } from "./http.js";
import { diagnosticToken, logDiagnostic, type HttpMetadata, type ModelContext } from "./diagnostics.js";

export const chatCompletionSchema = z.object({
  choices: z.array(z.object({
    finish_reason: z.string(),
    message: z.object({
      // Azure can omit content when output is filtered, refused, or truncated.
      content: z.string().nullable().optional(),
      refusal: z.string().nullable().optional(),
    }),
    content_filter_results: z.record(z.string(), z.unknown()).optional(),
  })).min(1),
});

const usageSchema = z.object({
  prompt_tokens: z.number().int().nonnegative().optional(),
  completion_tokens: z.number().int().nonnegative().optional(),
  total_tokens: z.number().int().nonnegative().optional(),
  completion_tokens_details: z.object({ reasoning_tokens: z.number().int().nonnegative().optional() }).optional(),
});

export function filteredCategories(results: Record<string, unknown> | undefined): string[] {
  return Object.entries(results ?? {})
    .filter(([, value]) => typeof value === "object" && value !== null && "filtered" in value && value.filtered === true)
    .map(([name, value]) => {
      const category = ["hate", "sexual", "violence", "self_harm", "jailbreak", "protected_material_text",
        "protected_material_code", "profanity", "custom_blocklists", "indirect_attack"].includes(name) ? name : "unknown";
      const severity = typeof value === "object" && value !== null && "severity" in value ? value.severity : undefined;
      return `${category}${typeof severity === "string" && ["safe", "low", "medium", "high"].includes(severity) ? `: ${severity}` : ""}`;
    });
}

export async function requestChatCompletion(init: RequestInit, context: ModelContext, callId: string) {
  const started = Date.now();
  let metadata: HttpMetadata | undefined;
  let response: unknown;
  try {
    response = await requestJson(`${config.openaiEndpoint}/openai/v1/chat/completions`, init, true, false, {
      context, callId, onResponse: value => { metadata = value; },
    });
  } catch (error) {
    logDiagnostic({ ...context, ...(error instanceof AzureHttpError || error instanceof SyntaxError ? metadata : {}),
      event: "model_error", callId, durationMs: Date.now() - started,
      errorKind: error instanceof AzureHttpError ? "http" : error instanceof SyntaxError ? "invalid_json" :
        error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network",
      errorCode: error instanceof AzureHttpError ? diagnosticToken(error.code) : undefined });
    if (error instanceof SyntaxError) throw new Error("Azure model response was not valid JSON.");
    throw error;
  }
  const parsed = chatCompletionSchema.safeParse(response);
  if (!parsed.success) {
    logDiagnostic({ ...context, ...metadata, event: "model_error", callId, durationMs: Date.now() - started, errorKind: "invalid_envelope" });
    throw new Error("Azure model returned an invalid chat completion envelope.");
  }
  const choice = parsed.data.choices[0]!;
  const usage = usageSchema.safeParse(typeof response === "object" && response !== null && "usage" in response ? response.usage : undefined);
  logDiagnostic({ ...context, ...metadata, event: "model_response", callId, durationMs: Date.now() - started,
    finishReason: ["stop", "length", "content_filter", "tool_calls", "function_call"].includes(choice.finish_reason) ? choice.finish_reason : "unknown",
    refusal: Boolean(choice.message.refusal), contentPresent: Boolean(choice.message.content),
    filteredCategories: filteredCategories(choice.content_filter_results),
    ...(usage.success ? { promptTokens: usage.data.prompt_tokens, completionTokens: usage.data.completion_tokens,
      totalTokens: usage.data.total_tokens, reasoningTokens: usage.data.completion_tokens_details?.reasoning_tokens } : {}),
  });
  return choice;
}

export function modelValidationFailure(error: SyntaxError | z.ZodError): string {
  return error instanceof SyntaxError ? "Response is not valid JSON." :
    `Invalid response schema: ${error.issues.map(issue => issue.code === "invalid_type" ? `expected ${issue.expected}` : issue.code).join(", ")}.`;
}
