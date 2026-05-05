#!/bin/sh
set -e

mkdir -p /data /data/ollama

ollama serve &
OLLAMA_PID=$!

echo "waiting for ollama to come up..."
for i in $(seq 1 30); do
  if curl -sf http://127.0.0.1:11434/api/tags > /dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! ollama list 2>/dev/null | grep -q nomic-embed-text; then
  echo "pulling nomic-embed-text (one-time, persisted to /data/ollama)..."
  ollama pull nomic-embed-text
fi

# First-boot synchronous data load. Each marker gates one phase so a partial
# boot can resume cleanly. We block server start until imports finish — slow
# first boot, but reliable, no SSH dance.
cd /app

if [ ! -f /data/.corpus-imported ]; then
  echo "first-boot: importing curated real-corpus (223 specs)..."
  npm run import:corpus 2>&1 | tee /data/import-corpus.log | tail -3 || true
  touch /data/.corpus-imported
fi

if [ ! -f /data/.subagents-imported ]; then
  echo "first-boot: scraping public subagents (wshobson + voltagent)..."
  npm run scrape:subagents 2>&1 | tee /data/import-subagents.log | tail -3 || true
  touch /data/.subagents-imported
fi

if [ ! -f /data/.skills-imported ]; then
  echo "first-boot: scraping public skills (anthropics/skills)..."
  npm run scrape:skills 2>&1 | tee /data/import-skills.log | tail -3 || true
  touch /data/.skills-imported
fi

if [ ! -f /data/.curated-prompts-imported ]; then
  echo "first-boot: importing 12 curated prompts..."
  npm run import:prompts 2>&1 | tee /data/import-prompts.log | tail -3 || true
  touch /data/.curated-prompts-imported
fi

if [ ! -f /data/.public-prompts-imported ]; then
  echo "dispatching awesome-chatgpt-prompts scrape in background"
  ( setsid sh -c 'sleep 60 && cd /app && npm run scrape:prompts >>/data/import-public-prompts.log 2>&1 && touch /data/.public-prompts-imported' </dev/null >/dev/null 2>&1 ) &
fi

if [ ! -f /data/.mcp-imported-1500 ]; then
  echo "dispatching awesome-mcp-servers scrape (cap 1500) in background"
  ( setsid sh -c 'sleep 90 && cd /app && MAX_MCP=1500 npm run scrape:mcp >>/data/import-mcp.log 2>&1 && touch /data/.mcp-imported-1500' </dev/null >/dev/null 2>&1 ) &
fi

if [ ! -f /data/.mcp-curated-imported ]; then
  echo "first-boot: importing curated MCP_SERVERS (real spawn configs)..."
  npm run import:mcp 2>&1 | tee /data/import-mcp-curated.log | tail -3 || true
  touch /data/.mcp-curated-imported
fi

if [ ! -f /data/.hn-imported ]; then
  echo "first-boot: scraping HackerNews Show HN posts..."
  npm run scrape:hn 2>&1 | tee /data/import-hn.log | tail -3 || true
  touch /data/.hn-imported
fi

if [ ! -f /data/.kitfunso-imported ]; then
  echo "dispatching kitfunso first-party repos in background"
  ( setsid sh -c 'sleep 20 && cd /app && npm run scrape:kitfunso >>/data/import-kitfunso.log 2>&1 && touch /data/.kitfunso-imported' </dev/null >/dev/null 2>&1 ) &
fi

if [ ! -f /data/.agent-infra-imported ]; then
  echo "dispatching agent-infra curated set in background"
  ( setsid sh -c 'sleep 40 && cd /app && npm run scrape:agent-infra >>/data/import-agent-infra.log 2>&1 && touch /data/.agent-infra-imported' </dev/null >/dev/null 2>&1 ) &
fi

if [ ! -f /data/.callable-stubs-imported ]; then
  echo "first-boot: pushing callable-stub specs (github/npm/wikipedia search)"
  npm run import:callable-stubs 2>&1 | tee /data/import-callable-stubs.log | tail -3 || true
  touch /data/.callable-stubs-imported
fi

if [ ! -f /data/.skills-extra-imported ]; then
  echo "dispatching extra skills scrape in background"
  ( setsid sh -c 'sleep 60 && cd /app && npm run scrape:skills-extra >>/data/import-skills-extra.log 2>&1 && touch /data/.skills-extra-imported' </dev/null >/dev/null 2>&1 ) &
fi

if [ ! -f /data/.skills-discovery-imported ]; then
  echo "dispatching skills discovery (github topic search) in background"
  ( setsid sh -c 'sleep 180 && cd /app && npm run discover:skills >>/data/discover-skills.log 2>&1 && touch /data/.skills-discovery-imported' </dev/null >/dev/null 2>&1 ) &
fi

# GitHub stars + last-commit enrichment. Idempotent (skips rows refreshed
# within last 7d), so runs on every boot to keep stats current. Slow without
# GITHUB_TOKEN (60/hr unauth limit) but resumable across reboots.
echo "dispatching github stats enrichment in background"
( setsid sh -c 'sleep 120 && cd /app && npm run enrich:github >>/data/enrich-github.log 2>&1' </dev/null >/dev/null 2>&1 ) &

# Chunked snapshot import (1200 specs from npm + PyPI + HF + awesome-*).
# Runs in background AFTER server starts so the slow import doesn't block
# the dashboard. Skip-existing makes it resumable across reboots.
if [ ! -f /data/.snapshot-imported ]; then
  echo "first-boot: dispatching chunked snapshot import in background"
  ( setsid sh -c 'sleep 30 && cd /app && npm run import:snapshot:chunked >>/data/import-snapshot.log 2>&1 && touch /data/.snapshot-imported' </dev/null >/dev/null 2>&1 ) &
fi

# Always-run domain reclassifier so newly imported entries get bucketed.
# Domain classification now happens INLINE in src/import/scrape-import.ts at
# import time, so every imported row already lands in a canonical bucket.
# The reclassify script is retained for retroactive cleanup (run on demand
# when keyword rules change), but is NOT part of the boot workflow.

# Per-kind eval rubric: scores every tool's reliability based on rubric
# pass-rate. Sub-second total runtime, no embedder calls.
echo "running per-kind eval rubric..."
npm run eval:all 2>&1 | tee /data/eval-all.log | tail -10 || true

# Auto-create the public demo + author agents if missing (idempotent upsert).
if [ ! -f /data/.agents-bootstrapped ]; then
  echo "first-boot: bootstrapping demo agents..."
  npm run agent:create -- --name public-demo --role caller --key sk_public_caller_09e45ffbb6781f2f 2>&1 | tail -2 || true
  npm run agent:create -- --name kit-author --role tool_author --key sk_kit_author_ef22484635fa3eac 2>&1 | tail -2 || true
  touch /data/.agents-bootstrapped
fi

echo "starting 2chain api on $HOST:$PORT (db=$TWOCHAIN_DB_PATH)"
exec npm start
