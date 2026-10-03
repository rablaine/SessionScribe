import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AzureSpeech } from "../src/azure.js";
import { config } from "../src/config.js";
import { createDemo } from "../src/demo.js";
import type { Job, Recap, Segment } from "../src/domain.js";
import { applyNameList, applySuggestions, normalizeNameList, suggestNameFixes, type SuggestCaller } from "../src/names.js";
import { learnVariants } from "../src/name-routes.js";
import { generateRecap, type RecapPhase } from "../src/recap.js";
import { JobRunner } from "../src/runner.js";
import { JobStore } from "../src/store.js";
import { createSessionFixture } from "./session-fixture.js";

const segment = (id: string, text: string, startMs = 0): Segment => ({ id, speaker: "speaker-1", startMs, endMs: startMs + 1000, text });
const realJob = (): Job => ({ ...createDemo(), demo: false, status: "completed" });
const azureConfig = {
  speechEndpoint: "https://fixture.cognitiveservices.azure.com",
  storageAccountUrl: "https://fixture.blob.core.windows.net", openaiEndpoint: "https://fixture.openai.azure.com",
  openaiDeployment: "fixture", authMode: "azure-cli",
} as const;

async function idle(runner: JobRunner, id: string) {
  const deadline = Date.now() + 10_000;
  while (runner.busyIds.has(id)) {
    if (Date.now() > deadline) throw new Error("Runner test timed out.");
    await delay(20);
  }
}

test("names list: whole-word, case-insensitive variant fixes that keep IDs and timestamps", () => {
  const segments = [
    segment("S00001", "She left lonelywood at dawn.", 1000),
    segment("S00002", "Lonelywoods is not a place, but Lost  Elton's gate is.", 2000),
    segment("S00003", "Nothing to change here.", 3000),
  ];
  const { segments: fixed, changes, count } = applyNameList(segments, [{ term: "Lostleton", variants: ["Lonelywood", "Lost Elton"] }]);
  assert.equal(count, 2);
  assert.equal(fixed[0]!.text, "She left Lostleton at dawn.");
  assert.equal(fixed[1]!.text, "Lonelywoods is not a place, but Lostleton's gate is.");
  assert.equal(fixed[2], segments[2], "untouched lines are the same objects");
  assert.deepEqual(fixed.map(value => [value.id, value.startMs, value.endMs]), segments.map(value => [value.id, value.startMs, value.endMs]));
  assert.deepEqual(changes.map(change => change.segmentId), ["S00001", "S00002"]);
  // Regex metacharacters in a variant are literal.
  assert.equal(applyNameList([segment("S1", "Meet at (the) gate.")], [{ term: "Gate", variants: ["(the) gate"] }]).segments[0]!.text, "Meet at Gate.");
});

test("names list: normalization drops duplicates and self-variants", () => {
  assert.deepEqual(normalizeNameList([
    { term: "Mira", variants: ["Myra", "myra", "mira"] },
    { term: "mira", variants: ["Meera"] },
    { term: "Torren", variants: [] },
  ]), [{ term: "Mira", variants: ["Myra"] }, { term: "Torren", variants: [] }]);
});

test("reviewed suggestions apply only where their original text is still present", () => {
  const segments = [segment("S1", "We rode to Lonely Wood's gate."), segment("S2", "Myra waves.")];
  const { segments: fixed, applied } = applySuggestions(segments, [
    { id: "a", segmentId: "S1", before: "Lonely Wood's", after: "Lostleton's", term: "Lostleton" },
    { id: "b", segmentId: "S1", before: "Wood", after: "Lostleton", term: "Lostleton" },
    { id: "c", segmentId: "S2", before: "Mayra", after: "Mira", term: "Mira" },
  ]);
  assert.equal(fixed[0]!.text, "We rode to Lostleton's gate.");
  assert.equal(fixed[1], segments[1]);
  assert.deepEqual([...applied], ["a"]);
});

test("accepted fixes teach the names list new mishearings", () => {
  const learned = learnVariants([{ term: "Lostleton", variants: ["Lonelywood"] }, { term: "Mira", variants: [] }], [
    { before: "Lonely Wood's", after: "Lostleton's", term: "Lostleton" },
    { before: "lonelywood", after: "Lostleton", term: "Lostleton" },
    { before: "Myra", after: "Mira", term: "Mira" },
    { before: "the very long phrase here", after: "Mira", term: "Mira" },
    { before: "Myrah", after: "Mira the bold", term: "Mira" },
  ]);
  assert.deepEqual(learned, [{ term: "Lostleton", variants: ["Lonelywood", "Lonely Wood"] }, { term: "Mira", variants: ["Myra"] }]);
});

