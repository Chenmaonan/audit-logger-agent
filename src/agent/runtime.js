// src/agent/runtime.js
import { createDecisionPayload, createFinalResultPayload, createProgressPayload } from './payloads.js';

export function createRuntime({ runStore, outboxStore, waitStore, planner, registry, eventPublisher, auditLogger }) {
  return new Runtime({ runStore, outboxStore, waitStore, planner, registry, eventPublisher, auditLogger });
}

class Runtime {
  #runStore;
  #outboxStore;
  #waitStore;
  #planner;
  #registry;
  #eventPublisher;
  #auditLogger;

  constructor({ runStore, outboxStore, waitStore, planner, registry, eventPublisher, auditLogger }) {
    this.#runStore = runStore;
    this.#outboxStore = outboxStore;
    this.#waitStore = waitStore;
    this.#planner = planner;
    this.#registry = registry;
    this.#eventPublisher = eventPublisher;
    this.#auditLogger = auditLogger;
  }

  getRun(runId) {
    return this.#runStore.getRun(runId);
  }

  async startRun(input) {
    const created = this.#runStore.createRun(input);
    await this.#auditLogger.log({ runId: created.run_id, event: 'run.start', status: 'ok', summary: 'Run created' });
    return this.#planAndExecute(created.run_id);
  }

  async resumeRun(runId, body) {
    const run = this.#runStore.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    const waiting = this.#waitStore.getWaitingState(body.decision_id);
    if (!waiting || waiting.run_id !== runId || waiting.status !== 'pending') {
      throw new Error('Waiting state not found or already resolved');
    }

    this.#waitStore.resolveWaitingState(body.decision_id);
    const planning = await this.#planner.resumeFromDecision(waiting.context_json, body.response);
    this.#runStore.transitionRun(runId, 'running', { plan: planning.plan });
    await this.#auditLogger.log({ runId, event: 'run.resume', status: 'ok', summary: 'Run resumed from user decision' });
    return this.#executePlan(runId, planning.plan);
  }

  async #planAndExecute(runId) {
    const run = this.#runStore.transitionRun(runId, 'planning');
    const decision = await this.#planner.createInitialPlan({
      requestText: run.request_text,
      metadata: run.metadata_json,
    });

    if (decision.type === 'decision_request') {
      const decisionId = this.#waitStore.createWaitingState({
        runId,
        schemaJson: decision.decision,
        contextJson: { requestText: run.request_text, metadata: run.metadata_json },
        requestedByStep: 0,
      });
      // Plan: planning -> waiting_user. State machine requires planning -> running -> waiting_user,
      // so pass through running first.
      this.#runStore.transitionRun(runId, 'running');
      const waitingRun = this.#runStore.transitionRun(runId, 'waiting_user');
      this.#eventPublisher.enqueueRunEvent(waitingRun, 'decision_request', createDecisionPayload(waitingRun, decisionId, decision.decision));
      await this.#auditLogger.log({ runId, event: 'run.waiting_user', status: 'ok', summary: 'Run waiting for user input' });
      return waitingRun;
    }

    this.#runStore.transitionRun(runId, 'running', { plan: decision.plan });
    return this.#executePlan(runId, decision.plan);
  }

  async #executePlan(runId, plan) {
    const run = this.#runStore.getRun(runId);
    const toolResults = [];

    for (let index = 0; index < plan.steps.length; index += 1) {
      const step = plan.steps[index];
      const progressPayload = createProgressPayload(run, `正在执行 ${step.stepName}`, index + 1, plan.steps.length);
      this.#eventPublisher.enqueueRunEvent(run, 'progress_update', progressPayload);

      const result = await this.#registry.execute(step.toolName, step.input, { runId });
      toolResults.push({ stepName: step.stepName, result });
      this.#runStore.appendStep({
        runId,
        stepIndex: index,
        stepName: step.stepName,
        status: 'completed',
        toolName: step.toolName,
        inputJson: step.input,
        outputJson: result,
      });
    }

    const finalResult = await this.#planner.synthesizeFinalResult({ runId, toolResults });
    const completedRun = this.#runStore.transitionRun(runId, 'completed', { result: finalResult, currentStepIndex: plan.steps.length });
    this.#eventPublisher.enqueueRunEvent(completedRun, 'final_result', createFinalResultPayload(completedRun, finalResult));
    await this.#auditLogger.log({ runId, event: 'run.final_result', status: 'ok', summary: finalResult.summary });
    return completedRun;
  }
}