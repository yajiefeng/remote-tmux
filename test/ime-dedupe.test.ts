import { describe, expect, it } from "vitest"
import { ImeDeduper } from "../src/client/ime-dedupe.js"

describe("ImeDeduper", () => {
	it("does not fallback-track normal Han characters", () => {
		const deduper = new ImeDeduper()

		const id = deduper.onInput("你")
		expect(id).toBeNull()
	})

	it("marks CJK punctuation as handled when onData already emitted it", () => {
		const deduper = new ImeDeduper()
		deduper.onData("，")

		const id = deduper.onInput("，")
		expect(id).not.toBeNull()
		expect(deduper.shouldSendFallback(id!)).toBe(false)
	})

	it("requests fallback send for CJK punctuation without matching onData", () => {
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
