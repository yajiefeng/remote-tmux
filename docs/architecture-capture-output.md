# 架构文档 — Screen Capture & Output Pipeline

## 概述

remote-tmux 通过 **screen-scraping** 方式把 tmux 终端画面实时传输到浏览器。
不直接转发 tmux 的 raw 输出流，而是定时截屏（capture-pane），获取渲染后的完整画面。

## 数据流

```
tmux pane
  │
  ├─ pipe-pane → 输出文件 → tail -f (检测活动)
  │                              │
  │                              ▼
  │                     activityDetected = true
  │
  ├─ capture-pane -pe -S -500  ← 每 50ms 轮询（仅在有活动时执行）
  │         │
  │         ▼
  │   screen (500行scrollback + 可见区域，带escape序列)
  │         │
  │         ├─ 和 lastScreen 比较 → 相同则跳过
  │         │
  │         ▼
  │   data = "\x1b[2J\x1b[H" + screen + "\x1b[y;xH"
  │         │
  │         ├─ RingBuffer.append(data) → seq 号
  │         │
  │         ▼
  │   broadcast → 所有 readyState=1 的 WebSocket 客户端
  │
  └─ capture-pane -pe -S -500  ← snapshot（连接/切换session时）
            │
            ▼
      { screen, cursor(seq), cursorX, cursorY }
```

## 核心模块

### 1. `captureAndBroadcast()` — 实时输出

位置：`src/core/session-manager.ts` → `startOutputReader()`

```
触发条件: pipe-pane stdout 有数据 → activityDetected = true
轮询间隔: setInterval 50ms
```

**每帧输出格式：**
```
\x1b[2J     ← ED: 清除整个屏幕
\x1b[H      ← CUP: 光标移到 (1,1)
{screen}    ← 500行scrollback + 可见区域（带ANSI颜色/样式escape序列）
\x1b[y;xH   ← CUP: 恢复光标位置
```

**关键行为：**

| 行为 | 说明 |
|------|------|
| `\x1b[2J` 清屏 | xterm.js 把当前可见内容推入 scrollback，然后清空可见区域 |
| 写入 500+ 行 | 前 ~460 行从 `\x1b[H` 开始写，超出可见区域后自然滚入 scrollback |
| 每帧重建 scrollback | xterm.js 的 scrollback 每帧被完整重建，永远和 tmux 一致 |
| screen 未变则跳过 | `lastScreen` 缓存上一帧，内容相同时不发送 |
| 500 行 scrollback | `tmuxCapturePaneEscape()` 默认参数，包含 tmux 滚出可见区域的历史 |

**`\x1b[2J` 的三重作用：**
1. 清除旧画面（视觉）
2. 把旧内容推入 xterm.js scrollback（维护历史）
3. 为全量写入腾出空间（下一帧从第1行开始）

**代价**：每帧清屏导致可见的闪烁。

### 2. `snapshot()` — 连接时恢复画面

位置：`src/core/session-manager.ts`

```typescript
tmuxCapturePaneEscape(session.tmuxName)  // 默认 500 行 scrollback
tmuxGetCursorPosition(session.tmuxName)  // 光标 x, y
```

返回 `{ screen, cursor(seq), cursorX, cursorY }`。
和 `captureAndBroadcast` 用完全相同的 capture 函数和参数。

### 3. `loadHistory()` — 客户端恢复逻辑

位置：`src/server.ts`（内联前端 JS）

**两种模式：**

| 场景 | 处理 |
|------|------|
| 新 session / 切换 session | `term.reset()` → fetch snapshot → `term.write(screen)` → 设置光标 |
| 重连同一 session | 增量 fetch：`/history?after=lastSeq` → 按 seq 回放 |

**防重复机制：**
- `historyLoaded` flag：加载中的实时输出暂存到 `pendingOutputs`
- 加载完后 flush `pendingOutputs`，按 `seq > lastSeq` 去重
- 实时 output 也按 `seq > lastSeq` 过滤

### 4. `tmuxCapturePaneEscape()` — tmux 截屏

位置：`src/core/tmux.ts`

```bash
tmux capture-pane -p -e -S -{scrollbackLines} -t {name}:0.0
```

- `-p`：输出到 stdout
- `-e`：包含 escape 序列（颜色、样式）
- `-S -500`：从 scrollback 第 -500 行开始（即最多 500 行历史）
- 输出 `\n` 分隔，转换为 `\r\n`（xterm.js 需要 CR+LF 回到第一列）
- **不去除尾部空行**：空行用于对齐 tmux 可见区域和光标位置

### 5. `RingBuffer` — 输出历史

位置：`src/core/ring-buffer.ts`

- 固定容量环形缓冲区（默认 100 个 chunk）
- 每个 chunk: `{ seq, data, timestamp }`
- `seq` 单调递增，不受 wrap 影响
- 用于断线重连时的增量回放

### 6. `broadcast()` — WebSocket 广播

位置：`src/core/session-manager.ts`

- 遍历 `session.clients`，只发给 `readyState === 1`（OPEN）的连接
- 消息格式：`JSON.stringify({ type: "output", data, seq })`

## tmux scrollback vs xterm.js scrollback

这是两个独立的 scrollback：

| | tmux scrollback | xterm.js scrollback |
|---|---|---|
| 位置 | 服务端 tmux 进程内 | 客户端浏览器内存 |
| 内容 | 真正滚出 tmux 可见区域的行 | 每帧 `\x1b[2J` 推入的旧画面 |
| 大小 | tmux `history-limit`（默认 2000） | xterm.js `scrollback`（默认 5000） |
| 抓取 | `capture-pane -S -500` 读取 | 用户在浏览器中向上滚动查看 |

**当前实现下**，xterm.js scrollback 每帧被重建（`\x1b[2J` 推旧 → 写新 500 行）。
所以 xterm.js scrollback 的内容和 tmux scrollback 基本一致。

## 已知问题

### 1. 闪烁
每帧 `\x1b[2J` 清屏导致可见闪烁。这是当前实现为了维护 scrollback 付出的代价。

### 2. 滚动时被拉回底部
客户端没有滚动冻结机制。用户向上滚动查看历史时，下一帧的 `term.write()` 会把视口拉回底部。

### 3. 全量传输
每帧发送 500+ 行全量内容（即使只有一个字符变化），带宽开销大。

## 变更注意事项

**修改 `captureAndBroadcast` 的输出格式时，必须同时保证：**
1. 可见区域内容正确（和 tmux 一致）
2. xterm.js scrollback 持续增长（历史不丢失）
3. 重连后 snapshot 能正确恢复画面

这三个行为在当前实现中由 `\x1b[2J\x1b[H` + 全量写入共同实现。
去掉其中任何一部分都会破坏其他行为。参见 `test/capture-broadcast.test.ts`。
