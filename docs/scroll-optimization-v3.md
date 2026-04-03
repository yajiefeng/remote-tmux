# 滚动优化方案 v3

> 基于 v2 方案 + free-code-main（Claude Code CLI）TUI 渲染引擎的深度分析重写。
> 每个方案附完整实现伪代码、逐帧推演、测试验证方案、回退策略。

## 问题清单

| # | 问题 | 严重程度 | 用户感知 |
|---|------|----------|----------|
| 1 | 每帧 `\x1b[2J` 清屏导致闪烁 | 高 | 手机上画面持续闪烁，尤其 `top`/`htop` 等全屏程序 |
| 2 | 用户向上滚动时被拉回底部 | 高 | 无法查看历史输出，翻页体验完全不可用 |
| 3 | 触摸滚动没有惯性 | 中 | 手指离开屏幕后立即停止，不符合移动端交互习惯 |
| 4 | 50ms 固定轮询浪费资源 | 低 | 静止时仍在反复 exec tmux capture-pane |
| 5 | 每帧 540 行全量传输 | 低 | 网络带宽浪费（WiFi 下不明显，蜂窝网下可能卡顿） |

## 从 free-code-main 学到的关键经验

### 1. DEC 2026 Synchronized Output — 我们用不了，但要理解它解决了什么

free-code-main 的渲染管线用 BSU/ESU（`\x1b[?2026h` / `\x1b[?2026l`）包裹每帧输出。
终端在 BSU→ESU 之间缓冲所有写入，ESU 时一次性刷新。这让"清屏+重绘"变成原子操作——零闪烁。

**我们的场景**：xterm.js 不支持 DEC 2026。所以任何"清屏+重绘"方案在 xterm.js 中都会闪烁。
这验证了 v2 的结论：**必须避免 `\x1b[2J`，改为覆盖写入**。

### 2. `fullResetSequence_CAUSES_FLICKER` — 函数名就是警告

free-code-main 的 `log-update.ts` 中，全屏清除+重绘被封装在一个函数里，
函数名直接标注 `_CAUSES_FLICKER`。它只在三种无法避免的场景下调用：
- **resize**：viewport 尺寸变化
- **offscreen**：内容溢出 viewport 且变化发生在不可达行
- **clear**：显式清屏命令

正常帧走增量 diff，永远不会调用这个函数。

**我们的场景**：当前实现等于每帧都调用 `fullResetSequence_CAUSES_FLICKER`。

### 3. Sticky Scroll 模式 — 滚动冻结的正确实现

free-code-main 的 `ScrollBox` 组件有 `stickyScroll` 概念：
- 用户在底部时（`sticky=true`），新内容自动跟随
- 用户向上滚动（`sticky=false`），停止自动跟随
- 用户滚回底部或新内容增长到底部时，自动恢复 sticky

关键设计：**不用定时器恢复**，而是基于位置判断。用户可能在看一段很长的日志，
3 秒自动恢复会打断用户。应该让用户决定什么时候回来。

### 4. 帧调度：按需渲染而非固定轮询

free-code-main 的 Ink 引擎只在 React state 变化时触发 render，不做固定间隔轮询。
对应到我们的场景：pipe-pane 检测到活动才 capture，静止时不做任何事。
当前实现已经有 `activityDetected` 机制，但用的是 `setInterval(50ms)` 固定轮询。
应该改为递归 `setTimeout`，活跃时短间隔，空闲时长间隔。

---

## 方案详设

### P0: 去掉 `\x1b[2J` 消除闪烁

#### 原理

`p0-evaluation.md` 已经做了详细推演，结论是可行的。这里补充实现细节。

