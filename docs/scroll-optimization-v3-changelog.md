# Scroll Optimization v3 — 实施记录

> 分支: `feat/scroll-optimization-v3`
> 基线: `main` (commit `be66652`)
> 日期: 2026-04-03

## 变更总览

| Commit | 改动 | 文件 |
|--------|------|------|
| `a59f6e5` | P0: 去掉 `\x1b[2J` 消除闪烁 | session-manager.ts, capture-broadcast.test.ts |
| `6800023` | P1+P3: Sticky Scroll + 触摸惯性 | server.ts |
| `dacc157` | P2: 自适应 capture 频率 | session-manager.ts |
| `500087b` | 修复: tap 时自动回到底部 | server.ts |
| `6cb0de0` | 修复: 去掉 term.onScroll 避免竞态 | server.ts |
| `57357d1` | 性能: rAF 批处理 touchmove（后续被回退） | server.ts |
| `eb63439` | 性能: 滚动时跳过 term.write() | server.ts |
| `aaf031e` | 修复: 惯性参数调优 + 回退 rAF | server.ts |

共修改 3 个源文件 + 1 个测试文件，净增 ~160 行。

---

## P0: 消除闪烁

### 问题
每帧发送 `\x1b[2J\x1b[H`（清屏+归位），xterm.js 不支持 DEC 2026 同步输出，用户看到"清空→重绘"的闪烁间隙。

### 方案
改为 `\x1b[H` + 内容 + `\x1b[J`（归位 + 覆盖写入 + 清除残留）。

### 改动

**`src/core/session-manager.ts`** — `captureAndBroadcast()`:
```diff
- const data = "\x1b[2J\x1b[H" + screen + cursorSeq
+ const data = "\x1b[H" + screen + "\x1b[J" + cursorSeq
```

`\x1b[J`（Erase to End of Screen）处理新帧比旧帧短的边界情况——覆盖写入后清除光标到屏幕底部的残留内容。

### 为什么安全
- `term.write()` 同步处理整个字符串，不会在中间触发 paint → 无撕裂
- 从 (1,1) 写 540 行，超出 viewport 的行自然推入 scrollback → 行为与 `\x1b[2J` 一致
- RingBuffer 重连回放：每个 chunk 从 (1,1) 覆盖，最终只保留最后一个 chunk → 正确

---

## P1: Sticky Scroll（滚动冻结）

### 问题
用户向上滚动查看历史时，下一帧的 `term.write()` + `scrollToBottom()` 把视口拉回底部。

### 方案
基于位置判断（非定时器）的 sticky 模式，借鉴 free-code-main 的 `stickyScroll` 设计。

### 改动

**`src/server.ts`** — 新增客户端模块:

**状态管理**:
```javascript
var userScrolledUp = false;

function isAtBottom() {
  var buf = term.buffer.active;
  return buf.viewportY >= buf.baseY - 1;
}

function updateScrollState() {
  userScrolledUp = !isAtBottom();
  scrollIndicator.style.display = userScrolledUp ? 'block' : 'none';
}
```

**"↓ New output" 浮动指示器**: 用户滚动离开底部时显示，点击回到底部。

**`smartScrollToBottom()`**: 替代所有直接的 `term.scrollToBottom()` 调用，在 `userScrolledUp` 时跳过滚动、显示指示器。

**`resumeFollowing()`**: 统一的"回到底部"操作——重置状态、写入最后一帧跳过的数据、滚到底部。

### 关键设计决策

**不用 `term.onScroll`**（`6cb0de0` 修复）:

初版用了 `term.onScroll` 来检测用户是否在底部。但 `term.write()` 写入 540 行时会触发大量异步 scroll 事件，与用户的 tap 操作竞态：

```
tap → userScrolledUp = false → term.write() → onScroll → isAtBottom()=false → userScrolledUp = true ✗
```

修复：`userScrolledUp` 只由触摸手势控制（touchmove / touchend / inertia），不由 `term.onScroll` 控制。

**Tap = 回到底部**（`500087b` 修复）:

touchend 时如果 `didScroll === false`（没有滑动，只是轻点），且 `userScrolledUp === true`，自动调用 `resumeFollowing()` 回到底部。用户点击屏幕的意图是"输入"，需要看到光标。

### 输出挂起机制（`eb63439`）:

`userScrolledUp` 时跳过 `term.write()`，只更新 `lastSeq`。最后一帧数据缓存在 `lastSkippedData`。回到底部时 `resumeFollowing()` 一次性写入。

```javascript
// ws.onmessage output handler:
if (!userScrolledUp) {
  term.write(msg.data);
  lastSkippedData = null;
} else {
  lastSkippedData = msg.data;  // buffer, don't write
}
```

这是工具输出滚动卡顿的关键修复——每帧 540 行 ANSI 内容的 `term.write()` 是主线程性能杀手，滚动时完全跳过后滑动流畅度大幅改善。

---

## P2: 自适应 capture 频率

