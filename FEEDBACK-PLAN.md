# Feedback plan: names, uncertainties, audio balance

Source: first real-world use by the DM the app was built for, on several full sessions (October 2026).
**Decision (owner):** items 1 and 2 are merged into one feature, item 3 is in scope, and item 4 is dropped (the DM is happy with clip defaults as they are). Implemented on branch `feature/names-and-audio`.

## What's working (protect it)

- **Recap voice and accuracy.** The narrative recap closely matched the DM's own writing style, with more detail. Don't
  change the recap prompts or model settings as part of this work. Every fix below feeds *better inputs*
  (spellings, clarifications) into the same recap pipeline.
- **Laughter index → clip workflow.** Finding a funny moment and exporting a clip took about two minutes, and the
  default clip start (before the laugh) usually captures the whole bit. Only defaults may change here (item 4).

## Answer to "should I hold off on recaps?"

No need to wait on *transcription*. Everything below corrects the **transcript** and then regenerates the recap, which
keeps the transcript, costs roughly $0.40–0.80 per long session, and needs no new upload. Recommended:

- Keep uploading sessions now (transcription is the slow part).
- Don't hand-edit recaps yet. Once item 1 ships, fix names once per session (or once per campaign via the glossary)
  and click **Regenerate recap**.

## 1. Fix names and uncertainties after transcription (highest value)

**Problem.** Proper nouns get misheard, especially with several accents. Example: *Lostleton* came out as
"Lonelywood". The DM can't know what context to give before hearing the recap.

**Plan**

1. **Names & spelling panel** on each session: a list of correct spellings, each with optional "heard as" variants
   (e.g. *Lostleton* ← "Lonelywood", "Lost Elton").
2. **Two ways to apply it**
   - **Find & replace:** exact variant matches, instant and free, with a preview of how many lines change.
   - **AI-assisted fix:** GPT-5.4 reads the transcript in chunks with the glossary and proposes corrections for names
     and terms only, including variants nobody listed. It returns structured suggestions (line, old text, new text,
     reason), which the DM reviews and accepts all or individually. It never rewrites wording, speakers or timestamps;
     only line text changes, so clips and laughter links stay valid. Costs about the same as one recap read-through
     (≈ $0.30 per 3-hour session); counts toward the daily recap quota.
3. **Clarify uncertainties.** Each item in the recap's "uncertain" list gets a **Clarify** box (e.g. "That was Mira,
   not Myra"). Clarifications are saved on the session and given to the recap writer as authoritative notes on the
   next regeneration, alongside the glossary.
4. After any fix, the recap is marked **Out of date** with a one-click **Regenerate recap** (existing behavior).

**Notes and risks**

- Edits keep the existing segment IDs and timestamps (same rules as today's manual transcript edits).
- Suggestions are reviewed before applying, never applied silently, because a wrong "fix" across a whole session is
  worse than the original mishearing.
- Size: largest item. New API routes (glossary CRUD, suggest, apply, clarifications), one prompt and JSON schema,
  a review UI, and tests. About 1.5–2 days.

## 2. Names before upload + saved names list (merged into item 1)

**Constraint (verified).** Azure batch transcription, the only mode that handles 4-hour recordings with speaker
labels, doesn't accept a phrase or vocabulary list. Fast transcription accepts phrase lists but is limited to shorter
files; splitting a session would break speaker labels across parts. A custom-trained speech model per campaign is
possible but slow to iterate and unlikely to fix accent-driven mishearings well.

**Merged design.** Items 1 and 2 fix the same problem, so they're one feature built on item 1's machinery:

1. **Names list on the account,** not per session: correct spellings plus known "heard as" variants. It's reused by
   every session and grows as the DM fixes sessions.
2. **Automatic fix after transcription** (account setting, on by default): known variants are replaced in each new
   transcript before the recap is written. Only exact listed variants are applied automatically; the AI pass always
   waits for review.
3. **Recap spelling:** the names list is added to the recap writer's spelling guidance on every recap.
4. Separate *campaigns* are deferred unless name collisions between campaigns become a problem.

*Optional experiment, not recommended yet:* train an Azure Custom Speech model from a campaign's glossary text and
compare accuracy on one recording. Only worth it if items 1–2 aren't enough.

## 3. Quiet speakers (the DM is often quieter than the players)

1. **"Even out voices" toggle** in the bottom player and clip editor preview. The browser applies a compressor and
   make-up gain (Web Audio API) at playback: no server cost, instant on/off, remembered per browser, on by default.
2. **Clip export: "Even out voices" option** using FFmpeg dynamic normalization (`dynaudnorm`, light compression),
   on by default, with a checkbox to export untouched audio.
3. **Speech input:** send Azure a level-balanced mono mix (same filter in the existing normalization step). This may
   also improve recognition of the quieter DM and so reduce item 1 fixes. A/B one real recording before making it the
   default.
4. *Later, only if needed:* per-speaker gain in exports using diarization timestamps (e.g. "+6 dB for the DM").

Size: about 0.5–1 day. Doesn't change stored originals.

## 4. Clip defaults: dropped

The DM is happy with the current defaults.

## Order

1. Darker accent red (UI feedback).
2. Item 3 (audio balance).
3. Items 1+2 (names list, AI suggestions, clarifications).
