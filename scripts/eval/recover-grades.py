"""Recover partial grades from truncated raw judge outputs in v2-golden-judge-raw.json.

The .raw field was truncated to 4000 chars at grading time. The original
parser worked on the full output, but a buggy re-parse step destroyed those.
This script salvages whatever complete JSON objects we can find in the
truncated text, then re-applies the corrected name-stripping logic.

For unrecoverable queries (truncated to < N parsed objects), the candidate's
grade is left as a default (rel=0, 'incomplete-truncation') and flagged for
re-grading.
"""

import json
import re
import sys


def parse_partial(raw_text: str) -> list[dict]:
    if not raw_text:
        return []
    s = raw_text.strip()
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", s)
    if fence:
        s = fence.group(1).strip()
    start = s.find("[")
    if start < 0:
        return []
    body = s[start + 1 :]
    depth = 0
    in_str = False
    escape = False
    obj_start = None
    objs: list[dict] = []
    for i, ch in enumerate(body):
        if escape:
            escape = False
            continue
        bslash = chr(92)
        if ch == bslash and in_str:
            escape = True
            continue
        if ch == '"' and not escape:
            in_str = not in_str
            continue
        if in_str:
            continue
        if ch == "{":
            if depth == 0:
                obj_start = i
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0 and obj_start is not None:
                try:
                    obj = json.loads(body[obj_start : i + 1])
                    objs.append(obj)
                except Exception:
                    pass
    return objs


def strip_ver_suffix(name: str) -> str:
    at = name.rfind("@")
    if at < 0:
        return name
    suffix = name[at + 1 :]
    if re.fullmatch(r"[\d.]+[a-z0-9-]*", suffix):
        return name[:at]
    return name


def main():
    with open("tests/fixtures/v2-golden-judge-raw.json", "r", encoding="utf-8") as f:
        d = json.load(f)
    with open("tests/fixtures/v2-golden-candidates.json", "r", encoding="utf-8") as f:
        c = json.load(f)
    cand_by_id = {q["id"]: q["candidates"] for q in c["queries"]}

    summary = {"queries": [], "totals": {"claude_recovered": 0, "claude_missing": 0, "codex_recovered": 0, "codex_missing": 0}}
    for q in d["queries"]:
        cand_list = cand_by_id.get(q["id"], [])
        cand_keys = {(x["name"], x["version"]) for x in cand_list}
        for judge in ("claude", "codex"):
            j = q.get(judge)
            if not j:
                continue
            raw = j.get("raw", "")
            objs = parse_partial(raw)
            by_key: dict[tuple[str, str], dict] = {}
            for o in objs:
                rname = str(o.get("name", ""))
                ver = str(o.get("version", ""))
                if not rname or not ver:
                    continue
                clean = strip_ver_suffix(rname)
                key = (clean, ver)
                if key in cand_keys:
                    by_key[key] = {
                        "name": clean,
                        "version": ver,
                        "relevance": max(0, min(3, int(round(float(o.get("relevance", 0)))))),
                        "rationale": str(o.get("rationale", ""))[:240],
                    }
            new_grades = []
            recovered = 0
            missing = 0
            for c_ in cand_list:
                k = (c_["name"], c_["version"])
                if k in by_key:
                    new_grades.append(by_key[k])
                    recovered += 1
                else:
                    new_grades.append({
                        "name": c_["name"],
                        "version": c_["version"],
                        "relevance": 0,
                        "rationale": "(incomplete-truncation — re-grade)",
                    })
                    missing += 1
            j["grades"] = new_grades
            summary["totals"][f"{judge}_recovered"] += recovered
            summary["totals"][f"{judge}_missing"] += missing
        summary["queries"].append({
            "id": q["id"],
            "claude_recovered": sum(1 for g in q["claude"]["grades"] if not g["rationale"].startswith("(incomplete")) if q.get("claude") else 0,
            "codex_recovered": sum(1 for g in q["codex"]["grades"] if not g["rationale"].startswith("(incomplete")) if q.get("codex") else 0,
            "total_candidates": len(cand_list),
        })

    with open("tests/fixtures/v2-golden-judge-raw.json", "w", encoding="utf-8") as f:
        json.dump(d, f, indent=2)
        f.write("\n")
    print(f"claude recovered: {summary['totals']['claude_recovered']} (missing: {summary['totals']['claude_missing']})")
    print(f"codex  recovered: {summary['totals']['codex_recovered']} (missing: {summary['totals']['codex_missing']})")
    fully_recovered = sum(1 for q in summary["queries"] if q["claude_recovered"] >= q["total_candidates"] * 0.9 and q["codex_recovered"] >= q["total_candidates"] * 0.9)
    print(f"queries with ≥90% coverage on both judges: {fully_recovered}/100")
    needs_regrade = [q["id"] for q in summary["queries"] if q["claude_recovered"] < q["total_candidates"] * 0.5 or q["codex_recovered"] < q["total_candidates"] * 0.5]
    print(f"queries needing re-grade (<50% coverage): {len(needs_regrade)}")
    if needs_regrade[:20]:
        print(f"  first 20: {', '.join(needs_regrade[:20])}")


if __name__ == "__main__":
    main()
