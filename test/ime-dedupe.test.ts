import { describe, expect, it } from "vitest"
import { existsSync } from "node:fs"

describe("minimalism", () => {
	it("does not keep unused IME mirror module", () => {
		expect(existsSync("src/client/ime-dedupe.ts")).toBe(false)
	})
})
