import test from 'node:test';
import assert from 'node:assert/strict';

import { loadAppConfig } from '../../src/app/loadConfig.js';

test('dashboard base URL environment variable overrides container configuration', () => {
  const config = loadAppConfig(process.cwd(), {
    env: {
      AUDIT_AGENT_CONFIG_PATH: 'config.container.json',
      AUDIT_AGENT_DASHBOARD_BASE_URL: '  http://audit.example.test  ',
    },
  });

  assert.equal(
    config.auditReview.visualization.baseUrl,
    'http://audit.example.test',
  );
});

test('blank dashboard base URL environment variable preserves file configuration', () => {
  const config = loadAppConfig(process.cwd(), {
    env: {
      AUDIT_AGENT_CONFIG_PATH: 'config.json',
      AUDIT_AGENT_DASHBOARD_BASE_URL: '   ',
    },
  });

  assert.equal(
    config.auditReview.visualization.baseUrl,
    'http://127.0.0.1:9320',
  );
});
