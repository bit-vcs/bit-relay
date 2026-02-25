export type TestLayer = 'contract' | 'unit' | 'integration' | 'e2e';

export const TEST_HIERARCHY: Readonly<Record<TestLayer, ReadonlyArray<string>>> = {
  contract: [
    'tests/cache_store_contract_test.ts',
    'tests/relay_contract_test.ts',
  ],
  unit: [
    'tests/cache_exchange_test.ts',
    'tests/cache_persistence_queue_test.ts',
    'tests/cache_sync_worker_test.ts',
    'tests/git_cache_layer_test.ts',
    'tests/github_keys_test.ts',
    'tests/github_relay_target_test.ts',
    'tests/github_transport_test.ts',
    'tests/issue_projection_test.ts',
    'tests/issue_sync_engine_test.ts',
    'tests/relay_cache_adapter_test.ts',
    'tests/relay_observability_test.ts',
    'tests/runtime_config_test.ts',
    'tests/repository_affinity_test.ts',
    'tests/trigger_dispatcher_test.ts',
  ],
  integration: [
    'tests/admin_github_api_test.ts',
    'tests/cache_exchange_api_test.ts',
    'tests/cache_issue_pull_test.ts',
    'tests/cache_issue_sync_test.ts',
    'tests/git_serve_session_test.ts',
    'tests/github_issue_webhook_test.ts',
    'tests/mcp_server_test.ts',
    'tests/presence_test.ts',
    'tests/relay_handler_test.ts',
    'tests/review_test.ts',
    'tests/trigger_callback_test.ts',
    'tests/trigger_incoming_ref_integration_test.ts',
    'tests/ws_broadcast_test.ts',
  ],
  e2e: [
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
  ],
};

export function getLayerTests(layer: TestLayer): string[] {
  return [...TEST_HIERARCHY[layer]];
}

export function getAllLayerTests(): string[] {
  const merged = Object.values(TEST_HIERARCHY).flatMap((entries) => entries);
  return [...new Set(merged)].sort((a, b) => a.localeCompare(b));
}
