# Pack Splitting and Integrity Strategy

This note defines the baseline strategy for handling large git pack payloads in cache storage
(memory/R2) without requiring a single giant object write/read.

## Goals

- Keep clone/fetch cache hits possible when origin nodes are down.
- Avoid large-object write failures by chunking pack payloads.
- Verify chunk-level and whole-pack integrity before serving cached data.
- Keep implementation compatible with the existing `CacheStore` contract.

## Storage Model

- Manifest key: `pack-manifest/<session_or_repo>/<request_hash>`
- Chunk key: `pack-chunk/<manifest_hash>/<index>`
- Manifest payload fields:
  - `version` (integer)
  - `total_size`
  - `chunk_size`
  - `chunk_count`
  - `pack_sha256` (whole payload digest)
  - `chunk_sha256[]` (ordered list)
  - `content_type`
  - `updated_at`

Chunk size baseline:

- default: `4 MiB`
- configurable range: `1 MiB` to `16 MiB`

## Write Path

1. Stream response body and cut fixed-size chunks.
2. Compute SHA-256 for each chunk and for the whole payload.
3. Write all chunks (`pack-chunk/*`).
4. Write manifest (`pack-manifest/*`) last.
5. Treat missing manifest as incomplete write and ignore orphan chunks via GC.

## Read Path

1. Load manifest by request hash.
2. Load chunks in index order.
3. Verify each chunk hash against `chunk_sha256[]`.
4. Recompute whole payload SHA-256 and compare with `pack_sha256`.
5. If verification passes, stream reconstructed payload to client.
6. If verification fails, delete manifest (and optionally bad chunks) and fall back to live path.

## Integrity/Recovery Rules

- Manifest is the commit marker. No manifest means cache miss.
- Any missing chunk or hash mismatch invalidates the whole manifest.
- Failed manifest should be tombstoned to prevent repeated bad hits.
- GC may delete orphan chunks that are not referenced by a live manifest.

## GC/TTL Interaction

- TTL applies to manifest timestamp.
- When a manifest expires, its referenced chunks become GC candidates.
- Capacity eviction is manifest-first:
  - evict oldest manifests
  - then collect unreferenced chunks

## Validation Plan

- Unit:
  - manifest encode/decode and hash verification
  - chunk ordering and reconstruction
- E2E:
  - large pack clone fallback from cache
  - corruption case (one chunk modified) must degrade to live fetch
  - interrupted write (chunks exist, manifest missing) must behave as cache miss
