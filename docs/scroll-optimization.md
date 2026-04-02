# 滚动优化方案

## 问题描述

用户在手机浏览器中向上滚动查看终端历史时，画面抖动严重、不流畅。

## 根因分析

当前输出架构是 **screen-scraping**：

```
tmux pipe-pane 检测活动 → 每 50ms capture-pane → 清屏 + 全量重写 → WS 广播
```

每帧发送的数据是：

```
\x1b[2J\x1b[H   ← 清屏 + 光标归位
{整屏内容}       ← 全量重写
\x1b[y;xH       ← 光标定位
```

导致三个问题：

1. **`\x1b[2J` 清屏导致闪烁** — xterm.js 先清空再写入，两步之间有视觉间隙
2. **scrollback buffer 被扰动** — 全屏重写改变 buffer 内容，用户的滚动视口被打断
3. **无差分、每帧全量** — 即使只有一个字符变化也重写整屏（120×36 = 4320 字符）

## 方案概览

三个方案**互补叠加**，共同解决问题，都需要实施：

| 编号 | 方案 | 解决的层面 | 改动量 |
|------|------|-----------|--------|
| P0-1 | 服务端差分输出 | 消除 `\x1b[2J` 清屏闪烁 | 中 |
| P0-2 | 客户端滚动冻结 | 用户浏览历史时不被拉回底部 | 小 |
| P1-1 | 自适应 capture 频率 | 空闲时减少无效 capture 开销 | 小 |

- P0-1 单独做：不闪了，但用户滚动时新数据写入仍干扰视口位置
- P0-2 单独做：不跳了，但画面还是每帧全屏闪烁
- P1-1 单独做：只降低 CPU，不解决体验问题

建议实施顺序：P0-2 → P0-1 → P1-1（按改动量从小到大）

---

## P0-1: 服务端差分输出

### 目标

把「清屏 + 全量重写」改为「逐行对比 + 只更新变化行」。

### 修改文件

`src/core/session-manager.ts` — `startOutputReader` 中的 `captureAndBroadcast`

### 当前代码

