# bit-relay Usage Guide

A step-by-step guide to sharing repositories, managing issues, and collaborating through bit-relay. This guide assumes familiarity with Git.

## Why bit

The Git protocol was originally designed as a decentralized storage system. In practice, however, GitHub has become the de facto authoritative server. This is convenient for choosing stable branches, but it doesn't match the development cycle that assumes the high-speed productivity of AI agents. We believe developers should be able to create branches more freely, choose their own upstreams, and that many forks with different purposes should naturally emerge.

The author of bit has no political stance on decentralization. It's simply that there is a technical advantage in the development workflow. In the end, P2P-developed code will likely be synced to GitHub for operational convenience, and volatile P2P caches lack the reliability needed for long-term storage.

bit + bit-relay is implemented as a P2P relay server. The intent is to realize Git as the distributed storage it was originally meant to be — autonomous AI agents join development nodes via the bit protocol, broadcast their changes, and each participant independently decides what to adopt. Think of it as the open-source developer model: directed autonomous agents explore possibilities, and humans review the results and selectively incorporate them. Decentralized Git is needed to accelerate this cycle.

Concretely, while `bit relay serve` is running, changes made by P2P peers are automatically stored in `.git/objects` and `refs/relay/incoming/...` (with configurable size limits). Users and AI agents can then cherry-pick whichever changes they find useful from local storage. If this model works well, the most useful branch should function as the de facto fast-forward — similar to how a blockchain's longest chain becomes canonical.

That said, only basic fetch/clone/sync/PR mechanisms exist today. Many features are still needed:

- Synchronization between multiple relay servers
- Sharing PRs/issues with GitHub
- Closed/private localhost relays
- Relay servers caching data for days as backup
- Prompts for teaching AI agents this development cycle

This is currently being developed as a hobby-level PoC, and we are looking for people and companies to support the project. What's lacking: the effort needed to guarantee full compatibility with Git, SDKs and documentation for integration, and practical knowledge from running agent clusters in production.

If this concept resonates with you, reach out at https://x.com/mizchi.

## Key Concepts

bit extends Git with platform-independent collaboration features. Before diving into the workflow, here are the concepts that differ from a typical Git + GitHub setup.

### bit — Git Implementation

bit is a Git implementation written in MoonBit. It is compatible with Git except for a few unsupported features (e.g., `--object-hash=sha256`). Existing Git repositories can be used with bit as-is, and vice versa.

### hub — Decentralized Issue/PR Management

In a GitHub workflow, issues and pull requests live on the GitHub server. In bit, they are stored **inside the repository itself** as Git notes (`refs/notes/bit-hub`). This means:

- Issues and PRs are part of the repository data, not tied to any hosting platform
- They can be synced between peers without a central server
- `bit issue init` initializes this metadata store in any git repository

### relay — Relay Server for Sharing

bit-relay is a lightweight relay server that solves two problems:

1. **Repository sharing across NAT/firewalls**: `bit relay serve` exposes a local repository through the relay, and others can `bit clone` from it — no port forwarding needed
2. **Hub metadata sync**: `bit relay sync push/fetch` publishes and retrieves issues/PRs through the relay

```
┌──────────┐                      ┌───────────┐
│  Alice    │──relay serve────────│           │────clone────▶ Bob
│  (host)   │──sync push──────▶  │  bit-relay │                │
│           │                     │  (server)  │◀──sync fetch── │
└──────────┘                      └───────────┘
```

Code (blobs/trees/commits) transfers via `serve`/`clone`. Hub metadata (issues/PRs) transfers via `sync push`/`sync fetch`. These are independent operations.

By default, the relay URL points to the public instance deployed from this project (`bit-relay.mizchi.workers.dev`). You can also deploy your own — see [Hosting bit-relay](./host-bit-relay.md) for details.

### sender — Your Identity

A `sender` is your identifier on the relay (e.g., `alice`). Combined with an Ed25519 signing key, it proves who published a message. With GitHub verification, your sender name maps to a GitHub username, enabling named sessions like `alice/my-repo`.

### session — Temporary Relay Endpoint

When you run `bit relay serve`, the relay creates a **session** — a temporary endpoint identified by a random ID (e.g., `AbCdEfGh`) or a named path (e.g., `alice/my-repo`). The session is active as long as the `serve` command is running.

