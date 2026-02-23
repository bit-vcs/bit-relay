# bit-relay Usage Guide

A guide to sharing repositories, managing issues, and collaborating through bit-relay. Assumes
familiarity with Git.

## Install

```bash
# Shell script (Mac/Linux)
curl -fsSL https://raw.githubusercontent.com/bit-vcs/bit/main/install.sh | bash

# MoonBit package manager
moon install bit-vcs/bit/cmd/bit
```

```bash
bit --version
```

## Quick Start

### Create a repo and share issues

```bash
# Create a repository
mkdir my-project && cd my-project
bit init
echo "# My Project" > README.md
bit add . && bit commit -m "initial commit"

# Initialize issue tracking
bit issue init

# Create an issue
bit issue create -t "Login page crashes on special characters" -b "Crash on special char input"

# Push issues to relay
bit relay sync push relay+https://bit-relay.mizchi.workers.dev
```

### Serve the repo via relay

```bash
bit relay serve relay+https://bit-relay.mizchi.workers.dev
# => Clone URL: relay+https://bit-relay.mizchi.workers.dev/AbCdEfGh
```

### The other side clones and fetches issues

```bash
bit clone relay+https://bit-relay.mizchi.workers.dev/AbCdEfGh
cd AbCdEfGh
bit issue init
bit relay sync fetch relay+https://bit-relay.mizchi.workers.dev
bit issue list
```

That's it — repositories and issues shared without GitHub.

## Why bit

The Git protocol was originally designed as a decentralized storage system. In practice, however,
GitHub has become the de facto authoritative server. This is convenient for choosing stable
branches, but it doesn't match the development cycle that assumes the high-speed productivity of AI
agents. We believe developers should be able to create branches more freely, choose their own
upstreams, and that many forks with different purposes should naturally emerge.

The author of bit has no political stance on decentralization. It's simply that there is a technical
advantage in the development workflow. In the end, P2P-developed code will likely be synced to
GitHub for operational convenience, and volatile P2P caches lack the reliability needed for
long-term storage.

bit + bit-relay is implemented as a P2P relay server. The intent is to realize Git as the
distributed storage it was originally meant to be — autonomous AI agents join development nodes via
the bit protocol, broadcast their changes, and each participant independently decides what to adopt.
Think of it as the open-source developer model: directed autonomous agents explore possibilities,
and humans review the results and selectively incorporate them. Decentralized Git is needed to
accelerate this cycle.

Concretely, while `bit relay serve` is running, changes made by P2P peers are automatically stored
in `.git/objects` and `refs/relay/incoming/...` (with configurable size limits). Users and AI agents
can then cherry-pick whichever changes they find useful from local storage. If this model works
well, the most useful branch should function as the de facto fast-forward — similar to how a
blockchain's longest chain becomes canonical.

That said, only basic fetch/clone/sync/PR mechanisms exist today. Many features are still needed:

- Synchronization between multiple relay servers
- Sharing PRs/issues with GitHub
- Closed/private localhost relays
- Relay servers caching data for days as backup
- Prompts for teaching AI agents this development cycle

This is currently being developed as a hobby-level PoC, and we are looking for people and companies
to support the project. What's lacking: the effort needed to guarantee full compatibility with Git,
SDKs and documentation for integration, and practical knowledge from running agent clusters in
production.

If this concept resonates with you, reach out at https://x.com/mizchi.

## Key Concepts

### bit — Git Implementation

bit is a Git implementation written in MoonBit. Compatible with Git except for a few unsupported
features (e.g., `--object-hash=sha256`). Existing Git repositories work with bit as-is, and vice
versa.

### hub — Decentralized Issue/PR Management

In GitHub, issues and PRs live on the GitHub server. In bit, they are stored **inside the
repository** as Git notes (`refs/notes/bit-hub`).

- Issues/PRs become part of the repository data, not tied to any hosting platform
- Can be synced between peers without a central server
- `bit issue init` initializes the metadata store in any git repository

### relay — Relay Server for Sharing

bit-relay is a lightweight relay server that solves two problems:

1. **Repository sharing across NAT/firewalls**: `bit relay serve` exposes a local repository through
   the relay. Others can `bit clone` from it — no port forwarding needed
2. **Hub metadata sync**: `bit relay sync push/fetch` publishes and retrieves issues/PRs through the
   relay

```
┌──────────┐                      ┌───────────┐
│  Alice    │──relay serve────────│           │────clone────▶ Bob
│  (host)   │──sync push──────▶  │  bit-relay │                │
│           │                     │  (server)  │◀──sync fetch── │
└──────────┘                      └───────────┘
```

Code (blobs/trees/commits) transfers via `serve`/`clone`. Hub metadata (issues/PRs) transfers via
`sync push`/`sync fetch`. These are independent operations.

