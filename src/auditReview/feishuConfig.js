import fs from 'fs';

export const FEISHU_LIVE_CONFIRMATION = 'CONFIRM_FEISHU_LIVE';

function trimmed(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function readWebhook(env) {
  const filePath = trimmed(env.AUDIT_AGENT_FEISHU_WEBHOOK_FILE);
  if (filePath) {
    try {
      return trimmed(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
      throw new Error(`Unable to read Feishu webhook secret file: ${error.code ?? error.message}`);
    }
  }
  return trimmed(env.AUDIT_AGENT_FEISHU_WEBHOOK_URL);
}

export function loadFeishuRuntimeConfig({ env = process.env, appConfig = {} } = {}) {
  const notification = appConfig?.auditReview?.notification ?? {};
  const configuredMode = trimmed(env.AUDIT_AGENT_FEISHU_MODE) || trimmed(notification.feishuMode) || 'disabled';
  if (!['disabled', 'dry-run', 'live'].includes(configuredMode)) {
    throw new Error('AUDIT_AGENT_FEISHU_MODE must be disabled, dry-run, or live');
  }
  const webhookUrl = readWebhook(env);
  const liveConfirmation = trimmed(env.AUDIT_AGENT_FEISHU_LIVE_CONFIRM);
  if (configuredMode === 'live') {
    if (!webhookUrl) throw new Error('Feishu live mode requires a webhook secret');
    if (liveConfirmation !== FEISHU_LIVE_CONFIRMATION) {
      throw new Error('Feishu live mode confirmation is missing or invalid');
    }
  }
  return {
    mode: configuredMode,
    webhookUrl: webhookUrl || null,
    liveConfirmation,
    requiredLiveConfirmation: FEISHU_LIVE_CONFIRMATION,
  };
}