### 问题
`setInterval(50ms)` 固定轮询，空闲时浪费 CPU。且 setInterval 不等 async 回调完成就触发下一次，可能并发 capture。

### 方案
递归 `setTimeout`，活跃 50ms / 空闲 200ms，pipe-pane 数据到达时立即唤醒。

### 改动

**`src/core/session-manager.ts`**:

```javascript
const INTERVAL_ACTIVE = 50    // 有活动时
const INTERVAL_IDLE = 200     // 连续 3 帧无变化后
const IDLE_THRESHOLD = 3

const scheduleNext = (): void => {
  const interval = unchangedFrames >= IDLE_THRESHOLD ? INTERVAL_IDLE : INTERVAL_ACTIVE
  captureTimer = setTimeout(() => void captureAndBroadcast(), interval)
}
```

唤醒机制：`tail.stdout.on("data")` 检测到新数据时，如果当前在 idle 间隔，取消 timer 立即调度。

```javascript
tail.stdout!.on("data", () => {
  activityDetected = true
  if (unchangedFrames >= IDLE_THRESHOLD && captureTimer) {
    clearTimeout(captureTimer)
    unchangedFrames = 0
    captureTimer = setTimeout(() => void captureAndBroadcast(), INTERVAL_ACTIVE)
  }
})
```

### 附带效果
递归 setTimeout 天然保证上一次 captureAndBroadcast 完成后才调度下一次——消除了 setInterval 可能的并发 capture 问题（相当于方案文档中的 P4）。

---

## P3: 触摸滚动惯性

### 问题
原版触摸滚动是线性映射 (`delta / 15 * 6`)，手指离屏即停，无动量。

### 方案
速度追踪 + 摩擦衰减 + requestAnimationFrame 动画。

### 改动

**`src/server.ts`** — 替换整个触摸滚动 IIFE:

**速度追踪**: `touchHistory` 数组记录最近 10 个触摸点的 `{y, t}`。释放时取最近 100ms 内的点计算速度。

```javascript
function computeReleaseVelocity() {
  // 只用最近 VELOCITY_WINDOW(100ms) 内的触摸点
  // 返回 行/帧 (60fps 基准)
  return (dy / dt * 16.67) / LINE_HEIGHT * SCROLL_MULTIPLIER;
}
```

**惯性动画**: touchend 后启动 rAF 循环，每帧乘以 `FRICTION(0.97)` 衰减，低于 `MIN_VELOCITY(0.3)` 时停止。

### 最终参数

| 参数 | 值 | 作用 |
|------|-----|------|
| `SCROLL_MULTIPLIER` | 5 | 滑动灵敏度 |
| `FRICTION` | 0.97 | 惯性衰减（~1.5 秒惯性时长） |
| `MIN_VELOCITY` | 0.3 行/帧 | 惯性停止门槛 |
| `VELOCITY_WINDOW` | 100ms | 释放速度采样窗口 |
| `MAX_INERTIA_LINES` | 12 行/帧 | 单帧最大滚动量 |
| `LINE_HEIGHT` | 15px | 像素→行映射基准 |
| `DEAD_ZONE` | 8px | 轻点不触发滚动 |

### 调参经历

初版 `FRICTION=0.92, MULTIPLIER=3` 惯性只有 0.4 秒且几乎感受不到。经过一轮调优确定当前参数，惯性时长约 1.5 秒，接近原生滚动手感。

曾尝试 rAF 批处理 touchmove（`57357d1`），增加了一帧延迟使拖动变迟钝，且对卡顿无帮助（真正的卡顿源是 `term.write()` 而非 `scrollLines()`），在 `aaf031e` 中回退。

---

## 被尝试后放弃的方案

| 方案 | Commit | 为什么放弃 |
|------|--------|-----------|
| `term.onScroll` 追踪滚动状态 | `6800023` → `6cb0de0` 移除 | `term.write()` 的异步 scroll 事件与 tap 竞态，导致 sticky 状态被意外翻转 |
| rAF 批处理 touchmove | `57357d1` → `aaf031e` 回退 | 增加一帧延迟使拖动迟钝；卡顿真因是 `term.write()` 不是 `scrollLines()` |
| 3 秒定时器自动恢复跟随（v2 方案） | 未实施 | 用户看长日志时被强制拉回，改用位置判断 |

---

## 测试

所有 85 个测试通过。`test/capture-broadcast.test.ts` 断言已更新：

```diff
- expect(msg.data).toMatch(/^\x1b\[2J\x1b\[H/)
+ expect(msg.data).toMatch(/^\x1b\[H/)
+ expect(msg.data).not.toContain("\x1b[2J")
+ expect(msg.data).toMatch(/line3\x1b\[J\x1b\[3;6H$/)
```

---

## 已知待改进

- 触摸惯性参数可能需要根据实际设备继续微调
- 工具输出（大量 ANSI 序列）的滚动流畅度有改善但仍不如纯文本
- `lastSkippedData` 只缓存最后一帧，如果回到底部瞬间恰好没有新帧，画面可能有一帧延迟（50ms 内自动恢复）
