import { assertEquals } from '@std/assert';
import type { CacheStoreObject } from '../src/cache_store.ts';
import {
  deriveIssueAction,
  extractIssueIdFromEnvelope,
  isIssueTopic,
  issueCursorStorageKey,
  issueEventStorageKey,
  issueSnapshotStorageKey,
  parseCachedIssueEnvelope,
  parseIssueCacheCursorRecord,
  parseIssueCacheEventRecord,
  parseIssueCacheSnapshotRecord,
  parseIssueEventCursorFromKey,
  parseIssueSourceUpdatedAtMs,
} from '../src/issue_projection.ts';

const validators = {
  isValidRoomName(room: string): boolean {
    return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(room);
  },
  isValidTopic(topic: string): boolean {
    return /^[a-z][a-z0-9._-]{0,63}$/.test(topic);
  },
};

function objectFrom(value: unknown): CacheStoreObject {
  return {
    body: new TextEncoder().encode(JSON.stringify(value)),
    metadata: {
      kind: 'object',
      key: 'k',
      size: 1,
      updatedAt: 1,
    },
  };
}

Deno.test('issue projection derives topic/action/issue id and source updated time', () => {
  assertEquals(isIssueTopic('issue'), true);
  assertEquals(isIssueTopic('issue.updated'), true);
  assertEquals(isIssueTopic('notify'), false);

  const envelope = {
    room: 'repo',
    id: 'i-1',
    sender: 'bot',
    topic: 'issue.closed',
    payload: {
      issue_id: 'repo#1',
      issue: { updated_at: '2026-01-01T00:00:00Z' },
    },
    signature: null,
  } as const;
  assertEquals(extractIssueIdFromEnvelope(envelope), 'repo#1');
  assertEquals(deriveIssueAction(envelope), 'closed');
  assertEquals(parseIssueSourceUpdatedAtMs(envelope.payload), Date.parse('2026-01-01T00:00:00Z'));
});

Deno.test('issue projection builds and parses issue storage keys', () => {
  const eventKey = issueEventStorageKey('repo', 12, 'i-12');
  assertEquals(eventKey, 'issue/events/repo/000000000012-i-12');
  assertEquals(parseIssueEventCursorFromKey('repo', eventKey), 12);
  assertEquals(parseIssueEventCursorFromKey('repo', 'issue/events/repo/bad'), null);
  assertEquals(issueSnapshotStorageKey('repo', 'repo#1'), 'issue/snapshots/repo/repo#1');
  assertEquals(issueCursorStorageKey('repo'), 'issue/cursors/repo');
});

Deno.test('issue projection parses cached envelope/event/snapshot/cursor records', () => {
  const envelopeObj = objectFrom({
    room: 'repo',
    id: 'i-1',
    sender: 'bot',
    topic: 'issue',
    payload: { issue_id: 'repo#1' },
    signature: null,
  });
  const parsedEnvelope = parseCachedIssueEnvelope(envelopeObj, validators);
  assertEquals(parsedEnvelope?.id, 'i-1');

  const eventObj = objectFrom({
    version: 1,
    kind: 'issue_event',
    room: 'repo',
    cursor: 1,
    issue_id: 'repo#1',
    action: 'upsert',
    source_updated_at_ms: 1,
    updated_at: 2,
    envelope: {
      room: 'repo',
      id: 'i-1',
      sender: 'bot',
      topic: 'issue',
      payload: { issue_id: 'repo#1' },
      signature: null,
    },
  });
  const parsedEvent = parseIssueCacheEventRecord(eventObj, validators);
  assertEquals(parsedEvent?.cursor, 1);
  assertEquals(parsedEvent?.envelope.topic, 'issue');

  const snapshotObj = objectFrom({
    version: 1,
    kind: 'issue_snapshot',
    room: 'repo',
    issue_id: 'repo#1',
    last_cursor: 3,
    source_updated_at_ms: 2,
    updated_at: 3,
    envelope: {
      room: 'repo',
      id: 'i-2',
      sender: 'bot',
      topic: 'issue.updated',
      payload: { issue_id: 'repo#1' },
      signature: null,
    },
  });
  const parsedSnapshot = parseIssueCacheSnapshotRecord(snapshotObj, validators);
  assertEquals(parsedSnapshot?.last_cursor, 3);

  const cursorObj = objectFrom({
    version: 1,
    kind: 'issue_cursor',
    room: 'repo',
    cursor: 7,
    updated_at: 9,
  });
  const parsedCursor = parseIssueCacheCursorRecord(cursorObj, validators.isValidRoomName);
  assertEquals(parsedCursor?.cursor, 7);
});
