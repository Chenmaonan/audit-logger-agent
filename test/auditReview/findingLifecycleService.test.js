import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FindingLifecycleError,
  createFindingLifecycleService,
} from '../../src/auditReview/findingLifecycleService.js';

const NOW = new Date('2026-07-17T08:00:00.000Z');

function makeFinding(status = 'open', stateVersion = 1) {
  return {
    finding_id: 'fnd_1',
    status,
    state_version: stateVersion,
    acknowledged_at: null,
    acknowledged_by: null,
    snoozed_until: null,
    resolved_at: null,
  };
}

function makeFakeStore(initialFindings = [makeFinding()]) {
  const findings = new Map(initialFindings.map((finding) => [finding.finding_id, { ...finding }]));
  const actions = [];
  const calls = [];

  return {
    findings,
    actions,
    calls,
    applyFindingAction(input) {
      calls.push(structuredClone(input));
      const current = findings.get(input.findingId);
      if (!current) return { outcome: 'not_found' };
      if (current.state_version !== input.expectedStateVersion) {
        return { outcome: 'version_conflict', finding: { ...current } };
      }
      if (!input.allowedFromStatuses.includes(current.status)) {
        return { outcome: 'state_conflict', finding: { ...current } };
      }

      const fromStatus = current.status;
      const updated = {
        ...current,
        ...input.findingPatch,
        state_version: current.state_version + 1,
      };
      const action = {
        action_id: `act_${actions.length + 1}`,
        finding_id: input.findingId,
        action_type: input.action.actionType,
        from_status: fromStatus,
        to_status: input.toStatus,
        actor: input.action.actor,
        note: input.action.note,
        snoozed_until: input.action.snoozedUntil,
        created_at: input.action.createdAt,
      };
      findings.set(input.findingId, updated);
      actions.push(action);
      return { outcome: 'updated', finding: { ...updated }, action: { ...action } };
    },
  };
}

function makeService(store) {
  return createFindingLifecycleService({ reviewStore: store, now: () => NOW });
}

function actionInput(action, expectedStateVersion = 1) {
  const input = {
    findingId: 'fnd_1',
    action,
    actor: ' operator-1 ',
    expected_state_version: expectedStateVersion,
  };
  if (action === 'snooze') input.snoozed_until = '2026-07-18T08:00:00Z';
  if (action === 'resolve' || action === 'reopen') input.note = `note for ${action}`;
  return input;
}

function assertLifecycleError(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof FindingLifecycleError);
    assert.equal(error.code, code);
    return true;
  });
}

test('findingLifecycleService requires an atomic reviewStore operation', () => {
  assert.throws(
    () => createFindingLifecycleService({ reviewStore: {} }),
    /reviewStore\.applyFindingAction is required/
  );
});

test('findingLifecycleService supports every legal state transition', async (t) => {
  const cases = [
    ['open', 'acknowledge', 'acknowledged'],
    ['open', 'snooze', 'snoozed'],
    ['open', 'resolve', 'resolved'],
    ['acknowledged', 'reopen', 'open'],
    ['acknowledged', 'snooze', 'snoozed'],
    ['acknowledged', 'resolve', 'resolved'],
    ['snoozed', 'acknowledge', 'acknowledged'],
    ['snoozed', 'resolve', 'resolved'],
    ['resolved', 'reopen', 'open'],
  ];

  for (const [fromStatus, action, toStatus] of cases) {
    await t.test(`${fromStatus} --${action}--> ${toStatus}`, () => {
      const store = makeFakeStore([makeFinding(fromStatus, 4)]);
      const service = makeService(store);

      const result = service.performAction(actionInput(action, 4));

      assert.equal(result.finding.status, toStatus);
      assert.equal(result.finding.state_version, 5);
      assert.equal(result.action.from_status, fromStatus);
      assert.equal(result.action.to_status, toStatus);
      assert.equal(result.action.action_type, action);
      assert.equal(result.action.actor, 'operator-1');
      assert.equal(store.calls.length, 1);
      assert.equal(store.calls[0].expectedStateVersion, 4);
      assert.equal(store.calls[0].toStatus, toStatus);
    });
  }
});

test('findingLifecycleService rejects every illegal state transition', async (t) => {
  const cases = [
    ['open', 'reopen'],
    ['acknowledged', 'acknowledge'],
    ['snoozed', 'snooze'],
    ['snoozed', 'reopen'],
    ['resolved', 'acknowledge'],
    ['resolved', 'snooze'],
    ['resolved', 'resolve'],
  ];

  for (const [status, action] of cases) {
    await t.test(`${status} cannot ${action}`, () => {
      const store = makeFakeStore([makeFinding(status, 2)]);
      const service = makeService(store);

      assertLifecycleError(
        () => service.performAction(actionInput(action, 2)),
        'finding_state_conflict'
      );
      assert.equal(store.actions.length, 0);
      assert.equal(store.findings.get('fnd_1').state_version, 2);
    });
  }
});

