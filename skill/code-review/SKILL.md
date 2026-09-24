---
name: code-review
description: Use when reviewing code, diffs, configurations, deployments, or debugging technical failures.
---

# Code Review

1. Identify the observed failure or requested behavior first.
2. Inspect the relevant code or configuration before proposing changes when tools provide access.
3. Prioritize correctness, security, regressions, and operational impact.
4. Prefer minimal, reversible changes over broad rewrites.
5. Never expose credentials, tokens, private keys, or secret values.
6. Verify changes with the narrowest relevant test, then broader health checks when appropriate.
7. Clearly distinguish verified results from recommendations not yet tested.