The default relay is the public instance deployed from this project
(`bit-relay.mizchi.workers.dev`). You can also deploy your own — see
[Hosting bit-relay](./host-bit-relay.md).

### sender — Your Identity

A `sender` is your identifier on the relay (e.g., `alice`). Combined with an Ed25519 signing key, it
proves who published a message. With GitHub verification, your sender name maps to a GitHub
username, enabling named sessions like `alice/my-repo`.

### session — Temporary Relay Endpoint

Running `bit relay serve` creates a session on the relay — a temporary endpoint identified by a
random ID (e.g., `AbCdEfGh`) or a named path (e.g., `alice/my-repo`). Active only while the `serve`
command is running.

## Configuration

### Environment Variables

```bash
# Relay URL (default for serve/sync commands)
export BIT_RELAY_URL=relay+https://bit-relay.mizchi.workers.dev

# Sender ID
export BIT_RELAY_SENDER=alice

# Signing key file path (optional)
export BIT_RELAY_SIGN_PRIVATE_KEY_FILE=~/.config/bit/relay-key.pem
```

### Generating a Signing Key (Optional)

```bash
# Generate Ed25519 private key
openssl genpkey -algorithm Ed25519 -out ~/.config/bit/relay-key.pem

# Extract public key in base64url format
openssl pkey -in ~/.config/bit/relay-key.pem -pubout -outform DER \
  | base64 | tr '+/' '-_' | tr -d '='
```

### GitHub Username Verification

Link your signing key to your GitHub account for identity verification. Matches your Ed25519 key
against your GitHub SSH keys.

```bash
# Register key and verify against GitHub SSH keys
# (requires BIT_RELAY_SENDER and BIT_RELAY_SIGN_PRIVATE_KEY_FILE)
bit relay sync push relay+https://bit-relay.mizchi.workers.dev
```

Once verified, relay sessions use named paths (e.g., `alice/my-repo`) instead of random IDs.

### relay serve Options

| Option                | Description                                                  |
| --------------------- | ------------------------------------------------------------ |
| `--allow-remote-push` | Accept pushes from remote (stored in `refs/relay/incoming/`) |
| `--auto-fetch`        | Auto-fetch when feature broadcasts are detected              |
| `--repo <name>`       | Advertise a repository name (enables named sessions)         |

### Relay URL Formats

| Format                  | Behavior                                        |
| ----------------------- | ----------------------------------------------- |
| `relay+https://host`    | Use relay API directly (TLS)                    |
| `relay+http://host`     | Use relay API directly (no TLS, for local dev)  |
| `https://host/repo.git` | Try smart-http first, fall back to relay on 404 |

## Full Workflow: Alice and Bob

### Alice (Host)

```bash
# 1. Create and initialize repository
mkdir my-project && cd my-project
bit init
echo "# My Project" > README.md
bit add . && bit commit -m "initial commit"
bit issue init

# 2. Create an issue
bit issue create -t "Authentication fails with unicode passwords" \
  -b "Users with unicode characters in passwords cannot log in"

# 3. Push hub data to relay
bit relay sync push relay+http://localhost:8788

# 4. Serve the repository (keep running)
bit relay serve relay+http://localhost:8788
# => Clone URL: relay+http://localhost:8788/AbCdEfGh
```

### Bob (Client)

```bash
# 1. Clone from relay
bit clone relay+http://localhost:8788/AbCdEfGh
cd AbCdEfGh

# 2. Initialize hub locally
bit issue init

# 3. Fetch hub data from relay
bit relay sync fetch relay+http://localhost:8788

# 4. View issues and pull requests
bit issue list
bit pr list
```

## bithub — Web UI for bit

[bithub](https://github.com/bit-vcs/bithub) is a web server that integrates with bit to provide a
GitHub-like UI. Currently under development.

- Browse repositories via web interface (`/blob/<path>`, `/issues`, etc.)
- View issues synced via bit-relay
- Discover other bithub nodes via relay (`/relay`)
- Runs on Cloudflare Workers or as a local server

```bash
# Launch a local viewer for the current repository
./bithub .

# With relay integration
./bithub . --relay relay+https://bit-relay.mizchi.workers.dev
```

## Planned Integrations

- [sprites.dev](https://sprites.dev) — Lightweight container platform. Planned as a deployment
  target for relay servers and bithub instances.
- [exe.dev](https://exe.dev) — Remote execution environment. Planned for running AI agent clusters
  that participate in the bit P2P development workflow.

## Troubleshooting

- **"session not found"**: The host's `bit relay serve` may have stopped. Ask the host to restart
  it.
- **Signature errors**: Check that `BIT_RELAY_SENDER` and `BIT_RELAY_SIGN_PRIVATE_KEY_FILE` are set
  correctly. For testing, use a relay started with `RELAY_REQUIRE_SIGNATURE=false`.
- **Connection refused**: Verify the relay URL and that the server is running
  (`curl <relay-url>/health`).
