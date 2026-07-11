import { beforeEach, describe, expect, it, vi } from "vitest"

const { spawnedPtys, spawnPty } = vi.hoisted(() => {
	class FakePty {
		pid = 1234
		cols = 120
		rows = 36
		process = "tmux"
		handleFlowControl = false
		writes: Array<string | Buffer> = []
		resizes: Array<{ cols: number; rows: number }> = []
		private dataHandlers: Array<(data: string) => void> = []
		private exitHandlers: Array<(event: { exitCode: number; signal?: number }) => void> = []

		onData = (handler: (data: string) => void) => {
			this.dataHandlers.push(handler)
			return { dispose: vi.fn() }
		}

		onExit = (handler: (event: { exitCode: number; signal?: number }) => void) => {
			this.exitHandlers.push(handler)
			return { dispose: vi.fn() }
		}

		write(data: string | Buffer): void { this.writes.push(data) }
		resize(cols: number, rows: number): void {
			this.cols = cols
			this.rows = rows
			this.resizes.push({ cols, rows })
		}
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

function mockWs(readyState = 1): any {
	return {
		readyState,
		send: vi.fn(),
		close: vi.fn(),
	}
}

describe("SessionManager resize (smallest-wins)", () => {
	let manager: SessionManager
	let sessionId: string

	beforeEach(async () => {
		vi.clearAllMocks()
		spawnedPtys.length = 0
		manager = new SessionManager(makeConfig())
		const info = await manager.create({ name: "test-resize" })
		sessionId = info.sessionId
	})

	it("single client resize updates session dimensions", () => {
		const ws1 = mockWs()
		manager.addClient(sessionId, ws1, 100, 30)
		manager.resize(sessionId, 80, 24, ws1)

		const session = manager.get(sessionId)!
		expect(session.cols).toBe(80)
		expect(session.rows).toBe(24)
	})

	it("two clients: uses smallest cols and rows", () => {
		const ws1 = mockWs()
		const ws2 = mockWs()
		manager.addClient(sessionId, ws1, 120, 40)
		manager.addClient(sessionId, ws2, 80, 24)

		manager.resize(sessionId, 120, 40, ws1)
		manager.resize(sessionId, 80, 24, ws2)

		const session = manager.get(sessionId)!
		expect(session.cols).toBe(80)
		expect(session.rows).toBe(24)
	})

	it("picks min cols from one client and min rows from another", () => {
		const ws1 = mockWs()
		const ws2 = mockWs()
		manager.addClient(sessionId, ws1, 80, 40)
		manager.addClient(sessionId, ws2, 120, 24)

		manager.resize(sessionId, 80, 40, ws1)
		manager.resize(sessionId, 120, 24, ws2)

		const session = manager.get(sessionId)!
		expect(session.cols).toBe(80)
		expect(session.rows).toBe(24)
	})

	it("does not resize PTY when size is unchanged", () => {
		const ws1 = mockWs()
		manager.addClient(sessionId, ws1, 120, 36)

		spawnedPtys[0]!.resizes = []
		manager.resize(sessionId, 120, 36, ws1)

		expect(spawnedPtys[0]!.resizes).toEqual([])
	})

	it("resizes PTY when size changes", () => {
		const ws1 = mockWs()
		manager.addClient(sessionId, ws1, 120, 36)

		spawnedPtys[0]!.resizes = []
		manager.resize(sessionId, 80, 24, ws1)

		expect(spawnedPtys[0]!.resizes).toEqual([{ cols: 80, rows: 24 }])
	})

	it("recalculates size when a client disconnects", () => {
		const ws1 = mockWs()
		const ws2 = mockWs()
		manager.addClient(sessionId, ws1, 80, 24)
		manager.addClient(sessionId, ws2, 120, 40)

		manager.resize(sessionId, 80, 24, ws1)
		manager.resize(sessionId, 120, 40, ws2)

		const session = manager.get(sessionId)!
		expect(session.cols).toBe(80)
		expect(session.rows).toBe(24)

		spawnedPtys[0]!.resizes = []
		manager.removeClient(sessionId, ws1)

		expect(session.cols).toBe(120)
		expect(session.rows).toBe(40)
		expect(spawnedPtys[0]!.resizes).toEqual([{ cols: 120, rows: 40 }])
	})

	it("does not resize when last client disconnects", () => {
		const ws1 = mockWs()
		manager.addClient(sessionId, ws1, 80, 24)
		manager.resize(sessionId, 80, 24, ws1)

		spawnedPtys[0]!.resizes = []
		manager.removeClient(sessionId, ws1)

		expect(spawnedPtys[0]!.resizes).toEqual([])
	})

	it("ignores closed WebSocket connections in min calculation", () => {
		const ws1 = mockWs(1)
		const ws2 = mockWs(3)
		manager.addClient(sessionId, ws1, 120, 40)
		manager.addClient(sessionId, ws2, 40, 10)

		manager.resize(sessionId, 120, 40, ws1)

		const session = manager.get(sessionId)!
		expect(session.cols).toBe(120)
		expect(session.rows).toBe(40)
	})

	it("addClient defaults to session dimensions when cols/rows not provided", () => {
		const ws1 = mockWs()
		manager.addClient(sessionId, ws1)

		const session = manager.get(sessionId)!
		const info = session.clients.get(ws1)!
		expect(info.cols).toBe(120)
		expect(info.rows).toBe(36)
	})
})
