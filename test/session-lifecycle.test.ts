import { beforeEach, describe, expect, it, vi } from "vitest"

const { spawnedPtys, spawnPty } = vi.hoisted(() => {
	class FakePty {
		pid = 1234
		cols = 120
		rows = 36
		process = "tmux"
		handleFlowControl = false
		killed = false
		onData = (_handler: (data: string) => void) => ({ dispose: vi.fn() })
		onExit = (_handler: (event: { exitCode: number; signal?: number }) => void) => ({ dispose: vi.fn() })
		write(): void {}
		resize(): void {}
		clear(): void {}
		pause(): void {}
		resume(): void {}
		kill(): void { this.killed = true }
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

const mockKillSession = vi.fn().mockResolvedValue(undefined)
const mockListSessions = vi.fn().mockResolvedValue([])
const mockGetSize = vi.fn().mockResolvedValue({ cols: 80, rows: 24 })

vi.mock("@lydell/node-pty", () => ({
	spawn: spawnPty,
}))

vi.mock("../src/core/tmux.js", () => ({
	tmuxCapturePaneEscape: vi.fn().mockResolvedValue(""),
	tmuxGetCursorPosition: vi.fn().mockResolvedValue({ x: 0, y: 0 }),
	tmuxGetSize: (...args: any[]) => mockGetSize(...args),
	tmuxKillSession: (...args: any[]) => mockKillSession(...args),
	tmuxListSessions: (...args: any[]) => mockListSessions(...args),
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

describe("SessionManager lifecycle", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		spawnedPtys.length = 0
		mockKillSession.mockResolvedValue(undefined)
		mockListSessions.mockResolvedValue([])
		mockGetSize.mockResolvedValue({ cols: 80, rows: 24 })
	})

	it("destroy kills the PTY attach client and the tmux session", async () => {
		const manager = new SessionManager(makeConfig())
		const info = await manager.create({ name: "web" })

		await manager.destroy(info.sessionId)

		expect(spawnedPtys[0]!.killed).toBe(true)
		expect(mockKillSession).toHaveBeenCalledWith(expect.stringMatching(/^ses_[a-f0-9]{8}$/))
		expect(manager.get(info.sessionId)).toBeUndefined()
	})

	it("destroyAll kills PTY attach clients without killing tmux sessions", async () => {
		const manager = new SessionManager(makeConfig())
		await manager.create({ name: "web" })

		await manager.destroyAll()

		expect(spawnedPtys[0]!.killed).toBe(true)
		expect(mockKillSession).not.toHaveBeenCalled()
		expect(manager.list()).toEqual([])
	})

	it("reattaches existing ses_* tmux sessions through PTY", async () => {
		mockListSessions.mockResolvedValue([
			{ name: "other", windows: 1, created: "1" },
			{ name: "ses_abcd1234", windows: 1, created: "2" },
		])
		mockGetSize.mockResolvedValue({ cols: 90, rows: 30 })
		const manager = new SessionManager(makeConfig())

		const count = await manager.reattachAll()

		expect(count).toBe(1)
		expect(spawnPty).toHaveBeenCalledWith(
			"tmux",
			["new-session", "-A", "-s", "ses_abcd1234", "-c", expect.any(String)],
			expect.objectContaining({ cols: 90, rows: 30 }),
		)
		expect(manager.list()).toHaveLength(1)
		expect(manager.list()[0]!.name).toBe("reattached_ses_abcd1234")
	})
})
