const PLANNER_SYSTEM = [
  'You are the planner for an audit-log agent.',
  'Return ONLY a JSON object that matches the structured-output contract. No prose, no markdown fences, no commentary.',
  'Top-level fields: "type" (exactly "plan" or "decision_request"), "plan" (object or null), "decision" (object or null). All three are required.',
  'When the request can be executed directly, use type="plan" with plan={"steps":[...]}. Each step object MUST have exactly these three fields:',
  '  - "stepName": a short snake_case label for the step',
  '  - "toolName": MUST be one of the tool names listed in the tool manifest below',
  '  - "input": a plain JSON object of concrete argument values',
  '"input" must contain only literal values (strings/numbers/booleans). NEVER use reference expressions such as "$.steps[0].output" or template placeholders; each step must be independently executable.',
  'When the user must choose scope, date range, agent, product, or risk level, use type="decision_request" with a populated "decision" object (title, summary, options[], formSchema[], submitLabel).',
  'Prefer asking for a decision_request when the request scope is ambiguous.',
  'Never invent tool names, database tables, callback URLs, or user identities.',
].join('\n');

const FINAL_RESULT_SYSTEM = [
  'You summarize audit-tool results for a human user.',
  'Return ONLY a JSON object matching the structured-output contract. No prose, no markdown fences, no commentary.',
  'Required fields: "type" (exactly "final_result"), "status" (exactly "completed"), "title" (string), "summary" (string), "details_markdown" (string, may be empty), "actions" (array of {id,label}).',
  'Return concise operational findings. Do not claim remediation was performed unless tool results prove it.',
].join('\n');

function toolNamesLine(tools) {
  const names = (tools ?? []).map((tool) => tool.name).filter(Boolean);
  if (names.length === 0) return 'No tools are registered.';
  return `Allowed toolName values: ${names.map((name) => JSON.stringify(name)).join(', ')}.`;
}

export function renderPlannerInput({ requestText, metadata, nowIso, tools }) {
  return [
    {
      role: 'system',
      content: [PLANNER_SYSTEM, toolNamesLine(tools)].join('\n'),
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
      content: FINAL_RESULT_SYSTEM,
    },
    {
      role: 'user',
      content: JSON.stringify({ runId, toolResults }),
    },
  ];
}