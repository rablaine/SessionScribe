import { test } from "node:test";
import assert from "node:assert/strict";
import { AzureSpeech } from "../src/azure.js";
import { config } from "../src/config.js";
import { createDemo } from "../src/demo.js";
import { callAzure, generateRecap, RecapModelError } from "../src/recap.js";
import { callSuggestModel } from "../src/names.js";
import { requestJson } from "../src/http.js";

test("Azure wire contract: Entra bearer auth, plain blob URLs, isolated result SAS, recap and cleanup", async () => {
  const originalConfig = { ...config };
  const originalFetch = globalThis.fetch;
  Object.assign(config, {
    speechEndpoint: "https://fixture.cognitiveservices.azure.com",
    openaiEndpoint: "https://fixture.openai.azure.com", openaiDeployment: "recap-deployment",
    openaiReasoningEffort: "low", openaiMaxCompletionTokens: 16000,
  });
  const jobUrl = `${config.speechEndpoint}/speechtotext/transcriptions/fixture?api-version=2025-10-15`;
  const contentUrl = "https://fixture.blob.core.windows.net/result.json?sig=fixture";
  const requests: { url: string; method: string }[] = [];
  const job = createDemo();
  try {
    globalThis.fetch = async (input, init = {}) => {
      const url = String(input);
      const method = init.method || "GET";
      requests.push({ url, method });
      const headers = new Headers(init.headers);
      assert.equal(headers.has("api-key"), false);
      assert.equal(headers.has("Ocp-Apim-Subscription-Key"), false);
      if (url !== contentUrl) assert.equal(headers.get("Authorization"), "Bearer fixture-token");
      if (url.includes("transcriptions:submit")) {
        assert.equal(method, "POST");
        const body = JSON.parse(String(init.body));
        assert.deepEqual(body.properties.diarization, { enabled: true, maxSpeakers: 6 });
        assert.equal("diarizationEnabled" in body.properties, false);
        assert.equal(body.contentUrls[0], "https://fixture.blob.core.windows.net/audio.mp3");
        return Response.json({ self: jobUrl });
      }
      if (url === jobUrl && method === "GET") return Response.json({ status: "Succeeded", links: { files: `${config.speechEndpoint}/speechtotext/transcriptions/fixture/files` } });
      if (url.endsWith("/files")) return Response.json({ values: [{ kind: "Transcription", links: { contentUrl } }] });
      if (url === contentUrl) {
        assert.equal(headers.has("Authorization"), false);
        return Response.json({ recognizedPhrases: [{
          recognitionStatus: "Success", speaker: 1, offsetInTicks: 0, durationInTicks: 10000000,
          nBest: [{ display: "The door is still sealed.", confidence: 0.98 }],
        }] });
      }
      if (url.endsWith("/openai/v1/chat/completions")) {
        const body = JSON.parse(String(init.body));
        assert.equal(body.model, "recap-deployment");
        assert.equal(body.reasoning_effort, "low");
        assert.equal(body.max_completion_tokens, 16000);
        assert.equal(body.response_format.type, "json_schema");
        assert.equal(body.response_format.json_schema.strict, true);
        // Only the first pass over raw transcript lines nominates out-of-context quotes.
        const extraction = /Extract at most 8/.test(body.messages[0].content);
        assert.deepEqual(body.response_format.json_schema.schema.required,
          ["title", "paragraphs", "uncertainties", ...(extraction ? ["quotes"] : [])]);
        assert.match(body.messages[0].content, /untrusted DATA/);
        assert.deepEqual(body.response_format.json_schema.schema.properties.paragraphs.items.required, ["text"]);
        return Response.json({ choices: [{
          finish_reason: "stop",
          message: { content: JSON.stringify({
            title: job.recap!.title, paragraphs: job.recap!.paragraphs.map(({ text }) => ({ text })), uncertainties: [],
            ...(extraction ? { quotes: [] } : {}),
          }) },
        }] });
      }
      if (url === jobUrl && method === "DELETE") return new Response(null, { status: 204 });
      throw new Error(`Unexpected fixture request: ${method} ${url}`);
    };
    const headers = async () => ({ Authorization: "Bearer fixture-token" });
    const speech = new AzureSpeech(headers);
    const submitted = await speech.submit(job, "https://fixture.blob.core.windows.net/audio.mp3");
    assert.equal(submitted, jobUrl);
    const result = await speech.waitForTranscript(submitted, async () => {});
    assert.equal(result.segments[0]!.endMs, 1000);
    assert.equal(result.segments[0]!.text, "The door is still sealed.");
    const recap = await generateRecap(job, async () => {}, (source, context, phase) => callAzure(source, context, phase, headers));
    assert.equal(recap.title, "The Lantern Below");
    assert.deepEqual(await speech.cleanup({ ...job, speechJobUrl: jobUrl }), []);
    assert.equal(requests.length, 7);
  } finally {
    globalThis.fetch = originalFetch;
    Object.assign(config, originalConfig);
  }
});

