// ============================================================
// ring-buffer.test.ts
// ============================================================

import { describe, expect, it } from "vitest"
import { RingBuffer } from "../src/core/ring-buffer.js"

describe("RingBuffer", () => {
	it("should append and retrieve chunks", () => {
		const buf = new RingBuffer(100)
		buf.append("hello")
		buf.append("world")

		expect(buf.size()).toBe(2)
		expect(buf.getCurrentSeq()).toBe(2)

		const latest = buf.getLatest(10)
		expect(latest).toHaveLength(2)
		expect(latest[0].data).toBe("hello")
		expect(latest[1].data).toBe("world")
	})

	it("should return chunks after a given seq", () => {
		const buf = new RingBuffer(100)
		buf.append("a")
		buf.append("b")
		buf.append("c")

		const after1 = buf.getAfter(1, 10)
		expect(after1).toHaveLength(2)
		expect(after1[0].data).toBe("b")
		expect(after1[1].data).toBe("c")
	})

	it("should wrap around when full", () => {
		const buf = new RingBuffer(3)
		buf.append("a") // seq 1
		buf.append("b") // seq 2
		buf.append("c") // seq 3
		buf.append("d") // seq 4, overwrites "a"

		expect(buf.size()).toBe(3)
		expect(buf.getCurrentSeq()).toBe(4)

		const latest = buf.getLatest(10)
		expect(latest).toHaveLength(3)
		expect(latest[0].data).toBe("b")
		expect(latest[1].data).toBe("c")
		expect(latest[2].data).toBe("d")
	})

	it("should respect limit in getAfter", () => {
		const buf = new RingBuffer(100)
		for (let i = 0; i < 20; i++) {
			buf.append(`line ${i}`)
		}

		const result = buf.getAfter(0, 5)
		expect(result).toHaveLength(5)
	})

	it("should respect limit in getLatest", () => {
		const buf = new RingBuffer(100)
		for (let i = 0; i < 20; i++) {
			buf.append(`line ${i}`)
		}

		const result = buf.getLatest(3)
		expect(result).toHaveLength(3)
		expect(result[0].data).toBe("line 17")
		expect(result[2].data).toBe("line 19")
	})

	it("should handle empty buffer", () => {
		const buf = new RingBuffer(100)
		expect(buf.size()).toBe(0)
		expect(buf.getCurrentSeq()).toBe(0)
		expect(buf.getLatest(10)).toHaveLength(0)
		expect(buf.getAfter(0, 10)).toHaveLength(0)
	})

	it("should handle getAfter with seq beyond buffer", () => {
		const buf = new RingBuffer(3)
		buf.append("a")
		buf.append("b")
		buf.append("c")
		buf.append("d") // "a" evicted

		// Asking for after seq 0 should only get b, c, d (seq 2, 3, 4)
		const result = buf.getAfter(0, 10)
		expect(result).toHaveLength(3)
		expect(result[0].seq).toBe(2)
	})

	it("should include timestamp in chunks", () => {
		const buf = new RingBuffer(10)
		const before = Date.now()
		buf.append("test")
		const after = Date.now()

		const chunks = buf.getLatest(1)
		expect(chunks[0].timestamp).toBeGreaterThanOrEqual(before)
		expect(chunks[0].timestamp).toBeLessThanOrEqual(after)
	})
})
