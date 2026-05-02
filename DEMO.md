# 2chain — DEMO.md

The word-for-word 3-minute live script. Rehearse to **2:45 spoken** so there's a 15s buffer for stage handoff, slide advance, and breath. **Read the script verbatim in rehearsals 1-3.** Improvise only after the muscle memory is set.

Locked to DESIGN.md D1-D27 and EVALS.md §1.

---

## 1. Roles

| Role | Who | What they do |
|---|---|---|
| **Presenter** | one person | reads the script, drives slides, narrates. Does NOT touch the laptop. |
| **Operator** | second person | runs commands at the laptop on cue. Does NOT speak unless asked. |
| **Floor** | third person (optional) | hands microphone, advances slide deck if presenter forgets. |

Solo? Operator and Presenter are the same person. Saturday afternoon (H6 onwards, after the live build), wrap the operator commands in shell aliases or `expect` scripts so the presenter only types `enter`. **Do not prepare these scripts pre-event** — anything executable that ships into the demo must be authored Saturday after `git init`.

---

## 2. Pre-flight checklist (T-10 minutes before slot)

```
[ ] Laptop on cellular hotspot (preferred) OR venue WiFi: SSID `CodeNode`, password `EnterSpace`. Hotspot is the safer pick during the demo slot — venue WiFi will be saturated.
[ ] Atlas dashboard open in browser tab 2 (for screenshot recovery)
[ ] Terminal at C:/Users/skf_s/2chain  with these tabs:
    Tab 1: server log    (tail -f)
    Tab 2: agent runner  (ready to invoke demo agent)
    Tab 3: push CLI      (cd to dir with bad/pdf-extractor-3.1.json)
    Tab 4: curl prober   (for /rankings sanity)
[ ] Browser at:
    Tab 1: http://localhost:3000 (dashboard) — full-screen, no chrome
    Tab 2: Architecture diagram slide (cold open)
    Tab 3: Close slide (full-bleed black, "Tools that lie / Tools that work")
    Tab 4: Atlas Sandbox dashboard (recovery view if cluster goes down on stage)
    Tab 5: Hackathon Discord (sponsor questions, official updates) — **mandatory infrastructure**
[ ] Pre-recorded fallback video queued in QuickTime / VLC (full-screen ready)
[ ] Phone on silent, on the laptop (not in pocket)
[ ] Water within reach
[ ] Verify before walking on stage:
    - curl http://localhost:4000/health → 200
    - curl http://localhost:4000/discover?q="Extract tables..." → 5 results, [0].name === pdf-extractor, reliability 1.0
    - dashboard renders top-N
    - bad/pdf-extractor-3.1.json file exists in tab 3 cwd
```

If any of those fail → use fallback video. Don't try to fix on stage.

---

## 3. The 3-minute script (word-for-word)

### Cold open — 00:00 to 00:20

> **PRESENTER**: "Every coding agent in this room has the same problem. Last month, Anthropic shipped the MCP registry — it tells you what exists. Smithery hosts seven thousand servers and counts how often each gets called. Neither tells you whether a tool actually works. Your agent picks one. It writes garbage. Your user pays. We built the layer that knows. One sentence: the dev lifecycle for agent tools — discovery, contracts, evals — on MongoDB Atlas. We're 2chain."

**SLIDE**: Architecture diagram — three pillars labelled Discovery / Contracts / CI.

**Operator**: nothing yet.

**Buffer**: ~2s. If you hit 00:24 here, drop "and counts how often each gets called" — saves 2s.

---

### Beat 1 — Discovery — 00:20 to 00:50

**SLIDE**: switch to the dashboard tab (Browser tab 1).

> **PRESENTER**: "Here's the registry. Five tools active across three capability domains. An agent shows up with a job: extract tables from this financial PDF. It queries 2chain — semantically, not by string match — and gets a ranked shortlist."

**Operator**: in Tab 2, run:
```
npm run agent:demo
```

(this triggers the LangGraph agent which calls `/discover` with `DEMO_AGENT_QUERY`.)

> **PRESENTER**: "Top of the list: pdf-extractor v3, reliability one-hundred percent over five eval cases, p95 latency one-point-two seconds. Number two: pdftools-pro, eighty percent reliable. The agent picks the top one. Calls it. Five rows back, all numbers correct."

**SCREEN**: agent's terminal output shows the 5 extracted rows. Dashboard top-N is visible above.

**Time check**: aim 00:48. If you're at 00:55, skip "p95 latency" line and the latency comment.

---

### Beat 2 — Bad version pushed — 00:50 to 01:45

> **PRESENTER**: "Now — the interesting bit. A tool author pushes a new version. Honest mistake. Subtle bug in the number parser."

