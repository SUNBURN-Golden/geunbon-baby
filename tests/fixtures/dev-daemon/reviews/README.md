These are saved real reviewer answers, not live provider probes. `manifest.json`
records original log filenames, provider, answer boundary, stream provenance,
sanitization, and expected parser outcome. Codex answers were extracted after the
last `--- final answer ---` marker. Its empty answers retain recognized quota
diagnostics separately; diagnostic stream placement is unknown. Print-mode logs
were historically merged, so their stream remains **unknown**. They establish
answer/parser compatibility, not stdout/stderr placement.

Environment values and credential patterns were scrubbed. Worktree roots were
replaced with `/saved/worktrees/`; Codex tool transcripts were omitted. No task,
provider, model or publication settings were changed to obtain these fixtures.
Synthetic formatting and stream-placement cases are separately labeled in the
fallback and runner tests. Offline tests only read the saved fixtures.
