export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type RelayOperation = 'clone' | 'fetch' | 'push' | 'notify';
export type RelayTargetKind = 'github_repository' | 'relay_session' | 'cache_node';
export type AuthRole = 'anonymous' | 'relay_admin' | 'github_app';
export type IssueProvider = 'bit' | 'github';
export type IssueSyncAction = 'upsert' | 'close';

export interface AuthContext {
  role: AuthRole;
  principalId: string | null;
  scopes: string[];
  githubInstallationId?: number | null;
}

export interface RelayTargetRequest {
  operation: RelayOperation;
  repo: string;
  ref?: string;
  payload?: JsonValue;
  auth: AuthContext;
}

export interface RelayTargetResult {
  ok: boolean;
  operation: RelayOperation;
  status: number;
  message?: string;
  data?: JsonValue;
}

export interface RelayTarget {
  kind: RelayTargetKind;
  execute(request: RelayTargetRequest): Promise<RelayTargetResult>;
}

interface RelayEventBase {
  eventId: string;
  occurredAt: number;
  room: string;
  source: string;
}

export interface IncomingRefRelayEvent extends RelayEventBase {
  type: 'incoming_ref';
  ref: string;
  target: string;
}

export interface IssueSyncedRelayEvent extends RelayEventBase {
  type: 'issue_synced';
  provider: IssueProvider;
  action: IssueSyncAction;
  issueId: string;
}

export interface CacheReplicatedRelayEvent extends RelayEventBase {
  type: 'cache_replicated';
  cacheKey: string;
  fromNode: string;
  toNode: string;
  bytes: number;
}

export type RelayEvent = IncomingRefRelayEvent | IssueSyncedRelayEvent | CacheReplicatedRelayEvent;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

const AUTH_ROLES: ReadonlySet<AuthRole> = new Set(['anonymous', 'relay_admin', 'github_app']);
const ISSUE_PROVIDERS: ReadonlySet<IssueProvider> = new Set(['bit', 'github']);
const ISSUE_SYNC_ACTIONS: ReadonlySet<IssueSyncAction> = new Set(['upsert', 'close']);
const EVENT_TYPES: ReadonlySet<RelayEvent['type']> = new Set([
  'incoming_ref',
  'issue_synced',
  'cache_replicated',
]);
const TARGET_KINDS: ReadonlySet<RelayTargetKind> = new Set([
  'github_repository',
  'relay_session',
  'cache_node',
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asNullableString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return asString(value);
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readField(record: Record<string, unknown>, snake: string, camel: string): unknown {
  if (Object.hasOwn(record, snake)) return record[snake];
  return record[camel];
}

function parseBaseEvent(record: Record<string, unknown>): ParseResult<RelayEventBase> {
  const eventId = asString(record.event_id);
  if (!eventId) return { ok: false, error: 'invalid event_id' };
  const occurredAt = asFiniteNumber(record.occurred_at);
  if (occurredAt === null) return { ok: false, error: 'invalid occurred_at' };
  const room = asString(record.room);
  if (!room) return { ok: false, error: 'invalid room' };
  const source = asString(record.source);
  if (!source) return { ok: false, error: 'invalid source' };
  return {
    ok: true,
    value: {
      eventId,
      occurredAt,
      room,
      source,
    },
  };
}

export function isRelayTarget(value: unknown): value is RelayTarget {
  const record = asRecord(value);
  if (!record) return false;
  if (!TARGET_KINDS.has(record.kind as RelayTargetKind)) return false;
  return typeof record.execute === 'function';
}

export function parseAuthContext(input: unknown): ParseResult<AuthContext> {
  const record = asRecord(input);
  if (!record) return { ok: false, error: 'auth context must be object' };

  const roleRaw = asString(record.role);
  if (!roleRaw || !AUTH_ROLES.has(roleRaw as AuthRole)) {
    return { ok: false, error: 'invalid role' };
  }
  const role = roleRaw as AuthRole;

  const principalRaw = asNullableString(readField(record, 'principal_id', 'principalId'));
  if (principalRaw === undefined) return { ok: false, error: 'missing principal_id' };
  if (principalRaw !== null && principalRaw.length === 0) {
    return { ok: false, error: 'invalid principal_id' };
  }

  if (!Array.isArray(record.scopes) || !record.scopes.every((scope) => typeof scope === 'string')) {
    return { ok: false, error: 'invalid scopes' };
  }

  const githubInstallationIdRaw = readField(
    record,
    'github_installation_id',
    'githubInstallationId',
  );
  const githubInstallationId = githubInstallationIdRaw === undefined
    ? undefined
    : githubInstallationIdRaw === null
    ? null
    : asFiniteNumber(githubInstallationIdRaw);
  if (
    githubInstallationIdRaw !== undefined &&
    githubInstallationIdRaw !== null &&
    githubInstallationId === null
  ) {
    return { ok: false, error: 'invalid github_installation_id' };
  }

  return {
    ok: true,
    value: {
      role,
      principalId: principalRaw,
      scopes: [...record.scopes],
      githubInstallationId,
    },
  };
}

export function parseRelayEvent(input: unknown): ParseResult<RelayEvent> {
  const record = asRecord(input);
  if (!record) return { ok: false, error: 'event must be object' };

  const typeRaw = asString(record.type);
  if (!typeRaw || !EVENT_TYPES.has(typeRaw as RelayEvent['type'])) {
    return { ok: false, error: 'invalid type' };
  }

  const baseParsed = parseBaseEvent(record);
  if (!baseParsed.ok) return baseParsed;
  const base = baseParsed.value;

  if (typeRaw === 'incoming_ref') {
    const ref = asString(record.ref);
    if (!ref) return { ok: false, error: 'invalid ref' };
    const target = asString(record.target);
    if (!target) return { ok: false, error: 'invalid target' };
    return {
      ok: true,
      value: {
        ...base,
        type: 'incoming_ref',
        ref,
        target,
      },
    };
  }

  if (typeRaw === 'issue_synced') {
    const providerRaw = asString(record.provider);
    if (!providerRaw || !ISSUE_PROVIDERS.has(providerRaw as IssueProvider)) {
      return { ok: false, error: 'invalid provider' };
    }
    const actionRaw = asString(record.action);
    if (!actionRaw || !ISSUE_SYNC_ACTIONS.has(actionRaw as IssueSyncAction)) {
      return { ok: false, error: 'invalid action' };
    }
    const issueId = asString(record.issue_id);
    if (!issueId) return { ok: false, error: 'invalid issue_id' };
    return {
      ok: true,
      value: {
        ...base,
        type: 'issue_synced',
        provider: providerRaw as IssueProvider,
        action: actionRaw as IssueSyncAction,
        issueId,
      },
    };
  }

  const cacheKey = asString(record.cache_key);
  if (!cacheKey) return { ok: false, error: 'invalid cache_key' };
  const fromNode = asString(record.from_node);
  if (!fromNode) return { ok: false, error: 'invalid from_node' };
  const toNode = asString(record.to_node);
  if (!toNode) return { ok: false, error: 'invalid to_node' };
  const bytes = asFiniteNumber(record.bytes);
  if (bytes === null) return { ok: false, error: 'invalid bytes' };
  return {
    ok: true,
    value: {
      ...base,
      type: 'cache_replicated',
      cacheKey,
      fromNode,
      toNode,
      bytes,
    },
  };
}
