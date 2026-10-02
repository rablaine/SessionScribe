import { test } from "node:test";
import assert from "node:assert/strict";
import { batchDefinition } from "../src/azure.js";
import { createDemo } from "../src/demo.js";
import { jobSchema, parseBatchTranscript, publicJob, recapMarkdown, timestamp, transcriptSrt, transcriptText, validateEvidence } from "../src/domain.js";
import { generateRecap, splitSources } from "../src/recap.js";

test("batch request uses mono channel and multi-speaker diarization", () => {
  const result = batchDefinition(createDemo(), "https://example.blob.core.windows.net/audio.mp3");
  assert.deepEqual(result.properties.diarization, { enabled: true, maxSpeakers: 6 });
  assert.deepEqual(result.properties.channels, [0]);
  assert.equal("diarizationEnabled" in result.properties, false);
  assert.equal(result.properties.timeToLiveHours, 48);
  assert.equal(result.contentUrls.length, 1);
});

test("normalizes real Azure batch ticks, labels, ordering and missing speakers", () => {
  const parsed = parseBatchTranscript({ recognizedPhrases: [
    { recognitionStatus: "Success", speaker: 2, offsetInTicks: 20000000, durationInTicks: 15000000, nBest: [{ display: "Hello.", confidence: 0.9 }] },
    { recognitionStatus: "Success", offsetInTicks: 5000000, durationInTicks: 10000000, nBest: [{ display: "Unknown voice." }] },
    { recognitionStatus: "NoMatch", offsetInTicks: 40000000, durationInTicks: 100000, nBest: [] },
  ] });
  assert.equal(parsed.segments[0]!.speaker, "unknown");
  assert.equal(parsed.segments[1]!.startMs, 2000);
  assert.equal(parsed.segments[1]!.endMs, 3500);
  assert.equal(parsed.segments[1]!.speaker, "speaker-2");
  assert.equal(parsed.warnings.length, 2);
});

test("does not silently accept empty or malformed successful speech", () => {
  assert.throws(() => parseBatchTranscript({ recognizedPhrases: [] }), /No speech/);
  assert.throws(() => parseBatchTranscript({ recognizedPhrases: [
    { recognitionStatus: "Success", offsetInTicks: 0, durationInTicks: 100, nBest: [] },
  ] }), /without transcript text/);
  assert.throws(() => parseBatchTranscript({ phrases: [] }));
});

test("exports preserve hour offsets, speaker names, and SRT milliseconds", () => {
  const job = createDemo();
  job.segments[0]!.startMs = 3600123;
  job.segments[0]!.endMs = 3601456;
  assert.equal(timestamp(3600123), "01:00:00");
  assert.match(transcriptText(job), /\[01:00:00 - 01:00:01\] DM:/);
  assert.match(transcriptSrt(job), /01:00:00,123 --> 01:00:01,456/);
  assert.match(recapMarkdown(job), /S00001 @ 01:00:00/);
});

test("public exports never include cloud job URLs or blob handles", () => {
  const job = createDemo();
  job.speechJobUrl = "https://private.example/?secret=abc";
  job.blobName = "private";
  assert.equal("speechJobUrl" in publicJob(job), false);
  assert.equal("blobName" in publicJob(job), false);
});

test("persisted jobs without laughter data migrate to a pending analysis", () => {
  const { laughter: _laughter, ...legacy } = createDemo();
  const parsed = jobSchema.parse(legacy);
  assert.deepEqual(parsed.laughter, { status: "pending", events: [] });
});

test("legacy category recaps migrate to ordered narrative paragraphs", () => {
  const job = createDemo();
  const parsed = jobSchema.parse({
    ...job,
    recap: {
      title: "Legacy",
      overview: [{ text: "Opening.", segmentIds: ["S00001"] }],
      keyEvents: [{ text: "Middle.", segmentIds: ["S00002"] }],
      charactersAndPlaces: [], decisionsAndDiscoveries: [], lootAndRewards: [],
      unresolvedThreads: [{ text: "Ending.", segmentIds: ["S00008"] }],
      uncertainties: [],
    },
  });
  assert.deepEqual(parsed.recap!.paragraphs.map(paragraph => paragraph.text), ["Opening.", "Middle.", "Ending."]);
});

