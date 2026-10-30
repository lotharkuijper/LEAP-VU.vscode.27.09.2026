---
name: tidy-workspace
description: Check Claude's own working environment for this repo - auto-memory, CLAUDE.md, local git leftovers, stray secret-file copies, old branches, stashes, local test containers and growing files - and give a short Dutch report with suggested clean-up actions. Report first; nothing is changed or deleted without explicit confirmation.
disable-model-invocation: true
---

# Tidy workspace (report first)

Goal: keep this Claude setup and the local checkout clean, so old notes and leftovers do not mislead future sessions. Work in three phases: **look**, **report**, **only then act on what the user confirms**.

Hard limits for the whole skill:
- Never print the contents of `.env` or any other secret file, and never `git log -p`/`git show` a commit that touched one. File names, sizes and dates only.
- Never delete `.env`. Never run `git clean -f`, `git reset --hard`, `git push`, `git branch -D` or `docker rm` without the user naming that action.
- `db-backups/` may hold copies of production data with student data: report its size and age, never open the files.

## Phase 1: look (read-only)

### a. Claude memory and instructions
1. Find the auto-memory folder: `~/.claude/projects/<slug>/memory/`, where `<slug>` is the repo path with every non-letter/digit replaced by `-` (macOS/Linux: `git rev-parse --show-toplevel | sed 's/[^A-Za-z0-9]/-/g'`). If it does not exist, list `~/.claude/projects/` and pick the folder that matches this repo; on Windows it is under `%USERPROFILE%\.claude\projects\`.
2. For `MEMORY.md` and every topic file: lines, size, last-modified date. `MEMORY.md` is loaded every session but only the first 200 lines / 25 KB; it should be a short index (one line per memory).
3. Read each memory and classify it:
   - **stale**: mentions files, commands, branches or settings that no longer exist (check with `ls`/`grep`), or states as "open" something the code shows is done;
   - **contradicted**: conflicts with `CLAUDE.md` or `docs/decisions/` (the repo wins);
   - **duplicate**: says the same as another memory or as a rule;
   - **durable rule**: a project rule that every contributor needs; propose adding it in one line to `CLAUDE.md` (if it truly applies to every task) or to the matching `docs/decisions/` file (a repo change, so it needs a commit);
   - **keep**.
4. Instruction files: `wc -l CLAUDE.md` (it should stay a short, stable overview of ~50 lines) and `CLAUDE.local.md` if present (personal, git-ignored). Flag feature details, file paths or dated sections that crept into `CLAUDE.md`; they belong in `docs/decisions/` or `docs/README.md`.

### b. Local repository
Run from the repo root:
- `git status --short` and `git status --short --ignored` (summarise ignored items by folder; do not list `node_modules` contents).
- `git clean -nd` (dry run only: what untracked files and folders would go).
- Secret-file copies: list names matching `.env*`, `*.pem`, `*.key`, `*.bak`, `*backup*` outside `node_modules` (names and dates only). Flag every `.env` copy other than `.env` and `.env.example` as a candidate to delete.
- Secret files in git: `git ls-files | grep -E '(^|/)\.env|\.pem$|\.key$' | grep -v '\.env\.example$'` (should be empty) and `git log --all --oneline -- '.env' '.env.*' '*.pem' '*.key'` (names of commits only). Anything found: tell the user the secret must be considered leaked and rotated in Key Vault; removing it from history alone is not enough.
- Large files: tracked files over 1 MB (`git ls-files -z | xargs -0 du -k | sort -rn | head -15`) and untracked files over 5 MB (`find . -path ./node_modules -prune -o -type f -size +5M -print`).
- Branches: `git branch --merged main` (local branches already in `main`, except `main` itself), and branches whose upstream is gone (`git branch -vv | grep ': gone]'`).
- `git stash list` (with dates: `git stash list --date=relative`) and `git worktree list`.
- Local test database containers: `docker ps -a --filter label=nl.vu.leap.tool=local-db` (skip if Docker is not running). Clean-up route: `bash scripts/local-db/down.sh`.
- Generated output: sizes of `ui-audit-output/`, `db-backups/`, `dist/`.
- `node_modules`: `npm ls --depth=0` (missing or invalid packages mean `npm install` is due).

### c. Habits
- Unpushed or unmerged work: `git fetch --quiet` then `git log --oneline origin/main..main` (commits on local `main` that are not on GitHub) and `git log --oneline main..HEAD` on the current branch.
- Commits without tests: for the last 20 commits (`git log -20 --name-only --format='@%h %s'`), list those that changed `server/` or `src/` code but no file under `__tests__/`, `*.test.*` or `scripts/local-db/tests/`.
- Large, growing files: code files over 2000 lines (`git ls-files '*.js' '*.ts' '*.tsx' | grep -v node_modules | xargs wc -l | sort -rn | head -10`) and whether they grew in the last 30 days (`git log --since=30.days --numstat --format= -- <file>`, sum added minus removed).
- Very large commits in the last two weeks (more than ~30 files or ~1000 changed lines) that mix several features.

## Phase 2: report (in Dutch, short)

Write a report of at most ~40 lines with three headings: **Geheugen en instructies**, **Repository**, **Gewoontes**. Each finding on one numbered line: what you saw, what you suggest, and the risk of doing it (e.g. "kan niet ongedaan worden gemaakt"). Put nothing secret in it. End with:

> Welke acties zal ik uitvoeren? Noem de nummers, of "geen".

Then stop and wait.

## Phase 3: act only on confirmed numbers
- Memory: edit or delete only the confirmed memory files; keep `MEMORY.md` a one-line-per-entry index and update it in the same step. Moving something into `CLAUDE.md` or `docs/` is a repo change: show the diff and leave the commit to the user.
- Branches: `git branch -d <name>` (the safe form; if git refuses, report it instead of forcing).
- Stashes: `git stash drop stash@{n}` only for confirmed entries; show `git stash show --stat` first.
- Untracked files: delete exactly the confirmed paths (`rm <path>`), not `git clean -f`.
- Never delete `db-backups/` (database snapshots can contain student data): name the path and ask the user to check and remove it by hand. Never use globs with `rm`.
- Containers: `bash scripts/local-db/down.sh`.
- Afterwards, rerun the relevant checks and report in Dutch what changed.
