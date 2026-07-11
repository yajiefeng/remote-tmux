# 架构文档 — PTY Transport & Snapshot Recovery

## 概述

当前实现使用 **PTY 实时传输 + tmux 持久化**。

实时交互不再通过 `pipe-pane`/`tail -f`/高频 `capture-pane` 截屏完成，而是让 Node 通过 `@lydell/node-pty` 启动：

```bash
tmux new-session -A -s <session-name>
```

这样浏览器得到真实终端字节流，tmux 仍然负责会话存活和服务重启后的 reattach。

## 数据流

```text
Browser xterm.js
  │
  ├─ input/paste/resize → WebSocket
  │                         │
  │                         ▼
  │                  SessionManager
  │                         │
  │                         ▼
  │                  PTY write/resize
  │                         │
  │                         ▼
  │               tmux new-session -A
  │                         │
  │                         ▼
  │                      shell/TUI
  │
  └─ output ← WebSocket ← RingBuffer ← PTY onData ← tmux/shell output
```

## 实时输出

位置：`src/core/session-manager.ts`

每个 session 持有一个 PTY 进程：

```ts
pty.spawn("tmux", ["new-session", "-A", "-s", tmuxName, "-c", workspace], ...)
```

PTY 的 `onData` 事件是实时输出来源：

```ts
const seq = session.buffer.append(data)
broadcast({ type: "output", data, seq })
```

这意味着：

- 不再每帧发送完整屏幕
- 不再高频启动 `tmux capture-pane`
- `vim`/`nvim`/`top`/`pi`/Claude 等 TUI 看到更接近真实终端的流
- RingBuffer 继续用于断线后的增量回放和 seq 去重

## 输入

WebSocket 收到输入后直接写入 PTY：

```ts
session.ptyProcess.write(data)
```

粘贴输入会包一层 bracketed paste 标记：

```text
ESC[200~ + data + ESC[201~
```

## Resize

浏览器报告尺寸后，SessionManager 使用“最小客户端尺寸获胜”的策略：

```text
所有 OPEN WebSocket client 的 min(cols), min(rows)
```

尺寸变化时调用：

```ts
session.ptyProcess.resize(cols, rows)
```

tmux 会从 attached PTY 接收尺寸变化。

## Snapshot / session 切换

实时链路走 PTY，但 session 切换仍然用 `tmux capture-pane` 快速恢复当前画面：

```bash
tmux capture-pane -p -e -S -500 -t <session>:0.0
```

接口：

```text
GET /api/sessions/:id/snapshot
```

返回：

```ts
{ screen, cursor, cursorX, cursorY }
```

前端在切换 session 时先写入 snapshot，再通过 RingBuffer 的 seq 机制避免重复输出。

## 服务重启恢复

关闭 server 时：

- 关闭 WebSocket
- kill 当前 PTY attach 客户端
- **不杀 tmux session**

下次启动时：

```ts
reattachAll()
```

会扫描 `ses_*` tmux sessions，并为每个 session 重新创建一个 PTY attach 客户端。

## 安全部署建议

默认监听地址是：

```text
127.0.0.1
```

公网访问建议：

```text
Browser
  ↓
Cloudflare Access
  ↓
Cloudflare Tunnel
  ↓
127.0.0.1:<WEBSHELL_PORT>
  ↓
remote-tmux
```

不要直接把 WebShell 端口暴露到公网。
