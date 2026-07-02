function dayRange(nowIso) {
  const date = nowIso.slice(0, 10);
  return {
    from: `${date}T00:00:00.000+08:00`,
    to: `${date}T23:59:59.999+08:00`,
  };
}

export function createPlanner({ now = () => new Date().toISOString() } = {}) {
  return {
    async createInitialPlan(input) {
      const text = input.requestText ?? '';
      const scopeKnown = text.includes('今天') || text.includes('今日') || text.includes('全部');

      if (text.includes('异常') && !scopeKnown) {
        return {
          type: 'decision_request',
          decision: {
            title: '需要确认处理范围',
            summary: '当前请求未明确范围，请先选择处理今天的异常，还是处理全部异常。',
            options: [
              { id: 'today_only', label: '只处理今天', description: '优先处理当天问题' },
              { id: 'all_errors', label: '处理全部异常', description: '覆盖全部历史异常' },
            ],
            formSchema: [],
            submitLabel: '继续执行',
          },
        };
      }

      const range = dayRange(now());
      return {
        type: 'plan',
        plan: {
          steps: [
            {
              stepName: 'load-errors',
              toolName: 'audit.queryEvents',
              input: text.includes('全部')
                ? { status: 'error', limit: 100 }
                : { status: 'error', from: range.from, to: range.to, limit: 100 },
            },
            {
              stepName: 'summarize-errors',
              toolName: 'report.errorSummary',
              input: text.includes('全部')
                ? { from: '1970-01-01', to: '2099-12-31', agentId: undefined }
                : { from: range.from, to: range.to, agentId: undefined },
            },
          ],
        },
      };
    },

    async resumeFromDecision(waitingContext, response) {
      const selected = response?.selected_option;
      const nowIso = now();
      const range = dayRange(nowIso);

      if (selected === 'today_only') {
        return {
          type: 'plan',
          plan: {
            steps: [
              { stepName: 'load-errors', toolName: 'audit.queryEvents', input: { status: 'error', from: range.from, to: range.to, limit: 100 } },
              { stepName: 'summarize-errors', toolName: 'report.errorSummary', input: { from: range.from, to: range.to, agentId: undefined } },
            ],
          },
        };
      }

      if (selected === 'all_errors') {
        return {
          type: 'plan',
          plan: {
            steps: [
              { stepName: 'load-errors', toolName: 'audit.queryEvents', input: { status: 'error', limit: 100 } },
              { stepName: 'summarize-errors', toolName: 'report.errorSummary', input: { from: '1970-01-01', to: '2099-12-31', agentId: undefined } },
            ],
          },
        };
      }

      const err = new Error(`Invalid selected_option: ${String(selected)}`);
      err.code = 'invalid_decision_response';
      err.retryable = false;
      throw err;
    },

    async synthesizeFinalResult(context) {
      const errorRows = context.toolResults.find((item) => item.stepName === 'load-errors')?.result ?? [];
      const summaryRows = context.toolResults.find((item) => item.stepName === 'summarize-errors')?.result ?? [];
      const urgentCount = errorRows.slice(0, 5).length;

      return {
        type: 'final_result',
        status: 'completed',
        title: '异常任务分析已完成',
        summary: `共发现 ${errorRows.length} 条异常，建议优先处理前 ${urgentCount} 条。`,
        details_markdown: summaryRows.length === 0
          ? '未查询到异常记录。'
          : summaryRows.map((row, index) => `${index + 1}. ${row.tool_name} | ${row.result_summary}`).join('\n'),
        actions: [{ id: 'view_trace', label: '查看执行轨迹' }],
      };
    },
  };
}