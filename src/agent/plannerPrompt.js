export function renderPlannerInput({ requestText, metadata, nowIso, tools }) {
  return [
    {
      role: 'system',
      content: [
        'You are the planner for an audit-log agent.',
        'Return only a structured planner decision that matches the supplied JSON schema.',
        'You may choose only tools listed in the tool manifest.',
        'Prefer asking for a decision_request when the request scope is ambiguous.',
        'Never invent tool names, database tables, callback URLs, or user identities.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({
        now: nowIso,
        requestText,
        metadata: metadata ?? {},
        tools,
        expectedOutputs: {
          plan: 'Use when the request can be executed directly.',
          decision_request: 'Use when the user must choose scope, date range, agent, product, or risk level.',
        },
      }),
    },
  ];
}

export function renderFinalResultInput({ runId, toolResults }) {
  return [
    {
      role: 'system',
      content: [
        'You summarize audit-tool results for a human user.',
        'Return concise operational findings.',
        'Do not claim remediation was performed unless tool results prove it.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({ runId, toolResults }),
    },
  ];
}
