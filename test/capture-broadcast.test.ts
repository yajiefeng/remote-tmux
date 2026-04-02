// ============================================================
// capture-broadcast.test.ts — 保护 captureAndBroadcast + snapshot 的正确行为
// ============================================================

import { describe, expect, it, vi, beforeEach } from "vitest"
import { EventEmitter } from "node:events"
import { Readable } from "node:stream"

// --- Mocks ---

const mockCapturePaneEscape = vi.fn().mockResolvedValue("")
const mockGetCursorPosition = vi.fn().mockResolvedValue({ x: 0, y: 0 })

vi.mock("../src/core/tmux.js", () => ({
	tmuxCreate: vi.fn().mockResolvedValue(undefined),
	tmuxPipePane: vi.fn().mockResolvedValue(undefined),
	tmuxResizeWindow: vi.fn().mockResolvedValue(undefined),
	tmuxKillSession: vi.fn().mockResolvedValue(undefined),
	tmuxCapturePaneText: vi.fn().mockResolvedValue(""),
	tmuxCapturePaneEscape: (...args: any[]) => mockCapturePaneEscape(...args),
	tmuxGetCursorPosition: (...args: any[]) => mockGetCursorPosition(...args),
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

// Capture the spawned tail process so tests can trigger stdout events
let lastSpawnedProc: EventEmitter & { stdout: Readable }

vi.mock("node:child_process", async () => {
	const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process")
	return {
		...actual,
		spawn: vi.fn().mockImplementation(() => {
			const proc = new EventEmitter() as any
			proc.stdout = new Readable({ read() {} })
			proc.stderr = new Readable({ read() {} })
			proc.stdin = { write: vi.fn(), end: vi.fn() }
			proc.kill = vi.fn()
			proc.pid = 12345
			lastSpawnedProc = proc
			return proc
		}),
		execFile: vi.fn().mockImplementation((_cmd: string, _args: string[], cb: Function) => {
			cb(null, "", "")
		}),
	}
})

import { SessionManager } from "../src/core/session-manager.js"
import type { Config } from "../src/config.js"

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

function mockWs(readyState = 1): any {
	return { readyState, send: vi.fn(), close: vi.fn() }
}

/** Trigger a capture cycle: emit stdout data + wait for the interval timer */
async function triggerCapture(): Promise<void> {
	// Emit data on tail stdout to set activityDetected = true
	lastSpawnedProc.stdout.push("x")
	// Let the setInterval callback run
	await vi.advanceTimersByTimeAsync(60)
}

// ============================================================

describe("captureAndBroadcast", () => {
	let manager: SessionManager
	let sessionId: string
	let ws: any

	beforeEach(async () => {
		vi.useFakeTimers()
		vi.clearAllMocks()
		mockCapturePaneEscape.mockResolvedValue("")
		mockGetCursorPosition.mockResolvedValue({ x: 0, y: 0 })

		manager = new SessionManager(makeConfig())
		const info = await manager.create({ name: "test-capture" })
		sessionId = info.sessionId
		ws = mockWs()
		manager.addClient(sessionId, ws, 80, 24)
	})

	it("sends \\x1b[2J\\x1b[H + screen + cursor on each frame", async () => {
		const screen = "line1\r\nline2\r\nline3"
		mockCapturePaneEscape.mockResolvedValue(screen)
		mockGetCursorPosition.mockResolvedValue({ x: 5, y: 2 })

		await triggerCapture()

		expect(ws.send).toHaveBeenCalledTimes(1)
		const msg = JSON.parse(ws.send.mock.calls[0][0])
		expect(msg.type).toBe("output")
		// Must start with clear screen + home
		expect(msg.data).toMatch(/^\x1b\[2J\x1b\[H/)
		// Must contain the screen content
		expect(msg.data).toContain(screen)
		// Must end with cursor position (row 3, col 6)
		expect(msg.data).toContain("\x1b[3;6H")
	})

	it("does not broadcast when screen is unchanged", async () => {
		const screen = "same content"
		mockCapturePaneEscape.mockResolvedValue(screen)

		await triggerCapture()
		expect(ws.send).toHaveBeenCalledTimes(1)

		ws.send.mockClear()
		await triggerCapture()
		expect(ws.send).not.toHaveBeenCalled()
	})

	it("broadcasts again when screen changes", async () => {
		mockCapturePaneEscape.mockResolvedValue("frame1")
		await triggerCapture()

		ws.send.mockClear()
		mockCapturePaneEscape.mockResolvedValue("frame2")
		await triggerCapture()

		expect(ws.send).toHaveBeenCalledTimes(1)
		const msg = JSON.parse(ws.send.mock.calls[0][0])
		expect(msg.data).toContain("frame2")
	})

	it("does not broadcast without activity (no stdout data)", async () => {
		mockCapturePaneEscape.mockResolvedValue("some screen")
		// Only advance timer without triggering stdout
		await vi.advanceTimersByTimeAsync(60)

		expect(ws.send).not.toHaveBeenCalled()
	})

	it("uses default scrollbackLines (500) for capture", async () => {
		mockCapturePaneEscape.mockResolvedValue("test")
		await triggerCapture()

		// tmuxCapturePaneEscape should be called with session name only (default 500)
		expect(mockCapturePaneEscape).toHaveBeenCalledWith(
			expect.stringContaining("ses_"),
		)
		// Verify no explicit 0 is passed — default parameter = 500
		const callArgs = mockCapturePaneEscape.mock.calls[0]
		expect(callArgs).toHaveLength(1)
	})

	it("appends output to RingBuffer with incrementing seq", async () => {
		mockCapturePaneEscape.mockResolvedValue("frame1")
		await triggerCapture()

		mockCapturePaneEscape.mockResolvedValue("frame2")
		await triggerCapture()

		const session = manager.get(sessionId)!
		expect(session.buffer.getCurrentSeq()).toBe(2)
		const chunks = session.buffer.getLatest(10)
		expect(chunks).toHaveLength(2)
		expect(chunks[0].seq).toBe(1)
		expect(chunks[1].seq).toBe(2)
	})

	it("only sends to open WebSocket connections", async () => {
		const wsOpen = mockWs(1)
		const wsClosed = mockWs(3)
		manager.addClient(sessionId, wsOpen, 80, 24)
		manager.addClient(sessionId, wsClosed, 80, 24)

		mockCapturePaneEscape.mockResolvedValue("test")
		await triggerCapture()

		// ws (from beforeEach) + wsOpen should receive, wsClosed should not
		expect(ws.send).toHaveBeenCalled()
		expect(wsOpen.send).toHaveBeenCalled()
		expect(wsClosed.send).not.toHaveBeenCalled()
	})
})

// ============================================================

describe("snapshot", () => {
	let manager: SessionManager
	let sessionId: string

	beforeEach(async () => {
		vi.useRealTimers()
		vi.clearAllMocks()
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

	it("uses default scrollbackLines (500) for snapshot", async () => {
		mockCapturePaneEscape.mockResolvedValue("snap")
		await manager.snapshot(sessionId)

		// Should be called with just the session name (default 500)
		expect(mockCapturePaneEscape).toHaveBeenCalledWith(
			expect.stringContaining("ses_"),
		)
		const callArgs = mockCapturePaneEscape.mock.calls[0]
		expect(callArgs).toHaveLength(1)
	})

	it("returns current buffer seq", async () => {
		mockCapturePaneEscape.mockResolvedValue("snap")

		// Manually append to buffer to set seq
		const session = manager.get(sessionId)!
		session.buffer.append("chunk1")
		session.buffer.append("chunk2")

		const snap = await manager.snapshot(sessionId)
		expect(snap!.cursor).toBe(2)
	})

	it("returns null for unknown session", async () => {
		const snap = await manager.snapshot("nonexistent")
		expect(snap).toBeNull()
	})
})
