// src/tools/registry.js
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_ATTEMPTS = 1;

function isAbortError(error) {
  return error?.name === 'AbortError' || error?.code === 'AbortError';
}

function classifyError(error, toolName, timedOut) {
  if (timedOut || isAbortError(error)) {
    return {
      code: 'tool_timeout',
      message: `Tool "${toolName}" exceeded its timeout`,
      retryable: true,
      summary: `工具 ${toolName} 执行超时`,
    };
  }
  if (error?.code && typeof error.code === 'string') {
    return {
      code: error.code,
      message: error.message ?? `Tool "${toolName}" failed`,
      retryable: error.retryable ?? false,
      summary: error.summary ?? `工具 ${toolName} 执行失败：${error.message ?? ''}`,
    };
  }
  return {
    code: 'tool_error',
    message: error?.message ?? `Tool "${toolName}" failed`,
    retryable: false,
    summary: `工具 ${toolName} 执行失败：${error?.message ?? '未知错误'}`,
  };
}

function normalizeResult(value, toolName) {
  if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'ok')) {
    return value;
  }
  return { ok: true, data: value };
}

export function createToolRegistry({ defaultTimeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const tools = new Map();

  return {
    register(tool) {
      if (!tool?.name || typeof tool.execute !== 'function') {
        throw new Error('Invalid tool definition');
      }
      tools.set(tool.name, tool);
    },

    has(name) {
      return tools.has(name);
    },

    list() {
      return Array.from(tools.keys());
    },

    describeTools() {
      return Array.from(tools.values()).map((tool) => ({
        name: tool.name,
        description: tool.description ?? `Tool ${tool.name}`,
        inputSchema: tool.inputSchema ?? { type: 'object', additionalProperties: true },
      }));
    },

    async execute(name, input, context = {}) {
      const tool = tools.get(name);
      if (!tool) {
        return {
          ok: false,
          error: {
            code: 'tool_not_found',
            message: `Tool not registered: ${name}`,
            retryable: false,
            summary: `工具 ${name} 未注册`,
          },
        };
      }

      const timeoutMs = tool.timeoutMs ?? defaultTimeoutMs;
      const controller = new AbortController();
      const timer = timeoutMs > 0
        ? setTimeout(() => controller.abort(), timeoutMs)
        : null;

      let rawResult;
      let timedOut = false;
      try {
        rawResult = await tool.execute(input, { ...context, signal: controller.signal });
      } catch (error) {
        if (controller.signal.aborted) {
          timedOut = true;
        }
        const classified = classifyError(error, name, timedOut);
        return { ok: false, error: classified };
      } finally {
        if (timer) clearTimeout(timer);
      }

      return normalizeResult(rawResult, name);
    },
  };
}

export { MAX_ATTEMPTS };