test("AI name suggestions are validated, de-duplicated, ordered, and report filtered slices", async () => {
  const job = { ...realJob(), segments: [
    segment("S00001", "Myra checks the lantern.", 0),
    segment("S00002", "Toren nods. Toren waits.", 5000),
  ] };
  const calls: string[] = [];
  const call: SuggestCaller = async lines => {
    calls.push(lines);
    return [
      { id: "S00002", before: "Toren", after: "Torren", name: "torren" },
      { id: "S00002", before: "Toren", after: "Torren", name: "Torren" },
      { id: "S00001", before: "Myra", after: "Mira", name: "Mira" },
      { id: "S00001", before: "lantern", after: "Lantern", name: "Mira" },
      { id: "S00001", before: "absent", after: "Mira", name: "Mira" },
      { id: "S09999", before: "Myra", after: "Mira", name: "Mira" },
      { id: "S00001", before: "Myra", after: "Mira", name: "Unknown" },
    ];
  };
  const progress: Array<[number, number]> = [];
  const result = await suggestNameFixes(job, [{ term: "Mira", variants: [] }, { term: "Torren", variants: [] }],
    async (done, total) => { progress.push([done, total]); }, call);
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0]!.split("\n")[0]!), { id: "S00001", text: "Myra checks the lantern." });
  assert.deepEqual(result.items.map(item => [item.segmentId, item.before, item.after, item.term]),
    [["S00001", "Myra", "Mira", "Mira"], ["S00002", "Toren", "Torren", "Torren"]]);
  assert.deepEqual(progress, [[0, 1], [1, 1]]);
  const filtered = await suggestNameFixes(job, [{ term: "Mira", variants: [] }], async () => {}, async () => "filtered");
  assert.deepEqual(filtered.items, []);
  assert.deepEqual(filtered.skipped, ["00:00:00\u201300:00:06"]);
  await assert.rejects(suggestNameFixes(job, [], async () => {}, call), /names list/);
});

test("recaps receive name spellings and owner clarifications on every model call", async () => {
  const phases: RecapPhase[] = [];
  const recap: Recap = { title: "T", paragraphs: [{ text: "Story.", segmentIds: [] }], uncertainties: [], scenes: [] };
  const job = { ...realJob(), clarifications: [
    { id: "c1", text: "It is Lostleton.", about: "Unclear town name", createdAt: new Date().toISOString() },
    { id: "c2", text: "Mira cast the ward.", createdAt: new Date().toISOString() },
  ] };
  await generateRecap(job, async () => {}, async (_source, _context, phase) => { phases.push(phase); return recap; }, ["Lostleton", "Mira"]);
  assert(phases.length >= 2);
  for (const phase of phases) {
    assert.deepEqual(phase.names, ["Lostleton", "Mira"]);
    assert.deepEqual(phase.clarifications, ["Regarding \"Unclear town name\": It is Lostleton.", "Mira cast the ward."]);
  }
  phases.length = 0;
  await generateRecap({ ...realJob(), clarifications: [] }, async () => {}, async (_s, _c, phase) => { phases.push(phase); return recap; });
  assert(phases.every(phase => phase.names === undefined && phase.clarifications === undefined));
});

class TranscriptSpeech extends AzureSpeech {
  async waitForTranscript(_url: string, onStatus: (status: string) => Promise<void>) {
    await onStatus("Running");
    return { segments: [segment("S00001", "We reach lonelywood by nightfall.")], warnings: [] };
  }
  async cleanup() { return []; }
}

test("runner fixes listed names right after transcription and passes the spellings to the recap", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "names-runner-"));
  const original = { ...config };
  Object.assign(config, azureConfig);
  try {
    const store = new JobStore(root);
    await store.init();
    const job = { ...realJob(), status: "queued" as const, segments: [], recap: undefined, audioRetained: false,
      speechJobUrl: "https://fixture.cognitiveservices.azure.com/speechtotext/transcriptions/x",
      laughter: { status: "skipped" as const, events: [] } };
    await store.save(job);
    let recapNames: string[] | undefined;
    let recapText = "";
    const runner = new JobRunner(store, new TranscriptSpeech(), async (input, _progress, _call, names) => {
      recapNames = names;
      recapText = input.segments[0]!.text;
      return { title: "T", paragraphs: [{ text: "Story.", segmentIds: [] }], uncertainties: [], scenes: [] };
    });
    runner.nameList = () => ({ entries: [{ term: "Lostleton", variants: ["Lonelywood"] }], autoApply: true });
    runner.enqueue(job.id);
    await idle(runner, job.id);
    const saved = store.get(job.id)!;
    assert.equal(saved.status, "completed", saved.error);
    assert.equal(saved.segments[0]!.text, "We reach Lostleton by nightfall.");
    assert.equal(recapText, "We reach Lostleton by nightfall.");
    assert.deepEqual(recapNames, ["Lostleton"]);
    assert.equal(saved.progress!.steps.find(step => step.key === "transcribe")!.detail, "Fixed 1 listed name");
  } finally {
    Object.assign(config, original);
    await rm(root, { recursive: true, force: true });
  }
});

