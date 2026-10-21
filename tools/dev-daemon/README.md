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

Inbox filenames sort lexically. A claimed task gets a unique ID and moves to `running/<id>.md`. Default branches are `dev-daemon/<id>`. Explicit branches must be valid, new Git branches; `main`, `master` and `HEAD` are rejected. Every task gets a fresh `worktrees/<id>` from fetched `origin/main` and its own `npm ci`. Worktrees and branches are retained for inspection; use `git worktree remove <path>` when no longer needed. A task renamed just before a crash is recovered from `running/` before inbox work.

## Stages and model IDs

IDs live in [models.json](models.json). `gpt-6-astra` and `gpt-6.1-sol` were found in the local Codex model cache; Sol was also user verified. `claude --help` advertises `fable`, `opus` and `sonnet`. The clearly named `opus55` slot uses `opus`, whose exact version is provider-controlled; pin a full ID there if necessary. GLM's `default` entry omits `--model` to use the Z.ai profile; an explicit ID is also supported. Discovery and offline tests make no inference calls.

| Stage | Fallback chain |
| --- | --- |
| Design | Fable medium → Astra 6 high → GLM → swe-2 |
| Design review | Opus 5.5 slot medium → Astra 6 high → GLM → swe-2 |
| Build | Sol 6.1 high → Sonnet high → GLM → swe-2 |
| Build review | Opus 5.5 slot medium → Sol 6.1 high → GLM → swe-2 |
| Review fix | Sol 6.1 high → Sonnet high → GLM → swe-2 |
| Re-review | Sonnet medium → Sol 6.1 high → GLM → swe-2 |
| Blueprint audit | Fable medium → Astra 6 high → GLM → swe-2 |

Designs are text saved in status. Design `CHANGES` triggers exactly one revision using the design chain. Build review is a separate read-only session. Reviews must return an unambiguous standalone `VERDICT: APPROVE` or `VERDICT: CHANGES`. Build `CHANGES` triggers at most two fix/re-review pairs; a missing/ambiguous verdict or remaining changes fails the task.

Designs, reviews and audits run read-only. Claude is restricted to Read/Grep/Glob, Codex uses its read-only sandbox, and Devin uses auto permissions plus read-only mounts of the repo, shared Git directory, queue and worktree. A before/after fingerprint also checks HEAD, tracked changes and untracked files. All invocations start fresh sessions. Claude's prompt precedes variadic tool flags. Child stdin is ignored, which opens `/dev/null` on Unix, including for Codex. Codex's final-answer file separates actual review verdicts from echoed prompts/tool transcripts.

Nonzero exits, empty responses and output containing usage/quota/429/`limit`/`resets` trigger fallback. Detection is conservative, including these words in otherwise successful output. If **all** choices report restrictions, status records `wakeAt` and this task pauses, blocking the next task. It resumes the same stage at the earliest future reset parsed. Unzoned Z.ai/GLM times are UTC+8; Claude times are Asia/Seoul (UTC+9); other providers default to UTC. Explicit ISO offsets, clock times, month-name dates, epochs, retry-after seconds and relative durations are supported. A past time-only reset means the next day. With no parseable reset, retry after 15 minutes. Mixed ordinary/restriction failures exhaust the stage and fail it.

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
| `worktrees/` | Independent Git worktrees |

New state/log files are private (0600), directories 0700. The console prints lifecycle messages only. Outputs, captured answers, summaries, reports and status redact sensitive environment values, credential assignments, bearer/basic auth, common token formats and credentials in URLs. Keep secrets out of task Markdown, which is retained as original input. Arbitrary unrecognized credentials cannot be inferred by redaction; models and CLIs use their configured credentials.

The confirmed merge counter and terminal stage are saved atomically. After every 10 daemon-confirmed merges, an audit runs in a fresh worktree before the next inbox task. It reads `/workspace/agamajung/TASK.md`, README and actual site structure, writes a Markdown report and returns a fenced JSON `{"fixes":[{"title":"...","task":"..."}]}` list. Up to 20 valid recommendations become deterministic inbox files. The audit answer is checkpointed before enqueueing, so restarting after partial enqueue is idempotent. Audits do not count as PRs. Exhausted/invalid audits are reported as failed and record the scheduled attempt to avoid infinite retries; the next audit is after the next 10 merges. Restriction pauses resume normally.

Stop PM2 before manually recovering work or editing state. Inspect `failed/<id>.summary.md` and `logs/<id>/`. Fix the cause and submit a new uniquely named task with a new branch; retained worktrees allow recovering useful edits. Invalid status JSON fails closed: restore a valid backup rather than deleting the durable counters/checkpoint. Normal restart resumes automatically. Re-running checks after interruption is intentional. A remotely created PR is looked up and reused after a restart.

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

`tests/dev-daemon-*.test.ts` use temporary queues and mocked model/Git/GitHub runners. They cover fallback chains, reset parsing, CLI arguments, ignored stdin, stream redaction, final-answer extraction, queue transitions, pause/restart, bounded review loops, check failures, publication gates, merge-count recovery and audit fix enqueueing. Only the lock test invokes local `flock`. No tests call models/network, push, publish, merge or start PM2.
