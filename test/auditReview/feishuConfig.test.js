import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  FEISHU_LIVE_CONFIRMATION,
  loadFeishuRuntimeConfig,
} from '../../src/auditReview/feishuConfig.js';

test('Feishu runtime config defaults to disabled and accepts dry-run without a webhook', () => {
  assert.deepEqual(loadFeishuRuntimeConfig({ env: {}, appConfig: {} }), {
    mode: 'disabled',
    webhookUrl: null,
    liveConfirmation: '',
    requiredLiveConfirmation: FEISHU_LIVE_CONFIRMATION,
  });
  assert.equal(loadFeishuRuntimeConfig({ env: { AUDIT_AGENT_FEISHU_MODE: 'dry-run' } }).mode, 'dry-run');
});

test('Feishu live runtime config fails closed without webhook or confirmation', () => {
  assert.throws(
    () => loadFeishuRuntimeConfig({ env: { AUDIT_AGENT_FEISHU_MODE: 'live' } }),
    /requires a webhook secret/,
  );
  assert.throws(
    () => loadFeishuRuntimeConfig({
      env: {
        AUDIT_AGENT_FEISHU_MODE: 'live',
        AUDIT_AGENT_FEISHU_WEBHOOK_URL: 'https://open.feishu.cn/open-apis/bot/v2/hook/test',
      },
    }),
    /confirmation is missing or invalid/,
  );
});

test('Webhook secret file takes precedence over the URL environment variable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-secret-'));
  const secretPath = path.join(dir, 'webhook');
  try {
    fs.writeFileSync(secretPath, 'https://open.feishu.cn/open-apis/bot/v2/hook/from-file\n', 'utf8');
    const result = loadFeishuRuntimeConfig({
      env: {
        AUDIT_AGENT_FEISHU_MODE: 'live',
        AUDIT_AGENT_FEISHU_WEBHOOK_FILE: secretPath,
        AUDIT_AGENT_FEISHU_WEBHOOK_URL: 'https://open.feishu.cn/open-apis/bot/v2/hook/from-env',
        AUDIT_AGENT_FEISHU_LIVE_CONFIRM: FEISHU_LIVE_CONFIRMATION,
      },
    });
    assert.match(result.webhookUrl, /from-file$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
