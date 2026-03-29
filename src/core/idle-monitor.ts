// ============================================================
// idle-monitor.ts — 会话空闲超时监控
// 当 session 没有任何 WS 客户端连接超过指定时间后触发回调
// ============================================================

export class IdleMonitor {
	private timers: Map<string, ReturnType<typeof setTimeout>> = new Map()
	private timeoutMs: number
	private onIdle: (sessionId: string) => void
	private enabled: boolean

	constructor(timeoutMs: number, onIdle: (sessionId: string) => void) {
		this.timeoutMs = timeoutMs
		this.onIdle = onIdle
		this.enabled = timeoutMs > 0
	}

	/** 客户端数量变化时调用 */
	onClientChange(sessionId: string, clientCount: number): void {
		if (!this.enabled) return

		// 清除已有的计时器
		const existing = this.timers.get(sessionId)
		if (existing) {
			clearTimeout(existing)
			this.timers.delete(sessionId)
		}

		// 有客户端连接，不需要计时
		if (clientCount > 0) return

		// 无客户端，启动倒计时
		const timer = setTimeout(() => {
			this.timers.delete(sessionId)
			this.onIdle(sessionId)
		}, this.timeoutMs)

		this.timers.set(sessionId, timer)
	}

	/** session 被手动销毁时清理 */
	removeSession(sessionId: string): void {
		const timer = this.timers.get(sessionId)
		if (timer) {
			clearTimeout(timer)
			this.timers.delete(sessionId)
		}
	}

	/** 清理所有计时器 */
	dispose(): void {
		for (const timer of this.timers.values()) {
			clearTimeout(timer)
		}
		this.timers.clear()
	}
}
