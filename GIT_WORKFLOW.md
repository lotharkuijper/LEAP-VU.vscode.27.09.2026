# LEAP-VU Git workflow

This project has two GitHub references:

- `origin`: the active working repo for the new version, `LEAP-VU.vscode.16.09.2026`
- `oldorigin`: the rollback backup repo, `LEAP-VU-VSCode.09.09.2026`

## Branch model

- `main`: the current working branch for the newest direction
- `backup/09-09-2026`: local safety branch pointing to the old GitHub state
- `experiment/<short-name>`: for trying one isolated idea at a time

Example names:

- `experiment/ai-chat-ui`
- `experiment/prompt-polish`
- `experiment/course-overview-fix`

## Safeguards

- Never commit `.env` files
- Keep each experiment in its own branch
- Commit small steps with clear messages
- Before big changes, make a branch
- Use the old repo as a rollback source when unsure
- Run `git status` before and after each working session

## Useful commands

```bash
git status
git branch -avv
git remote -v
git log --oneline --decorate --graph --all
```

## Quick rollback commands

Return to the current working branch:

```bash
git switch main
```

Jump to the old backup state:

```bash
git switch backup/09-09-2026
```

Reset local repo to the old GitHub state:

```bash
git reset --hard oldorigin/main
```

Restore a single file from the old repo:

```bash
git checkout oldorigin/main -- path/to/file
```

## Experiment tracking template

Use this for every experiment:

- Experiment: <name>
- Branch: `experiment/<name>`
- Goal: <what you want to test>
- Expected result: <what you think will happen>
- Actual result: <what happened>
- Keep or discard: <decision>
- Safety note: <rollback state or backup used>

## Example

- Experiment: AI chat layout test
- Branch: `experiment/ai-chat-layout`
- Goal: test a new chat shell layout
- Expected result: cleaner layout and faster reading
- Actual result: layout looked better but broke mobile responsiveness
- Keep or discard: discard and keep old layout
- Safety note: restored from `backup/09-09-2026`

This gives you a simple, repeatable rhythm for experimenting without losing the working baseline.
