// src/agent/payloads.js
export function createProgressPayload(run, summary, currentStep, totalSteps) {
  return {
    type: 'progress_update',
    run_id: run.run_id,
    title: '任务执行中',
    summary,
    progress: { current_step: currentStep, total_steps: totalSteps },
  };
}

export function createDecisionPayload(run, decisionId, decision) {
  return {
    type: 'decision_request',
    run_id: run.run_id,
    decision_id: decisionId,
    title: decision.title,
    summary: decision.summary,
    options: decision.options,
    form_schema: decision.formSchema,
    submit_label: decision.submitLabel,
  };
}

export function createFinalResultPayload(run, result) {
  return {
    ...result,
    run_id: run.run_id,
  };
}

export function createFailedFinalResultPayload(run, error) {
  return {
    type: 'final_result',
    run_id: run.run_id,
    status: 'failed',
    title: '任务执行失败',
    summary: error?.summary ?? error?.message ?? '任务执行过程中发生错误，未能完成。',
    error: {
      code: error?.code ?? 'runtime_error',
      message: error?.message ?? 'Unknown error',
      retryable: error?.retryable ?? false,
    },
    actions: [{ id: 'retry_run', label: '重新发起任务' }],
  };
}