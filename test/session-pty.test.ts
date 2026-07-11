import { beforeEach, describe, expect, it, vi } from "vitest"

type DataHandler = (data: string) => void
type ExitHandler = (event: { exitCode: number; signal?: number }) => void

class FakePty {
	pid = 1234
	cols = 120
	rows = 36
	process = "tmux"
	handleFlowControl = false
	writes: Array<string | Buffer> = []
	resizes: Array<{ cols: number; rows: number }> = []
	killed = false
	private dataHandlers: DataHandler[] = []
	private exitHandlers: ExitHandler[] = []

	onData = (handler: DataHandler) => {
		this.dataHandlers.push(handler)
		return { dispose: vi.fn() }
	}

	onExit = (handler: ExitHandler) => {
		this.exitHandlers.push(handler)
		return { dispose: vi.fn() }
	}

	write(data: string | Buffer): void {
		this.writes.push(data)
	}

	resize(cols: number, rows: number): void {
		this.cols = cols
		this.rows = rows
		this.resizes.push({ cols, rows })
	}

	clear(): void {}
	pause(): void {}
	resume(): void {}
	kill(): void { this.killed = true }

	emitData(data: string): void {
		for (const handler of this.dataHandlers) handler(data)
	}

	emitExit(exitCode: number, signal?: number): void {
		for (const handler of this.exitHandlers) handler({ exitCode, signal })
	}
}

const { spawnedPtys, spawnPty } = vi.hoisted(() => {
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
	tmuxGetSize: vi.fn().mockResolvedValue({ cols: 120, rows: 36 }),
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
	return { readyState, send: vi.fn(), close: vi.fn() }
}

describe("SessionManager PTY transport", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		spawnedPtys.length = 0
	})

	it("starts tmux inside a PTY using the requested workspace", async () => {
		const manager = new SessionManager(makeConfig())
		const info = await manager.create({ name: "web", workspace: "/tmp" })

		expect(info.state).toBe("running")
		expect(spawnPty).toHaveBeenCalledWith(
			"tmux",
			["new-session", "-A", "-s", expect.stringMatching(/^ses_[a-f0-9]{8}$/), "-c", "/tmp"],
			expect.objectContaining({
				name: "xterm-256color",
				cols: 120,
				rows: 36,
				cwd: "/tmp",
			}),
		)
	})

	it("streams PTY output to connected clients and stores it in history", async () => {
		const manager = new SessionManager(makeConfig())
		const info = await manager.create({ name: "web", workspace: "/tmp" })
		const ws = mockWs()
		manager.addClient(info.sessionId, ws, 80, 24)

		spawnedPtys[0]!.emitData("hello")

		expect(ws.send).toHaveBeenCalledTimes(1)
		const msg = JSON.parse(ws.send.mock.calls[0][0])
		expect(msg).toEqual({ type: "output", data: "hello", seq: 1 })

		const session = manager.get(info.sessionId)!
		expect(session.buffer.getLatest()).toEqual([
			expect.objectContaining({ data: "hello", seq: 1 }),
		])
	})

	it("writes input directly to the PTY", async () => {
		const manager = new SessionManager(makeConfig())
		const info = await manager.create({ name: "web", workspace: "/tmp" })

		expect(manager.write(info.sessionId, "ls\r")).toBe(true)

		expect(spawnedPtys[0]!.writes).toEqual(["ls\r"])
	})

	it("wraps paste input in bracketed paste markers", async () => {
		const manager = new SessionManager(makeConfig())
		const info = await manager.create({ name: "web", workspace: "/tmp" })

		expect(manager.write(info.sessionId, "hello\nworld", true)).toBe(true)

		expect(spawnedPtys[0]!.writes).toEqual(["\x1b[200~hello\nworld\x1b[201~"])
	})
})
