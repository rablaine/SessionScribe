import { randomUUID } from "node:crypto";
import { jobSchema, type Job } from "./domain.js";

export function createDemo(): Job {
  const now = new Date().toISOString();
  return jobSchema.parse({
    id: randomUUID(), title: "The Lantern Below - demo", originalName: "fictional-demo.mp3",
    createdAt: now, updatedAt: now, status: "completed", stage: "Fictional demo; no audio or Azure request",
    demo: true, locale: "en-US", maxSpeakers: 6, context: "", durationMs: 122000,
    laughter: { status: "skipped", events: [] },
    speakerNames: { "speaker-1": "DM", "speaker-2": "Alex / Mira", "speaker-3": "Sam / Torren" },
    warnings: ["This is a fictional UI sample, not a real transcription or a test of Azure accuracy."],
    segments: [
      { id: "S00001", speaker: "speaker-1", startMs: 4000, endMs: 11000, text: "Below the ruined observatory, a blue lantern hangs over a sealed stone door." },
      { id: "S00002", speaker: "speaker-2", startMs: 13500, endMs: 19000, text: "Mira checks the lantern. Can I make an Arcana check?" },
      { id: "S00003", speaker: "speaker-1", startMs: 21000, endMs: 29000, text: "With that eighteen, you recognize a ward. The inscription says the door opens at moonrise." },
      { id: "S00004", speaker: "speaker-3", startMs: 33000, endMs: 39000, text: "Torren wants to wait for moonrise rather than break the ward." },
      { id: "S00005", speaker: "speaker-2", startMs: 42000, endMs: 47000, text: "Agreed. While we wait, I search the alcove." },
      { id: "S00006", speaker: "speaker-1", startMs: 50000, endMs: 58000, text: "You find a silver key and a note signed by Archivist Vell. There is no gold." },
      { id: "S00007", speaker: "speaker-3", startMs: 65000, endMs: 71000, text: "Next time, we should ask Vell what is behind this door." },
      { id: "S00008", speaker: "speaker-1", startMs: 114000, endMs: 122000, text: "We stop here before moonrise. You have not opened the door yet." },
    ],
    recap: {
      title: "The Lantern Below",
      paragraphs: [
        { text: "Beneath a ruined observatory, the party found a blue lantern hanging over a sealed stone door. Mira's Arcana check revealed that the ward would open at moonrise, so Torren persuaded everyone to wait rather than force it.", segmentIds: ["S00001", "S00002", "S00003", "S00004", "S00005"] },
        { text: "While they waited, Mira searched an alcove and uncovered a silver key and a note signed by Archivist Vell—though, to the party's disappointment, no gold. They stopped before moonrise with the door still sealed and a plan to ask Vell what waited beyond it.", segmentIds: ["S00006", "S00007", "S00008"] },
      ],
      uncertainties: [],
    },
  });
}
