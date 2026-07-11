import { afterEach, describe, expect, it, vi } from "vitest"

const ORIGINAL_ENV = { ...process.env }

afterEach(() => {
	process.env = { ...ORIGINAL_ENV }
	vi.restoreAllMocks()
})

describe("loadConfig", () => {
	it("listens on localhost by default", async () => {
		process.env = { ...ORIGINAL_ENV, WEBSHELL_TOKEN: "secret" }
		delete process.env.WEBSHELL_HOST

		const { loadConfig } = await import("../src/config.js")

		expect(loadConfig().host).toBe("127.0.0.1")
	})

	it("allows an explicit host override", async () => {
		process.env = {
			...ORIGINAL_ENV,
			WEBSHELL_TOKEN: "secret",
			WEBSHELL_HOST: "0.0.0.0",
		}

		const { loadConfig } = await import("../src/config.js")

		expect(loadConfig().host).toBe("0.0.0.0")
	})
})
