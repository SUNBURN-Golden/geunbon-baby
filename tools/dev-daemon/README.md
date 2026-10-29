# Box development daemon

Linux, Node.js 22+, TypeScript via the repo's existing `tsx`; no new npm dependencies. This daemon processes one task at a time for `SUNBURN-Golden/geunbon-baby`. The Next.js/Cloudflare site and Linux crawler remain separate systems. Starting it enables queued tasks to push task branches and create and squash-merge PRs into `main` after approval and successful checks. It never pushes directly to `main` or deploys.

## Run

Run `npm ci` first. The box needs authenticated `git`, `gh`, `codex`, `claude`, `/home/box/.local/bin/devin`, util-linux `flock`, and `bwrap` (Bubblewrap, for read-only Devin reviews). Configure Git author identity and GitHub push/PR/merge access beforehand. Keep credentials in existing profiles/environment, never task files or this repo. Claude uses `/home/box/.claude-fable`; GLM uses the normal Claude profile with `CLAUDE_CONFIG_DIR` removed.

```sh
npm run dev-daemon -- --help
# Foreground:
npm run dev-daemon
# Or explicitly start the single PM2 app:
pm2 start tools/dev-daemon/ecosystem.config.cjs
pm2 logs agamajung-dev-daemon
pm2 stop agamajung-dev-daemon
# Optional, after checking PM2's process list:
pm2 save
```

The ecosystem file uses the repo's existing Node 22 package as interpreter. The daemon prepends its interpreter directory to PATH for child processes. PM2 starts one fork; a kernel `flock` excludes any other daemon using the queue. Locks release automatically on exit/crash. Leave `daemon.lock` in place: deleting a live lock file breaks exclusion. SIGINT/SIGTERM stop the active process group and preserve the stage checkpoint for restart. Each subprocess has a default 45 minute timeout; a timeout/nonzero exit enters the next fallback. An interrupted write stage can leave edits; the replacement inspects and continues them in the same worktree.

## Add a task

Submit a unique Markdown filename. Optional front matter supports only scalar `title` and `branch` strings, not general YAML. Double quoted values support JSON escapes; plain and single quoted values are literal. Include the component, requested behavior, acceptance criteria and verification. Submit atomically to avoid claiming a half-written file:

```sh
mkdir -p /workspace/agamajung/dev-queue/inbox
cat > /workspace/agamajung/dev-queue/001-model-page.tmp <<'TASK'
---
title: Improve the model page empty state
branch: dev-daemon/model-empty-state
---
Improve the site's missing-price message. Keep missing prices as 정보 없음
and preserve source/verification details. Do not change the crawler.
Verify the rendered state and run the existing checks.
TASK
mv /workspace/agamajung/dev-queue/001-model-page.tmp /workspace/agamajung/dev-queue/inbox/001-model-page.md
```

Inbox filenames sort lexically. A claimed task gets a unique ID and moves to `running/<id>.md`. Default branches are `dev-daemon/<id>`. Explicit branches must be valid, new Git branches; `main`, `master` and `HEAD` are rejected. Every task gets a fresh `worktrees/<id>` from fetched `origin/main` and its own `npm ci --include=dev`, so validation tools are installed even under `NODE_ENV=production`. When the active task reaches `done` or `failed`, the daemon validates its worktree, removes it with `git worktree remove --force`, checks prune scope, and runs `git worktree prune --expire now` before archiving. **Failed tasks also lose uncommitted edits, untracked/ignored files and `node_modules`.** Branches, original task Markdown, summaries, logs and audit reports are retained. A task renamed just before a crash is recovered from `running/` before inbox work.

## Stages and model IDs

IDs live in [models.json](models.json). `gpt-6-astra` and `gpt-6.1-sol` were found in the local Codex model cache; Sol was also user verified. `claude --help` advertises `fable`, `opus` and `sonnet`. The clearly named `opus55` slot uses `opus`, whose exact version is provider-controlled; pin a full ID there if necessary. GLM's `default` entry omits `--model` to use the Z.ai profile; an explicit ID is also supported. Discovery and offline tests make no inference calls.