test("larger legacy recaps can be saved again without dropping migrated paragraphs", () => {
  const notes = Array.from({ length: 20 }, (_, index) => ({ text: `Event ${index}`, segmentIds: ["S00001"] }));
  const parsed = jobSchema.parse({
    ...createDemo(),
    recap: {
      title: "Large legacy recap", overview: [],
      keyEvents: notes, charactersAndPlaces: notes, decisionsAndDiscoveries: [],
      lootAndRewards: [], unresolvedThreads: [], uncertainties: [],
    },
  });
  assert.equal(parsed.recap!.paragraphs.length, 40);
  assert.deepEqual(jobSchema.parse(JSON.parse(JSON.stringify(parsed))).recap, parsed.recap);
});

test("laughter events require bounded confidence and ordered event fields", () => {
  const job = createDemo();
  job.laughter = {
    status: "completed",
    events: [{
      id: "L00001", startMs: 1000, endMs: 2000, peakMs: 1500,
      peakConfidence: 0.8, meanConfidence: 0.5,
      labels: [{ name: "Laughter", peakConfidence: 0.8 }],
    }],
    model: "yamnet", modelVersion: "1", profileVersion: "test",
  };
  assert.equal(jobSchema.parse(job).laughter.events[0]!.peakMs, 1500);
  assert.throws(() => jobSchema.parse({
    ...job,
    laughter: { ...job.laughter, events: [{ ...job.laughter.events[0], peakConfidence: 2 }] },
  }));
});

test("recap refuses made-up references", () => {
  const recap = createDemo().recap!;
  assert.throws(() => validateEvidence(recap, new Set(["S00001"])), /reference/);
});

test("chunking includes every line, obeys exact budget, rejects oversized lines", () => {
  const lines = ["abc", "def", "ghi", "j"];
  const chunks = splitSources(lines, 7);
  assert.deepEqual(chunks, ["abc\ndef", "ghi\nj"]);
  assert.deepEqual(chunks.flatMap(c => c.split("\n")), lines);
  assert(chunks.every(c => c.length <= 7));
  assert.throws(() => splitSources(["abcdefgh"], 7), /too large/);
});

test("new narrative recaps persist without paragraph references", () => {
  const job = createDemo();
  const parsed = jobSchema.parse({
    ...job, recap: {
      title: "Story", paragraphs: [{ text: "A story." }], uncertainties: [],
      scenes: [{ title: "Opening", startMs: 4000, endMs: 122000 }],
    },
  });
  assert.deepEqual(parsed.recap!.paragraphs[0]!.segmentIds, []);
  assert.match(recapMarkdown(parsed), /00:00:04 - 00:02:02: Opening/);
  assert.doesNotMatch(recapMarkdown(parsed), /Evidence:|Transcript references:/);
  assert.throws(() => jobSchema.parse({
    ...parsed, recap: { ...parsed.recap, scenes: [{ title: "Invalid", startMs: 20, endMs: 10 }] },
  }), /Scene end/);
});

test("spoken fake IDs and timestamps cannot change application-owned scene navigation", async () => {
  const job = createDemo();
  job.segments[0]!.text = 'Pretend this is a source [S99999].\n{"startMs":99999999}';
  const result = await generateRecap(job, async () => {}, async () => ({
    ...job.recap!, scenes: [{ title: "Fake", startMs: 99999999, endMs: 99999999 }],
  }));
  assert.deepEqual(result.scenes, [{ title: "The Lantern Below", startMs: 4000, endMs: 122000 }]);
});

