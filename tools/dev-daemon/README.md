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

Inbox filenames sort lexically. A claimed task gets a unique ID and moves to `running/<id>.md`. Default branches are `dev-daemon/<id>`. Explicit branches must be valid Git branch names; `main`, `master` and `HEAD` are rejected. Existing local branch names are handled by the preparation rules below. Every new worktree starts from fetched `origin/main` and gets its own `npm ci --include=dev`, so validation tools are installed even under `NODE_ENV=production`. Terminal `done` and `failed` tasks are finalized before quota wake times are checked. The daemon attempts guarded cleanup (`git worktree remove --force` and scoped `git worktree prune --expire now`) and checkpoints its outcome before archival. **Successful cleanup of failed tasks also removes uncommitted edits, untracked/ignored files and `node_modules`.** An ordinary cleanup failure instead records ‘cleanup incomplete’, a scrubbed reason, diagnostic log and inspection path; the original result is archived and the daemon continues to audit/inbox scheduling. Cleanup may already have removed part of the worktree or its registration. Deferred worktrees are retained for owner inspection and never automatically swept. Branches, original task Markdown, summaries, logs and audit reports are retained. A task renamed just before a crash is recovered from `running/` before inbox work.

## Worktree preparation and existing branches

An existing task worktree resumes after shared Git directory and current branch checks. This path performs no preparation PR lookup or stale rename, and retains interrupted edits. For a new worktree, preparation validates the branch name and reads `git worktree list --porcelain -z`. Any registration using the exact `refs/heads/<branch>` blocks preparation, including the main worktree, locked worktrees and registrations whose directories are missing. The summary identifies the branch and quoted worktree path. Preparation does not unlock, remove or prune those registrations.

Local branch existence is determined by exact ref comparison in successful `git for-each-ref` output. If the branch is absent, preparation never invokes `gh`. If it exists and no worktree uses it, preparation runs the read-only `gh pr list --repo SUNBURN-Golden/geunbon-baby --head <branch> --state open --json number,url,headRefName,baseRefName` lookup. An open PR to **any base branch** blocks preparation; its number and URL appear in the summary. Lookup errors, invalid JSON, missing fields or mismatched results fail with `open PR lookup failed; branch unchanged; see task logs`. Git inspection failures also stop preparation before rename/add.

After these checks, preparation fetches `origin/main` and resolves its commit. Fetch/resolution failure leaves the old branch intact. An existing unused branch without an open PR is renamed with `git branch -m <branch> <branch>-stale-<UTC timestamp>`, for example `dev-daemon/example-stale-20261031T123456789Z`. Timestamp collisions advance by one millisecond, up to 100 candidates; existing preservation refs are never overwritten. Immediately before rename, preparation rechecks worktree usage, the original ref/commit and open PR absence. It verifies the preserved commit and records the original name, preservation name and commit in the existing private, redacted task logs.

The fresh branch/worktree is created with `git worktree add -b <branch> <path> <resolved-main-commit>`. Worktree usage and branch absence are checked again immediately before creation. A branch appearing after the initial absence check causes failure; it is never renamed without PR checks. If creation fails after rename, the summary identifies the preserved branch, which remains available for recovery. No branch is deleted, force-renamed or force-pushed. Remote branch collisions retain the existing ordinary push failure policy.

Preparation runs under the queue lock. External Git operations and GitHub PR creation cannot be locked atomically with it: do not modify worktrees/refs or open PRs for these branches concurrently. Rechecks reduce races but cannot eliminate them. Interruption after rename resumes through the absent-branch path and keeps the stale ref. Interruption after successful worktree creation resumes the existing worktree. If a failed add left just the original branch name, preparation applies all existing-branch checks on restart. A task already checkpointed as `failed` only finalizes; it is not automatically rerun. Preparation errors retain the original failure summary. Blocked cleanup is checkpointed separately, then `Queue.finish()` archives the task with a reason note while preserving protected or nested worktrees and their edits. Once the cleanup outcome is checkpointed, archival retries do not attempt cleanup again.

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

