import { describe, expect, it, vi, beforeEach } from "vitest"

vi.mock("../src/core/tmux.js", () => ({
	tmuxCreate: vi.fn().mockResolvedValue(undefined),
	tmuxPipePane: vi.fn().mockResolvedValue(undefined),
	tmuxResizeWindow: vi.fn().mockResolvedValue(undefined),
	tmuxKillSession: vi.fn().mockResolvedValue(undefined),
	tmuxCapturePaneText: vi.fn().mockResolvedValue(""),
	tmuxListSessions: vi.fn().mockResolvedValue([]),
	tmuxGetSize: vi.fn().mockResolvedValue({ cols: 80, rows: 24 }),
}))

vi.mock("node:fs/promises", async () => {
	const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
	return {
		...actual,
		open: vi.fn().mockResolvedValue({ close: vi.fn().mockResolvedValue(undefined) }),
		unlink: vi.fn().mockResolvedValue(undefined),
	}
})

// Track execFile calls to verify paste-buffer flags
const execFileCalls: Array<{ cmd: string; args: string[] }> = []

vi.mock("node:child_process", async () => {
	const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process")
	const EventEmitter = (await import("node:events")).EventEmitter
	const { Readable } = await import("node:stream")
	return {
		...actual,
		spawn: vi.fn().mockImplementation(() => {
			const proc = new EventEmitter() as any
			proc.stdout = new Readable({ read() {} })
			proc.stderr = new Readable({ read() {} })
			proc.stdin = {
				write: vi.fn(),
				end: vi.fn(() => {
					// Auto-fire close with success
					setTimeout(() => proc.emit("close", 0), 0)
				}),
			}
			proc.kill = vi.fn()
			proc.pid = 12345
			return proc
		}),
		execFile: vi.fn().mockImplementation((cmd: string, args: string[], cb: Function) => {
			execFileCalls.push({ cmd, args })
			cb(null, "", "")
		}),
	}
})

import { SessionManager } from "../src/core/session-manager.js"
import type { Config } from "../src/config.js"

function makeConfig(): Config {
	return {
		port: 3000,
		host: "0.0.0.0",
		token: "test",
		maxBufferChunks: 100,
		defaultCols: 120,
		defaultRows: 36,
		rateLimitMax: 100,
		rateLimitWindowMs: 60000,
		auditLogPath: "",
		idleTimeoutMs: 0,
		pingTimeoutMs: 30000,
	}
}

describe("SessionManager write with bracketed paste", () => {
	let manager: SessionManager
	let sessionId: string

	beforeEach(async () => {
		vi.clearAllMocks()
		execFileCalls.length = 0
		manager = new SessionManager(makeConfig())
		const info = await manager.create({ name: "test-paste" })
		sessionId = info.sessionId
	})

	it("normal write uses paste-buffer without -p flag", async () => {
		manager.write(sessionId, "ls\r")
		// Wait for write queue to flush
		const session = manager.get(sessionId)!
		await session.writeQueue

		const pasteCall = execFileCalls.find(
			(c) => c.cmd === "tmux" && c.args[0] === "paste-buffer",
		)
		expect(pasteCall).toBeDefined()
		expect(pasteCall!.args).not.toContain("-p")
	})

	it("bracketed write uses paste-buffer with -p flag", async () => {
		manager.write(sessionId, "line1\nline2\nline3", true)
		const session = manager.get(sessionId)!
		await session.writeQueue

		const pasteCall = execFileCalls.find(
			(c) => c.cmd === "tmux" && c.args[0] === "paste-buffer",
		)
		expect(pasteCall).toBeDefined()
		expect(pasteCall!.args).toContain("-p")
	})
})