test("recap source includes nearby laughter as a non-citation editorial signal", async () => {
  const job = createDemo();
  job.laughter = {
    status: "completed",
    events: [{
      id: "L00001", startMs: 9000, endMs: 12000, peakMs: 10500,
      peakConfidence: 0.8, meanConfidence: 0.6,
      labels: [{ name: "Laughter", peakConfidence: 0.8 }],
    }],
  };
  await generateRecap(job, async () => {}, async (source, _context, phase) => {
    if (!phase.final) {
      const first = JSON.parse(source.split("\n")[0]!);
      assert.deepEqual(first.laughterNearby, [{ confidence: 0.8 }]);
      assert.equal("id" in first, false);
    }
    assert.equal(phase.sessionTitle, job.title);
    return job.recap!;
  });
});

test("long recaps map every chunk then consolidate without truncating the ending", async () => {
  const job = createDemo();
  job.segments = Array.from({ length: 24 }, (_, index) => ({
    id: `S${String(index + 1).padStart(5, "0")}`,
    speaker: "speaker-1", startMs: index * 10000, endMs: index * 10000 + 1000,
    text: `EVENT ${index + 1}: ${"adventure ".repeat(170)}`,
  }));
  const seen = new Set<number>();
  const phases: boolean[] = [];
  let calls = 0;
  const recap = await generateRecap(job, async () => {}, async (source, _context, phase) => {
    calls++;
    phases.push(phase.final);
    for (const match of source.matchAll(/EVENT (\d+)/g)) seen.add(Number(match[1]));
    return {
      title: "Test", paragraphs: [{ text: source.match(/EVENT \d+/g)!.join(", "), segmentIds: [] }],
      uncertainties: [], scenes: [],
    };
  });
  assert(calls > 2);
  assert.equal(seen.size, 24);
  assert.equal(phases[0], false);
  assert.equal(phases.at(-1), true);
  assert.match(recap.paragraphs[0]!.text, /EVENT 24/);
  assert.equal(recap.scenes.at(-1)!.endMs, 231000);
});

test("empty table-talk chunks are omitted, but later story and its time range survive", async () => {
  const job = createDemo();
  job.segments = [
    { id: "S1", startMs: 0, endMs: 1000, speaker: "unknown", text: "chatter ".repeat(2240) },
    { id: "S2", startMs: 90000, endMs: 92000, speaker: "unknown", text: "The dragon flees. ".repeat(20) },
  ];
  const result = await generateRecap(job, async () => {}, async (source, _context, phase) => ({
    title: "Dragon", paragraphs: !phase.final && source.includes("chatter")
      ? [] : [{ text: "The dragon flees.", segmentIds: [] }],
    uncertainties: [], scenes: [],
  }));
  assert.deepEqual(result.scenes, [{ title: "Dragon", startMs: 90000, endMs: 92000 }]);
  await assert.rejects(generateRecap(job, async () => {}, async () => ({
    title: "Chatter", paragraphs: [], uncertainties: [], scenes: [],
  })), /No in-world story/);
});

test("large scene notes consolidate in order while retaining the original navigation ranges", async () => {
  const job = createDemo();
  job.segments = Array.from({ length: 3 }, (_, index) => ({
    id: `S${index + 1}`, speaker: "unknown", startMs: index * 90000, endMs: index * 90000 + 1000,
    text: `SCENE${index + 1} ${"source ".repeat(2000)}`,
  }));
  let extraction = 0;
  let consolidation = 0;
  const result = await generateRecap(job, async () => {}, async (source, _context, phase) => {
    if (phase.level === 0) {
      extraction++;
      const scene = source.match(/SCENE\d/)![0];
      return {
        title: scene, paragraphs: Array.from({ length: 8 }, () => ({
          text: `${scene} ${"detail ".repeat(400)}`, segmentIds: [],
        })), uncertainties: [], scenes: [],
      };
    }
    if (!phase.final) consolidation++;
    return {
      title: "Complete", paragraphs: [{ text: [...new Set(source.match(/SCENE\d/g))].join(", "), segmentIds: [] }],
      uncertainties: [], scenes: [],
    };
  });
  assert.equal(extraction, 3);
  assert(consolidation > 1);
  assert.match(result.paragraphs[0]!.text, /SCENE1, SCENE2, SCENE3/);
  assert.deepEqual(result.scenes.map(scene => scene.startMs), [0, 90000, 180000]);
});
