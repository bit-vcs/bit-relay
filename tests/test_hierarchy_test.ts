import { assertEquals } from '@std/assert';
import { getAllLayerTests, TEST_HIERARCHY } from './test_hierarchy.ts';

const EXPECTED_TEST_FILES = [
  'tests/admin_github_api_test.ts',
  'tests/cache_exchange_api_test.ts',
  'tests/cache_exchange_test.ts',
  'tests/cache_issue_pull_test.ts',
  'tests/cache_issue_sync_test.ts',
  'tests/cache_persistence_queue_test.ts',
  'tests/cache_store_contract_test.ts',
  'tests/cache_sync_worker_test.ts',
  'tests/e2e_agent_collaboration_test.ts',
  'tests/e2e_cache_sync_test.ts',
  'tests/e2e_chunk_exchange_test.ts',
  'tests/e2e_content_addressed_sync_test.ts',
  'tests/e2e_git_cache_fallback_test.ts',
  'tests/e2e_github_admin_dispatch_test.ts',
  'tests/e2e_github_signature_permissions_test.ts',
  'tests/e2e_issue_cache_fallback_test.ts',
  'tests/e2e_multi_node_test.ts',
  'tests/e2e_relay_scenarios_test.ts',
  'tests/git_cache_layer_test.ts',
  'tests/git_serve_session_test.ts',
  'tests/github_issue_webhook_test.ts',
  'tests/github_keys_test.ts',
  'tests/github_relay_target_test.ts',
  'tests/github_transport_test.ts',
  'tests/issue_projection_test.ts',
  'tests/issue_sync_engine_test.ts',
  'tests/mcp_server_test.ts',
  'tests/presence_test.ts',
  'tests/relay_cache_adapter_test.ts',
  'tests/relay_contract_test.ts',
  'tests/relay_handler_test.ts',
  'tests/relay_observability_test.ts',
  'tests/repository_affinity_test.ts',
  'tests/review_test.ts',
  'tests/runtime_config_test.ts',
  'tests/trigger_callback_test.ts',
  'tests/trigger_dispatcher_test.ts',
  'tests/trigger_incoming_ref_integration_test.ts',
  'tests/ws_broadcast_test.ts',
].sort((a, b) => a.localeCompare(b));

Deno.test('test hierarchy covers all test files without overlap', () => {
  const flattened = Object.values(TEST_HIERARCHY).flatMap((files) => files);
  const unique = [...new Set(flattened)];
  assertEquals(unique.length, flattened.length);
  assertEquals(unique.sort((a, b) => a.localeCompare(b)), EXPECTED_TEST_FILES);
  assertEquals(getAllLayerTests(), EXPECTED_TEST_FILES);
});

Deno.test('e2e layer contains only e2e test files', () => {
  for (const path of TEST_HIERARCHY.e2e) {
    assertEquals(path.startsWith('tests/e2e_'), true);
  }
});
