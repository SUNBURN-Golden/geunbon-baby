// Read-only command dispatch precedes the runner/runtime-store import and never opens SQLite.
const command = process.argv[2] ?? 'dry-run';
try {
  if (command === 'weekly-review') {
    const { stateDir } = await import('../src/deepseek-web/config.ts');
    const { weeklyReview, formatWeeklyReview, validateWeeklyArguments } = await import('../src/deepseek-web/weekly-review.ts');
    const args = process.argv.slice(3);
    validateWeeklyArguments(args);
    const packet = await weeklyReview(stateDir());
    console.log(args.includes('--json') ? JSON.stringify(packet, null, 2) : formatWeeklyReview(packet));
    process.exitCode = 0;
  } else if (command === 'status') {
    const { stateDir } = await import('../src/deepseek-web/config.ts');
    const { heartbeatStatus, printStatus } = await import('../src/deepseek-web/heartbeat.ts');
    const status = await heartbeatStatus(stateDir());
    printStatus(status, process.argv.includes('--json'));
    process.exitCode = status.exit_code;
  } else {
    const { deepSeekWebCli } = await import('../src/deepseek-web/cli.ts');
    const report = await deepSeekWebCli([command, ...process.argv.slice(3)]);
    if (report) console.log(JSON.stringify(report, null, 2));
  }
} catch (err) {
  if (err instanceof Error && ['weekly_review_invalid_arguments', 'weekly_review_unavailable'].includes(err.message)) {
    console.error(err.message);
    process.exitCode = 2;
  } else {
    // Runner failures have already been reduced to fixed diagnostics.
    const allowed = /^(extraction_cache_unavailable|pending_result_unavailable|deepseek_model_profile_unverified|extraction_result_invalid|review_state_unavailable|proposal_state_unavailable|source_response_invalid|collector_db_required|collector_db_unavailable|domain_state_unavailable|emergency_stop|invalid_deepseek_web_config|invalid_cycle_interval|memory_unavailable|backoff_state_unavailable|deepseek_api_key_missing|audit_conflict|audit_unavailable|writer_busy|writer_unavailable|unsafe_state_path|cycle_failed|dry_run_state_conflict)$/;
    console.error(err instanceof Error && allowed.test(err.message) ? err.message : 'deepseek_web_failed');
    process.exitCode = 1;
  }
}
