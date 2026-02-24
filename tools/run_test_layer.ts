import { getAllLayerTests, getLayerTests, type TestLayer } from '../tests/test_hierarchy.ts';

const LAYERS: ReadonlySet<TestLayer> = new Set(['contract', 'unit', 'integration', 'e2e']);

function parseLayer(raw: string | undefined): TestLayer | 'all' {
  const normalized = (raw ?? 'all').trim().toLowerCase();
  if (normalized === 'all') return 'all';
  if (LAYERS.has(normalized as TestLayer)) {
    return normalized as TestLayer;
  }
  throw new Error(
    `invalid layer: ${raw ?? ''}. expected one of: all, contract, unit, integration, e2e`,
  );
}

function resolveTargets(layer: TestLayer | 'all'): string[] {
  if (layer === 'all') return getAllLayerTests();
  return getLayerTests(layer);
}

const layer = parseLayer(Deno.args[0]);
const targets = resolveTargets(layer);
const args = ['test', '--allow-net', '--allow-env', ...targets];

const cmd = new Deno.Command(Deno.execPath(), {
  args,
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
});
const result = await cmd.output();
Deno.exit(result.code);

