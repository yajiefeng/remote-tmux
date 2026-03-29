// ============================================================
// rate-limiter.ts — 滑动窗口频率限制
// 按 IP 维度追踪请求时间戳，超过阈值拒绝
// ============================================================

export interface RateLimiterOptions {
	/** 窗口内最大请求数 */
	maxRequests: number
	/** 窗口时间（ms） */
	windowMs: number
}

export class RateLimiter {
	private maxRequests: number
	private windowMs: number
	private requests: Map<string, number[]> = new Map()

	constructor(options: RateLimiterOptions) {
		this.maxRequests = options.maxRequests
		this.windowMs = options.windowMs
	}

	/** 检查 IP 是否允许请求，允许则记录并返回 true */
	check(ip: string): boolean {
		const now = Date.now()
		const cutoff = now - this.windowMs

		let timestamps = this.requests.get(ip)
		if (timestamps) {
			// 清除过期的时间戳
			timestamps = timestamps.filter((t) => t > cutoff)
			this.requests.set(ip, timestamps)
		} else {
			timestamps = []
			this.requests.set(ip, timestamps)
		}

		if (timestamps.length >= this.maxRequests) {
			return false
		}

		timestamps.push(now)
		return true
	}

	/** 获取 IP 剩余配额 */
	remaining(ip: string): number {
		const now = Date.now()
		const cutoff = now - this.windowMs
		const timestamps = this.requests.get(ip)
		if (!timestamps) return this.maxRequests

		const active = timestamps.filter((t) => t > cutoff).length
		return Math.max(0, this.maxRequests - active)
	}

	/** 清理所有已过期的 IP 条目，防止内存泄漏 */
	cleanup(): void {
		const now = Date.now()
		const cutoff = now - this.windowMs

		for (const [ip, timestamps] of this.requests) {
			const active = timestamps.filter((t) => t > cutoff)
			if (active.length === 0) {
				this.requests.delete(ip)
			} else {
				this.requests.set(ip, active)
			}
		}
	}

	/** 当前追踪的 IP 数量 */
	get size(): number {
		return this.requests.size
	}
}
