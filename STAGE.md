# 2chain on stage — split-screen runbook

> **Historical (v1, May 2026 hackathon).** Kept as a record of the original Atlas stage demo.

> **Goal**: light up MongoDB Atlas as the second protagonist. Don't keep it under the hood.

---

## The screen layout

```
┌─────────────────────────────────────┬─────────────────────────────────────┐
│             LEFT                    │              RIGHT                  │
│                                     │                                     │
│   2chain dashboard (live)           │   Tab 1: Atlas Data Explorer        │
│   browser, full-screen              │           on twochain.tools         │
│   http://...3030.app.github.dev     │                                     │
│                                     │   Tab 2: Claude Code                │
│   Always shows:                     │           with 2chain MCP loaded    │
│   • Live ranking (top-N)            │                                     │
│   • Tools registry                  │   Tab 3: mongosh                    │
│   • Eval runs                       │           pre-connected to Atlas    │
│   • Violations                      │                                     │
│   • MongoDB Atlas stats             │   Operator switches by beat.        │
│   • Pipeline JSON inspector         │                                     │
│   • Live call feed                  │                                     │
└─────────────────────────────────────┴─────────────────────────────────────┘
```

The dashboard alone shows MongoDB doing real work in real time (Atlas stats panel, pipeline inspector, change-stream-driven flashes). The right pane is for emphasis on key beats.

---

## T-30 minutes — pre-flight

### 1. On the laptop

- Codespaces tab open; server running (`npm run dev`)
- Codespaces port 3030 visibility = **Public** (PORTS tab)
- Browser tab 1: `https://<codespace>-3030.app.github.dev/` — dashboard fullscreen
- Browser tab 2: `cloud.mongodb.com` — logged in, on Cluster0 → **Browse Collections** → `twochain.tools` → filter cleared
- Terminal tab: Claude Code CLI (or app) with 2chain MCP server configured (see `demo/prompts.md`)
- Terminal tab: mongosh connected (see `scripts/stage-queries.md`)

### 2. Run the preflight script in Codespaces

```bash
npm run preflight
```

**Pass condition: 12/12 checks green.** If anything red:

| Failure | Fix |
|---|---|
| `MONGODB_URI` missing | re-write the `.env` file |
| `tools_text_idx` missing | `npm run setup:text` (~30s) |
| Active tools < 5 | `npm run seed` |
| `GET /health` unreachable | server isn't running — `npm run dev` |
| MCP server doesn't boot | `npm install` then retry |

### 3. Warmup the embed cache

```bash
npm run demo:warmup
```

Pre-fetches the demo query embedding so Beat 1 cold call is sub-50ms.

---

## The 4 beats — what's on each screen

### Beat 1 — Discovery (00:00 → 00:55)

**LEFT (dashboard):** Live ranking panel empty.
**RIGHT (Tab 2 — Claude Code):** type:

```
Extract the line items from this PDF text:

Q3 Earnings
Revenue: $1,234.56
Cost of goods: $789.01
Gross margin: $445.55
Operating expenses: $200.10
Net income: $245.45

Use 2chain to discover the right tool, then call it.
```

**What lights up on LEFT:**
- Live ranking panel populates: pdf-extractor v3.0 #1, pdftools-pro v2.0 #2
- **Pipeline inspector** appears at the bottom — shows the actual `$rankFusion` aggregation JSON that just ran
- Live call feed `ok` counter ticks up

**Stage line:** *"MongoDB Atlas does this in one query — `$rankFusion` of vector search and text search, gated on reliability. The pipeline you're seeing on the dashboard right now is the actual aggregation that ran."*

---

### Beat 2 — Push the buggy version (00:55 → 01:50)

**RIGHT (Tab 1 — Atlas Data Explorer):** filter to `name = "pdf-extractor"`. Currently shows 1 doc (v3.0).
**RIGHT (Tab 3 — Codespaces terminal):** run:

```bash
npm run demo:beat2
```