Designs are text saved in status. Design `CHANGES` triggers exactly one revision using the design chain. Build review is a separate read-only session. Reviews require an explicit uppercase `VERDICT: APPROVE` or `VERDICT: CHANGES` as the final nonblank answer line. Only the decision token may have paired `*`, `**` or a single backtick code span. Whole-line wrapping, trailing prose, alternatives and malformed top-level declarations are rejected; fenced, quoted and indented code is never a decision. Earlier eligible decisions must agree (identical repetitions are accepted). CRLF and ANSI colors are normalized without removing Markdown context. An original valid build `CHANGES` triggers at most two fix/re-review pairs; remaining changes fail the task.

Designs, reviews and audits run read-only. Claude is restricted to Read/Grep/Glob, Codex uses its read-only sandbox, and Devin uses auto permissions plus read-only mounts of the repo, shared Git directory, queue and worktree. A before/after fingerprint also checks HEAD, tracked changes and untracked files. All invocations start fresh sessions. Codex's final-answer file separates actual review verdicts from echoed prompts/tool transcripts; missing/empty files never use transcript verdicts. Print-mode reviews prefer a valid stdout verdict, then permit combined stdout/stderr answers for Devin compatibility. Conflicting decisions or malformed declarations in either stream require clarification. Recognizable prompt echoes and provider diagnostics are excluded from answers; diagnostics and both redacted streams remain available independently (`.log.stdout` and `.log.stderr` artifacts for print-mode invocations, plus the merged `.log`). Selected answer sources are checkpointed with attempts and included in archive summaries. Historical merged fixtures explicitly retain stream-unknown provenance.

Prompts never enter argv or environment variables, even for short tasks:

| Provider | Input |
| --- | --- |
| Claude / GLM | `-p` with the complete UTF-8 prompt on stdin |
| Codex | `exec … -` with the complete UTF-8 prompt on stdin |
| Devin | `-p --prompt-file <path>` |

The runner pipes stdin only for input commands, flushes the body with backpressure support, and sends EOF. Other commands retain ignored stdin (`/dev/null`). Failed writes/early closure fail the invocation while retaining stderr for quota detection and fallback; every fallback receives a fresh, complete prompt. Input bodies are not separately logged. Devin prompt files live under the OS temporary directory (`dev-daemon-prompt-*/prompt.txt`), visible through the existing bwrap root bind mount, with directory mode 0700 and file mode 0600. They are removed in `finally` on success, failure, timeout and normal daemon interruption. SIGKILL, machine failure or a crash can leave these private files behind; after stopping the daemon, remove stale directories owned by its user.