**Operator**: in Tab 3, run:
```
2chain push bad/pdf-extractor-3.1.json
```

(Push CLI inserts the new version with `status: 'pending'`, runs eval inline. 4 cases pre-cached. 1 case — `financial-numbers` — runs live against the v3.1 stub, which produces decimal-comma-swapped outputs, fails the tolerance grader.)

> **PRESENTER**: "Push triggers the eval suite — five test cases, deterministic graders. Four are cached. One — the financial-numbers case — runs live against the new stub. The decimal-comma bug fails the tolerance check. Pass rate drops to three of five. Sixty percent."

**SCREEN**: dashboard updates within 2-3s of the push. The new version appears in the eval-runs panel with `pass_rate: 0.6`. Top-N panel updates.

> **PRESENTER**: "Reliability gate is eighty percent. Anything below the gate is filtered from discovery. Watch the rankings. v3.1 doesn't appear at all. v3.0 — the working version — stays at the top. The bad version is invisible to every agent in the system."

**SCREEN**: dashboard top-N panel — `pdf-extractor v3.0` still #1, `pdftools-pro v2.0` still #2. v3.1 absent. (The dashboard's `/rankings` poll has caught up.)

**Time check**: aim 01:42. If you're at 01:50, skip the "Reliability gate is eighty percent" recap — the screen tells the story.

**STAGE LANGUAGE WARNING**: do NOT say "circuit-broken" here. v3.1 is **filtered**. Circuit-broken is reserved for Beat 4. (DESIGN.md §3.4 + D20.)

---

### Beat 3 — The agent never saw the regression — 01:45 to 02:15

> **PRESENTER**: "An agent shows up. Same task. Same query. Watch what happens."

**Operator**: in Tab 2, run:
```
npm run agent:demo
```

(Same agent, same query string. `/discover` returns the same top-N as Beat 1 — v3.1 is filtered out by the reliability gate, never reaches the agent.)

> **PRESENTER**: "Same answer. Five rows, same numbers. The agent never saw the broken version. The registry caught the regression three seconds after it shipped, and every other agent in this room is now protected too — automatically. That's the spine."

**SCREEN**: agent output identical to Beat 1. Dashboard top-N unchanged. Eval-runs panel shows the failed v3.1 row prominently — that's the visible proof.

**Time check**: aim 02:13. Buffer 2s.

**Stage framing note** (do not say aloud): the story is *protection from regression*, not *new winner*. Less dramatic, but it's what the system actually does. A judge who tests the system finds protection. A judge who's promised reranking finds nothing changed and concludes the demo lied.

---

### Beat 4 — Contract enforcement — 02:15 to 02:45

> **PRESENTER**: "One more layer. A code-review tool — malformed-bot v1 — passes its eval suite, but the eval suite checks output existence, not output shape. An agent calls it for the first time, and the contract layer hits a class of failure evals can't catch — runtime schema violation."

**Operator**: in Tab 4, run:
```
curl -X POST http://localhost:4000/call -H "Content-Type: application/json" -d '{"tool_name":"malformed-bot","version":"1.0","input":{"code":"function f(){}"},"agent_id":"demo-pdf-agent","api_key":"<key>"}'
```

(Or wrap this in `npm run demo:beat4` for less typing on stage.)

> **PRESENTER**: "Contract layer catches the violation on the wire. The tool is registered with fail-fast repair, so it circuit-breaks on the first violation. Audit log written. Tool's status flips to circuit_broken. The agent gets a 503 and falls back to a different tool. From here on, no agent in the system can route to it."

**SCREEN**: server log shows:
```
[VIOLATION] malformed-bot@1.0 attempt=1 stage=output schema_errors=expected object, got string
[CIRCUIT_BREAK] malformed-bot@1.0 → status=circuit_broken
```

Dashboard's violations panel shows 3 fresh entries. Top-N still doesn't include malformed-bot.

> **PRESENTER**: "Now no agent — anywhere — can route to that tool. Until a human looks at it. That's the contract layer."

**Time check**: aim 02:43. Buffer 2s.

**STAGE LANGUAGE WARNING**: this IS where you say "circuit-broken." Beat 2 said "filtered." Two states, two words.

---

### Close — 02:45 to 03:00

**SLIDE**: switch to **black close slide** (Browser tab 3 — replace the old Roadmap slide). Three lines, large type, full-bleed black:

```
2chain
Tools that lie get filtered.
Tools that work get found.
```

> **PRESENTER**: "Tools are how agents touch reality, and right now, nobody knows which ones lie. Discovery. Contracts. Evals. We're 2chain. MIT on GitHub. Thanks."