test('findingLifecycleService validates action parameters before calling the store', async (t) => {
  const cases = [
    ['missing findingId', { action: 'acknowledge', actor: 'a', expected_state_version: 1 }],
    ['unknown action', { ...actionInput('acknowledge'), action: 'dismiss' }],
    ['missing actor', { ...actionInput('acknowledge'), actor: ' ' }],
    ['non-integer version', { ...actionInput('acknowledge'), expected_state_version: 1.2 }],
    ['zero version', { ...actionInput('acknowledge'), expected_state_version: 0 }],
    ['resolve without note', { ...actionInput('resolve'), note: ' ' }],
    ['reopen without note', { ...actionInput('reopen'), note: null }],
    ['snooze without deadline', { ...actionInput('snooze'), snoozed_until: '' }],
    ['snooze with invalid deadline', { ...actionInput('snooze'), snoozed_until: 'not-a-date' }],
    ['snooze with past deadline', { ...actionInput('snooze'), snoozed_until: '2026-07-17T07:59:59Z' }],
  ];

  for (const [name, input] of cases) {
    await t.test(name, () => {
      const store = makeFakeStore();
      const service = makeService(store);
      assertLifecycleError(() => service.performAction(input), 'invalid_finding_action');
      assert.equal(store.calls.length, 0);
    });
  }
});

test('findingLifecycleService accepts camelCase aliases and rejects conflicting aliases', () => {
  const store = makeFakeStore();
  const service = makeService(store);

  const result = service.performAction({
    findingId: 'fnd_1',
    action: 'snooze',
    actor: 'operator-1',
    expectedStateVersion: 1,
    snoozedUntil: '2026-07-18T08:00:00+00:00',
  });
  assert.equal(result.finding.snoozedUntil, '2026-07-18T08:00:00.000Z');
  assert.equal(result.action.snoozed_until, '2026-07-18T08:00:00.000Z');

  const conflictStore = makeFakeStore();
  const conflictService = makeService(conflictStore);
  assertLifecycleError(
    () => conflictService.performAction({
      ...actionInput('acknowledge'),
      expectedStateVersion: 2,
    }),
    'invalid_finding_action'
  );
  assert.equal(conflictStore.calls.length, 0);
});

test('findingLifecycleService maps store outcomes to stable error codes', async (t) => {
  const cases = [
    ['not_found', 'finding_not_found'],
    ['state_conflict', 'finding_state_conflict'],
    ['version_conflict', 'finding_version_conflict'],
  ];

  for (const [outcome, code] of cases) {
    await t.test(outcome, () => {
      const reviewStore = {
        applyFindingAction() {
          return {
            outcome,
            finding: outcome === 'not_found' ? undefined : makeFinding('resolved', 3),
          };
        },
      };
      const service = makeService(reviewStore);
      assertLifecycleError(
        () => service.performAction(actionInput('acknowledge')),
        code
      );
    });
  }
});

test('findingLifecycleService persists ordered actions with actor and version increments', () => {
  const store = makeFakeStore();
  const service = makeService(store);

  service.performAction(actionInput('acknowledge', 1));
  service.performAction(actionInput('snooze', 2));
  service.performAction(actionInput('resolve', 3));
  service.performAction(actionInput('reopen', 4));

  assert.deepEqual(
    store.actions.map((action) => [
      action.action_type,
      action.from_status,
      action.to_status,
      action.actor,
    ]),
    [
      ['acknowledge', 'open', 'acknowledged', 'operator-1'],
      ['snooze', 'acknowledged', 'snoozed', 'operator-1'],
      ['resolve', 'snoozed', 'resolved', 'operator-1'],
      ['reopen', 'resolved', 'open', 'operator-1'],
    ]
  );
  assert.equal(store.findings.get('fnd_1').state_version, 5);
});

test('findingLifecycleService creates action and Finding patch timestamps from one clock read', () => {
  let reads = 0;
  const store = makeFakeStore();
  const service = createFindingLifecycleService({
    reviewStore: store,
    now: () => {
      reads += 1;
      return NOW;
    },
  });

  const result = service.performAction(actionInput('resolve'));

  assert.equal(reads, 1);
  assert.equal(result.finding.resolvedAt, NOW.toISOString());
  assert.equal(result.action.created_at, NOW.toISOString());
  assert.equal(result.action.note, 'note for resolve');
});