## Prerequisites

- **bit CLI** installed:
  ```bash
  # Install via shell script (Mac/Linux)
  curl -fsSL https://raw.githubusercontent.com/mizchi/bit-vcs/main/install.sh | bash

  # Or install via MoonBit package manager
  moon install mizchi/bit/cmd/bit
  ```
- A running **bit-relay** server URL (e.g., `relay+https://bit-relay.mizchi.workers.dev`)
- (Optional) An **Ed25519 signing key** for authenticated publishing

Verify your setup:

```bash
bit --version
curl https://bit-relay.mizchi.workers.dev/health
# => {"status":"ok","service":"bit-relay"}
```

## 1. Environment Setup

### Environment Variables

Configure the relay URL and sender identity via environment variables:

```bash
# Relay URL (used as default for serve/sync commands)
export BIT_RELAY_URL=relay+https://bit-relay.mizchi.workers.dev

# Your sender identity
export BIT_RELAY_SENDER=alice

# (Optional) Signing key for authenticated publishing
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

## 2. GitHub Username Verification

If the relay requires signed messages, you can link your signing key to your GitHub account. This proves your identity by matching your Ed25519 key against your GitHub SSH keys.

```bash
# Register key and verify against GitHub SSH keys
# (requires BIT_RELAY_SENDER and BIT_RELAY_SIGN_PRIVATE_KEY_FILE)
bit relay sync push relay+https://bit-relay.mizchi.workers.dev
```

Once verified, your relay sessions can use named paths (e.g., `alice/my-repo`) instead of random IDs.

## 3. Initialize a Repository

Create or navigate to a git repository and initialize hub metadata:

```bash
# Create a new repository
mkdir my-project && cd my-project
bit init
echo "# My Project" > README.md
bit add .
bit commit -m "initial commit"

# Initialize issue/PR tracking
bit issue init
```

## 4. Create Issues

Issues declare a problem or task to be addressed:

```bash
# Create an issue (describe the problem, not the solution)
bit issue create --title "Login page crashes on special characters" \
  --body "Entering special characters in the password field causes a crash"

# List issues
bit issue list
```

## 5. Publish Hub Data to Relay

Push your local hub metadata (issues, PRs, notes) to the relay server:

```bash
bit relay sync push relay+https://bit-relay.mizchi.workers.dev
```

## 6. Serve Repository via Relay

Make your repository available for remote cloning through the relay:

```bash
bit relay serve relay+https://bit-relay.mizchi.workers.dev
```

Output:

```
Session registered: abc123
Clone URL: relay+https://bit-relay.mizchi.workers.dev/abc123
```

Share the clone URL with collaborators. The session stays active while the command runs.

### Options

| Option | Description |
|--------|-------------|
| `--allow-remote-push` | Accept pushes from remote (stored in `refs/relay/incoming/`) |
| `--auto-fetch` | Auto-fetch when feature broadcasts are detected |
| `--repo <name>` | Advertise a repository name (enables named sessions) |

## 7. Clone from Relay

Collaborators can clone the served repository:

```bash
bit clone relay+https://bit-relay.mizchi.workers.dev/abc123
cd abc123
```

## 8. Fetch Hub Data from Relay

After cloning, fetch the hub metadata (issues, PRs) from the relay:

```bash
bit relay sync fetch relay+https://bit-relay.mizchi.workers.dev
```

Then inspect:

```bash
# List issues
bit issue list

# List pull requests
bit pr list
```

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

## Relay URL Formats

| Format | Behavior |
|--------|----------|
| `relay+https://host` | Use relay API directly (TLS) |
| `relay+http://host` | Use relay API directly (no TLS, for local dev) |
| `https://host/repo.git` | Try smart-http first, fall back to relay on 404 |

## Troubleshooting

- **"session not found"**: The host's `bit relay serve` may have stopped. Ask the host to restart it.
- **Signature errors**: Ensure `BIT_RELAY_SENDER` and `BIT_RELAY_SIGN_PRIVATE_KEY_FILE` are set, or use a relay with `RELAY_REQUIRE_SIGNATURE=false`.
- **Connection refused**: Verify the relay URL and that the server is running (`curl <relay-url>/health`).