#### 当前代码（session-manager.ts:196-207）

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
        const cursorSeq = `\x1b[${pos.y + 1};${pos.x + 1}H`
        const data = "\x1b[2J\x1b[H" + screen + cursorSeq
        const seq = session.buffer.append(data)
        this.broadcast(session, { type: "output", data, seq })
    } catch {
        // tmux pane might be gone
    }
}
```

#### 改为

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
        const cursorSeq = `\x1b[${pos.y + 1};${pos.x + 1}H`
        // \x1b[H   = 光标归位到 (1,1)
        // {screen}  = 覆盖写入（不清屏，直接从第 1 行开始写）
        // \x1b[J   = 清除光标到屏幕底部（处理新帧比旧帧短的情况）
        // {cursor}  = 恢复光标位置
        const data = "\x1b[H" + screen + "\x1b[J" + cursorSeq
        const seq = session.buffer.append(data)
        this.broadcast(session, { type: "output", data, seq })
    } catch {
        // tmux pane might be gone
    }
}
```

#### 变更点

| 项 | 旧 | 新 |
|----|----|----|
| 帧前缀 | `\x1b[2J\x1b[H` | `\x1b[H` |
| 帧后缀 | `{cursorSeq}` | `\x1b[J` + `{cursorSeq}` |

就是一行字符串拼接的变化。

#### 逐帧推演（手机 viewport=13 行，capture 500+13=513 行）

**Frame 0（loadHistory snapshot 后的状态）：**
```
xterm.js scrollback: [snapshot 第 1-500 行]
xterm.js visible:    [snapshot 第 501-513 行]
baseY = 500, viewportY = 500（在底部）
```

**Frame 1（新方案）：**
```
1. \x1b[H        → cursor 移到 visible 的第 1 行第 1 列（即全局第 501 行）
2. 写 513 行     → 行 1-13: 覆盖 visible 的 13 行
                 → 行 14-513: 每行触发一次 scroll-up
                    每次 scroll-up: visible 的第 1 行被推入 scrollback
                 → 共推入 500 行到 scrollback
3. \x1b[J        → 清除 cursor 到屏幕底部（cursor 已在最后，无效果）
4. \x1b[y;xH     → 恢复光标

结果:
  scrollback: [...旧的, frame1 行 1-500]
  visible:    [frame1 行 501-513]
  baseY += 500
```

**与旧方案 Frame 1 对比：**
```
旧: \x1b[2J 把 visible 13 行清空 → 用户看到 13 行空白 → 然后被写入覆盖
新: 直接从第 1 行开始覆盖 → 用户看到旧内容被新内容逐行替换

由于 term.write() 是同步处理的，整个 513 行在一次 JS 微任务中完成，
浏览器在这期间不会触发 paint。所以用户看到的是原子替换，无闪烁。
```

#### `\x1b[J` 的必要性

正常情况下 cursor 在第 513 行（最后一行），`\x1b[J` 清除"光标到屏幕底部"无效果。

但有一个边界场景：**tmux capture 返回的行数减少**。例如：
- Frame N: tmux 输出 513 行（500 scrollback + 13 visible）
- Frame N+1: 用户执行了 `clear`，tmux 只输出 13 行（0 scrollback + 13 visible）

此时 Frame N+1 只写 13 行，覆盖了 visible 的 13 行。但旧的 scrollback 行仍然在
xterm.js 中。`\x1b[J` 确保 visible 区域中 cursor 之后没有残留内容。

不过更重要的是：即使不加 `\x1b[J`，下一帧也会从 (1,1) 重新覆盖，残留只存在一帧。
加 `\x1b[J` 是防御性代码，成本为 3 字节（`ESC [ J`），值得保留。

#### 对 RingBuffer 重连回放的影响

断线重连时，客户端按 seq 顺序回放多个 chunk：
```
chunk1: \x1b[H + screen1 + \x1b[J + cursor1
chunk2: \x1b[H + screen2 + \x1b[J + cursor2
...
chunkN: \x1b[H + screenN + \x1b[J + cursorN
```

每个 chunk 都从 (1,1) 开始覆盖写入。后一个覆盖前一个。最终结果是 chunkN 的内容。
这和旧方案（每个 chunk 用 `\x1b[2J` 清屏再写入）的最终结果完全一致。

#### 测试变更

`test/capture-broadcast.test.ts` 中的断言需要更新：

```typescript
// 旧:
expect(msg.data).toMatch(/^\x1b\[2J\x1b\[H/)
// 新:
expect(msg.data).toMatch(/^\x1b\[H/)
expect(msg.data).not.toContain("\x1b[2J")

// 新增：验证 \x1b[J 在 screen 之后、cursor 之前
expect(msg.data).toMatch(/line3\x1b\[J\x1b\[3;6H$/)
```

#### 手动验证清单

- [ ] 运行 `top`：确认无闪烁，数值每秒更新正确
- [ ] 运行 `vim`：打开文件，翻页，确认无残留行
- [ ] 执行 `clear`：确认屏幕正确清空，无残留
- [ ] 连续快速输出 `yes | head -500`：确认 scrollback 正确增长
- [ ] 断线重连：确认画面恢复正确
- [ ] 手机 Safari：确认无闪烁

#### 回退方式

一行代码改回 `"\x1b[2J\x1b[H" + screen + cursorSeq` 即可。

---

### P1: 客户端滚动冻结（Sticky Scroll）

#### 原理

借鉴 free-code-main 的 `stickyScroll` 模式：基于位置判断是否跟随，而不是定时器。

v2 方案用了 3 秒定时器自动恢复跟随。问题：
- 用户可能在阅读一段很长的日志，3 秒后突然被拉回底部
- 3 秒太短会打断用户，太长又不够及时

**正确做法**：用户滚回底部时自动恢复跟随，不用定时器。

#### 实现

在 `src/server.ts` 的内联前端 JS 中添加：

```javascript
// --- Sticky Scroll ---
var userScrolledUp = false;

// 判断是否在底部（允许 1 行误差，因为滚动事件有时不精确）
function isAtBottom() {
  var buf = term.buffer.active;
  return buf.viewportY >= buf.baseY - 1;
}

// 监听 xterm.js 的 scroll 事件
term.onScroll(function() {
  userScrolledUp = !isAtBottom();
});

// 显示"回到底部"指示器（可选，提升体验）
var scrollIndicator = document.createElement('div');
scrollIndicator.id = 'scroll-indicator';
scrollIndicator.textContent = '↓ New output';
scrollIndicator.style.cssText = 'display:none; position:fixed; bottom:60px; left:50%;' +
  'transform:translateX(-50%); background:rgba(76,175,80,0.9); color:#fff;' +
  'padding:6px 16px; border-radius:16px; font-size:13px; z-index:50;' +
  'cursor:pointer; backdrop-filter:blur(4px); transition:opacity 0.2s;';
document.body.appendChild(scrollIndicator);

scrollIndicator.addEventListener('click', function() {
  userScrolledUp = false;
  term.scrollToBottom();
  scrollIndicator.style.display = 'none';
  term.focus();
});

// 在输出时控制是否 scrollToBottom
function smartScrollToBottom() {
  if (userScrolledUp) {
    // 用户在看历史，不打扰。显示指示器
    scrollIndicator.style.display = 'block';
    return;
  }
  scrollIndicator.style.display = 'none';
  term.scrollToBottom();
}
```

然后修改所有调用 `term.scrollToBottom()` 的地方：

**1. `ws.onmessage` 中的 `output` 处理：**
```javascript
case 'output':
  if (!historyLoaded) {
    pendingOutputs.push(msg);
  } else {
    if (msg.seq > lastSeq) {
      term.write(msg.data);
      lastSeq = msg.seq;
      smartScrollToBottom();  // 替换原来可能隐含的自动滚动
    }
  }
  break;
```

**2. `loadHistory()` 结尾：**
```javascript
// History 加载完成后，总是滚到底部（这是刻意的，不受 sticky 控制）
userScrolledUp = false;
scrollIndicator.style.display = 'none';
term.scrollToBottom();
tc.style.visibility = 'visible';
term.focus();
```

**3. `handleResize()` 中：**
```javascript
function handleResize() {
  fitAddon.fit();
  if (term.cols !== lastCols || term.rows !== lastRows) {
    lastCols = term.cols;
    lastRows = term.rows;
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    }
  }
  // resize 后只在 sticky 模式下才 scrollToBottom
  smartScrollToBottom();
}
```

#### 状态机

```
                      ┌─────────────────┐
                      │  sticky (底部)   │ ← 初始状态
                      │  自动跟随新输出   │
                      └────────┬────────┘
                               │ 用户向上滚动
                               ▼
                      ┌─────────────────┐
                      │  detached (上方)  │
                      │  不跟随新输出     │
                      │  显示 ↓ 指示器   │
                      └────────┬────────┘
                               │ 用户滚回底部 / 点击指示器
                               ▼
                      ┌─────────────────┐
                      │  sticky (底部)   │
                      └─────────────────┘
```

#### 为什么不用定时器

| 方案 | 问题 |
|------|------|
| 3 秒定时器（v2） | 用户在看日志→3 秒后被拉回→需要重新翻→再被拉回，死循环 |
| 位置判断（v3） | 用户想回来就滚到底部，不想回来就一直停着 |

free-code-main 的 ScrollBox 也用位置判断：
```typescript
// render-node-to-output.ts:766-767
const atBottom = scrollTopBeforeFollow >= prevMaxScroll
if (atBottom && (node.pendingScrollDelta ?? 0) >= 0) {
```

#### 测试验证

纯客户端逻辑，无法用 vitest 测试。手动验证：

- [ ] 正常输出时：画面自动跟随到底部
- [ ] 向上滚动：画面冻结，新输出不影响视口
- [ ] 向上滚动后出现"↓ New output"指示器
- [ ] 点击指示器：跳回底部，指示器消失
- [ ] 手动滚回底部：自动恢复跟随，指示器消失
- [ ] 加载 history / 切换 session：总是跳到底部
- [ ] resize（键盘弹出/关闭）：sticky 模式下跟随，detached 模式下不跟随

#### 回退方式

删除 `scrollIndicator` 相关代码，把 `smartScrollToBottom()` 全部改回 `term.scrollToBottom()`。

---

### P2: 自适应 capture 频率

#### 原理

当前 `setInterval(50ms)` 在没有输出时仍然每 50ms 检查一次 `activityDetected`。
虽然 `activityDetected === false` 时直接 return，但 setInterval 回调本身有开销。

更重要的是：**连续无变化帧**时，应该降低 capture 频率，减少 `tmux capture-pane` 进程启动次数。

#### 实现

将 `setInterval` 改为递归 `setTimeout`，根据连续无变化帧数调整间隔：

```typescript
// 替换 startOutputReader 中的调度逻辑

const INTERVAL_ACTIVE = 50    // 有活动时的 capture 间隔
const INTERVAL_IDLE = 200     // 连续无变化后的 capture 间隔
const IDLE_THRESHOLD = 3      // 连续 N 帧无变化后切换到 idle 间隔

let unchangedFrames = 0
let captureTimer: ReturnType<typeof setTimeout> | null = null

const captureAndBroadcast = async (): Promise<void> => {
    if (!activityDetected) {
        scheduleNext()
        return
    }
    activityDetected = false
    try {
        const [screen, pos] = await Promise.all([
            tmuxCapturePaneEscape(session.tmuxName),
            tmuxGetCursorPosition(session.tmuxName),
        ])
        if (screen === lastScreen) {
            unchangedFrames++
            scheduleNext()
            return
        }
        unchangedFrames = 0
        lastScreen = screen
        const cursorSeq = `\x1b[${pos.y + 1};${pos.x + 1}H`
        const data = "\x1b[H" + screen + "\x1b[J" + cursorSeq
        const seq = session.buffer.append(data)
        this.broadcast(session, { type: "output", data, seq })
    } catch {
        // tmux pane might be gone
    }
    scheduleNext()
}

function scheduleNext(): void {
    const interval = unchangedFrames >= IDLE_THRESHOLD
        ? INTERVAL_IDLE
        : INTERVAL_ACTIVE
    captureTimer = setTimeout(() => void captureAndBroadcast(), interval)
}

// 启动
tail.stdout!.on("data", () => {
    activityDetected = true
    // 有新活动时重置 idle 计数，并且如果当前在 idle 间隔，
    // 取消当前 timer 立即调度一次（减少延迟）
    if (unchangedFrames >= IDLE_THRESHOLD && captureTimer) {
        clearTimeout(captureTimer)
        unchangedFrames = 0
        captureTimer = setTimeout(() => void captureAndBroadcast(), INTERVAL_ACTIVE)
    }
})

// 启动第一次调度
scheduleNext()

// cleanup 中改为:
tail.on("exit", () => {
    if (captureTimer) clearTimeout(captureTimer)
    // ...
})
```

#### 间隔选择依据

| 场景 | 间隔 | 原因 |
|------|------|------|
| 活跃输出（编译、日志流） | 50ms (20fps) | 对终端输出来说足够流畅 |
| 空闲（等待输入） | 200ms (5fps) | 光标闪烁频率约 500ms，200ms 足够捕获 |
| pipe-pane 新数据到达 | 立即唤醒 | 从 idle 到 active 的切换延迟 < 1ms |

#### 效果量化

假设用户 80% 时间在等待输入（idle），20% 时间在看输出（active）：

| 指标 | 旧（固定 50ms） | 新（自适应） | 改善 |
|------|-----------------|-------------|------|
| 每秒 setInterval 回调 | 20 | 5-20 | -75% idle 时 |
| 每秒 tmux capture-pane 进程 | 0-20 | 0-20 | 无变化（只在 active 时 capture） |
| 空闲时 CPU 开销 | ~0.5% | ~0.1% | -80% |
| active 响应延迟 | 50ms | 50ms | 不变 |
| idle→active 延迟 | 50ms | <1ms | 更快 |

最后一行是关键改善：旧方案在 idle 时仍然 50ms 轮询，但 `activityDetected=false` 直接 return。
新方案在 pipe-pane stdout 收到数据时立即唤醒，比等下一个 50ms interval 更快。

#### 测试变更

`test/capture-broadcast.test.ts` 中 `triggerCapture()` 需要适配 setTimeout：

```typescript
async function triggerCapture(): Promise<void> {
    lastSpawnedProc.stdout.push("x")
    // setTimeout 而非 setInterval，需要 advance 两次：
    // 1. 触发 scheduleNext 中的 setTimeout
    // 2. 等待 captureAndBroadcast 完成
    await vi.advanceTimersByTimeAsync(60)
}
```

实际上行为不变（vi.advanceTimersByTimeAsync 会处理所有到期的 timer），
但如果测试依赖了精确的 timer 触发次数，需要调整。

#### 回退方式

改回 `setInterval(50ms)` + `clearInterval`。

---

### P3: 触摸滚动惯性

#### 原理

当前触摸滚动实现：
```javascript
var delta = lastTouchY - currentY;
var lines = Math.round(delta / 15 * SCROLL_MULTIPLIER);
term.scrollLines(lines);
```

问题：
1. **无惯性**：手指离开屏幕后立即停止
2. **线性映射**：小幅移动和大幅移动的倍数相同，精细控制困难
3. **无速度追踪**：无法计算释放时的速度

#### 实现

替换整个触摸滚动 IIFE：

```javascript
(function() {
  var container = document.querySelector('#terminal-container .xterm-screen');
  if (!container) return;

  // --- 参数 ---
  var LINE_HEIGHT = 15;          // 像素/行的映射基准
  var SCROLL_MULTIPLIER = 3;     // 滑动灵敏度（比旧的 6 降低，因为加了惯性补偿）
  var DEAD_ZONE = 8;             // 死区：小于此像素不启动滚动
  var FRICTION = 0.92;           // 惯性摩擦系数（每帧速度衰减到 92%）
  var MIN_VELOCITY = 0.5;        // 惯性停止阈值（行/帧）
  var VELOCITY_WINDOW = 80;      // 速度采样窗口（ms），只用最近 80ms 的移动计算速度
  var MAX_INERTIA_LINES = 8;     // 单帧惯性最大行数（防止飞太远）

  // --- 状态 ---
  var startY = 0;
  var lastTouchY = 0;
  var scrolling = false;
  var didScroll = false;

  // 速度追踪：记录最近几个 touchmove 的时间和位置
  var touchHistory = [];   // [{ y, t }]

  // 惯性动画
  var inertiaId = null;
  var inertiaVelocity = 0;

  function stopInertia() {
    if (inertiaId !== null) {
      cancelAnimationFrame(inertiaId);
      inertiaId = null;
    }
    inertiaVelocity = 0;
  }

  function startInertia(velocity) {
    stopInertia();
    inertiaVelocity = velocity;

    function step() {
      inertiaVelocity *= FRICTION;
      if (Math.abs(inertiaVelocity) < MIN_VELOCITY) {
        inertiaId = null;
        return;
      }
      var lines = Math.round(Math.min(Math.abs(inertiaVelocity), MAX_INERTIA_LINES)
                             * (inertiaVelocity > 0 ? 1 : -1));
      if (lines !== 0) {
        term.scrollLines(lines);
      }
      inertiaId = requestAnimationFrame(step);
    }
    inertiaId = requestAnimationFrame(step);
  }

  // 从 touchHistory 计算释放速度（行/帧，60fps 基准）
  function computeReleaseVelocity() {
    var now = Date.now();
    // 只用最近 VELOCITY_WINDOW ms 内的记录
    var recent = touchHistory.filter(function(p) { return now - p.t < VELOCITY_WINDOW; });
    if (recent.length < 2) return 0;

    var first = recent[0];
    var last = recent[recent.length - 1];
    var dt = last.t - first.t;
    if (dt === 0) return 0;

    var dy = first.y - last.y;  // 向上滑 = 正值 = scrollLines 正数
    var pxPerMs = dy / dt;
    // 转换为 行/帧（假设 60fps = 16.67ms/帧）
    var linesPerFrame = (pxPerMs * 16.67) / LINE_HEIGHT * SCROLL_MULTIPLIER;
    return linesPerFrame;
  }

  container.addEventListener('touchstart', function(e) {
    if (e.touches.length !== 1) return;
    stopInertia();
    startY = e.touches[0].clientY;
    lastTouchY = startY;
    scrolling = true;
    didScroll = false;
    touchHistory = [{ y: startY, t: Date.now() }];
  }, { passive: true });

  container.addEventListener('touchmove', function(e) {
    if (!scrolling || e.touches.length !== 1) return;
    var currentY = e.touches[0].clientY;

    // 死区判断
    if (!didScroll && Math.abs(currentY - startY) < DEAD_ZONE) return;
    didScroll = true;

    var delta = lastTouchY - currentY;
    lastTouchY = currentY;

    // 记录触摸历史用于速度计算
    touchHistory.push({ y: currentY, t: Date.now() });
    // 只保留最近 10 个点
    if (touchHistory.length > 10) touchHistory = touchHistory.slice(-10);

    var lines = Math.round(delta / LINE_HEIGHT * SCROLL_MULTIPLIER);
    if (lines !== 0) {
      term.scrollLines(lines);
    }
  }, { passive: true });

  container.addEventListener('touchend', function() {
    if (!scrolling) return;
    scrolling = false;

    if (!didScroll) return;

    // 计算释放速度，启动惯性动画
    var velocity = computeReleaseVelocity();
    if (Math.abs(velocity) > MIN_VELOCITY) {
      startInertia(velocity);
    }
    touchHistory = [];
  }, { passive: true });

  // 触摸取消（如来电）
  container.addEventListener('touchcancel', function() {
    scrolling = false;
    touchHistory = [];
  }, { passive: true });
})();
```

#### 参数调优指南

| 参数 | 作用 | 调大 | 调小 |
|------|------|------|------|
| `FRICTION` (0.92) | 惯性衰减速度 | 滑得更远 | 停得更快 |
| `SCROLL_MULTIPLIER` (3) | 手指滑动灵敏度 | 轻滑就快速滚动 | 需要大幅滑动 |
| `VELOCITY_WINDOW` (80ms) | 速度采样时长 | 更平滑但延迟 | 更灵敏但抖动 |
| `MIN_VELOCITY` (0.5) | 惯性停止门槛 | 提早停止 | 滑得更久 |
| `MAX_INERTIA_LINES` (8) | 单帧惯性上限 | 允许飞速滚动 | 限制最大速度 |

建议调参顺序：先调 `FRICTION` 到感觉"自然"，再调 `SCROLL_MULTIPLIER` 到灵敏度合适。

#### 与 P1 的交互

惯性滚动期间 `term.onScroll` 会被持续触发，P1 的 sticky 检测会正确响应：
- 惯性向上滚 → `isAtBottom()=false` → `userScrolledUp=true` → 显示指示器
- 惯性向下滚到底 → `isAtBottom()=true` → `userScrolledUp=false` → 恢复跟随

无需特殊处理。

#### 手动验证清单

- [ ] 快速向上滑：松手后继续惯性滚动，逐渐减速
- [ ] 轻点（无滑动）：不触发滚动（死区生效）
- [ ] 惯性滚动中再次触摸：立即停止惯性
- [ ] 缓慢滑动：精确控制，无惯性跳跃
- [ ] 横向滑动：不误触发纵向滚动

#### 回退方式

替换回旧的触摸滚动 IIFE。

---

### P4: 输出节流（Throttle）—— 连续快速输出时只取最后一帧

#### 原理

当 `yes | head -1000` 这样的快速输出时，50ms 内可能有多帧变化。
每帧都通过 WebSocket 发送 540 行数据。在蜂窝网络下，消息堆积会导致延迟。

借鉴 free-code-main 的 `requestAnimationFrame` 式调度：
**在一次 capture-broadcast 周期内，如果上一次的数据还没发完，跳过本次。**

#### 实现

这实际上已经被当前的 `setInterval(50ms)` 隐式实现了——`captureAndBroadcast` 是 async，
但 `setInterval` 不等它完成就会触发下一次。如果 capture-pane 耗时 >50ms，
会出现并发 capture。

P2 的递归 setTimeout 方案天然避免了这个问题：上一次 `captureAndBroadcast` 完成后才 `scheduleNext()`。

**P2 已经包含了 P4 的效果。**无需额外实现。

---

## 被排除的方案（及原因）

| 方案 | 排除原因 |
|------|----------|
| **逐行 diff** | v1 已验证不可行。无法维护 xterm.js scrollback。free-code-main 的 diff 方案依赖自有的 Screen buffer 系统，不适用于 xterm.js |
| **DEC 2026 BSU/ESU 包裹** | xterm.js 不支持 DEC 2026。无效 |
| **WebGL renderer** | xterm.js 的 WebGL addon 不改变 write() 行为，不能消除闪烁 |
| **Canvas 双缓冲** | xterm.js 内部已经用 Canvas，我们控制不了它的绘制时机 |
| **服务端维护完整 Screen buffer + 逐 cell diff** | 过度工程。需要在服务端解析所有 ANSI 序列维护虚拟屏幕，复杂度爆炸。free-code-main 的方案是因为它本身就是终端——我们只是一个透传层 |
| **用 WebSocket binary frames 代替 JSON** | 带宽节省 ~10%（去掉 JSON 包装），但增加了协议复杂度。投入产出比低 |
| **减少 capture scrollback 行数** | 已在 v2 中确认不应该改。500 行 scrollback 是 tmux 历史的正确反映 |

---

## 实施顺序和依赖关系

```
P0 (去掉 \x1b[2J]) ──→ P2 (自适应频率)
                          ↑
P1 (sticky scroll) ──────┘   ← P1 不依赖 P0，可以并行
                    
P3 (触摸惯性) ── 依赖 P1（与 sticky 状态交互）
```

**推荐实施顺序：**

```
第 1 步: P0 — 消除闪烁（改动最小：1 行代码 + 测试更新）
第 2 步: P1 — 滚动冻结（纯客户端，独立可验证）
第 3 步: P2 — 自适应频率（重构 timer 逻辑，改动适中）
第 4 步: P3 — 触摸惯性（纯客户端，需要调参）
```

每步一个 commit，每步完成后在手机上验证后再继续下一步。

## 预期最终效果

| 场景 | 改进前 | 改进后 |
|------|--------|--------|
| 运行 `top` | 持续闪烁 | 平滑更新，无闪烁 |
| 向上翻看历史 | 被拉回底部，无法阅读 | 视口冻结，底部有"↓"指示器 |
| 手指快速上滑 | 松手即停 | 松手后惯性滑行 2-3 秒 |
| 空闲等待输入 | 每秒 20 次 timer 回调 | 每秒 5 次 timer 回调 |
| 蜂窝网络 | 消息堆积延迟 | 自动跳帧，只发最新画面 |
