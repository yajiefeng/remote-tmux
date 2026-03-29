import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { IdleMonitor } from "../src/core/idle-monitor.js"

describe("IdleMonitor", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("calls onIdle after timeout when no clients", () => {
		const onIdle = vi.fn()
		const monitor = new IdleMonitor(5000, onIdle)

		monitor.onClientChange("s1", 0)
		vi.advanceTimersByTime(5000)

		expect(onIdle).toHaveBeenCalledWith("s1")
		expect(onIdle).toHaveBeenCalledTimes(1)
		monitor.dispose()
	})

	it("does not call onIdle if client reconnects before timeout", () => {
		const onIdle = vi.fn()
		const monitor = new IdleMonitor(5000, onIdle)

		monitor.onClientChange("s1", 0)
		vi.advanceTimersByTime(3000)
		monitor.onClientChange("s1", 1) // client reconnected
		vi.advanceTimersByTime(5000)

		expect(onIdle).not.toHaveBeenCalled()
		monitor.dispose()
	})

	it("does not call onIdle if session has clients", () => {
		const onIdle = vi.fn()
		const monitor = new IdleMonitor(5000, onIdle)

		monitor.onClientChange("s1", 2)
		vi.advanceTimersByTime(10000)

		expect(onIdle).not.toHaveBeenCalled()
		monitor.dispose()
	})

	it("tracks multiple sessions independently", () => {
		const onIdle = vi.fn()
		const monitor = new IdleMonitor(5000, onIdle)

		monitor.onClientChange("s1", 0)
		monitor.onClientChange("s2", 0)
		vi.advanceTimersByTime(3000)
		monitor.onClientChange("s1", 1) // s1 reconnected

		vi.advanceTimersByTime(2000) // total 5s — s2 should fire
		expect(onIdle).toHaveBeenCalledTimes(1)
		expect(onIdle).toHaveBeenCalledWith("s2")

		vi.advanceTimersByTime(5000) // s1 still has client
		expect(onIdle).toHaveBeenCalledTimes(1)
		monitor.dispose()
	})

	it("removes session from tracking on removeSession", () => {
		const onIdle = vi.fn()
		const monitor = new IdleMonitor(5000, onIdle)

		monitor.onClientChange("s1", 0)
		vi.advanceTimersByTime(2000)
		monitor.removeSession("s1") // session destroyed manually
		vi.advanceTimersByTime(5000)

		expect(onIdle).not.toHaveBeenCalled()
		monitor.dispose()
	})

	it("is disabled when timeoutMs is 0", () => {
		const onIdle = vi.fn()
		const monitor = new IdleMonitor(0, onIdle)

		monitor.onClientChange("s1", 0)
		vi.advanceTimersByTime(999999)

		expect(onIdle).not.toHaveBeenCalled()
		monitor.dispose()
	})

	it("does not fire twice for same idle event", () => {
		const onIdle = vi.fn()
		const monitor = new IdleMonitor(5000, onIdle)

		monitor.onClientChange("s1", 0)
		vi.advanceTimersByTime(5000)
		expect(onIdle).toHaveBeenCalledTimes(1)

		// Advancing more time should not re-fire
		vi.advanceTimersByTime(5000)
		expect(onIdle).toHaveBeenCalledTimes(1)
		monitor.dispose()
	})
})
