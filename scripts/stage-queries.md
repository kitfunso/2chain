# Stage queries — paste into mongosh during the demo

Pre-flight: connect mongosh to Atlas before recording / going on stage.

```bash
mongosh "mongodb+srv://<user>:<pass>@cluster0.fcsrfc.mongodb.net/twochain"
```

Switch to the right DB:

```js
use twochain
```

---

## Beat 1 — hybrid retrieval ($rankFusion)

Show the named primitive in front of the judges. **Voyage embedding is pre-computed** in `2chain.tools` documents; for the on-stage query we just demonstrate the aggregation shape that the API runs internally.

Run a clean version of the API call (this is what `/discover?mode=hybrid` does):

```js
// Compact view: same top-N the dashboard shows
db.tools.aggregate([
  {
    $rankFusion: {
      input: {
        pipelines: {
          vector: [{
            $vectorSearch: {
              index: "tools_capability_idx",
              path: "capability_embedding",
              queryVector: db.tools.findOne({name:"pdf-extractor", version:"3.0"}).capability_embedding,
              numCandidates: 50,
              limit: 20,
              filter: {
                status: { $eq: "active" },
                "metadata.reliability_score": { $gte: 0.80 }
              }
            }
          }],
          text: [
            { $search: {
                index: "tools_text_idx",
                text: { query: "extract tables PDF financial", path: "capability_text" }
            }},
            { $match: { status: "active", "metadata.reliability_score": { $gte: 0.80 } } },
            { $limit: 20 }
          ]
        }
      },
      combination: { weights: { vector: 0.7, text: 0.3 } }
    }
  },
  { $project: { name: 1, version: 1, "metadata.reliability_score": 1, score: { $meta: "score" }, _id: 0 } },
  { $limit: 5 }
]).pretty()
```

Expected output (ordered by `score` descending):

```
{ name: "pdf-extractor", version: "3.0", metadata: { reliability_score: 1.0  }, score: 0.0163 }
{ name: "pdftools-pro",  version: "2.0", metadata: { reliability_score: 0.8  }, score: 0.0162 }
{ name: "summariser-mini", version: "1.0", metadata: { reliability_score: 1.0 }, score: 0.0111 }
...
```

> **Stage line**: "MongoDB Atlas does the discovery in one query — vector search and text search fused with reciprocal rank fusion, gated on reliability."

---

## Beat 2 — show the document mutation in real time

Right pane is **Atlas Data Explorer / Compass on `2chain.tools`**, filter `name = "pdf-extractor"`. After running `npm run demo:beat2`, the v3.1 document appears with:

```
status:                       "pending"   →    "active"
metadata.reliability_score:    0           →    0.6
metadata.last_eval_run:        <new>            <new>
```

Operator clicks Refresh once if Compass doesn't auto-refresh. Both fields visibly flip. This is **document mutation, change-stream-driven, on screen, in real time.**

If on mongosh instead:

```js
db.tools.find(
  { name: "pdf-extractor" },
  { version: 1, status: 1, "metadata.reliability_score": 1, _id: 0 }
).toArray()
```

Run before AND after the push. Show the transition.

---

## Beat 3 — both versions live in the registry

> **Stage line**: "Both versions live in the registry. The gate is what hides v3.1, not deletion. Full audit trail. Reversible."

```js
db.tools.find(
  { name: "pdf-extractor" },
  { version: 1, status: 1, "metadata.reliability_score": 1, _id: 0 }
).sort({ version: -1 }).pretty()
```

Output:

```
{ version: "3.1", status: "active", metadata: { reliability_score: 0.6 } }
{ version: "3.0", status: "active", metadata: { reliability_score: 1.0 } }
```

Then to confirm the gate works at the discovery layer (this is what the agent sees):

```js
db.tools.find(
  { name: "pdf-extractor", "metadata.reliability_score": { $gte: 0.80 } },
  { version: 1, _id: 0 }
).toArray()
```

Output: only v3.0.

---

## Beat 4 — circuit-break verification

Right pane stays on `2chain.tools` filtered to `name = "malformed-bot"`. After the call, status flips active → circuit_broken.

mongosh equivalent (run after `npm run demo:beat4`):

```js
db.tools.findOne(
  { name: "malformed-bot" },
  { version: 1, status: 1, _id: 0 }
)
// → { version: "1.0", status: "circuit_broken" }

db.violations.find({ tool_name: "malformed-bot" })
  .sort({ occurred_at: -1 })
  .limit(3)
  .pretty()
// → 1 doc, stage: "output", schema_errors: [{path:"", message:"must be object"}]
```

> **Stage line**: "Atlas Vector Search for discovery, document mutations for state, append-only collections for the audit trail. One database, one substrate."

---

## Bonus query — eval runs feed (if a judge asks "how do you track evals over time?")

```js
db.eval_runs.find(
  { tool_name: "pdf-extractor" },
  { tool_version: 1, pass_rate: 1, triggered_at: 1, triggered_by: 1, _id: 0 }
).sort({ triggered_at: -1 }).limit(5).pretty()
```

You'll see the v3.1 push run alongside the seeded v3.0 baseline.

---

## Quick verify (T-10 pre-flight)

Paste this once before the show. Should print 5 active tools, 3 agents, 2 search indexes (vector + text):

```js
print("active tools:    " + db.tools.countDocuments({ status: "active" }))
print("agents:          " + db.agents.countDocuments({}))
print("eval_runs:       " + db.eval_runs.countDocuments({}))
print("text idx ready:  " + (db.tools.aggregate([{$listSearchIndexes:{}}]).toArray().find(i=>i.name==="tools_text_idx").queryable))
print("vector idx ready:" + (db.tools.aggregate([{$listSearchIndexes:{}}]).toArray().find(i=>i.name==="tools_capability_idx").queryable))
```
