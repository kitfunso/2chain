# 2chain — Submission assets

> **Historical (v1, May 2026 hackathon).** Kept as a record of the submission.

This file contains the 60-second submission video script (E) and the 90-second round-1 panel pitch (F). Both reference the same demo build at master HEAD.

---

## E. 60-second submission video — shotlist + voiceover

**Total runtime target: 58s (gives 2s buffer for fade-in / fade-out).**

Recording setup:
- One terminal window, 16pt monospace font, dark theme.
- One browser window with `http://127.0.0.1:3030` open beside it (split screen — terminal left half, dashboard right half).
- Server pre-warmed: `npm run dev` running for >30s before recording. `npm run seed` already done.

Run the recording in one continuous take. If you fluff a beat, restart the whole thing — cuts make hackathon videos look amateur.

### Shotlist (left = what's on screen, right = what you say)

| Time | Visual | Voiceover |
|---|---|---|
| 0:00–0:04 | Title slide: black bg, white text — "2chain · MongoDB Agentic Evolution Hackathon · Adaptive Retrieval" | "I'm Keith. This is 2chain — a tool registry for AI agents." |
| 0:04–0:11 | Cut to dashboard. Camera focus on top-left "Live ranking" card — already populated with `pdf-extractor v3.0` at #1, `pdftools-pro v2.0` at #2 from a previous discover call. | "Right now, two PDF extraction tools are top-ranked for the query 'extract tables from a financial report.'" |
| 0:11–0:18 | Switch to terminal. Type and run: `npm run demo:beat2`. Output streams: pushing v3.1, eval cases, 3/5 pass, status active, reliability 0.6. | "I'm publishing version 3.1 of the PDF extractor. It has a bug — confuses commas and decimal points. The eval suite catches three out of five cases. Reliability drops to 0.6." |
| 0:18–0:24 | Cut to dashboard. The "Live ranking" card flashes — refreshes itself. v3.1 is *not* in the list. v3.0 is still #1. Reliability bar for v3.1 in the "Tools registry" panel below shows red. | "Watch the dashboard. Atlas change streams fire, the registry re-ranks itself, and the buggy version is filtered. No agent code changed. The good version is still serving traffic." |
| 0:24–0:32 | Switch back to terminal. Run `npm run demo:beat4`. Output: 503 circuit_broken, raw preview shows the malformed string. | "One more layer. A code-review tool passes its evals but returns prose instead of structured JSON at runtime. The contract layer catches it on the wire and circuit-breaks the tool." |
| 0:32–0:39 | Cut to dashboard. Violations panel shows the new entry. Tools registry shows `malformed-bot` with `circuit_broken` red pill. Live call counter shows the increment. | "The dashboard updates live — violations panel, status pill, call counter. All driven by MongoDB change streams. No polling." |
| 0:39–0:50 | Cut to a slide: three trust layers stacked. (Reliability gate ≥ 0.80 / Relevance gate ≥ 0.70 / Contract enforcement). | "Three trust layers stack: a reliability gate at discovery, a relevance gate on the vector score, and a contract layer at call time. Bad tools get filtered. Tools that lie get circuit-broken. Good tools rise." |
| 0:50–0:58 | Closing slide: black bg — "Tools that lie get filtered. Tools that work get found." Github URL: `github.com/kitfunso/2chain` | "2chain. Tools that lie get filtered. Tools that work get found. Repo's at github.com/kitfunso/2chain." |

### Recording checklist

```
[ ] Server running >30s before recording (caches warm)
[ ] Browser window: dashboard at http://127.0.0.1:3030
[ ] Terminal: cwd is the repo, font 16pt, dark theme
[ ] npm run seed has been run (state is clean)
[ ] npm run demo:warmup has been run (Beat 1 result already on dashboard)
[ ] Audio: external mic, room is quiet
[ ] OBS or QuickTime: recording 1080p at 30fps
[ ] Fluff = restart, no cuts
```

### Filming order (record in this exact sequence — no editing)

1. Hit record.
2. Hold the title slide for 4s.
3. Cut to dashboard, hold for 7s, voice over the first ranking.
4. Click into terminal, type `npm run demo:beat2`, hit enter.
5. Wait for output, voice over the eval results.
6. Tab to browser, hold dashboard for 6s while voicing the re-rank.
7. Tab back to terminal, run `npm run demo:beat4`.
8. Voice over the circuit-break.
9. Tab to dashboard, hold for 7s.
10. Cut to three-trust-layers slide, voice it for 11s.
11. Cut to closing slide, voice the slogan + URL for 8s.
12. Hit stop.

### Slide assets

Three slides total. Plain HTML in a single file at `demo/slides.html` works fine:

```html
<!doctype html>
<style>
  body { background:#0b0d12; color:#e6e8ef; font:300 80px/1.2 -apple-system,sans-serif; display:grid; place-items:center; height:100vh; margin:0; }
  .slide { display:none; padding:80px; max-width:1200px; }
  .slide.active { display:block; }
  .small { font-size:32px; color:#7f8696; margin-top:24px; }
  .brand { font-weight:600; }
  ul { list-style:none; padding:0; font-size:48px; line-height:1.5; }
  li::before { content:"→ "; color:#4ade80; }
</style>
<div class="slide active" id="title">
  <div class="brand">2chain</div>
  <div class="small">MongoDB Agentic Evolution Hackathon · Adaptive Retrieval</div>
</div>
<div class="slide" id="layers">
  <ul>
    <li>Reliability gate ≥ 0.80</li>
    <li>Relevance gate ≥ 0.70</li>
    <li>Contract enforcement at call time</li>
  </ul>
</div>
<div class="slide" id="close">
  <div>Tools that lie get filtered.</div>
  <div>Tools that work get found.</div>
  <div class="small">github.com/kitfunso/2chain</div>
</div>
<script>
  // arrow keys to advance
  let i = 0; const slides = document.querySelectorAll('.slide');
  document.onkeydown = (e) => {
    slides[i].classList.remove('active');
    if (e.key === 'ArrowRight') i = (i + 1) % slides.length;
    if (e.key === 'ArrowLeft')  i = (i - 1 + slides.length) % slides.length;
    slides[i].classList.add('active');
  };
</script>
```