**What lights up on LEFT:**
- Tools registry: new row `pdf-extractor v3.1` flashes in with red reliability bar
- Live ranking panel re-runs (driven by the change stream): v3.0 still #1, **no v3.1 in the list**
- MongoDB Atlas stats panel: `total docs` increments
- Live call feed: `ok` ticks for the eval cases

**RIGHT (Tab 1 — Atlas):** click refresh. New document `pdf-extractor v3.1` is visible with `status: "active"`, `metadata.reliability_score: 0.6`.

**Stage line:** *"Push insert, run evals, status flip — all visible in Atlas, all driven by document mutation. The reliability gate at discovery is what's filtering this out, not deletion. The bad version stays in the registry, audit trail intact."*

---

### Beat 3 — Re-discover (01:50 → 02:15)

**RIGHT (Tab 2 — Claude Code):** type:

```
Same task: extract financial line items from this PDF text. Use 2chain again.

Q3 Earnings
Revenue: $1,234.56
...
```

(Or just say "run it again with the same text".)

**What lights up on LEFT:**
- Live ranking panel re-renders: v3.0 still #1, v3.1 absent
- Live call feed: `ok` ticks again
- Pipeline inspector: shows the same pipeline ran again (judges see consistency)

**RIGHT (Tab 3 — mongosh):** paste:
```js
db.tools.find({ name: "pdf-extractor" }, { version: 1, "metadata.reliability_score": 1, status: 1, _id: 0 }).pretty()
```

Both versions print. Stage line: *"Both live in the registry. The 0.80 gate is what hides v3.1, not deletion. Reversible. Full audit."*

---

### Beat 4 — Contract violation, circuit-break (02:15 → 02:45)

**RIGHT (Tab 2 — Claude Code):** type:

```
Use 2chain to find a code review bot called "malformed-bot" and run it on this code:

const x = 1; export default x;
```

**What lights up on LEFT:**
- Tools registry: malformed-bot status pill flips `active` → red `circuit_broken`
- Violations panel: new entry appears (stage: output, schema_errors)
- Live call feed: `circuit_broken` counter ticks up

**RIGHT (Tab 1 — Atlas Data Explorer):** filter to `name = "malformed-bot"`. Refresh. Document's `status` field shows `"circuit_broken"`.

**Stage line:** *"Atlas Vector Search for discovery, document mutations for state, append-only collections for the audit trail. One database. One substrate."*

---

## Closing (02:45 → 03:00)

**LEFT and RIGHT** both go full-bleed black with closing slide:

```
2chain
Tools that lie get filtered.
Tools that work get found.

github.com/kitfunso/2chain
```

**Stage line:** *"Discovery, contracts, evals — on MongoDB Atlas. We're 2chain. Thanks."*

Stop talking. Wait for applause.

---

## Operator cheat sheet (laptop screen, taped corner)

```
[ ] T-10: npm run preflight  → 12/12 green
[ ] T-5:  npm run demo:warmup
[ ] T-3:  npm run demo:reset      (fresh state)
[ ] T-1:  Atlas tab on twochain.tools, filter cleared
[ ] T-1:  Claude Code open, MCP loaded, prompt 1 ready in clipboard
[ ] T-0:  GO

BEAT 1:   paste prompt 1 in Claude Code
BEAT 2:   `npm run demo:beat2`     (switch right pane to Atlas before running)
BEAT 3:   paste prompt 1 again, OR mongosh find query
BEAT 4:   paste prompt 6 in Claude Code   (switch right pane to Atlas)

If anything stalls > 5s: skip a sentence, keep moving
If anything stalls > 15s: cut to fallback video on the laptop
```

---

## Fallback video

Pre-record a 3-min clean run on Saturday afternoon. If live demo dies, full-screen the video, narrate over it. Save as `fallback.mp4` on the desktop.

Steps:
1. `npm run demo:reset`
2. Start screen recorder (OBS / QuickTime, 1080p 30fps)
3. Hit GO and execute the operator script verbatim, no commentary
4. Stop after the close slide
5. Save somewhere accessible

Re-record if any beat takes longer than its budget.