Build review and re-review share a context builder comparing `origin/main` with the current worktree, including staged, unstaged and untracked paths. NUL-delimited Git records and literal pathspecs preserve spaces, newlines, Korean and pathspec metacharacters. Renames are represented as deletion/addition. Images under `public/img/` (SVG, PNG, JPEG, GIF, WebP, AVIF, BMP, ICO, TIFF, APNG) are excluded **before patch generation** and summarized by quoted path, status, bytes, hash and lines. Current files use SHA-256; deleted files use the baseline Git blob ID and size. SVG line counts include a final unterminated line (deletions use Git's removed-line count); binary image lines are `n/a`. Symlinks are described without reading their target. Untracked code paths remain available for direct inspection.

The complete review context, including headings, paths, summaries and omission notices, is capped at **256 KiB of UTF-8**. Ordinary code patches get priority; bounded Git stdout collection keeps consuming discarded bytes without logging them or hiding stderr/nonzero exits. Large single lines are truncated on UTF-8 boundaries. Omission notices tell reviewers to inspect remaining diffs/files directly. Other commands retain the existing 16 MiB output limit. This context limit does not change the full-content fingerprint that detects asset edits and protects approval/validation.

Non-review generation retains its existing nonzero/empty-answer fallback behavior. Design review, build review and re-review validate verdicts inside the configured fallback chain. Provider restrictions take precedence even over a code-zero partial or complete answer and immediately advance to the next model. Other nonzero exits also advance. A successful invocation with a missing/ambiguous verdict receives one clarification from the same model and effort, under the same read-only protections. Fresh-session clarification includes the complete original review context and the original response as delimited JSON data, and requests exactly one verdict line. Approval requires completed inspection with no unresolved blockers; incomplete inspection, blocking tool restrictions or unresolved blockers require CHANGES. Restricted, unsuccessful or still-ambiguous clarification advances to the next model. **Clarification-only CHANGES fails the review as incomplete**, retaining both responses for inspection; it neither consumes a revision round nor asks another reviewer for approval. A valid original CHANGES retains the normal revision flow. Decisions are returned separately from original review text, never parsed from concatenated responses. Exhaustion names attempted models and failure categories. Restriction detection and reset parsing use recognized provider diagnostic lines on stderr/stdout (such as `You've hit your`, HTTP 429, usage/rate limits, quota and resets), excluding echoed prompt text. If **all** choices report restrictions, status records `wakeAt` and this task pauses, blocking the next task. It resumes the same stage at the earliest future reset parsed from diagnostics. Unzoned Z.ai/GLM times are UTC+8; Claude times are Asia/Seoul (UTC+9); other providers default to UTC. Explicit ISO offsets, clock times, month-name dates, epochs, retry-after seconds and relative durations are supported. A past time-only reset means the next day. With no parseable reset, retry after 15 minutes. Mixed ordinary/restriction failures exhaust the stage and fail it. Quota classification belongs to each original invocation: an unrestricted malformed original with a restricted clarification remains an ordinary failure, so mixed chains never pause. Review progress is keyed by task, stage, round, full-content fingerprint, complete review-context digest and configured choices. Model position, original outcome, clarification issuance, result and distinct log IDs are checkpointed before launch and before transition. Restart reuses durable results; an issued invocation without a durable result is interrupted and cannot be reissued. An issued clarification remains consumed. Changed content/context invalidates cached approval. Only all-original-quota wakeups start another invocation cycle; ambiguity never resets the clarification budget.

After final approval, the daemon runs `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, stages/commits, pushes the task branch, creates a PR to `main` and runs `gh pr merge --squash --match-head-commit ...`. Content changes after approval or during checks fail the task. The validated Git tree and parent are checkpointed before committing, allowing restart to reuse a completed commit. Commit hooks are disabled so they cannot change tested content. Publication checks the branch, validated HEAD, clean worktree, PR head and main base. GitHub rules/failed merges fail the task with a log reference. Restart after a remote merge recognizes the merged PR and counts it once.

## State, logs, audits and recovery

All state defaults to `/workspace/agamajung/dev-queue/`, outside the site/crawler repository:

| Path | Contents |
| --- | --- |
| `inbox/*.md` | Pending tasks |
| `running/*.md` | Active task, including a paused task |
| `done/`, `failed/` | Original task Markdown and summary |
| `status.json` | Atomic checkpoint: stage, outputs, review attempts, cleanup outcome, finalization intent, retry time, PR, merge counter, audit checkpoint |
| `logs/<task>/` | Every subprocess attempt, validation and publication output |
| `audits/` | Blueprint audit reports |
| `worktrees/` | Active task/audit worktree; cleanup attempted at finalization, unsafe/incomplete cleanup deferred for owner inspection |

New state/log files are private (0600), directories 0700. The console prints lifecycle messages only. Outputs, captured answers, summaries, reports and status redact sensitive environment values, credential assignments, bearer/basic auth, common token formats and credentials in URLs. Keep secrets out of task Markdown, which is retained as original input. Arbitrary unrecognized credentials cannot be inferred by redaction; models and CLIs use their configured credentials.

The confirmed merge counter and terminal stage are saved atomically. After every 10 daemon-confirmed merges, an audit runs in a fresh worktree before the next inbox task. It reads `/workspace/agamajung/TASK.md`, README and actual site structure, writes a Markdown report and returns a fenced JSON `{"fixes":[{"title":"...","task":"..."}]}` list. Up to 20 valid recommendations become deterministic inbox files. The audit answer is checkpointed before enqueueing, so restarting after partial enqueue is idempotent. Audits do not count as PRs. Exhausted/invalid audits are reported as failed and record the scheduled attempt to avoid infinite retries; the next audit is after the next 10 merges. Restriction pauses resume normally.

Cleanup runs only for the active terminal task (including audits), under the existing queue lock. Running/quota-paused worktrees and historical worktrees are never swept. The saved path must be exactly `<queue>/worktrees/<single-component-task-id>`. Symlink paths/ancestors, path escapes, the configured repository, Git's main worktree, the shared Git directory, the daemon's current directory and their enclosing directories are protected. An existing directory must be an exactly registered linked worktree in the same repository; an unregistered directory or uncertain ownership is preserved.

Before **any** remove/prune command, including prune dry-run, cleanup reads the entire NUL-delimited Git worktree list. Another registration inside the target or resolving to the same physical location blocks cleanup, even if it is locked or its directory is missing. `worktrees/A/B` blocks removal of A; the sibling `worktrees/AB` does not. Paths and the full list are checked again immediately before removal. Prune dry-runs with the same `--expire now` condition are checked before removal and again immediately before actual prune: every reported admin directory must map to this task's exact registered path, or the operation stops. No unrelated registration may be pruned, and uncertain output/metadata fails closed. Cleanup never unlocks a worktree with a second `--force` or falls back to recursive filesystem deletion.

Ordinary cleanup failure does not stop the daemon or change success/failure, merge counters or audit scheduling. The checkpoint and frozen archive summary retain the original result plus ‘cleanup incomplete’, its scrubbed reason, diagnostic reference and directory/registration inspection path. SIGINT/SIGTERM (`Daemon stopping`) propagates as interruption and leaves cleanup resumable. If interrupted before the outcome checkpoint, restart reruns the same idempotent safety checks. Already absent directories/registrations are accepted; stale registrations are pruned only within existing scope protections. Once recorded, deferred cleanup is never retried by archival.

`Queue.finish()` inspects source, archive and summary before mutation and persists a finalization intent (destination, original task SHA-256 and frozen scrubbed summary) while retaining the terminal active task. Completed summary bytes are published atomically through an exclusive hard link; original task movement uses link-then-unlink, never an overwriting rename. Affected directories and checkpoint files are synchronized. The copied checkpoint removes `active` only after archival completes, and in-memory state changes only after the checkpoint write succeeds. Matching summaries and archived files are reused, including recovery with both task names present or with only the archive present. Old version-1 terminal checkpoints acquire optional intent metadata; legacy partial archives must validate task identity against the checkpoint or fail closed. Conflicting contents, unexpected file types and missing source plus missing archive are preserved and reported.

Archival I/O errors or conflicts keep the terminal active task and block claiming another inbox item. Continuous mode retries within the process after a bounded delay (30 seconds maximum), even when writing the diagnostic log also fails. Conflicts require owner inspection; nothing is overwritten automatically. Cleanup/archival never repeats publication, increments counters or schedules an audit twice.

Stop PM2 before manually recovering work or editing state. Inspect `status.json`, `logs/<id>/` and, once archived, `failed/<id>.summary.md`. For archived deferred cleanup, inspect the summary/log and saved path; parts may already have been removed. Recover needed edits before manually resolving unsafe paths, nested registrations, locked worktrees or unrelated prune candidates. Historical and deferred worktrees are never swept. For an archival conflict, compare the source, destination, summary and persisted digest/intent with the daemon stopped; preserve evidence and resolve the identity conflict manually before restart. Do not delete status to bypass conflicts or full storage. After successful cleanup, useful committed work remains on the task branch; submit a new uniquely named task with a new branch to continue it. The queue lock excludes other daemons, but external Git operations do not honor it: do not register, move or prune worktrees concurrently with the daemon. Rechecks cannot make Git's separate list/remove/prune commands atomic. Invalid status JSON fails closed: restore a valid backup rather than deleting the durable counters/checkpoint. Normal restart resumes automatically. Re-running checks after interruption is intentional. A remotely created PR is looked up and reused after a restart.

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
npx vitest run --config tools/dev-daemon/vitest.config.ts
npx vitest run tests/dev-daemon-*.test.ts
npm run lint
npm run typecheck
npm test
npm run build
```

The separate configuration above is **required** when validating preparation changes: root `npm test` collects only `tests/**/*.test.ts` and does not include `tools/dev-daemon/prepare-worktree.test.ts`. The new suite uses temporary local origin/clone repositories and real Git commands, with `gh`, npm and model calls mocked, and shares `tests/setup.ts` network blocking. It covers absent branches (no preparation `gh`), unique stale commit preservation, occupied/locked/missing/main worktrees, PRs to any base, lookup/parsing/Git/fetch failures, stale-name collisions/exhaustion, state changes before rename/add, failed creation, interruption/restart, existing worktree ownership, audits, redacted logs/summaries and failed checkpoint/archival behavior. It never touches the live repository or queue and adds no dependencies.

`tests/dev-daemon-*.test.ts` use temporary queues and mocked model/Git/GitHub runners. They cover fallback chains, reset parsing, CLI arguments, stdin/file input, stream redaction, final-answer extraction, queue transitions, pause/restart, bounded review loops, check failures, publication gates, merge-count recovery and audit fix enqueueing. `tests/dev-daemon-worktrees.test.ts` also creates temporary local Git repositories to check dirty/ignored file removal, preserved branches/artifacts/siblings, terminal task/audit archival, path and ownership protection, nested registrations (present/locked/missing), prune scope, cleanup failures and restart after removal or partial archival. These fixtures create only local test commits/worktrees and never use the live queue. The lock test invokes local `flock`. No tests call models/network, push, publish, merge or start PM2.

`tests/dev-daemon-subprocess.test.ts` uses local Node children to verify 400 KiB ASCII/Unicode prompts by byte count and SHA-256 through stdin and files, EOF, early closure/EPIPE, spawn errors, timeout/interruption, file permissions/cleanup and bounded stdout collection. `tests/dev-daemon-review-context.test.ts` uses temporary local Git repositories to verify image exclusion and summaries, staged/unstaged/untracked changes, deletions, renames, unusual paths, symlinks and UTF-8 budgets. Run daemon tests first with `npx vitest run tests/dev-daemon-*.test.ts`, then the checks above.

## Rollout acceptance (owner managed)

Offline tests never access the live queue or invoke live models/publication commands. Saved sanitized real reviewer fixtures live in `tests/fixtures/dev-daemon/reviews/`, with source filenames, answer boundaries and known/unknown stream provenance. Synthetic Markdown and stream-placement cases are labeled separately in tests.

After the owner rolls out and intentionally restarts PM2, record only the app PID, uptime and restart count (avoid dumping environment or full PM2 JSON). Observe at least 30 minutes and multiple task transitions. Require an unchanged restart count, exactly-once failed-task archival with reason notes and subsequent inbox progress. Inspect review decisions and selected answer sources as well: complete Codex and print-mode reviews must be accepted and advance through unchanged validation/publication gates. A flat restart count achieved by failing every review does not meet acceptance. This runtime observation is separate from offline verification; do not run the production daemon from a task worktree.
