import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import {
  isRelayTarget,
  parseAuthContext,
  parseRelayEvent,
  type RelayTarget,
  type RelayTargetRequest,
  type RelayTargetResult,
} from '../src/contracts.ts';

Deno.test('parseAuthContext accepts anonymous context', () => {
  const parsed = parseAuthContext({
    role: 'anonymous',
    principal_id: null,
    scopes: [],
  });

  assert(parsed.ok);
  if (!parsed.ok) return;
  assertEquals(parsed.value.role, 'anonymous');
  assertEquals(parsed.value.principalId, null);
  assertEquals(parsed.value.scopes, []);
});

Deno.test('parseAuthContext rejects unknown role', () => {
  const parsed = parseAuthContext({
    role: 'owner',
    principal_id: 'admin',
    scopes: ['relay.admin'],
  });

  assertEquals(parsed.ok, false);
  if (parsed.ok) return;
  assertStringIncludes(parsed.error, 'role');
});

Deno.test('parseRelayEvent parses incoming_ref event', () => {
  const parsed = parseRelayEvent({
    type: 'incoming_ref',
    event_id: 'evt-1',
    occurred_at: 1_736_000_000,
    room: 'main',
    source: 'relay-a',
    ref: 'refs/relay/incoming/topic-1',
    target: 'github:bit-vcs/bit-relay',
  });

  assert(parsed.ok);
  if (!parsed.ok) return;
  assertEquals(parsed.value.type, 'incoming_ref');
  if (parsed.value.type !== 'incoming_ref') return;
  assertEquals(parsed.value.ref, 'refs/relay/incoming/topic-1');
});

Deno.test('parseRelayEvent rejects issue_synced without issue_id', () => {
  const parsed = parseRelayEvent({
    type: 'issue_synced',
    event_id: 'evt-2',
    occurred_at: 1_736_000_001,
    room: 'main',
    source: 'relay-a',
    provider: 'github',
    action: 'upsert',
  });

  assertEquals(parsed.ok, false);
  if (parsed.ok) return;
  assertStringIncludes(parsed.error, 'issue_id');
});

Deno.test('isRelayTarget validates shape', async () => {
  const target: RelayTarget = {
    kind: 'github_repository',
    async execute(request: RelayTargetRequest): Promise<RelayTargetResult> {
      return {
        ok: true,
        operation: request.operation,
        status: 200,
      };
    },
  };

  assert(isRelayTarget(target));
  assertEquals(isRelayTarget({ kind: 'broken' }), false);

  const response = await target.execute({
    operation: 'clone',
    repo: 'bit-vcs/bit-relay',
    auth: {
      role: 'anonymous',
      principalId: null,
      scopes: [],
    },
  });
  assertEquals(response.ok, true);
  assertEquals(response.operation, 'clone');
});
