---
name: fix-ci
description: Check and repair the GitHub Actions test run (.github/workflows/test.yml) after pushing a branch or opening a pull request. Use after every push of a branch, when a pull request shows a red check, or when the user says the tests on GitHub fail.
---

# CI controleren en repareren

The workflow `Tests` runs on every pull request to `main` and every push to another branch. It is the only automatic check before something reaches production, so a red run means: something is probably broken. Never ignore it, never make it green by hiding the problem.

## 1. Look
```bash
gh pr checks --watch            # for the current branch's pull request; waits until done
gh run list --branch "$(git branch --show-current)" --limit 3
gh run view <run-id> --log-failed | tail -300   # only the failed step, last part
```
Read the first real error, not the last line. Vitest prints `FAIL <file> > <test>` and the assertion.

## 2. Reproduce locally (same command as the failed step)
- Tests: `npx vitest run <failing file>` (CI has no `.env`; tests must not need one).
- Server messages: `node scripts/extract-server-messages.mjs --check` → run it without `--check` to update the list, then fill the translations (`add-ui-text` skill).
- Server lint: `npx eslint server --quiet` (usually a missing import or a typo).
- Build: `npx vite build`.

## 3. Decide what kind of failure it is
- **Real regression** (your change broke behaviour or a guard test): fix the code, not the test. A guard test (privacy, security, i18n) encodes a decision; change it only when the user changed that decision.
- **Test depends on the machine** (works locally, fails in CI): missing env var, real network, timing, locale, file order. Make the test self-contained (fake env values, mocked fetch, no real dates/timeouts). See `vite.config.ts` `test.env`.
- **Flaky** (passes on retry, marked `retry` in the log, or fails at random): rerun once with `gh run rerun <run-id> --failed`. If it passes, report it to the user as flaky and fix the cause in a separate commit (async waits, shared state between tests, timeouts under load). Do not add more retries.
- **Infrastructure** (npm install failed, GitHub outage): rerun once; if it persists, tell the user.

## 4. Never
- `it.skip`, `describe.skip`, `--passWithNoTests`, deleting a test, loosening an assertion, raising timeouts blindly, or `continue-on-error` just to get green.
- Changing the workflow's triggers, permissions or secrets without asking the user.

## 5. Finish
Commit the fix and ask for an explicit "push" before pushing it (never push to `main`). After the push, run `gh pr checks --watch` again and tell the user in Dutch: what failed, why, what you changed, and the final status of the run.
