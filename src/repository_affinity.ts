export interface RepositoryDescriptor {
  host: string | null;
  owner: string | null;
  name: string;
}

export interface RelayRepositoryIdentity {
  repoId: string | null;
  owner: string | null;
  name: string | null;
  recentCommits: string[];
}

export interface ResolveLocalRepositoryIdentityOptions {
  explicitRepoId?: string | null;
  explicitOriginUrl?: string | null;
  explicitRecentCommits?: string[] | null;
  commitWindow?: number;
  runGitCommand?: (args: string[]) => Promise<string | null>;
}

export interface RepositoryCompatibilityDecision {
  compatible: boolean;
  reason:
    | 'exact_repo_id'
    | 'recent_commit_overlap'
    | 'repository_name_mismatch'
    | 'peer_repository_unknown'
    | 'no_recent_fast_forward'
    | 'local_repository_unknown';
}

const COMMIT_HASH_PATTERN = /^[0-9a-f]{7,40}$/i;
const REPOSITORY_TOKEN_PATTERN = /^[A-Za-z0-9._-]+$/;
const DEFAULT_COMMIT_WINDOW = 30;

function normalizeOptionalString(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeToken(raw: string | null | undefined): string | null {
  const value = normalizeOptionalString(raw);
  if (!value) return null;
  if (!REPOSITORY_TOKEN_PATTERN.test(value)) return null;
  return value.toLowerCase();
}

function normalizeCommitWindow(raw: number | undefined): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_COMMIT_WINDOW;
  }
  return Math.max(1, Math.trunc(raw));
}

function stripKnownPrefix(raw: string): string {
  if (raw.includes('://') || raw.startsWith('git@')) return raw;
  const colon = raw.indexOf(':');
  if (colon <= 0) return raw;
  const prefix = raw.slice(0, colon).trim().toLowerCase();
  if (prefix === 'github' || prefix === 'gitlab' || prefix === 'repo') {
    return raw.slice(colon + 1);
  }
  return raw;
}

function parseOwnerAndName(pathRaw: string): { owner: string | null; name: string } | null {
  const path = pathRaw.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  if (path.length === 0) return null;
  const segments = path.split('/').filter((entry) => entry.length > 0);
  if (segments.length === 0) return null;
  const rawName = segments[segments.length - 1].endsWith('.git')
    ? segments[segments.length - 1].slice(0, -4)
    : segments[segments.length - 1];
  const name = normalizeToken(rawName);
  if (!name) return null;
  const owner = segments.length >= 2 ? normalizeToken(segments[segments.length - 2]) : null;
  return { owner, name };
}

function parseScpLike(raw: string): { host: string | null; path: string } | null {
  const matched = raw.match(/^[^@]+@([^:]+):(.+)$/);
  if (!matched) return null;
  const host = normalizeToken(matched[1]);
  const path = matched[2].trim();
  if (path.length === 0) return null;
  return { host, path };
}

function parseAsUrl(raw: string): { host: string | null; path: string } | null {
  try {
    const parsed = new URL(raw);
    const host = normalizeToken(parsed.hostname);
    const path = parsed.pathname;
    return { host, path };
  } catch {
    return null;
  }
}

function normalizeRepositoryId(raw: string | null | undefined): string | null {
  const descriptor = parseRepositoryDescriptor(raw ?? '');
  if (!descriptor) return null;
  if (!descriptor.owner) return descriptor.name;
  return `${descriptor.owner}/${descriptor.name}`;
}

function parseRepoNameFromRepoId(
  repoId: string | null,
): { owner: string | null; name: string | null } {
  const descriptor = repoId ? parseRepositoryDescriptor(repoId) : null;
  if (!descriptor) {
    return { owner: null, name: null };
  }
  return { owner: descriptor.owner, name: descriptor.name };
}

function normalizeCommitHashes(raw: Iterable<string>, limit: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const normalized = normalizeOptionalString(entry)?.toLowerCase() ?? '';
    if (normalized.length === 0) continue;
    if (!COMMIT_HASH_PATTERN.test(normalized)) continue;
    if (seen.has(normalized)) continue;
    out.push(normalized);
    seen.add(normalized);
    if (out.length >= limit) break;
  }
  return out;
}

