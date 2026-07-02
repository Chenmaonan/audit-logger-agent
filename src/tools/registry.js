export function createToolRegistry() {
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

    async execute(name, input, context) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Tool not registered: ${name}`);
      return tool.execute(input, context);
    },
  };
}