import { describe, expect, it } from "vitest"
import { ImeDeduper } from "../src/client/ime-dedupe.js"

describe("ImeDeduper", () => {
	it("marks IME input as handled when onData emitted a combined Chinese chunk", () => {
		const deduper = new ImeDeduper()

		// Some mobile keyboards emit combined data in onData
		deduper.onData("你好")

		const id1 = deduper.onInput("你")
		const id2 = deduper.onInput("好")

		expect(id1).not.toBeNull()
		expect(id2).not.toBeNull()
		expect(deduper.shouldSendFallback(id1!)).toBe(false)
		expect(deduper.shouldSendFallback(id2!)).toBe(false)
	})

	it("requests fallback send when IME input has no matching onData", () => {
		const deduper = new ImeDeduper()
		const id = deduper.onInput("，")

		expect(id).not.toBeNull()
		expect(deduper.shouldSendFallback(id!)).toBe(true)
	})

	it("ignores ASCII input in IME fallback path", () => {
		const deduper = new ImeDeduper()
		const id = deduper.onInput("a")

		expect(id).toBeNull()
	})
})
