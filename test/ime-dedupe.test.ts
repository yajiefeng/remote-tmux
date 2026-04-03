import { describe, expect, it, beforeEach } from "vitest"
import { ImeDedupe } from "../src/client/ime-dedupe.js"

describe("ImeDedupe", () => {
	let dedupe: ImeDedupe
	let clock: number

	beforeEach(() => {
		clock = 1000
		dedupe = new ImeDedupe(() => clock)
	})

	// --- needsFallback ---

	it("returns false for null, empty, and ASCII letters", () => {
		expect(ImeDedupe.needsFallback(null)).toBe(false)
		expect(ImeDedupe.needsFallback("")).toBe(false)
		expect(ImeDedupe.needsFallback("abc")).toBe(false)
	})

	it("returns true for digits", () => {
		expect(ImeDedupe.needsFallback("0")).toBe(true)
		expect(ImeDedupe.needsFallback("5")).toBe(true)
		expect(ImeDedupe.needsFallback("9")).toBe(true)
		expect(ImeDedupe.needsFallback("123")).toBe(true)
	})

	it("returns true for CJK Symbols and Punctuation (U+3000-303F)", () => {
		expect(ImeDedupe.needsFallback("\u3001")).toBe(true) // 、
		expect(ImeDedupe.needsFallback("\u3002")).toBe(true) // 。
		expect(ImeDedupe.needsFallback("\u300A")).toBe(true) // 《
		expect(ImeDedupe.needsFallback("\u300B")).toBe(true) // 》
	})

	it("returns true for Fullwidth Forms (U+FF00-FFEF)", () => {
		expect(ImeDedupe.needsFallback("\uFF01")).toBe(true) // ！
		expect(ImeDedupe.needsFallback("\uFF1F")).toBe(true) // ？
	})

	it("returns true for General Punctuation used in CJK (U+2010-2044)", () => {
		expect(ImeDedupe.needsFallback("\u2014")).toBe(true) // — em dash
		expect(ImeDedupe.needsFallback("\u2018")).toBe(true) // ' left single quote
		expect(ImeDedupe.needsFallback("\u2019")).toBe(true) // ' right single quote
		expect(ImeDedupe.needsFallback("\u201C")).toBe(true) // " left double quote
		expect(ImeDedupe.needsFallback("\u201D")).toBe(true) // " right double quote
		expect(ImeDedupe.needsFallback("\u2026")).toBe(true) // … ellipsis
	})

	it("returns false for Han characters (should not trigger fallback)", () => {
		expect(ImeDedupe.needsFallback("\u4F60")).toBe(false) // 你
		expect(ImeDedupe.needsFallback("\u597D")).toBe(false) // 好
		expect(ImeDedupe.needsFallback("\u6211")).toBe(false) // 我
	})

	// --- onData before input (reverse match) ---

	it("onData before input: deduplicates, no fallback", () => {
		dedupe.onData("\u3001")
		const id = dedupe.onInput("\u3001")
		expect(id).not.toBeNull()
		expect(dedupe.shouldSendFallback(id!)).toBe(false)
	})

	// --- input before onData (forward match) ---

	it("input before onData: deduplicates, no fallback", () => {
		const id = dedupe.onInput("\u3001")
		expect(id).not.toBeNull()
		dedupe.onData("\u3001") // matches pending entry
		expect(dedupe.shouldSendFallback(id!)).toBe(false)
	})

	// --- input without onData (true fallback) ---

	it("input without matching onData: sends fallback", () => {
		const id = dedupe.onInput("\u3001")
		expect(id).not.toBeNull()
		// No onData
		expect(dedupe.shouldSendFallback(id!)).toBe(true)
	})

	// --- repeated identical chars ---

	it("handles repeated identical chars matched individually", () => {
		dedupe.onData("\u3001")
		dedupe.onData("\u3001")
		const id1 = dedupe.onInput("\u3001")
		const id2 = dedupe.onInput("\u3001")
		expect(dedupe.shouldSendFallback(id1!)).toBe(false)
		expect(dedupe.shouldSendFallback(id2!)).toBe(false)
	})

	it("third repeated char without third onData: sends fallback", () => {
		dedupe.onData("\u3001")
		dedupe.onData("\u3001")
		const id1 = dedupe.onInput("\u3001")
		const id2 = dedupe.onInput("\u3001")
		const id3 = dedupe.onInput("\u3001") // no matching onData
		expect(dedupe.shouldSendFallback(id1!)).toBe(false)
		expect(dedupe.shouldSendFallback(id2!)).toBe(false)
		expect(dedupe.shouldSendFallback(id3!)).toBe(true)
	})

	// --- unrelated data ---

	it("ASCII onData does not match CJK pending input", () => {
		const id = dedupe.onInput("\u3001")
		dedupe.onData("a") // ASCII, not a match
		expect(dedupe.shouldSendFallback(id!)).toBe(true)
	})

	it("different CJK char onData does not match pending", () => {
		const id = dedupe.onInput("\u3001") // 、
		dedupe.onData("\u3002") // 。different char
		expect(dedupe.shouldSendFallback(id!)).toBe(true)
	})

	// --- digits (IME swallows on mobile) ---

	it("digit: onData before input deduplicates", () => {
		dedupe.onData("5")
		const id = dedupe.onInput("5")
		expect(id).not.toBeNull()
		expect(dedupe.shouldSendFallback(id!)).toBe(false)
	})

	it("digit: input without onData sends fallback", () => {
		const id = dedupe.onInput("5")
		expect(id).not.toBeNull()
		expect(dedupe.shouldSendFallback(id!)).toBe(true)
	})

	it("digit: input before onData deduplicates", () => {
		const id = dedupe.onInput("5")
		expect(id).not.toBeNull()
		dedupe.onData("5")
		expect(dedupe.shouldSendFallback(id!)).toBe(false)
	})

	// --- ASCII chars swallowed by CJK IME ---

	it("returns true for space, slash, hyphen", () => {
		expect(ImeDedupe.needsFallback(" ")).toBe(true)
		expect(ImeDedupe.needsFallback("/")).toBe(true)
		expect(ImeDedupe.needsFallback("-")).toBe(true)
	})

	it("returns true for #, @, _, \\, ^", () => {
		expect(ImeDedupe.needsFallback("#")).toBe(true)
		expect(ImeDedupe.needsFallback("@")).toBe(true)
		expect(ImeDedupe.needsFallback("_")).toBe(true)
		expect(ImeDedupe.needsFallback("\\")).toBe(true)
		expect(ImeDedupe.needsFallback("^")).toBe(true)
	})

	it("returns true for other ASCII punctuation (!~|=+)", () => {
		expect(ImeDedupe.needsFallback("!")).toBe(true)
		expect(ImeDedupe.needsFallback("~")).toBe(true)
		expect(ImeDedupe.needsFallback("|")).toBe(true)
		expect(ImeDedupe.needsFallback("=")).toBe(true)
		expect(ImeDedupe.needsFallback("+")).toBe(true)
	})

	it("returns true for currency symbols (¥ € £)", () => {
		expect(ImeDedupe.needsFallback("\u00A5")).toBe(true) // ¥
		expect(ImeDedupe.needsFallback("\u20AC")).toBe(true) // €
		expect(ImeDedupe.needsFallback("\u00A3")).toBe(true) // £
	})

	it("space: input without onData sends fallback", () => {
		const id = dedupe.onInput(" ")
		expect(id).not.toBeNull()
		expect(dedupe.shouldSendFallback(id!)).toBe(true)
	})

	it("slash: input without onData sends fallback", () => {
		const id = dedupe.onInput("/")
		expect(id).not.toBeNull()
		expect(dedupe.shouldSendFallback(id!)).toBe(true)
	})

	it("hyphen: input without onData sends fallback", () => {
		const id = dedupe.onInput("-")
		expect(id).not.toBeNull()
		expect(dedupe.shouldSendFallback(id!)).toBe(true)
	})

	it("space: onData before input deduplicates", () => {
		dedupe.onData(" ")
		const id = dedupe.onInput(" ")
		expect(id).not.toBeNull()
		expect(dedupe.shouldSendFallback(id!)).toBe(false)
	})

	// --- non-CJK-punctuation skipped ---

	it("returns null for non-CJK-punctuation input (Han chars)", () => {
		expect(dedupe.onInput("\u4F60")).toBeNull() // 你
	})

	it("returns null for ASCII letter input", () => {
		expect(dedupe.onInput("a")).toBeNull()
	})

	it("returns null for null input", () => {
		expect(dedupe.onInput(null)).toBeNull()
	})

	// --- TTL expiry (issue #5) ---

	it("expired recent entries are pruned, fallback fires", () => {
		dedupe.onData("\u3001")
		clock += 600 // past 500ms TTL
		const id = dedupe.onInput("\u3001")
		expect(id).not.toBeNull()
		expect(dedupe.shouldSendFallback(id!)).toBe(true) // expired, not matched
	})

	it("recent entries within TTL still match", () => {
		dedupe.onData("\u3001")
		clock += 400 // within 500ms TTL
		const id = dedupe.onInput("\u3001")
		expect(id).not.toBeNull()
		expect(dedupe.shouldSendFallback(id!)).toBe(false) // still valid
	})

	// --- shouldSendFallback edge cases ---

	it("shouldSendFallback returns false for unknown id", () => {
		expect(dedupe.shouldSendFallback(9999)).toBe(false)
	})

	it("shouldSendFallback cleans up entry after call", () => {
		const id = dedupe.onInput("\u3001")!
		dedupe.shouldSendFallback(id)
		// Second call returns false (entry gone)
		expect(dedupe.shouldSendFallback(id)).toBe(false)
	})
})