| Stage | Fallback chain |
| --- | --- |
| Design / Design revise | Opus 5.5 slot medium → Astra 6 high → GLM → swe-2 |
| Design review | Astra 6 high → Opus 5.5 slot medium → GLM → swe-2 |
| Build | Sol 6.1 high → Sonnet high → GLM → swe-2 |
| Build review | GLM → Sonnet medium → Sol 6.1 high → swe-2 |
| Review fix | Sol 6.1 high → Sonnet high → GLM → swe-2 |
| Re-review | GLM → Sol 6.1 high → Sonnet medium → swe-2 |
| Blueprint audit | Fable medium → Astra 6 high → GLM → swe-2 |

Designs are text saved in status. Design `CHANGES` triggers exactly one revision using the design chain. Build review is a separate read-only session. Reviews must return an unambiguous standalone `VERDICT: APPROVE` or `VERDICT: CHANGES`. Build `CHANGES` triggers at most two fix/re-review pairs; a missing/ambiguous verdict or remaining changes fails the task.

Designs, reviews and audits run read-only. Claude is restricted to Read/Grep/Glob, Codex uses its read-only sandbox, and Devin uses auto permissions plus read-only mounts of the repo, shared Git directory, queue and worktree. A before/after fingerprint also checks HEAD, tracked changes and untracked files. All invocations start fresh sessions. Codex's final-answer file separates actual review verdicts from echoed prompts/tool transcripts.

Prompts never enter argv or environment variables, even for short tasks:

| Provider | Input |
| --- | --- |
| Claude / GLM | `-p` with the complete UTF-8 prompt on stdin |
| Codex | `exec … -` with the complete UTF-8 prompt on stdin |
| Devin | `-p --prompt-file <path>` |

The runner pipes stdin only for input commands, flushes the body with backpressure support, and sends EOF. Other commands retain ignored stdin (`/dev/null`). Failed writes/early closure fail the invocation while retaining stderr for quota detection and fallback; every fallback receives a fresh, complete prompt. Input bodies are not separately logged. Devin prompt files live under the OS temporary directory (`dev-daemon-prompt-*/prompt.txt`), visible through the existing bwrap root bind mount, with directory mode 0700 and file mode 0600. They are removed in `finally` on success, failure, timeout and normal daemon interruption. SIGKILL, machine failure or a crash can leave these private files behind; after stopping the daemon, remove stale directories owned by its user.

