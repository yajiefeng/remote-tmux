import { beforeEach, describe, expect, it, vi } from "vitest"

const { spawnedPtys, spawnPty } = vi.hoisted(() => {
	class FakePty {
		pid = 1234
		cols = 120
		rows = 36
		process = "tmux"
		handleFlowControl = false
		writes: Array<string | Buffer> = []
		onData = (_handler: (data: string) => void) => ({ dispose: vi.fn() })
		onExit = (_handler: (event: { exitCode: number; signal?: number }) => void) => ({ dispose: vi.fn() })
		write(data: string | Buffer): void { this.writes.push(data) }
		resize(): void {}
		clear(): void {}
		pause(): void {}
		resume(): void {}
		kill(): void {}
	}

	const spawnedPtys: FakePty[] = []
	const spawnPty = vi.fn((_file: string, _args: string[], options: { cols?: number; rows?: number }) => {
		const fake = new FakePty()
		fake.cols = options.cols ?? fake.cols
		fake.rows = options.rows ?? fake.rows
		spawnedPtys.push(fake)
		return fake
	})
	return { spawnedPtys, spawnPty }
})

vi.mock("@lydell/node-pty", () => ({
	spawn: spawnPty,
}))

vi.mock("../src/core/tmux.js", () => ({
	tmuxCapturePaneEscape: vi.fn().mockResolvedValue(""),
	tmuxGetCursorPosition: vi.fn().mockResolvedValue({ x: 0, y: 0 }),
	tmuxGetSize: vi.fn().mockResolvedValue({ cols: 80, rows: 24 }),
	tmuxKillSession: vi.fn().mockResolvedValue(undefined),
	tmuxListSessions: vi.fn().mockResolvedValue([]),
}))

import { SessionManager } from "../src/core/session-manager.js"
import type { Config } from "../src/config.js"

function makeConfig(): Config {
	return {
		port: 3000,
		host: "127.0.0.1",
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
		spawnedPtys.length = 0
		manager = new SessionManager(makeConfig())
		const info = await manager.create({ name: "test-paste" })
		sessionId = info.sessionId
	})

	it("normal write sends raw input to PTY", () => {
		manager.write(sessionId, "ls\r")

		expect(spawnedPtys[0]!.writes).toEqual(["ls\r"])
	})

	it("bracketed write wraps input in paste markers", () => {
		manager.write(sessionId, "line1\nline2\nline3", true)

		expect(spawnedPtys[0]!.writes).toEqual([
			"\x1b[200~line1\nline2\nline3\x1b[201~",
		])
	})
})
