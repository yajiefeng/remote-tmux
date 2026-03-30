import { describe, expect, it, vi, beforeEach } from "vitest"

// Mock tmux module — must be before importing session-manager
vi.mock("../src/core/tmux.js", () => ({
	tmuxCreate: vi.fn().mockResolvedValue(undefined),
	tmuxPipePane: vi.fn().mockResolvedValue(undefined),
	tmuxResizeWindow: vi.fn().mockResolvedValue(undefined),
	tmuxKillSession: vi.fn().mockResolvedValue(undefined),
	tmuxCapturePaneText: vi.fn().mockResolvedValue(""),
	tmuxListSessions: vi.fn().mockResolvedValue([]),
	tmuxGetSize: vi.fn().mockResolvedValue({ cols: 80, rows: 24 }),
}))

// Mock fs/promises open — attachToTmux truncates the output file
vi.mock("node:fs/promises", async () => {
	const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
	return {
		...actual,
		open: vi.fn().mockResolvedValue({ close: vi.fn().mockResolvedValue(undefined) }),
		unlink: vi.fn().mockResolvedValue(undefined),
	}
})

// Mock child_process spawn (tail -f)
vi.mock("node:child_process", async () => {
	const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process")
	const EventEmitter = (await import("node:events")).EventEmitter
	const { Readable } = await import("node:stream")
	return {
		...actual,
		spawn: vi.fn().mockImplementation(() => {
			const proc = new EventEmitter() as ReturnType<typeof import("node:child_process").spawn>
			;(proc as any).stdout = new Readable({ read() {} })
			;(proc as any).stderr = new Readable({ read() {} })
			;(proc as any).stdin = { write: vi.fn(), end: vi.fn() }
			;(proc as any).kill = vi.fn()
			;(proc as any).pid = 12345
			return proc
		}),
		execFile: vi.fn().mockImplementation((_cmd: string, _args: string[], cb: Function) => {
			cb(null, "", "")
		}),
	}
})

import { SessionManager } from "../src/core/session-manager.js"
import { tmuxResizeWindow } from "../src/core/tmux.js"
import type { Config } from "../src/config.js"

const mockResize = tmuxResizeWindow as ReturnType<typeof vi.fn>

function makeConfig(overrides?: Partial<Config>): Config {
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
		...overrides,
	}
}

/** Minimal WebSocket mock with readyState */
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

		// ws1 resizes to 120x40
		manager.resize(sessionId, 120, 40, ws1)
		// ws2 resizes to 80x24
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

	it("does not call tmuxResizeWindow when size unchanged", () => {
		const ws1 = mockWs()
		manager.addClient(sessionId, ws1, 120, 36)

		mockResize.mockClear()
		// 120x36 is the default — no change expected
		manager.resize(sessionId, 120, 36, ws1)

		expect(mockResize).not.toHaveBeenCalled()
	})

	it("calls tmuxResizeWindow when size changes", () => {
		const ws1 = mockWs()
		manager.addClient(sessionId, ws1, 120, 36)

		mockResize.mockClear()
		manager.resize(sessionId, 80, 24, ws1)

		expect(mockResize).toHaveBeenCalledWith(
			expect.stringContaining("ses_"),
			80,
			24,
		)
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

		// Remove the smaller client
		mockResize.mockClear()
		manager.removeClient(sessionId, ws1)

		expect(session.cols).toBe(120)
		expect(session.rows).toBe(40)
		expect(mockResize).toHaveBeenCalledWith(
			expect.stringContaining("ses_"),
			120,
			40,
		)
	})

	it("does not resize when last client disconnects", () => {
		const ws1 = mockWs()
		manager.addClient(sessionId, ws1, 80, 24)
		manager.resize(sessionId, 80, 24, ws1)

		mockResize.mockClear()
		manager.removeClient(sessionId, ws1)

		// No clients left — should not attempt resize
		expect(mockResize).not.toHaveBeenCalled()
	})

	it("ignores closed WebSocket connections in min calculation", () => {
		const ws1 = mockWs(1)  // OPEN
		const ws2 = mockWs(3)  // CLOSED
		manager.addClient(sessionId, ws1, 120, 40)
		manager.addClient(sessionId, ws2, 40, 10)

		manager.resize(sessionId, 120, 40, ws1)

		const session = manager.get(sessionId)!
		// ws2 is closed, should be ignored — session uses ws1's size
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
