# P0 理论评估：`\x1b[H` 替代 `\x1b[2J\x1b[H`

## 关键参数

- xterm.js scrollback: 5000
- tmux capture: 500 行 scrollback + ~40 行可见 = ~540 行
- viewport: ~40 行（手机上可能 13 行）

## `\x1b[2J` 在 xterm.js 中的行为

**这是关键未知项**，有两种可能：

### 可能 A：`\x1b[2J` 不推 scrollback（VT100 标准行为）

ED mode 2 只清除可见区域的单元格（填充空格），不影响 scrollback。

当前每帧流程：
```
\x1b[2J  → 可见区域 40 行变成空格（scrollback 不变）
\x1b[H   → 光标到 (1,1)
写 540 行 → 前 40 行覆盖可见区域
           → 第 41 行开始，每行触发一次 scroll
           → 可见行 1（新内容）被推入 scrollback
           → 共推入 500 行到 scrollback
```

**去掉 `\x1b[2J]` 后**：
```
\x1b[H   → 光标到 (1,1)
写 540 行 → 前 40 行覆盖可见区域（旧内容被逐行覆盖）
           → 第 41 行开始，每行触发一次 scroll
           → 可见行 1（已被覆盖为新内容）被推入 scrollback
           → 共推入 500 行到 scrollback
```

**结论**：行为完全相同。唯一区别是没有"清空→填充"的视觉间隙（消除闪烁）。✅ 可行

### 可能 B：`\x1b[2J` 推可见内容到 scrollback（某些终端的行为）

`\x1b[2J` 先把 40 行可见内容推入 scrollback，再清空。

当前每帧：scrollback 增长 40（ED推入）+ 500（写入溢出）= **540 行/帧**
去掉后：scrollback 增长 **500 行/帧**

**结论**：scrollback 增长速度略慢（少了 40 行/帧），但仍然正常增长。
在 5000 行 scrollback 限制下，差异可忽略（稳态都是满 5000 行）。✅ 也可行

## 逐帧推演

### 初始状态（`loadHistory` 后）

```
xterm.js:
  scrollback: [snap 第 1-500 行]
  visible:    [snap 第 501-540 行]
  baseY = 500
```

### Frame 1（有 `\x1b[2J`，当前 main）

```
1. \x1b[2J → 清空 visible（40 行变空格或推入 scrollback）
2. \x1b[H  → cursor = (1,1)
3. 写 540 行:
   - 行 1-40: 覆盖 visible 的 40 行
   - 行 41-540: 每行触发 scroll，推 500 行到 scrollback
4. 结果:
   scrollback: [...之前的, frame1 行 1-500]  
   visible:    [frame1 行 501-540]
   baseY += 500 (或 540 如果 ED 推了 scrollback)
```

### Frame 1（无 `\x1b[2J`，P0 方案）

```
1. \x1b[H  → cursor = (1,1)
2. 写 540 行:
   - 行 1-40: 覆盖 visible 的 40 行（旧内容被覆盖为新内容）
   - 行 41-540: 每行触发 scroll，推 500 行到 scrollback
   - 被推入的是行 1-500（已经是新内容）
3. \x1b[J  → 清除 cursor 到屏幕底（cursor 在最后一行，无效果）
4. 结果:
   scrollback: [...之前的, frame1 行 1-500]
   visible:    [frame1 行 501-540]
   baseY += 500
```

**两种方案的最终状态完全一致。**

### Frame 2

两种方案的起始状态相同，过程相同，结果相同。

## 稳态分析

每帧写入 540 行，viewport 40 行，scrollback 增长 500 行/帧。
xterm.js scrollback 限制 5000 行 → 10 帧后（500ms）达到稳态。
稳态下：scrollback 始终保持最近 5000 行，旧行被丢弃。

**P0 方案和 main 在稳态下的 scrollback 内容完全一致。**

## 风险分析

### 风险 1：`term.write()` 的原子性

540 行内容在一次 `term.write()` 调用中写入。
xterm.js 是否在内部同步处理整个字符串？如果中途触发了渲染（paint），用户可能看到：
- 前几行已覆盖为新内容
- 后几行还是旧内容
- 一个"撕裂"效果

**评估**：xterm.js 的 `term.write()` 默认走 `writeBuffer`，会在下一帧批量刷新。
一次 write 调用的内容不会被拆开渲染。所以不会撕裂。
（但如果内容太大，xterm.js 可能分多个 chunk 处理——需要确认。）

### 风险 2：RingBuffer 历史重放

断线重连时，客户端回放多个 chunk。每个 chunk 格式从 `\x1b[2J\x1b[H` + content
变为 `\x1b[H` + content + `\x1b[J`。

回放多个 chunk 时，每个 chunk 都从 (1,1) 覆盖写入。最终结果是最后一个 chunk 的内容，
和 `\x1b[2J` 方案一致。✅ 无风险

### 风险 3：`\x1b[J` 的必要性

正常情况下，540 行写完后 cursor 在最后一行，`\x1b[J` 无效果。
但如果某帧 capture 返回的行数少于 viewport（异常情况），`\x1b[J` 能清除残留。
**保留作为防御性代码。**

### 风险 4：首帧行为

首帧时 `lastScreen = ""`，terminal 刚 `term.reset()`。
`\x1b[H` 后写入内容，和 `\x1b[2J\x1b[H` 后写入内容一致（屏幕本来就是空的）。
✅ 无风险

## 结论

**P0 方案理论上可行**，在两种 `\x1b[2J` 实现假设下都能正确工作。

唯一不确定项是 `term.write()` 对大内容的处理——如果 xterm.js 把 540 行拆成多个 chunk 异步处理，
可能在中间帧看到不完整的覆盖。这需要实际测试验证。

## 验证计划

1. 先在浏览器 console 中测试 `\x1b[2J` 是否推 scrollback（确认是可能 A 还是 B）
2. 测试 `term.write()` 写入 540 行的原子性
3. 改代码，运行 `top` 和 `pi` 观察效果
