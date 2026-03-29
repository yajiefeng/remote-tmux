// ============================================================
// rate-limiter.test.ts — 滑动窗口频率限制测试
// ============================================================

import { describe, expect, it, beforeEach, vi, afterEach } from "vitest"
import { RateLimiter } from "../src/middleware/rate-limiter.js"

describe("RateLimiter", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("allows requests within limit", () => {
		const limiter = new RateLimiter({ maxRequests: 5, windowMs: 10000 })
		for (let i = 0; i < 5; i++) {
			expect(limiter.check("1.2.3.4")).toBe(true)
		}
	})

	it("rejects requests over limit", () => {
		const limiter = new RateLimiter({ maxRequests: 3, windowMs: 10000 })
		expect(limiter.check("1.2.3.4")).toBe(true)
		expect(limiter.check("1.2.3.4")).toBe(true)
		expect(limiter.check("1.2.3.4")).toBe(true)
		expect(limiter.check("1.2.3.4")).toBe(false)
		expect(limiter.check("1.2.3.4")).toBe(false)
	})

	it("tracks IPs independently", () => {
		const limiter = new RateLimiter({ maxRequests: 2, windowMs: 10000 })
		expect(limiter.check("1.1.1.1")).toBe(true)
		expect(limiter.check("1.1.1.1")).toBe(true)
		expect(limiter.check("1.1.1.1")).toBe(false)

		// Different IP still has quota
		expect(limiter.check("2.2.2.2")).toBe(true)
		expect(limiter.check("2.2.2.2")).toBe(true)
		expect(limiter.check("2.2.2.2")).toBe(false)
	})

	it("allows requests again after window expires", () => {
		const limiter = new RateLimiter({ maxRequests: 2, windowMs: 1000 })
		expect(limiter.check("1.1.1.1")).toBe(true)
		expect(limiter.check("1.1.1.1")).toBe(true)
		expect(limiter.check("1.1.1.1")).toBe(false)

		// Advance past window
		vi.advanceTimersByTime(1001)

		expect(limiter.check("1.1.1.1")).toBe(true)
		expect(limiter.check("1.1.1.1")).toBe(true)
		expect(limiter.check("1.1.1.1")).toBe(false)
	})

	it("sliding window: old timestamps expire individually", () => {
		const limiter = new RateLimiter({ maxRequests: 3, windowMs: 1000 })

		// t=0: request 1
		expect(limiter.check("ip")).toBe(true)

		// t=400: request 2
		vi.advanceTimersByTime(400)
		expect(limiter.check("ip")).toBe(true)

		// t=800: request 3
		vi.advanceTimersByTime(400)
		expect(limiter.check("ip")).toBe(true)

		// t=800: limit reached
		expect(limiter.check("ip")).toBe(false)

		// t=1001: request 1 expired, one slot opens
		vi.advanceTimersByTime(201)
		expect(limiter.check("ip")).toBe(true)

		// Still at limit (requests 2, 3, and new one)
		expect(limiter.check("ip")).toBe(false)
	})

	it("cleans up stale entries", () => {
		const limiter = new RateLimiter({ maxRequests: 1, windowMs: 1000 })
		limiter.check("stale-ip")

		// Advance well past window
		vi.advanceTimersByTime(5000)

		// Cleanup should remove the entry
		limiter.cleanup()
		expect(limiter.size).toBe(0)
	})

	it("returns remaining count", () => {
		const limiter = new RateLimiter({ maxRequests: 5, windowMs: 10000 })
		expect(limiter.remaining("ip")).toBe(5)
		limiter.check("ip")
		expect(limiter.remaining("ip")).toBe(4)
		limiter.check("ip")
		limiter.check("ip")
		expect(limiter.remaining("ip")).toBe(2)
	})
})
