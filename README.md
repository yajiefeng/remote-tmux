# remote-tmux

Control Mac terminal sessions from your phone browser. Shell runs inside tmux — sessions survive server restarts.

[中文文档](README_cn.md)

## Features

- **tmux Persistence** — Shell processes run inside tmux. Server restarts auto-reattach existing sessions without losing terminal content
- **Real-time Terminal** — xterm.js frontend + WebSocket for bidirectional I/O with color, cursor, and CJK wide character support
- **Disconnect Recovery** — Auto-reconnect with countdown, RingBuffer history replay, seq-based deduplication for consistent state
- **Multi-session** — Create, switch, and delete multiple terminal sessions from the browser
- **Mobile Optimized** — Soft keyboard adaptation, landscape mode maximization, shortcut bar (Tab / Ctrl-C / Ctrl-D / ↑ / ↓ / Esc / Paste)
- **Security** — Static token auth, per-IP rate limiting, audit logging (JSONL)
- **Idle Cleanup** — Auto-destroy sessions after configurable idle timeout with no connected clients
- **Self-hosted Font** — Maple Mono NF CN (woff2, ~6MB) with CJK and Nerd Font icon support

## Installation

### Prerequisites

- **Node.js** >= 20
- **tmux** — on macOS:

```bash
brew install tmux
```

### From Source

```bash
git clone https://github.com/user/remote-tmux.git
cd remote-tmux
npm install

# Start dev server
export WEBSHELL_TOKEN=your_secret_token
npx tsx src/cli.ts
```

### Build & Run

```bash
npm run build

WEBSHELL_TOKEN=your_secret_token node dist/cli.js
```

## Quick Start

```bash
export WEBSHELL_TOKEN=your_secret_token
npx tsx src/cli.ts

# Open in browser
# http://localhost:3000?token=your_secret_token
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `WEBSHELL_TOKEN` | (required) | Auth token |
| `WEBSHELL_PORT` | `3000` | Listen port |
| `WEBSHELL_HOST` | `0.0.0.0` | Listen address |
| `WEBSHELL_COLS` | `120` | Default terminal columns |
| `WEBSHELL_ROWS` | `36` | Default terminal rows |
| `WEBSHELL_BUFFER_SIZE` | `50000` | RingBuffer max chunks |
| `WEBSHELL_MAX_INPUT` | `4096` | Max input bytes per message |
| `WEBSHELL_PING_TIMEOUT` | `45000` | WS heartbeat timeout (ms) |
| `WEBSHELL_RATE_LIMIT_MAX` | `60` | Max requests per window |
| `WEBSHELL_RATE_LIMIT_WINDOW` | `10000` | Rate limit window (ms) |
| `WEBSHELL_AUDIT_LOG` | (empty=disabled) | Audit log file path |
| `WEBSHELL_IDLE_TIMEOUT` | `0` (disabled) | Idle timeout (ms), auto-cleanup session |

## Mobile Access

On the same WiFi, use Mac's local IP:

```bash
# Get local IP
ipconfig getifaddr en0

# Open on phone
# http://192.168.x.x:3000?token=your_secret_token
```

For cross-network access, see [docs/tailscale-setup.md](docs/tailscale-setup.md).

## Architecture

```
Phone Browser (xterm.js)
    │ HTTP / WebSocket
    ▼
API Server (Node.js)
    │ pipe-pane (output) / load-buffer (input)
    ▼
tmux session (shell persistence)
```

- **Output**: shell → tmux pipe-pane → file → tail -f → RingBuffer → WS broadcast
- **Input**: WS → tmux load-buffer + paste-buffer (serial queue for ordering)
- **Reconnect**: tmux capture-pane plain text snapshot + RingBuffer history replay

## Project Structure

```
src/
├── cli.ts                  # Entry point
├── server.ts               # HTTP/WS server + inline frontend
├── config.ts               # Env-based configuration
├── types.ts                # Shared types
├── core/
│   ├── session-manager.ts  # Session lifecycle, tmux + pipe-pane I/O
│   ├── ring-buffer.ts      # Output history ring buffer
│   ├── tmux.ts             # tmux command wrappers
│   └── idle-monitor.ts     # Idle timeout monitor
├── middleware/
│   ├── auth.ts             # Token authentication
│   ├── rate-limiter.ts     # Per-IP rate limiting
│   └── audit-logger.ts     # Audit logging (JSONL)
└── routes/
    ├── sessions.ts         # REST API
    └── ws-terminal.ts      # WebSocket terminal
```

## Testing

```bash
npm test
```

## License

MIT