function parseRecentCommits(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  const entries = value.filter((item): item is string => typeof item === 'string');
  return normalizeCommitHashes(entries, limit);
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function parseRepositoryDescriptor(raw: string): RepositoryDescriptor | null {
  const trimmed = normalizeOptionalString(raw);
  if (!trimmed) return null;
  const stripped = stripKnownPrefix(trimmed);

  const scpLike = parseScpLike(stripped);
  if (scpLike) {
    const parsed = parseOwnerAndName(scpLike.path);
    if (!parsed) return null;
    return {
      host: scpLike.host,
      owner: parsed.owner,
      name: parsed.name,
    };
  }

  const asUrl = parseAsUrl(stripped);
  if (asUrl) {
    const parsed = parseOwnerAndName(asUrl.path);
    if (!parsed) return null;
    return {
      host: asUrl.host,
      owner: parsed.owner,
      name: parsed.name,
    };
  }

  const parsedPath = parseOwnerAndName(stripped);
  if (!parsedPath) return null;
  return {
    host: null,
    owner: parsedPath.owner,
    name: parsedPath.name,
  };
}

export function hasRecentFastForwardLikeOverlap(
  localRecentCommits: ReadonlyArray<string>,
  peerRecentCommits: ReadonlyArray<string>,
): boolean {
  if (localRecentCommits.length === 0 || peerRecentCommits.length === 0) return false;
  const localSet = new Set(localRecentCommits.map((value) => value.toLowerCase()));
  const peerSet = new Set(peerRecentCommits.map((value) => value.toLowerCase()));
  const localHead = localRecentCommits[0]?.toLowerCase();
  const peerHead = peerRecentCommits[0]?.toLowerCase();
  if (localHead && peerSet.has(localHead)) return true;
  if (peerHead && localSet.has(peerHead)) return true;
  for (const commit of localSet) {
    if (peerSet.has(commit)) return true;
  }
  return false;
}

export function decideRepositoryCompatibility(
  local: RelayRepositoryIdentity,
  peer: RelayRepositoryIdentity | null,
): RepositoryCompatibilityDecision {
  if (!local.name) {
    return { compatible: true, reason: 'local_repository_unknown' };
  }
  if (!peer || !peer.name) {
    return { compatible: false, reason: 'peer_repository_unknown' };
  }
  if (local.name !== peer.name) {
    return { compatible: false, reason: 'repository_name_mismatch' };
  }

  const localRepoId = normalizeRepositoryId(local.repoId);
  const peerRepoId = normalizeRepositoryId(peer.repoId);
  if (localRepoId && peerRepoId && localRepoId === peerRepoId) {
    return { compatible: true, reason: 'exact_repo_id' };
  }

  if (hasRecentFastForwardLikeOverlap(local.recentCommits, peer.recentCommits)) {
    return { compatible: true, reason: 'recent_commit_overlap' };
  }

  return { compatible: false, reason: 'no_recent_fast_forward' };
}

export function parseRepositoryFromDiscoveryBody(
  body: Record<string, unknown>,
  commitWindow = DEFAULT_COMMIT_WINDOW,
): RelayRepositoryIdentity | null {
  const normalizedWindow = normalizeCommitWindow(commitWindow);
  const container = asObject(body.repository) ?? body;
  const repoId = normalizeRepositoryId(asString(container.repo_id));
  const ownerField = normalizeToken(asString(container.owner));
  const nameField = normalizeToken(asString(container.name));
  const commits = parseRecentCommits(container.recent_commits, normalizedWindow);

  const repoFromId = parseRepoNameFromRepoId(repoId);
  const owner = ownerField ?? repoFromId.owner;
  const name = nameField ?? repoFromId.name;

  if (!repoId && !owner && !name && commits.length === 0) return null;
  return {
    repoId,
    owner,
    name,
    recentCommits: commits,
  };
}

async function defaultRunGitCommand(args: string[]): Promise<string | null> {
  try {
    const cmd = new Deno.Command('git', {
      args,
      stdout: 'piped',
      stderr: 'null',
    });
    const result = await cmd.output();
    if (!result.success) return null;
    const output = new TextDecoder().decode(result.stdout).trim();
    return output.length > 0 ? output : null;
  } catch {
    return null;
  }
}

function parseCommitLines(raw: string | null, limit: number): string[] {
  if (!raw) return [];
  const lines = raw.split(/\s+/).map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  return normalizeCommitHashes(lines, limit);
}

export async function resolveLocalRepositoryIdentity(
  options: ResolveLocalRepositoryIdentityOptions = {},
): Promise<RelayRepositoryIdentity> {
  const commitWindow = normalizeCommitWindow(options.commitWindow);
  const runGitCommand = options.runGitCommand ?? defaultRunGitCommand;

  const explicitRepoId = normalizeOptionalString(options.explicitRepoId);
  const explicitOriginUrl = normalizeOptionalString(options.explicitOriginUrl);
  let descriptor = explicitRepoId ? parseRepositoryDescriptor(explicitRepoId) : null;
  let repoId = normalizeRepositoryId(explicitRepoId);

  if (!descriptor) {
    const origin = explicitOriginUrl ??
      await runGitCommand(['config', '--get', 'remote.origin.url']);
    descriptor = origin ? parseRepositoryDescriptor(origin) : null;
    if (!repoId && descriptor) {
      repoId = descriptor.owner ? `${descriptor.owner}/${descriptor.name}` : descriptor.name;
    }
  }

  let recentCommits = normalizeCommitHashes(options.explicitRecentCommits ?? [], commitWindow);
  if (recentCommits.length === 0) {
    const fromGit = await runGitCommand(['rev-list', `--max-count=${commitWindow}`, 'HEAD']);
    recentCommits = parseCommitLines(fromGit, commitWindow);
  }

  const parsedFromId = parseRepoNameFromRepoId(repoId);
  return {
    repoId,
    owner: descriptor?.owner ?? parsedFromId.owner,
    name: descriptor?.name ?? parsedFromId.name,
    recentCommits,
  };
}