test("HTTP errors surface explicitly, POSTs are not silently retried, expired cleanup is idempotent", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => { calls++; return new Response(null, { status: 503 }); };
    await assert.rejects(requestJson("https://fixture.example", { method: "POST" }, false), /HTTP 503/);
    assert.equal(calls, 1);
    globalThis.fetch = async () => new Response(null, { status: 404 });
    assert.equal(await requestJson("https://fixture.example", { method: "DELETE" }, false, true), null);
    await assert.rejects(requestJson("https://fixture.example", {}, false), /HTTP 404/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("recap generation retries malformed prose once without requesting paragraph citations", async () => {
  const originalFetch = globalThis.fetch;
  const originalConfig = { ...config };
  const job = createDemo();
  let calls = 0;
  try {
    Object.assign(config, {
      openaiEndpoint: "https://fixture.openai.azure.com",
      openaiDeployment: "recap-deployment",
      openaiReasoningEffort: "",
    });

    globalThis.fetch = async (_input, init = {}) => {
      calls++;
      const body = JSON.parse(String(init.body));
      assert.equal("reasoning_effort" in body, false);
      if (calls === 2) {
        assert.match(body.messages[1].content, /prior response failed/);
        assert.match(body.messages[1].content, /expected string/);
      }
      const recap = calls === 1
        ? { title: "Invalid", paragraphs: [{ text: 42 }], uncertainties: [] }
        : { title: "Corrected", paragraphs: [{ text: "A supported event." }], uncertainties: [] };
      return Response.json({ choices: [{
        finish_reason: "stop",
        message: { content: JSON.stringify(recap) },
      }] });
    };
    const recap = await callAzure(
      JSON.stringify({ id: "S00001", text: "A supported event." }),
      "",
      { final: true, level: 1 },
      async () => ({ Authorization: "******" }),
    );
    assert.equal(calls, 2);
    assert.equal(recap.title, "Corrected");
    assert.deepEqual(recap.paragraphs[0]!.segmentIds, []);
  } finally {
    globalThis.fetch = originalFetch;
    Object.assign(config, originalConfig);
  }
});

test("evocative episode-title guidance is final-pass only and leaves descriptive scene navigation intact", async () => {
  const originalFetch = globalThis.fetch;
  const prompts: string[] = [];
  try {
    globalThis.fetch = async (_input, init = {}) => {
      const body = JSON.parse(String(init.body));
      const prompt: string = body.messages[0].content;
      prompts.push(prompt);
      const extraction = /Extract at most 8/.test(prompt);
      return Response.json({ choices: [{
        finish_reason: "stop",
        message: { content: JSON.stringify({
          title: extraction ? "Reaching the silver tree" : "Silver at the Summit",
          paragraphs: [{ text: "The party reaches the silver tree at the summit." }],
          uncertainties: [],
          ...(extraction ? { quotes: [] } : {}),
        }) },
      }] });
    };
    const headers = async () => ({ Authorization: "******" });
    const source = JSON.stringify({ text: "The party reaches the silver tree at the summit." });
    const scene = await callAzure(source, "", { final: false, level: 0 }, headers);
    await callAzure(source, "", { final: false, level: 1 }, headers);
    const episode = await callAzure(source, "", { final: true, level: 2 }, headers);
    assert.equal(scene.title, "Reaching the silver tree");
    assert.equal(episode.title, "Silver at the Summit");
    for (const prompt of prompts) {
      assert.match(prompt, /Nev and Nevermore are aliases for the same male participant; use he\/him pronouns/);
      assert.match(prompt, /does not identify an anonymous speaker or establish the gender or actions of a character he plays/);
      assert.match(prompt, /In narrative paragraphs and scene notes, keep romantic or sexual references non-graphic/);
      assert.match(prompt, /not the separate verbatim out-of-context quote list/);
      assert.match(prompt, /Preserve surrounding story events, meetings, identities, and relationship information/);
      assert.match(prompt, /do not turn an expression of desire/);
      assert.match(prompt, /infer reciprocation, or invent anyone's age/);
    }
    assert.match(prompts[0]!, /Do not exclude a quote solely for profanity, a sexual reference, or bawdy humor/);
    assert.match(prompts[0]!, /Selected quotes must remain verbatim, never euphemized or rewritten/);
    assert.doesNotMatch(prompts[0]!, /Omit an explicit remark from quotes|Skip.*sexually explicit remarks/);
    assert.match(prompts[0]!, /short descriptive scene title/);
    for (const prompt of prompts.slice(0, 2)) {
      assert.doesNotMatch(prompt, /evocative episode title|Silver at the Summit|Bearing Burdens/);
    }
    const final = prompts[2]!;
    assert.match(final, /usually 2-6 words/);
    assert.match(final, /chapter heading rather than a plot summary/);
    assert.match(final, /Silver at the Summit/);
    assert.match(final, /Bearing Burdens/);
    assert.match(final, /The Halls of Glacierhold/);
    assert.match(final, /NOT facts or titles to copy/);
    assert.match(final, /Do not string together highlights or proper nouns/);
    assert.match(final, /do not force a pun or symbolism/);
    assert.match(final, /identity and spelling are reliable/);
    assert.match(final, /sparse or names are uncertain/);
    assert.doesNotMatch(final, /short descriptive or playful title|incorporating the supplied session date/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("recap stops after two malformed responses and does not retry refusals or truncation as prose", async () => {
  const originalFetch = globalThis.fetch;
  const originalConfig = { ...config };
  try {
    Object.assign(config, { openaiEndpoint: "https://fixture.openai.azure.com", openaiDeployment: "fixture" });
    const source = JSON.stringify({ text: "The door opens." });
    const phase = { final: true, level: 1 };
    const headers = async () => ({ Authorization: "******" });
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return Response.json({ choices: [{
        finish_reason: "stop", message: { content: JSON.stringify({ title: "Empty", paragraphs: [], uncertainties: [] }) },
      }] });
    };
    await assert.rejects(callAzure(source, "", phase, headers), /after a corrective retry/);
    assert.equal(calls, 2);
    for (const [choice, message] of [
      [{ finish_reason: "stop", message: { content: null, refusal: "Refused." } }, /declined to summarize/],
      [{ finish_reason: "content_filter", message: { content: null },
        content_filter_results: { violence: { filtered: true, severity: "medium" }, hate: { filtered: false, severity: "safe" } } },
      /content filter blocked part of the recap \(violence: medium\)/],
    ] as const) {
      calls = 0;
      globalThis.fetch = async () => { calls++; return Response.json({ choices: [choice] }); };
      await assert.rejects(callAzure(source, "", phase, headers), message);
      assert.equal(calls, 1, "refusals and filtered output are not retried");
    }
    // Truncation is retried once with a larger allowance, then reported specifically.
    const allowances: number[] = [];
    globalThis.fetch = async (_input, init = {}) => {
      allowances.push(JSON.parse(String(init.body)).max_completion_tokens);
      return Response.json({ choices: [{ finish_reason: "length", message: { content: '{"title":' } }] });
    };
    await assert.rejects(callAzure(source, "", phase, headers), /ran out of output space/);
    assert.deepEqual(allowances, [config.openaiMaxCompletionTokens, Math.min(64000, config.openaiMaxCompletionTokens * 2)]);
    calls = 0;
    globalThis.fetch = async () => { calls++; return Response.json({ error: { code: "content_filter" } }, { status: 400 }); };
    await assert.rejects(callAzure(source, "", phase, headers), /content filter blocked part of the recap \(input\)/);
    assert.equal(calls, 1);
    calls = 0;
    globalThis.fetch = async () => { calls++; return new Response(null, { status: 400 }); };
    await assert.rejects(callAzure(source, "", phase, headers), /HTTP 400/);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    Object.assign(config, originalConfig);
  }
});

test("speech read URLs are read-only, HTTPS-only, single-blob SAS links that expire within 48 hours", async () => {
  const { StorageSharedKeyCredential } = await import("@azure/storage-blob");
  const { speechReadUrl } = await import("../src/azure.js");
  const now = new Date("2026-10-03T00:00:00Z");
  const credential = new StorageSharedKeyCredential("fixture", Buffer.alloc(64, 1).toString("base64"));
  const url = new URL(speechReadUrl("https://fixture.blob.core.windows.net/speech-input/abc/mono.mp3", "speech-input", "abc/mono.mp3", credential, now));
  assert.equal(url.origin + url.pathname, "https://fixture.blob.core.windows.net/speech-input/abc/mono.mp3");
  assert.equal(url.searchParams.get("sp"), "r");
  assert.equal(url.searchParams.get("spr"), "https");
  assert.equal(url.searchParams.get("sr"), "b");
  assert.equal(url.searchParams.get("se"), "2026-10-05T00:00:00Z");
  assert.ok(url.searchParams.get("sig"));
});

test("omitted model content is classified before recap and name-check output validation", async () => {
  const originalFetch = globalThis.fetch;
  const headers = async () => ({ Authorization: "******" });
  const source = JSON.stringify({ id: "S00001", text: "The door opens." });
  const phase = { final: true, level: 1 };
  try {
    for (const [choice, reason] of [
      [{ finish_reason: "content_filter", message: {},
        content_filter_results: { violence: { filtered: true, severity: "medium" } } }, "content_filter"],
      [{ finish_reason: "stop", message: { refusal: "Refused." } }, "refusal"],
      [{ finish_reason: "stop", message: {} }, "empty"],
    ] as const) {
      let calls = 0;
      globalThis.fetch = async () => { calls++; return Response.json({ choices: [choice] }); };
      await assert.rejects(callAzure(source, "", phase, headers), (error: unknown) => {
        assert.ok(error instanceof RecapModelError);
        assert.equal(error.reason, reason);
        assert.deepEqual(error.categories, reason === "content_filter" ? ["violence: medium"] : []);
        return true;
      });
      assert.equal(calls, 1);
      if (reason === "empty") {
        await assert.rejects(callSuggestModel(source, [], headers), /did not complete its response/);
      } else {
        assert.equal(await callSuggestModel(source, [], headers), "filtered");
      }
      assert.equal(calls, 2);
    }

    for (const caller of [
      () => callAzure(source, "", phase, headers),
      () => callSuggestModel(source, [], headers),
    ]) {
      const allowances: number[] = [];
      globalThis.fetch = async (_input, init = {}) => {
        allowances.push(JSON.parse(String(init.body)).max_completion_tokens);
        return Response.json({ choices: [{ finish_reason: "length", message: {} }] });
      };
      await assert.rejects(caller(), /ran out of output space|did not complete its response/);
      assert.deepEqual(allowances, [config.openaiMaxCompletionTokens, Math.min(64000, config.openaiMaxCompletionTokens * 2)]);
      let calls = 0;
      globalThis.fetch = async (_input, init = {}) => {
        calls++;
        const body = JSON.parse(String(init.body));
        assert.equal(body.max_completion_tokens, calls === 1 ? config.openaiMaxCompletionTokens : Math.min(64000, config.openaiMaxCompletionTokens * 2));
        const content = body.response_format.json_schema.name === "name_fixes"
          ? { suggestions: [] }
          : { title: "Recovered", paragraphs: [{ text: "The door opens." }], uncertainties: [] };
        return Response.json({ choices: [{
          finish_reason: calls === 1 ? "length" : "stop",
          message: calls === 1 ? {} : { content: JSON.stringify(content) },
        }] });
      };
      await caller();
      assert.equal(calls, 2, "a successful retry recovers from truncation with omitted content");
    }

    // Do not loosen the contract for malformed envelopes or non-string content.
    for (const choice of [
      { finish_reason: "stop" },
      { finish_reason: "stop", message: { content: 42 } },
    ]) {
      globalThis.fetch = async () => Response.json({ choices: [choice] });
      await assert.rejects(callAzure(source, "", phase, headers), /invalid chat completion envelope/);
      await assert.rejects(callSuggestModel(source, [], headers), /invalid chat completion envelope/);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Azure filtered slices with omitted content produce a recap with an explicit gap, not a schema failure", async () => {
  const originalFetch = globalThis.fetch;
  const job = { ...createDemo(), segments: [
    { id: "S1", speaker: "speaker-1", startMs: 0, endMs: 1000, text: "Opening scene. ".repeat(1000) },
    { id: "S2", speaker: "speaker-1", startMs: 1000, endMs: 2000, text: "Blocked scene. ".repeat(1000) },
    { id: "S3", speaker: "speaker-1", startMs: 2000, endMs: 3000, text: "Ending scene. ".repeat(1000) },
  ] };
  let calls = 0;
  try {
    globalThis.fetch = async (_input, init = {}) => {
      calls++;
      const body = JSON.parse(String(init.body));
      const { source } = JSON.parse(body.messages[1].content);
      if (source.includes("Blocked scene.")) {
        return Response.json({ choices: [{
          finish_reason: "content_filter", message: {},
          content_filter_results: { violence: { filtered: true, severity: "medium" } },
        }] });
      }
      const extraction = /Extract at most 8/.test(body.messages[0].content);
      return Response.json({ choices: [{
        finish_reason: "stop", message: { content: JSON.stringify({
          title: "The journey", paragraphs: [{ text: extraction ? "Supported scene notes." : "Supported story." }],
          uncertainties: [], ...(extraction ? { quotes: [] } : {}),
        }) },
      }] });
    };
    const call = (source: string, context: string, phase: Parameters<typeof callAzure>[2]) =>
      callAzure(source, context, phase, async () => ({ Authorization: "******" }));
    const recap = await generateRecap(job, async () => {}, call);
    assert.equal(calls, 4, "three scene calls plus final writing; filtered output is not retried");
    assert.equal(recap.paragraphs[0]!.text, "Supported story.");
    assert.deepEqual(recap.scenes.map(scene => scene.startMs), [0, 2000]);
    assert.match(recap.uncertainties[0]!.text, /00:00:01.00:00:02 isn't included.*violence: medium/);

    globalThis.fetch = async () => Response.json({ choices: [{
      finish_reason: "content_filter", message: {},
    }] });
    await assert.rejects(generateRecap(job, async () => {}, call), /blocked every part.*transcript is preserved/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});