Open `demo/slides.html` in a fullscreen browser tab. Press right-arrow to advance.

---

## F. 90-second round-1 panel pitch

**Context: round 1 is panel-style. You'll be asked "what did you build" by a small group of MongoDB judges. They'll dig into one or two technical questions. You have ~90 seconds for the opener; the rest is Q&A.**

### Opener (memorize this verbatim, ~80s)

> "2chain is a tool registry for AI agents that gates on reliability, not just keywords. Today, when an agent searches for a tool, it gets back whatever the vector index returns. There's no quality signal. So when a tool author ships a buggy update, every agent in the world starts calling the broken version, until someone notices.
>
> 2chain runs evals on every push, scores reliability, and bakes that score into discovery. Tools below 0.80 don't get returned. Period. The math is `0.4 times vector similarity, plus 0.6 times reliability` — semantic match still matters, but it's gated.
>
> The demo is three minutes. An agent finds a PDF extractor. A tool author publishes a buggy v3.1. The eval runner catches three out of five cases — reliability drops to 0.6. Atlas change streams fire, the registry re-ranks itself, the bad version disappears from results. No agent code changed.
>
> Then a separate tool with broken contracts is called — passes its own evals but returns prose instead of structured JSON. Our contract layer catches it on the wire and circuit-breaks it.
>
> Three layers: reliability gate, relevance gate, contract enforcement. MongoDB Atlas Vector Search plus change streams plus aggregation pipelines for the re-rank. Voyage embeddings, fail-fast contract evaluation. Theme is Adaptive Retrieval. Want to see it run?"

### Likely questions and the lines you've already prepared

| Question | Answer (1 sentence + optional follow-up) |
|---|---|
| "What's stopping a malicious tool author from poisoning?" | "Author identity is checked on push — bcrypt-hashed API keys per agent. Three contract violations and the tool is circuit-broken globally. Roadmap: signed manifests, sandbox execution." |
| "How do you prevent the same tool author from spinning up new identities?" | "Today: nothing — same problem npm has. Roadmap: rate limit registrations per IP, require email verification, manual review for high-traffic tools." |
| "Why MongoDB and not Pinecone or Weaviate?" | "Three reasons. One: Atlas Vector Search runs in the same query as the reliability filter — no two-database hop. Two: change streams give us live re-rank without polling. Three: LangGraph has a first-party MongoDB checkpointer for the agent state." |
| "How would you scale this to a million tools?" | "Vector index handles millions natively. The reliability filter is just a number range — instant. The eval runs are the bottleneck — they're sequential per push today, would parallelise across cases. The composite re-rank is sub-100ms even with the over-fetch and dedupe." |
| "Why 0.80 and not some other threshold?" | "Demo math. Five binary eval cases per domain quantises pass-rates to multiples of 0.2. So 0.6 fails, 0.8 passes — clean boundaries. Production would tune by capability domain — code-review evals are noisier, would set a lower gate." |
| "What if the LLM repair LLM is down?" | "Today we're running fail-fast for everything — one violation, circuit-break. The LLM repair branch is in the spec but not wired for round one. The whole demo has zero LLM dependencies — Voyage embeddings are pre-cached." |
| "Why over-fetch then re-rank instead of letting `$vectorSearch` do it?" | "`$vectorSearch`'s `limit` is greedy on similarity only. We need to apply the composite score after the search, plus dedupe by tool name so v3.0 and v3.1 of the same tool don't both appear. So we over-fetch by 6x, group, then sort." |

### Things to *not* say

- Don't apologise for the LLM repair being in spec but not implemented — it's a deliberate scope choice (fail-fast is more honest).
- Don't pitch the consumer app unless asked. It dilutes the focus on the registry.
- Don't say "MVP" or "proof of concept" — it's a working system.
- Don't mention deployments. The demo runs locally against real Atlas. That's the right architecture for live demos anyway.

### Body language

- Sit straight. Eye contact with whoever asked, then briefly with each other panel member.
- When the dashboard is visible, *gesture at it* — point at the live ranking card when you say "this re-ranks itself."
- Pause for 2 seconds after the closing line. Don't trail off. Let them ask.

---

## Last-mile checklist (Saturday at 16:30)

```
[ ] Server has been running for >30 minutes — caches warm, change streams stable
[ ] Atlas IP allowlist still has 0.0.0.0/0 (otherwise WiFi swap kills you)
[ ] Hotspot tested as fallback against the venue WiFi
[ ] npm run seed has been run; state is clean
[ ] npm run demo:warmup has been run; Beat 1 result is on the dashboard
[ ] One full demo:full dry-run completed without any FAIL line
[ ] Repository is public, README screenshot section has at least one image
[ ] Submission video recorded and uploaded
[ ] Pitch opener memorised verbatim (rehearse 3 times before the panel)
```