```typescript
const captureAndBroadcast = async (): Promise<void> => {
  if (!activityDetected) return
  activityDetected = false
  try {
    const [screen, pos] = await Promise.all([
      tmuxCapturePaneEscape(session.tmuxName),
      tmuxGetCursorPosition(session.tmuxName),
    ])
    if (screen === lastScreen) return
    lastScreen = screen
    // 全屏清除 + 重写
    const cursorSeq = `\x1b[${pos.y + 1};${pos.x + 1}H`
    const data = "\x1b[2J\x1b[H" + screen + cursorSeq
    const seq = session.buffer.append(data)
    this.broadcast(session, { type: "output", data, seq })
  } catch {
    // tmux pane might be gone
  }
}
```

### 改为

```typescript
const captureAndBroadcast = async (): Promise<void> => {
  if (!activityDetected) return
  activityDetected = false
  try {
    const [screen, pos] = await Promise.all([
      tmuxCapturePaneEscape(session.tmuxName),
      tmuxGetCursorPosition(session.tmuxName),
    ])
    if (screen === lastScreen) return

    const oldLines = lastScreen.split("\r\n")
    const newLines = screen.split("\r\n")
    lastScreen = screen

    const patches: string[] = []

    // 逐行对比，只发送变化的行
    const maxLen = Math.max(oldLines.length, newLines.length)
    for (let i = 0; i < maxLen; i++) {
      const oldLine = i < oldLines.length ? oldLines[i] : undefined
      const newLine = i < newLines.length ? newLines[i] : undefined

      if (newLine === undefined) {
        // 新屏幕更短，清除多余行
        patches.push(`\x1b[${i + 1};1H\x1b[2K`)
      } else if (oldLine !== newLine) {
        // 行内容变化：定位到行首 + 清除该行 + 写新内容
        patches.push(`\x1b[${i + 1};1H\x1b[2K${newLine}`)
      }
    }

    if (patches.length === 0) return

    const cursorSeq = `\x1b[${pos.y + 1};${pos.x + 1}H`
    const data = patches.join("") + cursorSeq
    const seq = session.buffer.append(data)
    this.broadcast(session, { type: "output", data, seq })
  } catch {
    // tmux pane might be gone
  }
}
```

### 注意事项

- **首帧处理**：`lastScreen` 初始为 `""`，首次 capture 时所有行都是 diff，等价于全量写入（但不带 `\x1b[2J`）。需要确保首帧前 xterm.js 是干净状态（`term.reset()` 已在 `loadHistory` 中处理）。
- **snapshot 接口不受影响**：`/api/sessions/:id/snapshot` 返回的是一次性全屏数据，仍然用 `\x1b[2J\x1b[H` 是合理的（只在会话切换/首次连接时调用一次）。
- **RingBuffer 历史重放**：重放时数据是差分的，客户端按序回放即可还原完整画面。

---

## P0-2: 客户端滚动冻结

### 目标

用户向上滚动查看历史时，暂停自动跟随底部；停止滚动后自动恢复。

### 修改文件

`src/server.ts` — 内联前端 JS 部分

### 新增代码

在 `term.open(...)` 之后，`ws.onmessage` 之前：

```javascript
// --- 滚动状态跟踪 ---
let userScrolling = false;
let scrollResumeTimer = null;
const SCROLL_RESUME_DELAY = 3000; // 停止滚动 3 秒后恢复跟随

// 检测用户是否在查看历史（视口不在底部）
function isAtBottom() {
  const buf = term.buffer.active;
  return buf.viewportY >= buf.baseY;
}

// xterm.js 视口滚动事件
term.onScroll(function() {
  if (!isAtBottom()) {
    userScrolling = true;
    if (scrollResumeTimer) clearTimeout(scrollResumeTimer);
    scrollResumeTimer = setTimeout(function() {
      userScrolling = false;
      term.scrollToBottom();
    }, SCROLL_RESUME_DELAY);
  } else {
    userScrolling = false;
    if (scrollResumeTimer) {
      clearTimeout(scrollResumeTimer);
      scrollResumeTimer = null;
    }
  }
});
```

### 修改 output 处理

```javascript
case 'output':
  if (msg.seq > lastSeq) {
    term.write(msg.data);
    lastSeq = msg.seq;
    // ★ 不再无条件 scrollToBottom
    // 只有不在滚动浏览时才跟随底部
    // （xterm.js 默认行为：写入时如果视口在底部会自动跟随）
  }
  break;
```

### 修改 loadHistory 结尾

```javascript
// 只在非滚动状态下跳到底部
if (!userScrolling) {
  term.scrollToBottom();
}
```

### 移动端触摸滚动配合

现有的 `touchmove` → `term.scrollLines()` 触摸滚动逻辑不需要改动——`term.scrollLines()` 会触发 `onScroll`，自动进入 `userScrolling` 状态。

---

## P1-1: 自适应 capture 频率

### 目标

空闲时降低 capture 频率（减少 CPU 开销），有活动时恢复高频。

### 修改文件

`src/core/session-manager.ts` — `startOutputReader`

### 当前代码

```typescript
captureTimer = setInterval(() => void captureAndBroadcast(), CAPTURE_INTERVAL_MS)
```

### 改为

```typescript
const FAST_INTERVAL = 50    // 有活动时 50ms（~20fps）
const SLOW_INTERVAL = 200   // 空闲时 200ms（~5fps）
const IDLE_THRESHOLD = 3    // 连续 N 帧无变化后切换到慢速

let unchangedFrames = 0

function scheduleCapture(): void {
  const interval = unchangedFrames >= IDLE_THRESHOLD
    ? SLOW_INTERVAL
    : FAST_INTERVAL

  captureTimer = setTimeout(() => {
    captureAndBroadcast()
      .then(() => {
        if (!session.tailProcess) return // session 已销毁
        scheduleCapture()
      })
      .catch(() => {
        if (!session.tailProcess) return
        scheduleCapture()
      })
  }, interval)
}

// 在 captureAndBroadcast 内部更新计数器：
// if (screen === lastScreen) { unchangedFrames++; return }
// unchangedFrames = 0

scheduleCapture()
```

### 清理

`tail.on("exit", ...)` 中的清理也需要适配：

```typescript
tail.on("exit", () => {
  if (captureTimer) clearTimeout(captureTimer)  // clearInterval → clearTimeout
  captureTimer = null
  console.log(`[session ${session.sessionId}] tail process exited`)
})
```

---

## 验证方法

### 闪烁测试

1. 连接到一个正在运行 `top` 或 `htop` 的会话
2. 观察画面是否还有整屏闪烁（差分前 vs 差分后对比）

### 滚动测试

1. 在会话中执行 `seq 1 1000` 生成大量输出
2. 再执行一个持续输出的命令（如 `ping localhost`）
3. 在手机上往上滚动查看 `seq` 的历史输出
4. 验证：画面不应跳回底部，停止滚动 3 秒后自动恢复

### 性能测试

1. 连接会话但不做任何操作
2. 观察服务端 CPU 占用（自适应频率应该从 20fps 降到 5fps）

---

## 参考

- 方案灵感来自 [claude-code](https://github.com/anthropics/claude-code) 的 `src/ink/render-node-to-output.ts` — DECSTBM 硬件滚动 + blit-shift 差分渲染
- xterm.js scrollback API: `term.buffer.active.viewportY` / `term.buffer.active.baseY`
- ANSI escape 参考: `\x1b[{r};{c}H` (CUP), `\x1b[2K` (EL, 清除整行), `\x1b[2J` (ED, 清屏)