**End**: 03:00. Stop talking. Wait for applause. Hand mic to floor.

**Why this close** (notes for the presenter, do not say aloud):
- The "tools that lie" line is the *load-bearing sentence* — the one a judge will quote tomorrow if they remember anything from your demo.
- The black slide is intentional taste. Every other team will close on a roadmap.
- Roadmap content stays in the README — judges read it later.

---

## 4. Q&A bank — rehearse the answers

| Question | Answer (≤ 20 seconds) |
|---|---|
| "How is this different from the official MCP registry?" | "The MCP registry is a metadata catalog. It tells you a server exists. 2chain runs deterministic evals on every push, enforces typed I/O contracts, and re-ranks by reliability. It tells you whether the tool *works*." |
| "Isn't this just Smithery?" | "Smithery hosts MCP servers and counts calls. We're orthogonal. We're the eval + contract + ranking layer. Smithery is a hosting backend we'd plug into." |
| "Are you compatible with Smithery and the official registry?" | "Yes. We consume their metadata, we layer evals and contracts on top. Tool authors publish into the registry and into 2chain." |
| "How are you different from LangSmith Evals?" | "LangSmith evaluates the *agent's trajectory* across a trace. 2chain evaluates the *tool itself*, in isolation, and re-ranks it. Different unit, different consumer — the agent runtime, not the human dev tuning prompts." |
| "Why MongoDB instead of Postgres + cron?" | "Atlas converges vector search, JSON-flexible contracts, and change streams in one store. Postgres needs pgvector plus a separate orchestrator plus a separate stream system. We picked converged." |
| "Can tool authors game the evals?" | "In principle, yes. The registry team owns the `evals` collection — authors can't edit them. Held-out test sets and secret graders are roadmap. Today, cases are public, deterministic, versioned. Anyone can re-run." |
| "Who trusts the scores?" | "The graders are deterministic functions — regex, JSON-schema, numeric tolerance. Not LLM-as-judge. Reproducible. Anyone runs the suite, gets the same number." |
| "What if evals disagree with real production usage?" | "We log every call in a `usage` collection. Roadmap blends usage-derived reliability with eval-derived reliability. We chose eval-only today for stage determinism." |
| "How do agents know rankings are fresh?" | "Rankings doc has a `computed_at`. Agents poll every two seconds. Webhooks and Atlas Streams are the production path. We're on the hackathon Atlas Sandbox; polling is the safer choice and works on any tier." |
| "What stops a malicious tool from poisoning the network?" | "Author identity is checked on push — bcrypt-hashed API keys per agent. Three contract violations and the tool is circuit-broken globally. Roadmap: signed manifests, sandbox execution." |
| "What's the business model?" | "Private registries for enterprises that don't want their internal tool quality scores public. That's the wedge. Same product, customer pays for the firewall. Twenty teams in this hackathon would be candidates." |
| "Why TypeScript?" | "It aligns with the agent-tool-author audience — most MCP and LangGraph work is in TypeScript. The Atlas SDK is mature. We're shipping an npm package." |
| "How does this scale?" | "M0 demo. Production: shard `tools` by `name` hash, partition `eval_runs` by month, push eval execution to a worker pool. The architecture doesn't change." |
| "Why didn't you use change streams?" | "We chose polling for hackathon-day reliability — 2-second polls work on any Atlas Sandbox tier, no surprises if filters or stream availability differ. Production swaps polling for change-stream subscriptions in fifteen minutes." |
| "What happens if the repair LLM is down?" | "On stage we're already running fail-fast — one attempt, then circuit-break. The LLM-repair branch is a separate path for tools that *can* be salvaged. Beats 1 through 3 have no LLM dependency at all." |

---

## 5. Fallback playbook (when something breaks on stage)

