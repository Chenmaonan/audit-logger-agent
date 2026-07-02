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