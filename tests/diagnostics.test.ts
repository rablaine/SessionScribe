import { test } from "node:test";
import assert from "node:assert/strict";
import { createDemo } from "../src/demo.js";
import { callAzure, generateRecap } from "../src/recap.js";
import { callSuggestModel, suggestNameFixes } from "../src/names.js";
import { AzureHttpError, requestJson } from "../src/http.js";
import type { ModelContext } from "../src/diagnostics.js";

const secret = "PRIVATE_TRANSCRIPT_AND_CREDENTIAL";
const nameSource = JSON.stringify({ id: "S1", text: secret });
const headers = async () => ({ Authorization: `Bearer ${secret}` });
const context: ModelContext = { sessionId: "session-fixture", runId: "run-fixture", part: 2, parts: 3 };

async function capture(work: (entries: Array<Record<string, unknown>>) => Promise<void>) {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const originalWarn = console.warn;
  const entries: Array<Record<string, unknown>> = [];
  const collect = (value: unknown) => {
    assert.equal(typeof value, "string");
    const text = String(value);
    assert.equal(text.includes(secret), false, "private content must never appear in diagnostic output");
    entries.push(JSON.parse(text));
  };
  console.log = collect;
  console.warn = collect;
  try { await work(entries); }
  finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.warn = originalWarn;
  }
}

test("model diagnostics correlate every recap pass and name-check slice without recording source data", async () => {
  await capture(async entries => {
    const job = { ...createDemo(), title: secret, context: secret,
      segments: Array.from({ length: 3 }, (_, index) => ({
        id: `S${index + 1}`, speaker: "speaker-1", startMs: index * 1000, endMs: (index + 1) * 1000, text: secret.repeat(400),
      })),
      clarifications: [{ id: "c1", text: secret, createdAt: new Date().toISOString() }] };
    globalThis.fetch = async (_input, init = {}) => {
      const body = JSON.parse(String(init.body));
      assert.equal(new Headers(init.headers).get("Authorization"), `Bearer ${secret}`);
      assert.equal(String(init.body).includes("sessionId"), false, "diagnostic context must not be sent to the model");
      const names = body.response_format.json_schema.name === "name_fixes";
      const extraction = /Extract at most 8/.test(body.messages[0].content);
      return Response.json({
        choices: [{ finish_reason: "stop", message: { content: JSON.stringify(names ? { suggestions: [] } : {
          title: "Story", paragraphs: [{ text: secret }], uncertainties: [], ...(extraction ? { quotes: [] } : {}),
        }) } }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, completion_tokens_details: { reasoning_tokens: 5 } },
      }, { headers: { "apim-request-id": "azure-request-fixture" } });
    };
    await generateRecap(job, async () => {}, (source, campaign, phase) => callAzure(source, campaign, phase, headers));
    await suggestNameFixes(job, [{ term: secret, variants: [] }], async () => {},
      (lines, names, diagnostics) => callSuggestModel(lines, names, headers, diagnostics));
    assert.deepEqual(entries.map(entry => entry.phase), ["extraction", "extraction", "extraction", "writing", "name_check", "name_check", "name_check"]);
    assert.equal(new Set(entries.slice(0, 4).map(entry => entry.runId)).size, 1);
    assert.equal(new Set(entries.slice(4).map(entry => entry.runId)).size, 1);
    assert.notEqual(entries[0]!.runId, entries[4]!.runId);
    assert.equal(new Set(entries.map(entry => entry.callId)).size, 7);
    assert.deepEqual(entries.slice(0, 3).map(entry => entry.part), [1, 2, 3]);
    assert.deepEqual(entries.slice(4).map(entry => entry.part).sort(), [1, 2, 3]);
    for (const entry of entries) {
      assert.equal(entry.event, "model_response");
      assert.equal(entry.sessionId, job.id);
      assert.equal(entry.parts, entry.phase === "writing" ? 1 : 3);
      if (entry.phase === "writing") assert.equal(entry.part, 1);
      assert.equal(entry.status, 200);
      assert.equal(entry.requestId, "azure-request-fixture");
      assert.equal(entry.modelAttempt, 1);
      assert.equal(entry.promptTokens, 100);
      assert.equal(entry.completionTokens, 20);
      assert.equal(entry.totalTokens, 120);
      assert.equal(entry.reasoningTokens, 5);
      assert.equal(typeof entry.timestamp, "string");
      assert.equal(typeof entry.durationMs, "number");
    }
  });
});

