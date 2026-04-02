# TODO — 滚动优化

跟踪 [docs/scroll-optimization.md](docs/scroll-optimization.md) 中方案的实施进度。

## P0 — 必须修复

- [x] **P0-1: 服务端差分输出**
  - 文件: `src/core/session-manager.ts` → `captureAndBroadcast`
  - 去掉 `\x1b[2J\x1b[H` 全屏清除，改为逐行 diff 只发送变化行
  - 验证: 运行 `top` 时画面无整屏闪烁

- [x] **P0-2: 客户端滚动冻结**
  - 文件: `src/server.ts` → 内联前端 JS
  - 用户向上滚动时暂停自动跟随，3 秒无操作后恢复
  - 验证: `ping localhost` 运行中向上滚动不跳回底部

## P1 — 体验增强

- [x] **P1-1: 自适应 capture 频率**
  - 文件: `src/core/session-manager.ts` → `startOutputReader`
  - 连续无变化后从 50ms 降到 200ms，有活动时恢复
  - 验证: 空闲会话 CPU 占用明显下降
