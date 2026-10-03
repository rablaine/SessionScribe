import { test } from "node:test";
import assert from "node:assert/strict";
import { createDemo } from "../src/demo.js";
import { recapMarkdown, recapSchema, topQuotes, type Job } from "../src/domain.js";
import { generateRecap, matchQuote, selectQuotes, type RecapCaller, type RecapPhase } from "../src/recap.js";

const job = (): Job => ({ ...createDemo(), demo: false });

test("quotes must be the real words of a real line, and take that line's speaker and time", () => {
  const session = job();
  const chunk = session.segments;
  const quote = matchQuote({ text: "\u201cmira checks the LANTERN\u201d", speaker: "Speaker 2", rating: 5 }, chunk, session);
  assert.deepEqual(quote, { text: "mira checks the LANTERN", speaker: "speaker-2", segmentId: "S00002", startMs: 13500, endMs: 19000 });
  // Invented or reworded quotes are dropped.
  assert.equal(matchQuote({ text: "Mira licks the lantern", speaker: "Speaker 2", rating: 5 }, chunk, session), undefined);
  // Fragments too short to stand alone are dropped.
  assert.equal(matchQuote({ text: "Agreed.", speaker: "Speaker 2", rating: 5 }, chunk, session), undefined);
  // Partial words don't count as a match.
  assert.equal(matchQuote({ text: "ira checks the lantern", speaker: "Speaker 2", rating: 5 }, chunk, session), undefined);
  // One breath split across consecutive lines by the same speaker still matches; across speakers it doesn't.
  const split = [
    { id: "A1", speaker: "speaker-2", startMs: 1000, endMs: 2000, text: "No, I'm not doing coke." },
    { id: "A2", speaker: "speaker-2", startMs: 2000, endMs: 5000, text: "I'm not doing coke here in the woods." },
    { id: "A3", speaker: "speaker-3", startMs: 5000, endMs: 6000, text: "Fine, maybe the deer will." },
  ];
  assert.deepEqual(matchQuote({ text: "No, I'm not doing coke. I'm not doing coke here in the woods.", speaker: "Speaker 2", rating: 5 }, split, session),
    { text: "No, I'm not doing coke. I'm not doing coke here in the woods.", speaker: "speaker-2", segmentId: "A1", startMs: 1000, endMs: 5000 });
  assert.equal(matchQuote({ text: "here in the woods. Fine, maybe the deer will", speaker: "Speaker 2", rating: 5 }, split, session), undefined);
});

test("quote ranking spreads the best across parts, then fills with the rest, in spoken order", () => {
  const quote = (id: number, score: number, chunk: number) =>
    ({ text: `q${id}`, speaker: "speaker-1", segmentId: `S${id}`, startMs: id * 1000, endMs: id * 1000 + 500, score, chunk });
  const candidates = [quote(5, 5, 0), quote(1, 4, 0), quote(2, 4.5, 0), quote(9, 3, 1), quote(9, 5, 1), quote(7, 3.5, 2)];
  assert.deepEqual(selectQuotes(candidates, 3).map(item => item.segmentId), ["S2", "S5", "S9"]);
  const all = selectQuotes(candidates);
  // Part 0 has three good quotes: two rank first, the third only after the other parts are represented.
  assert.deepEqual(all.map(item => [item.segmentId, item.rank]), [["S1", 5], ["S2", 3], ["S5", 1], ["S7", 4], ["S9", 2]]);
  assert(!("score" in all[0]!));
  assert.deepEqual(topQuotes(all, 2).map(item => item.segmentId), ["S5", "S9"]);
  // Older recaps without ranks keep their stored order.
  assert.deepEqual(topQuotes(all.map(({ rank: _rank, ...item }) => item), 2).map(item => item.segmentId), ["S1", "S2"]);
});

test("recaps collect verified quotes from the transcript pass only, boosted by nearby laughter", async () => {
  const session = { ...job(), laughter: { status: "completed" as const, events: [{
    id: "L00001", startMs: 47500, endMs: 49000, peakMs: 48000, peakConfidence: 0.9, meanConfidence: 0.5,
    labels: [{ name: "Laughter", peakConfidence: 0.9 }],
  }] } };
  const phases: RecapPhase[] = [];
  const call: RecapCaller = async (_source, _context, phase) => {
    phases.push(phase);
    return {
      title: "Scene", paragraphs: [{ text: "Story.", segmentIds: [] }], uncertainties: [], scenes: [],
      quoteCandidates: phase.final ? [{ text: "From the final pass only", speaker: "", rating: 5 }] : [
        { text: "While we wait, I search the alcove.", speaker: "Speaker 2", rating: 3 },
        { text: "Can I make an Arcana check?", speaker: "Speaker 2", rating: 4 },
        { text: "A line nobody ever said out loud", speaker: "Speaker 1", rating: 5 },
        { text: "With that eighteen, you recognize a ward", speaker: "Speaker 1", rating: 2 },
      ],
    };
  };
  const recap = await generateRecap(session, async () => {}, call);
  assert(phases.some(phase => phase.final));
  assert.deepEqual(recap.quotes.map(quote => quote.segmentId), ["S00002", "S00005"]);
  assert.equal(recap.quotes[1]!.text, "While we wait, I search the alcove.");
  assert(!("quoteCandidates" in recap));
  // Stored recaps from before this feature still load, with no quotes.
  const legacy = recapSchema.parse({ title: "Old", paragraphs: [{ text: "Story.", segmentIds: [] }], uncertainties: [] });
  assert.deepEqual(legacy.quotes, []);
});

test("recap Markdown lists the out-of-context quotes with speaker names and times", () => {
  const session = job();
  session.recap = { ...session.recap!, quotes: [{ text: "I search the *alcove*", speaker: "speaker-2", segmentId: "S00005", startMs: 42000, endMs: 47000 }] };
  session.speakerNames = { "speaker-2": "Mira" };
  const markdown = recapMarkdown(session);
  assert.match(markdown, /## Out of context\n\n> \u201cI search the \\\*alcove\\\*\u201d \u2014 Mira \(00:00:42\)/);
  assert.doesNotMatch(recapMarkdown(session, 0), /Out of context/);
});