test("HTTP retries retain correlation, record rate limiting and request IDs, and never log URLs or error bodies", async () => {
  await capture(async entries => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      if (calls === 1) return Response.json({ error: { message: secret } }, {
        status: 429, headers: { "retry-after": "0", "x-ms-request-id": "throttled-request" },
      });
      return Response.json({ choices: [{ finish_reason: "stop", message: { content: '{"suggestions":[]}' } }] },
        { headers: { "x-request-id": "successful-request" } });
    };
    await callSuggestModel(nameSource, [], headers, context);
    assert.equal(calls, 2);
    const [retry, response] = entries;
    assert.equal(retry!.event, "azure_http_retry");
    assert.equal(retry!.status, 429);
    assert.equal(retry!.httpAttempt, 1);
    assert.equal(retry!.retryDelayMs, 1000);
    assert.equal(retry!.requestId, "throttled-request");
    assert.equal(response!.requestId, "successful-request");
    assert.equal(retry!.callId, response!.callId);
    assert.equal(retry!.runId, context.runId);
    assert.equal(retry!.part, 2);
    assert.equal(response!.parts, 3);

    globalThis.fetch = async () => Response.json({ error: { code: "content_filter", message: secret } },
      { status: 400, headers: { "apim-request-id": "blocked-request" } });
    assert.equal(await callSuggestModel(nameSource, [], headers, context), "filtered");
    const failure = entries.at(-1)!;
    assert.equal(failure.event, "model_error");
    assert.equal(failure.errorKind, "http");
    assert.equal(failure.errorCode, "content_filter");
    assert.equal(failure.requestId, "blocked-request");
    await assert.rejects(requestJson(`https://fixture.example/${secret}?sig=${secret}`, {}, false), (error: unknown) => {
      assert.ok(error instanceof AzureHttpError);
      assert.equal(error.requestId, "blocked-request");
      return true;
    });
  });
});

test("model failures log safe categories, timeout classification and sanitized validation errors", async () => {
  await capture(async entries => {
    const phase = { final: true, level: 1, diagnostics: context };
    globalThis.fetch = async () => Response.json({ choices: [{
      finish_reason: "content_filter", message: { refusal: secret },
      content_filter_results: {
        violence: { filtered: true, severity: "medium" },
        [secret]: { filtered: true, severity: secret },
      },
    }] });
    await assert.rejects(callAzure(secret, secret, phase, headers), /content filter/);
    assert.deepEqual(entries.at(-1)!.filteredCategories, ["violence: medium", "unknown"]);
    assert.equal(entries.at(-1)!.refusal, true);
    assert.equal(entries.at(-1)!.contentPresent, false);

    globalThis.fetch = async () => { throw new DOMException(secret, "TimeoutError"); };
    await assert.rejects(callAzure(secret, secret, phase, headers), { name: "TimeoutError" });
    assert.equal(entries.at(-1)!.errorKind, "timeout");
    assert.equal(entries.at(-2)!.event, "azure_http_error");
    assert.equal(entries.at(-1)!.status, undefined);

    for (const content of [secret, JSON.stringify({ title: "Story", paragraphs: [], uncertainties: [], [secret]: secret })]) {
      globalThis.fetch = async () => Response.json({ choices: [{ finish_reason: "stop", message: { content } }] });
      await assert.rejects(callAzure(secret, secret, phase, headers), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message.includes(secret), false, "persisted errors must not echo model text or unknown keys");
        return true;
      });
      const failure = entries.at(-1)!;
      assert.equal(failure.event, "model_validation_error");
      assert.equal(failure.modelAttempt, 2);
      assert.equal(failure.errorKind, content === secret ? "invalid_json" : "invalid_schema");
      assert.equal(entries.at(-3)!.event, "model_validation_retry");
    }

    globalThis.fetch = async () => Response.json({ choices: [{ finish_reason: "stop", message: { content: 42 } }] });
    await assert.rejects(callSuggestModel(nameSource, [], headers, context), /invalid chat completion envelope/);
    assert.equal(entries.at(-1)!.errorKind, "invalid_envelope");
    globalThis.fetch = async () => new Response(secret, { headers: { "x-request-id": "malformed-json-request" } });
    await assert.rejects(callAzure(secret, secret, phase, headers), /response was not valid JSON/);
    assert.equal(entries.at(-1)!.errorKind, "invalid_json");
    assert.equal(entries.at(-1)!.requestId, "malformed-json-request");
  });
});
