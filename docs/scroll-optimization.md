# 滚动优化方案 v2

> 基于 `docs/architecture-capture-output.md` 和 v1 方案的实际踩坑经验重写。

## 要解决的问题

1. **闪烁** — 每帧 `\x1b[2J` 清屏，画面闪烁（尤其手机上明显）
2. **滚动被拉回** — 用户向上滚动查看历史时，下一帧 output 把视口拉回底部
3. **触摸滚动生硬** — touchmove 直接跳到位，无惯性，不符合手机交互预期

## v1 踩坑总结

v1 用逐行 diff 替代 `\x1b[2J\x1b[H` + 全量写入，花了一整天修连锁问题：

| 问题 | 原因 |
|------|------|
| xterm.js scrollback 不增长 | diff 只更新可见行，没有触发滚动 |
| 滚动检测 80% 成功率 | TUI 全屏重绘时 `detectScrollUp` 失败 |
| `\x1b[1S` 保底导致重复 | pi 的 header 行被反复推入 scrollback |
| snapshot 改了导致重复/偏移 | 改了不该改的东西（snapshot 本来是好的） |

**核心教训**：`\x1b[2J\x1b[H` + 全量写入同时做了三件事（清屏 + 推 scrollback + 写新内容）。diff 方案只做了第三件，前两件丢了。

## 新方案

### 设计原则

1. **不改 snapshot** — snapshot 是正确的，不动
2. **不改 capture 参数** — 500 行 scrollback 是正确的，不动
3. **每个改动独立可回退** — 每个方案是独立 commit，任何一个出问题可以单独 revert

### P0: 去掉 `\x1b[2J` 消除闪烁（服务端）

**思路**：不用 diff，保持全量写入。只把 `\x1b[2J\x1b[H` 换成 `\x1b[H`。

当前：
```
\x1b[2J    ← 清屏（推旧内容进 scrollback + 清空可见区域）
\x1b[H     ← 光标到 (1,1)
{500行+可见区域}  ← 全量写入
\x1b[y;xH  ← 光标定位
```

改为：
```
\x1b[H     ← 光标到 (1,1)
{500行+可见区域}  ← 全量覆盖写入
\x1b[J     ← 清除光标到屏幕底部（清理残留的旧行，如果新帧比旧帧短）
\x1b[y;xH  ← 光标定位
```

**为什么这能保持 scrollback**：从 (1,1) 开始写 500+ 行，超出可见区域的行自然滚入 xterm.js scrollback。和 `\x1b[2J` 的效果相同，但没有"先清空再写入"的视觉间隙。

**风险**：
- 每帧 500 行从 (1,1) 覆盖写，xterm.js 的行为是否和预期一致？需要验证。
- 写入过程中旧内容被逐行覆盖，如果写入不是原子的，可能看到新旧混合。但 xterm.js 的 `term.write()` 是同步渲染的，一次 write 调用不会被拆开。

**测试验证**：
- `test/capture-broadcast.test.ts` 中的输出格式测试需要更新（`\x1b[2J\x1b[H` → `\x1b[H` ... `\x1b[J`）
- 手动验证：运行 `top`，确认无闪烁
- 手动验证：scrollback 向上滚动，内容和 tmux 一致

**改动范围**：`src/core/session-manager.ts` — `captureAndBroadcast` 中一行。

### P1: 客户端滚动冻结（客户端）

**思路**：和 v1 相同，纯客户端逻辑，和服务端输出方式无关。

用户向上滚动时设置 `userScrolling = true`，暂停 `scrollToBottom()`。
停止滚动 3 秒后自动恢复跟随。

**改动范围**：`src/server.ts` — 内联前端 JS。

```javascript
let userScrolling = false;
let scrollResumeTimer = null;
const SCROLL_RESUME_DELAY = 3000;

function isAtBottom() {
  var buf = term.buffer.active;
  return buf.viewportY >= buf.baseY;
}

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
    if (scrollResumeTimer) { clearTimeout(scrollResumeTimer); scrollResumeTimer = null; }
  }
});
```

修改 `loadHistory` 结尾和 resize handler 中的 `scrollToBottom()`：
```javascript
if (!userScrolling) term.scrollToBottom();
```

**风险**：无。纯客户端，不影响数据流。

### P2: 自适应 capture 频率（服务端）

**思路**：和 v1 相同。连续 3 帧无变化后从 50ms 降到 200ms。

`setInterval(50ms)` → 递归 `setTimeout`，根据 `unchangedFrames` 动态选间隔。

**改动范围**：`src/core/session-manager.ts` — `startOutputReader` 调度逻辑。

**风险**：无。只影响 capture 频率，不影响输出内容。

### P3: 触摸滚动惯性（客户端）

**思路**：touchmove 累积到 `pendingScroll`，用 `requestAnimationFrame` 分帧消耗。touchend 时根据最后速度添加惯性量。

**改动范围**：`src/server.ts` — 触摸事件处理部分。

**风险**：纯客户端触摸交互，不影响数据流。调参可能需要几轮。

## 实施顺序

```
P1（滚动冻结）→ P0（去掉 \x1b[2J）→ P2（自适应频率）→ P3（触摸惯性）
```

- **P1 先做**：改动最小、风险最低、效果立竿见影（手机上不再被拉回底部）
- **P0 其次**：消除闪烁。需要验证 xterm.js 对覆盖写入的行为
- **P2 再做**：纯优化，降低空闲 CPU
- **P3 最后**：体验增强，需要调参

每个方案独立 commit，独立可回退。

## 删除的方案

以下是 v1 中尝试过但已证明有问题的方案，**不再实施**：

| 方案 | 为什么删除 |
|------|-----------|
| 逐行 diff 替代全量写入 | 无法维护 xterm.js scrollback |
| 滚动检测 `detectScrollUp` + `\x1b[nS` | 只有 ~80% 成功率，失败时丢内容 |
| `\x1b[1S` 保底推 1 行 | TUI 重绘时推重复行 |
| 减少 snapshot scrollback 行数 | snapshot 本来就是对的 |
| 纯文本 scrollback + escape 可见区域分段抓取 | 过度工程，解决的是不存在的问题 |
| 服务端 scrollback buffer | tmux scrollback 本身是干净的，不需要额外缓存 |
