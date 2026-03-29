import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { readFile, unlink } from "node:fs/promises"
import { AuditLogger, type AuditEvent } from "../src/middleware/audit-logger.js"

describe("AuditLogger", () => {
	const logPath = "/tmp/webshell-audit-test.jsonl"
	let logger: AuditLogger

	beforeEach(() => {
		logger = new AuditLogger(logPath)
	})

	afterEach(async () => {
		await logger.close()
		try { await unlink(logPath) } catch {}
	})

	it("writes a single event as JSONL", async () => {
		await logger.log({
			event: "session.created",
			sessionId: "abc-123",
			ip: "127.0.0.1",
		})
		await logger.flush()

		const content = await readFile(logPath, "utf-8")
		const lines = content.trim().split("\n")
		expect(lines).toHaveLength(1)

		const parsed = JSON.parse(lines[0]!) as AuditEvent
		expect(parsed.event).toBe("session.created")
		expect(parsed.sessionId).toBe("abc-123")
		expect(parsed.ip).toBe("127.0.0.1")
		expect(parsed.ts).toBeTypeOf("string")
	})

	it("writes multiple events in order", async () => {
		await logger.log({ event: "auth.success", ip: "1.2.3.4" })
		await logger.log({ event: "session.created", sessionId: "s1" })
		await logger.log({ event: "session.destroyed", sessionId: "s1" })
		await logger.flush()

		const content = await readFile(logPath, "utf-8")
		const lines = content.trim().split("\n")
		expect(lines).toHaveLength(3)

		const events = lines.map((l) => (JSON.parse(l) as AuditEvent).event)
		expect(events).toEqual(["auth.success", "session.created", "session.destroyed"])
	})

	it("records timestamp automatically", async () => {
		const before = Date.now()
		await logger.log({ event: "auth.failure", ip: "10.0.0.1" })
		await logger.flush()
		const after = Date.now()

		const content = await readFile(logPath, "utf-8")
		const parsed = JSON.parse(content.trim()) as AuditEvent
		const ts = new Date(parsed.ts).getTime()
		expect(ts).toBeGreaterThanOrEqual(before)
		expect(ts).toBeLessThanOrEqual(after)
	})

	it("truncates input data to maxInputPreview chars", async () => {
		const longInput = "a".repeat(500)
		await logger.log({
			event: "session.input",
			sessionId: "s1",
			input: longInput,
		})
		await logger.flush()

		const content = await readFile(logPath, "utf-8")
		const parsed = JSON.parse(content.trim()) as AuditEvent
		expect(parsed.input!.length).toBeLessThanOrEqual(100 + 3) // 100 + "..."
		expect(parsed.input!.endsWith("...")).toBe(true)
	})

	it("does not truncate short input", async () => {
		await logger.log({
			event: "session.input",
			sessionId: "s1",
			input: "ls -la",
		})
		await logger.flush()

		const content = await readFile(logPath, "utf-8")
		const parsed = JSON.parse(content.trim()) as AuditEvent
		expect(parsed.input).toBe("ls -la")
	})

	it("appends to existing file", async () => {
		await logger.log({ event: "auth.success", ip: "1.1.1.1" })
		await logger.flush()
		await logger.close()

		// Reopen same file
		const logger2 = new AuditLogger(logPath)
		await logger2.log({ event: "auth.success", ip: "2.2.2.2" })
		await logger2.flush()
		await logger2.close()

		const content = await readFile(logPath, "utf-8")
		const lines = content.trim().split("\n")
		expect(lines).toHaveLength(2)
	})

	it("handles disabled logger (empty path) gracefully", async () => {
		const disabled = new AuditLogger("")
		// Should not throw
		await disabled.log({ event: "auth.success", ip: "1.1.1.1" })
		await disabled.flush()
		await disabled.close()
	})
})
