// ============================================================
// capture-broadcast.test.ts — snapshot correctness for tmux-backed PTY sessions
// ============================================================

import { beforeEach, describe, expect, it, vi } from "vitest"

const { spawnedPtys, spawnPty } = vi.hoisted(() => {
	class FakePty {
		pid = 1234
		cols = 120
		rows = 36
		process = "tmux"
		handleFlowControl = false
		private dataHandlers: Array<(data: string) => void> = []
		onData = (handler: (data: string) => void) => {
			this.dataHandlers.push(handler)
			return { dispose: vi.fn() }
		}
		onExit = (_handler: (event: { exitCode: number; signal?: number }) => void) => ({ dispose: vi.fn() })
		write(): void {}
		resize(): void {}
		clear(): void {}
		pause(): void {}
		resume(): void {}
		kill(): void {}
		emitData(data: string): void {
			for (const handler of this.dataHandlers) handler(data)
		}
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

const mockCapturePaneEscape = vi.fn().mockResolvedValue("")
const mockGetCursorPosition = vi.fn().mockResolvedValue({ x: 0, y: 0 })

vi.mock("@lydell/node-pty", () => ({
	spawn: spawnPty,
}))

vi.mock("../src/core/tmux.js", () => ({
	tmuxCapturePaneEscape: (...args: any[]) => mockCapturePaneEscape(...args),
	tmuxGetCursorPosition: (...args: any[]) => mockGetCursorPosition(...args),
	tmuxGetSize: vi.fn().mockResolvedValue({ cols: 80, rows: 24 }),
	tmuxKillSession: vi.fn().mockResolvedValue(undefined),
	tmuxListSessions: vi.fn().mockResolvedValue([]),
}))

import { SessionManager } from "../src/core/session-manager.js"
import type { Config } from "../src/config.js"

function makeConfig(overrides?: Partial<Config>): Config {
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
		...overrides,
	}
}

describe("snapshot", () => {
	let manager: SessionManager
	let sessionId: string

	beforeEach(async () => {
		vi.clearAllMocks()
		spawnedPtys.length = 0
		mockCapturePaneEscape.mockResolvedValue("")
		mockGetCursorPosition.mockResolvedValue({ x: 0, y: 0 })

		manager = new SessionManager(makeConfig())
		const info = await manager.create({ name: "test-snapshot" })
		sessionId = info.sessionId
	})

	it("returns screen content with escape sequences", async () => {
		const screen = "\x1b[1mBold\x1b[0m line\r\nnormal line"
		mockCapturePaneEscape.mockResolvedValue(screen)
		mockGetCursorPosition.mockResolvedValue({ x: 10, y: 1 })

		const snap = await manager.snapshot(sessionId)
		expect(snap).not.toBeNull()
		expect(snap!.screen).toBe(screen)
		expect(snap!.cursorX).toBe(10)
		expect(snap!.cursorY).toBe(1)
	})

	it("uses default scrollbackLines for snapshot", async () => {
		mockCapturePaneEscape.mockResolvedValue("snap")

		await manager.snapshot(sessionId)

		expect(mockCapturePaneEscape).toHaveBeenCalledWith(
			expect.stringContaining("ses_"),
		)
		const callArgs = mockCapturePaneEscape.mock.calls[0]
		expect(callArgs).toHaveLength(1)
	})

	it("returns current buffer seq", async () => {
		mockCapturePaneEscape.mockResolvedValue("snap")
		spawnedPtys[0]!.emitData("chunk1")
		spawnedPtys[0]!.emitData("chunk2")

		const snap = await manager.snapshot(sessionId)

		expect(snap!.cursor).toBe(2)
	})

	it("returns null for unknown session", async () => {
		const snap = await manager.snapshot("missing")
		expect(snap).toBeNull()
	})
})
