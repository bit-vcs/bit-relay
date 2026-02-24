import { assertEquals } from '@std/assert';
import {
  decideRepositoryCompatibility,
  parseRepositoryDescriptor,
  parseRepositoryFromDiscoveryBody,
  resolveLocalRepositoryIdentity,
} from '../src/repository_affinity.ts';

Deno.test('parseRepositoryDescriptor parses github https/ssh patterns', () => {
  const httpsRepo = parseRepositoryDescriptor('https://github.com/bit-vcs/bit.git');
  assertEquals(httpsRepo?.owner, 'bit-vcs');
  assertEquals(httpsRepo?.name, 'bit');

  const sshRepo = parseRepositoryDescriptor('git@github.com:mizchi/bit.git');
  assertEquals(sshRepo?.owner, 'mizchi');
  assertEquals(sshRepo?.name, 'bit');

  const explicitRepo = parseRepositoryDescriptor('github:bit-vcs/bit');
  assertEquals(explicitRepo?.owner, 'bit-vcs');
  assertEquals(explicitRepo?.name, 'bit');
});

Deno.test('resolveLocalRepositoryIdentity prioritizes explicit repo id and commit hints', async () => {
  const identity = await resolveLocalRepositoryIdentity({
    explicitRepoId: 'bit-vcs/bit',
    explicitRecentCommits: ['aaaaaaaa', 'bbbbbbbb', 'invalid-hash', 'bbbbbbbb'],
    commitWindow: 3,
    runGitCommand: () => Promise.reject(new Error('should not be called')),
  });

  assertEquals(identity.owner, 'bit-vcs');
  assertEquals(identity.name, 'bit');
  assertEquals(identity.repoId, 'bit-vcs/bit');
  assertEquals(identity.recentCommits, ['aaaaaaaa', 'bbbbbbbb']);
});

Deno.test('parseRepositoryFromDiscoveryBody returns normalized metadata', () => {
  const parsed = parseRepositoryFromDiscoveryBody(
    {
      repository: {
        repo_id: 'bit-vcs/bit',
        owner: 'bit-vcs',
        name: 'bit',
        recent_commits: ['ABCDEF1', 'abcdef2', 'zz-not-hash'],
      },
    },
    30,
  );

  assertEquals(parsed?.repoId, 'bit-vcs/bit');
  assertEquals(parsed?.owner, 'bit-vcs');
  assertEquals(parsed?.name, 'bit');
  assertEquals(parsed?.recentCommits, ['abcdef1', 'abcdef2']);
});

Deno.test('decideRepositoryCompatibility allows forks with recent commit overlap', () => {
  const decision = decideRepositoryCompatibility(
    {
      repoId: 'bit-vcs/bit',
      owner: 'bit-vcs',
      name: 'bit',
      recentCommits: [
        'c3c3c3c',
        'c2c2c2c',
        'c1c1c1c',
      ],
    },
    {
      repoId: 'mizchi/bit',
      owner: 'mizchi',
      name: 'bit',
      recentCommits: [
        'x9x9x9x',
        'c2c2c2c',
        'x1x1x1x',
      ],
    },
  );
  assertEquals(decision.compatible, true);
  assertEquals(decision.reason, 'recent_commit_overlap');
});

Deno.test('decideRepositoryCompatibility blocks same-name repo without overlap', () => {
  const decision = decideRepositoryCompatibility(
    {
      repoId: 'bit-vcs/bit',
      owner: 'bit-vcs',
      name: 'bit',
      recentCommits: ['a1a1a1a', 'a2a2a2a', 'a3a3a3a'],
    },
    {
      repoId: 'someone/bit',
      owner: 'someone',
      name: 'bit',
      recentCommits: ['b1b1b1b', 'b2b2b2b', 'b3b3b3b'],
    },
  );
  assertEquals(decision.compatible, false);
  assertEquals(decision.reason, 'no_recent_fast_forward');
});