| What breaks | Smell | Action | Stage language |
|---|---|---|---|
| `/health` returns 500 before slot starts | Pre-flight check fails | **Use the recorded video.** No live attempt. | "We had an Atlas hiccup just before the slot — running the recorded version." |
| Atlas connection drops during Beat 1 | Dashboard goes blank, agent timeouts | Switch to Atlas dashboard tab — show the cluster status. Continue narrating from memory; don't run more commands. After the slot: announce that you'll take Q&A on the architecture. | "Connection blip — let me show you the architecture instead, then take questions." |
| Beat 2 push hangs (eval timeout) | Push CLI doesn't return in 5s | Wait until 15s deadline. If still hanging, kill, push a sanitized `bad/pdf-extractor-3.1-cached.json` (precomputed eval_run already in DB). | "Network spike on the eval call — switching to the cached run." |
| Dashboard doesn't reflect Beat 2 flip within 5s | Dashboard panel still shows v3.0 only (no flip evidence) | Refresh the page once. If still wrong, screenshot the eval_runs panel manually. | "Browser cache — let me refresh." |
| Repair LLM (Anthropic Haiku) outage | n/a — Beat 4's malformed-bot is fail-fast by default, no LLM call. Only matters for the *roadmap mention* of LLM repair. | If asked about LLM repair and it's down: speak the mechanism, don't run it. | "LLM repair is the other branch — fail-fast is what we're showing today." |
| Demo agent (LangGraph) errors out | Agent terminal shows stack trace | Operator silently runs `curl` against `/discover` and `/call` from Tab 4 — narrate from there. | (no acknowledgement — keep going) |
| Slide deck won't advance | Close slide doesn't load | Close on the dashboard tab instead. | "We'll skip the slide — the line stands on its own." |
| Mic dies | Presenter inaudible | Floor crew swaps mic. Presenter pauses, waits, restarts at the last beat boundary. | (resume from beat) |
| Heckler / aggressive question | Q&A goes hostile | Acknowledge once, redirect to README, take the next question. | "Great point — the README has a deeper answer. Next question?" |
| Time alarm at 02:45 and you're at 01:45 | Way ahead | Add the closing line slowly. Pause for emphasis. Take an early Q. | "We've got time — happy to take a question early." |
| Time alarm at 02:45 and you're at 02:30 | Slightly behind | Skip the Beat 4 recap line. Go straight to close. | (no acknowledgement — finish strong) |

**Hard rule**: never apologise on stage for a glitch. Acknowledge once, redirect, keep going. Apologies kill the energy.

---

## 6. Submission video script (1-min cut, separate from live)

The hackathon submission portal asks for a video. Re-cut the 3-minute live demo to ~60s. Not a separate take — film during rehearsal #3 (15:30 Saturday).

Cuts:
- 00:00-00:08: cold open, just the MCP-registry / Smithery / "doesn't tell you if it works" hook
- 00:08-00:20: Beat 1, agent + ranked top-N (no narration about p95 latency)
- 00:20-00:40: Beat 2, push + flip + filter (narrate over screen)
- 00:40-00:48: Beat 3, re-discovery (no narration, just screen)
- 00:48-00:55: Beat 4, contract violation + circuit-break (one sentence)
- 00:55-01:00: close — "Discovery, contracts, evals. 2chain. MIT on GitHub."

**Background music**: lift the 60s cut over a quiet electronic loop. Keep it subtle.

**Subtitle the whole thing**. Judges play submission videos on mute first.

---

## 7. Cue cards (one-line reminders printed/taped to laptop)

For the presenter, in order:

```
[ ] CLEAR THROAT — wait for "Go" from the floor
[ ] COLD OPEN: "Last month Anthropic shipped..."
[ ] BEAT 1: dashboard tab + "Five tools, three domains..."
[ ] BEAT 2: do NOT say "circuit-broken" — say "filtered"
[ ] BEAT 3: "Same task. Same query. New world."
[ ] BEAT 4: do NOT say "filtered" — say "circuit-broken"
[ ] CLOSE: "Discovery. Contracts. Evals. We're 2chain. Thanks."
[ ] STOP TALKING. Wait for applause.
```

For the operator, in order:

```
[ ] T-10: pre-flight checklist all green
[ ] BEAT 1: `npm run agent:demo` (Tab 2)
[ ] BEAT 2: `2chain push bad/pdf-extractor-3.1.json` (Tab 3)
[ ] BEAT 3: `npm run agent:demo` (Tab 2)
[ ] BEAT 4: `npm run demo:beat4` (Tab 4)
[ ] If anything stalls > 5s: cue presenter to skip a sentence
[ ] If anything stalls > 15s: kill terminal, switch to fallback video
```

---

## 8. Rehearsal protocol (Saturday H6.5, H7, H7.5)

Three takes minimum. Different operator for each if possible.

| Take | Time target | Focus |
|---|---|---|
| #1 (15:30) | 2:55 (allow overrun) | Get through it once. Note where you stumble. |
| #2 (16:00) | 2:50 | Trim filler. Hit beat boundaries. |
| #3 (16:30) | 2:45 | **FILM THIS for the fallback video and submission video.** Tight, clean. |

After each take, fill in:

```
TAKE #__
Total time: __:__
Slowest beat: ____
Mistake: ____ (one only — fix the worst)
Fix before next take: ____
```

If take #3 is over 2:50, scope-cut Beat 4 entirely — Beats 1-3 in 2:15 with a 30-second close is a complete demo.

---

## 9. The one mantra

**Demo first, build to demo. Every line of code in this repo serves these three minutes.** If something on stage doesn't match the script, the script wins.