Build review and re-review share a context builder comparing `origin/main` with the current worktree, including staged, unstaged and untracked paths. NUL-delimited Git records and literal pathspecs preserve spaces, newlines, Korean and pathspec metacharacters. Renames are represented as deletion/addition. Images under `public/img/` (SVG, PNG, JPEG, GIF, WebP, AVIF, BMP, ICO, TIFF, APNG) are excluded **before patch generation** and summarized by quoted path, status, bytes, hash and lines. Current files use SHA-256; deleted files use the baseline Git blob ID and size. SVG line counts include a final unterminated line (deletions use Git's removed-line count); binary image lines are `n/a`. Symlinks are described without reading their target. Untracked code paths remain available for direct inspection.

The complete review context, including headings, paths, summaries and omission notices, is capped at **256 KiB of UTF-8**. Ordinary code patches get priority; bounded Git stdout collection keeps consuming discarded bytes without logging them or hiding stderr/nonzero exits. Large single lines are truncated on UTF-8 boundaries. Omission notices tell reviewers to inspect remaining diffs/files directly. Other commands retain the existing 16 MiB output limit. This context limit does not change the full-content fingerprint that detects asset edits and protects approval/validation.

Nonzero exits and empty final answers trigger fallback. A zero exit with a final answer succeeds even when the answer discusses limits. Restriction detection and reset parsing use provider diagnostics: stderr and recognized error lines on stdout (such as `You've hit your`, HTTP 429, usage/rate limits, quota and resets), excluding echoed prompt text. If **all** choices report restrictions, status records `wakeAt` and this task pauses, blocking the next task. It resumes the same stage at the earliest future reset parsed from diagnostics. Unzoned Z.ai/GLM times are UTC+8; Claude times are Asia/Seoul (UTC+9); other providers default to UTC. Explicit ISO offsets, clock times, month-name dates, epochs, retry-after seconds and relative durations are supported. A past time-only reset means the next day. With no parseable reset, retry after 15 minutes. Mixed ordinary/restriction failures exhaust the stage and fail it.

After final approval, the daemon runs `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, stages/commits, pushes the task branch, creates a PR to `main` and runs `gh pr merge --squash --match-head-commit ...`. Content changes after approval or during checks fail the task. The validated Git tree and parent are checkpointed before committing, allowing restart to reuse a completed commit. Commit hooks are disabled so they cannot change tested content. Publication checks the branch, validated HEAD, clean worktree, PR head and main base. GitHub rules/failed merges fail the task with a log reference. Restart after a remote merge recognizes the merged PR and counts it once.

## State, logs, audits and recovery

All state defaults to `/workspace/agamajung/dev-queue/`, outside the site/crawler repository:

| Path | Contents |
| --- | --- |
| `inbox/*.md` | Pending tasks |
| `running/*.md` | Active task, including a paused task |
| `done/`, `failed/` | Original task Markdown and summary |
| `status.json` | Atomic checkpoint: stage, outputs, retry time, PR, merge counter, audit checkpoint |
| `logs/<task>/` | Every subprocess attempt, validation and publication output |
| `audits/` | Blueprint audit reports |
| `worktrees/` | Active task/audit worktree; removed before terminal archival |

New state/log files are private (0600), directories 0700. The console prints lifecycle messages only. Outputs, captured answers, summaries, reports and status redact sensitive environment values, credential assignments, bearer/basic auth, common token formats and credentials in URLs. Keep secrets out of task Markdown, which is retained as original input. Arbitrary unrecognized credentials cannot be inferred by redaction; models and CLIs use their configured credentials.

The confirmed merge counter and terminal stage are saved atomically. After every 10 daemon-confirmed merges, an audit runs in a fresh worktree before the next inbox task. It reads `/workspace/agamajung/TASK.md`, README and actual site structure, writes a Markdown report and returns a fenced JSON `{"fixes":[{"title":"...","task":"..."}]}` list. Up to 20 valid recommendations become deterministic inbox files. The audit answer is checkpointed before enqueueing, so restarting after partial enqueue is idempotent. Audits do not count as PRs. Exhausted/invalid audits are reported as failed and record the scheduled attempt to avoid infinite retries; the next audit is after the next 10 merges. Restriction pauses resume normally.

Cleanup runs only for the active terminal task (including audits), under the existing queue lock. Running/quota-paused worktrees and historical worktrees are never swept. The saved path must be exactly `<queue>/worktrees/<single-component-task-id>`. Symlink paths/ancestors, path escapes, the configured repository, Git's main worktree, the shared Git directory, the daemon's current directory and their enclosing directories are protected. An existing directory must be an exactly registered linked worktree in the same repository; an unregistered directory or uncertain ownership is preserved.

Before **any** remove/prune command, including prune dry-run, cleanup reads the entire NUL-delimited Git worktree list. Another registration inside the target or resolving to the same physical location blocks cleanup, even if it is locked or its directory is missing. `worktrees/A/B` blocks removal of A; the sibling `worktrees/AB` does not. Paths and the full list are checked again immediately before removal. Prune dry-runs with the same `--expire now` condition are checked before removal and again immediately before actual prune: every reported admin directory must map to this task's exact registered path, or the operation stops. No unrelated registration may be pruned, and uncertain output/metadata fails closed. Cleanup never unlocks a worktree with a second `--force` or falls back to recursive filesystem deletion.

Cleanup failure or interruption stops the daemon **before `Queue.finish()`**, leaving the terminal stage, original result, merge counter and audit checkpoint in `status.json`. Diagnostics use the existing private, redacted task logs. Restart retries cleanup without re-running the merge/audit. An already absent directory and registration are accepted after safety checks; an absent directory with stale registration is recovered using scoped prune. Archival occurs only after both are absent. Restart also resumes an interrupted archival if the original task Markdown has already moved.

Stop PM2 before manually recovering work or editing state. Inspect `status.json`, `logs/<id>/` and, once archived, `failed/<id>.summary.md`. If cleanup is blocked, stop the daemon and recover needed edits before resolving the unsafe path, nested registration, locked worktree or unrelated prune candidate. After successful cleanup, useful committed work remains on the task branch; submit a new uniquely named task with a new branch to continue it. The queue lock excludes other daemons, but external Git operations do not honor it: do not register, move or prune worktrees concurrently with the daemon. Rechecks cannot make Git's separate list/remove/prune commands atomic. Invalid status JSON fails closed: restore a valid backup rather than deleting the durable counters/checkpoint. Normal restart resumes automatically. Re-running checks after interruption is intentional. A remotely created PR is looked up and reused after a restart.

| Environment variable | Default |
| --- | --- |
| `DEV_DAEMON_QUEUE` | `/workspace/agamajung/dev-queue` |
| `DEV_DAEMON_REPO` | Repo containing this daemon |
| `DEV_DAEMON_BLUEPRINT` | `/workspace/agamajung/TASK.md` |
| `DEV_DAEMON_MODELS` | Adjacent `models.json` |
| `DEV_DAEMON_TIMEOUT_MS` | `2700000` |
| `DEV_DAEMON_UNKNOWN_RESET_MS` | `900000` |

`npm run dev-daemon -- --once` processes one task, exits when idle, or exits after saving a quota pause. It has the same publication behavior as continuous mode; it is not a dry run.

## Offline verification

```sh
npm run lint
npm run typecheck
npm test
npm run build
```

`tests/dev-daemon-*.test.ts` use temporary queues and mocked model/Git/GitHub runners. They cover fallback chains, reset parsing, CLI arguments, stdin/file input, stream redaction, final-answer extraction, queue transitions, pause/restart, bounded review loops, check failures, publication gates, merge-count recovery and audit fix enqueueing. `tests/dev-daemon-worktrees.test.ts` also creates temporary local Git repositories to check dirty/ignored file removal, preserved branches/artifacts/siblings, terminal task/audit archival, path and ownership protection, nested registrations (present/locked/missing), prune scope, cleanup failures and restart after removal or partial archival. These fixtures create only local test commits/worktrees and never use the live queue. The lock test invokes local `flock`. No tests call models/network, push, publish, merge or start PM2.

`tests/dev-daemon-subprocess.test.ts` uses local Node children to verify 400 KiB ASCII/Unicode prompts by byte count and SHA-256 through stdin and files, EOF, early closure/EPIPE, spawn errors, timeout/interruption, file permissions/cleanup and bounded stdout collection. `tests/dev-daemon-review-context.test.ts` uses temporary local Git repositories to verify image exclusion and summaries, staged/unstaged/untracked changes, deletions, renames, unusual paths, symlinks and UTF-8 budgets. Run daemon tests first with `npx vitest run tests/dev-daemon-*.test.ts`, then the checks above.

## Site design rules (owner approval, 2026-10-26)

Follow [the current design decision](../../docs/design-decisions.md) for the ledger/index-binder redesign: site-specific light/dark backgrounds, Prussian ink, vermilion stamp and self-hosted Gowun Batang/Spoqa fonts. Historical ivory/terracotta, no-new-colours, system-font, light-only and home-colour-only instructions are superseded for this approved redesign; keep their history in the decision record. Preserve Korean copy pending Argon (except the approved headline), real data, accessibility and the `/models` no-date/no-discount-badge rules. Never modify `crawler/` as part of the redesign.