test("runner name check stores suggestions for review without changing the transcript", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "names-check-"));
  const original = { ...config };
  Object.assign(config, azureConfig);
  try {
    const store = new JobStore(root);
    await store.init();
    const job = { ...realJob(), status: "queued" as const, queuedOperation: "names" as const };
    await store.save(job);
    const runner = new JobRunner(store, new TranscriptSpeech(), undefined, undefined,
      async () => [{ id: "S00002", before: "Mira", after: "Mirra", name: "Mirra" }]);
    runner.nameList = () => ({ entries: [{ term: "Mirra", variants: [] }], autoApply: true });
    runner.enqueueNames(job.id);
    await idle(runner, job.id);
    const saved = store.get(job.id)!;
    assert.equal(saved.status, "completed");
    assert.equal(saved.queuedOperation, undefined);
    assert.deepEqual(saved.segments, job.segments);
    assert.equal(saved.nameSuggestions!.items.length, 1);
    assert.equal(saved.progress!.kind, "names");
    assert.equal(saved.progress!.outcome, "completed");
    assert.equal(saved.stage, "1 suggested name fix to review");
  } finally {
    Object.assign(config, original);
    await rm(root, { recursive: true, force: true });
  }
});

test("names API: account list, preview/apply, review, and recap corrections", async () => {
  const fixture = await createSessionFixture("names-api-");
  try {
    const json = (body: unknown) => ({ headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.deepEqual(await (await fixture.request(`${fixture.base}/api/names`)).json(), { entries: [], autoApply: true });
    const saved = await fixture.request(`${fixture.base}/api/names`, { method: "PUT", ...json({
      entries: [{ term: "Mirra", variants: ["Mira", "mira"] }, { term: "Torren", variants: [] }], autoApply: false,
    }) });
    assert.deepEqual(await saved.json(), { entries: [{ term: "Mirra", variants: ["Mira"] }, { term: "Torren", variants: [] }], autoApply: false });
    const invalid = await fixture.request(`${fixture.base}/api/names`, { method: "PUT", ...json({ entries: [{ term: "" }], autoApply: true }) });
    assert.equal(invalid.status, 400);

    const job = await fixture.save(realJob());
    const preview = await (await fixture.request(`${fixture.base}/api/jobs/${job.id}/names/preview`, { method: "POST" })).json();
    assert.equal(preview.count, 1);
    assert.equal(preview.examples[0].after, "Mirra checks the lantern. Can I make an Arcana check?");
    const applied = await (await fixture.request(`${fixture.base}/api/jobs/${job.id}/names/apply`, { method: "POST" })).json();
    assert.equal(applied.segments[1].text, "Mirra checks the lantern. Can I make an Arcana check?");
    assert.equal(applied.recapStale, true);
    assert.equal(applied.segments[1].startMs, job.segments[1]!.startMs);

    // AI checks need Azure OpenAI; without it the request is refused before any quota is used.
    const endpoint = config.openaiEndpoint;
    config.openaiEndpoint = "";
    const suggest = await fixture.request(`${fixture.base}/api/jobs/${job.id}/names/suggest`, { method: "POST" }).finally(() => { config.openaiEndpoint = endpoint; });
    assert.equal(suggest.status, 503);

    await fixture.store.save({ ...fixture.store.get(job.id)!, nameSuggestions: { createdAt: new Date().toISOString(), skipped: [], items: [
      { id: "a", segmentId: "S00004", before: "Torren wants", after: "Torren wants", term: "Torren" },
      { id: "b", segmentId: "S00004", before: "moonrise", after: "Moonrise", term: "Torren" },
    ] } });
    const accepted = await (await fixture.request(`${fixture.base}/api/jobs/${job.id}/names/accept`, { method: "POST", ...json({ ids: ["b"], remember: false }) })).json();
    assert.equal(accepted.segments[3].text, "Torren wants to wait for Moonrise rather than break the ward.");
    assert.equal(accepted.nameSuggestions, undefined);

    const clarified = await (await fixture.request(`${fixture.base}/api/jobs/${job.id}/clarifications`, { method: "PUT", ...json({
      clarifications: [{ text: "The ward was Mirra's.", about: "Who cast the ward is unclear." }],
    }) })).json();
    assert.equal(clarified.clarifications.length, 1);
    assert.equal(clarified.clarifications[0].about, "Who cast the ward is unclear.");
    assert.equal(clarified.recapStale, true);
    const tooLong = await fixture.request(`${fixture.base}/api/jobs/${job.id}/clarifications`, { method: "PUT", ...json({ clarifications: [{ text: "x".repeat(501) }] }) });
    assert.equal(tooLong.status, 400);

    fixture.runner.reserve(job.id);
    const busy = await fixture.request(`${fixture.base}/api/jobs/${job.id}/names/apply`, { method: "POST" });
    assert.equal(busy.status, 409);
    fixture.runner.release(job.id);
  } finally {
    await fixture.close();
  }
});
