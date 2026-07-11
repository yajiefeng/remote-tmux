// ============================================================
// session-manager.ts — Session 生命周期管理
// shell 运行在 tmux 里（进程持久化），通过 PTY 提供真实终端流。
// 服务重启后可重新 attach 已有 tmux session。
// ============================================================

import * as pty from "@lydell/node-pty"
import type { IDisposable, IPty } from "@lydell/node-pty"
import { v4 as uuidv4 } from "uuid"
import type WebSocket from "ws"
import type { Config } from "../config.js"
import type { CreateSessionRequest, SessionInfo } from "../types.js"
import { RingBuffer } from "./ring-buffer.js"
import {
	tmuxCapturePaneEscape,
	tmuxGetCursorPosition,
	tmuxGetSize,
	tmuxKillSession,
	tmuxListSessions,
} from "./tmux.js"

export interface ClientInfo {
	cols: number
	rows: number
}

export interface Session {
	sessionId: string
	name: string
	tmuxName: string
	buffer: RingBuffer
	clients: Map<WebSocket, ClientInfo>
	cols: number
	rows: number
	createdAt: Date
	state: "running" | "exited"
	/** PTY running `tmux new-session -A -s ...` */
	ptyProcess: IPty
	dataSubscription: IDisposable
	exitSubscription: IDisposable
}

export class SessionManager {
	private sessions: Map<string, Session> = new Map()
	private nameIndex: Map<string, string> = new Map() // name -> sessionId
	private config: Config

	constructor(config: Config) {
		this.config = config
	}

	/** 创建新 session */
	async create(req: CreateSessionRequest): Promise<SessionInfo> {
		// 检查同名 session
		if (this.nameIndex.has(req.name)) {
			const existingId = this.nameIndex.get(req.name)!
			const existing = this.sessions.get(existingId)
			if (existing) {
				return this.toInfo(existing)
			}
		}

		const sessionId = uuidv4()
		const tmuxName = `ses_${sessionId.substring(0, 8)}`
		const workspace = req.workspace ?? process.env.HOME ?? "/tmp"
		const cols = this.config.defaultCols
		const rows = this.config.defaultRows

		const session = this.attachPtyToTmux(sessionId, req.name, tmuxName, workspace, cols, rows)

		// 如果指定了启动命令，发送它
		if (req.command && req.command !== "bash" && req.command !== "zsh") {
			this.write(session.sessionId, `${req.command}\r`)
		}

		console.log(
			`[session ${sessionId}] Created: name=${req.name} tmux=${tmuxName}`,
		)
		return this.toInfo(session)
	}

	/** 服务启动时 reattach 已有的 ses_* tmux session */
	async reattachAll(): Promise<number> {
		const tmuxSessions = await tmuxListSessions()
		let count = 0

		for (const ts of tmuxSessions) {
			if (!ts.name.startsWith("ses_")) continue

			// 已经被管理的跳过
			const alreadyManaged = Array.from(this.sessions.values()).some(
				(s) => s.tmuxName === ts.name,
			)
			if (alreadyManaged) continue

			const sessionId = uuidv4()
			const name = `reattached_${ts.name}`
			const size = await tmuxGetSize(ts.name)
			const workspace = process.env.HOME ?? "/tmp"

			this.attachPtyToTmux(
				sessionId,
				name,
				ts.name,
				workspace,
				size.cols,
				size.rows,
			)

			console.log(
				`[session ${sessionId}] Reattached: tmux=${ts.name}`,
			)
			count++
		}

		return count
	}

	/** 连接到 tmux session，PTY 负责真实终端 I/O */
	private attachPtyToTmux(
		sessionId: string,
		name: string,
		tmuxName: string,
		workspace: string,
		cols: number,
		rows: number,
	): Session {
		const buffer = new RingBuffer(this.config.maxBufferChunks)
		const ptyProcess = pty.spawn(
			"tmux",
			["new-session", "-A", "-s", tmuxName, "-c", workspace],
			{
				name: "xterm-256color",
				cols,
				rows,
				cwd: workspace,
				env: buildPtyEnv(),
			},
		)

		const session = {} as Session
		Object.assign(session, {
			sessionId,
			name,
			tmuxName,
			buffer,
			clients: new Map<WebSocket, ClientInfo>(),
			cols,
			rows,
			createdAt: new Date(),
			state: "running" as const,
			ptyProcess,
		})

		const dataSubscription = ptyProcess.onData((data) => {
			const seq = session.buffer.append(data)
			this.broadcast(session, { type: "output", data, seq })
		})

		const exitSubscription = ptyProcess.onExit((event) => {
			session.state = "exited"
			this.broadcast(session, {
				type: "closed",
				reason: `PTY exited (${event.exitCode}${event.signal ? `, ${event.signal}` : ""})`,
			})
			console.log(`[session ${session.sessionId}] PTY exited: ${event.exitCode}`)
		})

		session.dataSubscription = dataSubscription
		session.exitSubscription = exitSubscription

		this.sessions.set(sessionId, session)
		this.nameIndex.set(name, sessionId)

		return session
	}

	/** 获取 session */
	get(sessionId: string): Session | undefined {
		return this.sessions.get(sessionId)
	}

	/** 列出所有 session */
	list(): SessionInfo[] {
		return Array.from(this.sessions.values()).map((s) => this.toInfo(s))
	}

	/** 获取当前屏幕快照（带 escape 序列）+ 当前 seq + 光标位置 */
	async snapshot(sessionId: string): Promise<{ screen: string; cursor: number; cursorX: number; cursorY: number } | null> {
		const session = this.sessions.get(sessionId)
		if (!session) return null
		const [screen, pos] = await Promise.all([
			tmuxCapturePaneEscape(session.tmuxName),
			tmuxGetCursorPosition(session.tmuxName),
		])
		const cursor = session.buffer.getCurrentSeq()
		return { screen, cursor, cursorX: pos.x, cursorY: pos.y }
	}

	/** 销毁 session */
	async destroy(sessionId: string): Promise<boolean> {
		const session = this.sessions.get(sessionId)
		if (!session) return false

		// 通知所有客户端
		this.broadcast(session, {
			type: "closed",
			reason: "Session destroyed",
		})

		// 关闭所有 WS
		for (const [ws] of session.clients) {
			ws.close()
		}

		this.disposePty(session)

		// 杀 tmux session
		await tmuxKillSession(session.tmuxName)

		// 清理索引
		this.nameIndex.delete(session.name)
		this.sessions.delete(sessionId)

		console.log(`[session ${sessionId}] Destroyed`)
		return true
	}

	/** 写入到 PTY */
	write(sessionId: string, data: string, bracketed?: boolean): boolean {
		const session = this.sessions.get(sessionId)
		if (!session || session.state !== "running") return false

		const payload = bracketed ? `\x1b[200~${data}\x1b[201~` : data
		session.ptyProcess.write(payload)
		return true
	}

	/** 客户端报告尺寸，取所有客户端最小值 resize PTY */
	resize(sessionId: string, cols: number, rows: number, ws?: WebSocket): boolean {
		const session = this.sessions.get(sessionId)
		if (!session || session.state !== "running") return false

		// 更新该客户端自身的尺寸
		if (ws) {
			const info = session.clients.get(ws)
			if (info) {
				info.cols = cols
				info.rows = rows
			}
		}

		// 取所有已连接客户端的最小 cols/rows（类似 tmux smallest 策略）
		let minCols = cols
		let minRows = rows
		for (const [client, info] of session.clients) {
			if (client.readyState === 1) {
				if (info.cols < minCols) minCols = info.cols
				if (info.rows < minRows) minRows = info.rows
			}
		}

		// 只在尺寸真正变化时才 resize PTY
		if (minCols !== session.cols || minRows !== session.rows) {
			session.cols = minCols
			session.rows = minRows
			session.ptyProcess.resize(minCols, minRows)
		}
		return true
	}

	/** 添加 WS 客户端 */
	addClient(sessionId: string, ws: WebSocket, cols?: number, rows?: number): boolean {
		const session = this.sessions.get(sessionId)
		if (!session) return false
		session.clients.set(ws, { cols: cols ?? session.cols, rows: rows ?? session.rows })
		return true
	}

	/** 移除 WS 客户端，重新计算尺寸 */
	removeClient(sessionId: string, ws: WebSocket): void {
		const session = this.sessions.get(sessionId)
		if (session) {
			session.clients.delete(ws)
			// 剩余客户端重新计算最小尺寸
			if (session.clients.size > 0 && session.state === "running") {
				let minCols = Infinity
				let minRows = Infinity
				for (const [client, info] of session.clients) {
					if (client.readyState === 1) {
						if (info.cols < minCols) minCols = info.cols
						if (info.rows < minRows) minRows = info.rows
					}
				}
				if (minCols !== Infinity && (minCols !== session.cols || minRows !== session.rows)) {
					session.cols = minCols
					session.rows = minRows
					session.ptyProcess.resize(minCols, minRows)
				}
			}
		}
	}

	/** 销毁所有 session（shutdown 时只清理自身资源，不杀 tmux） */
	async destroyAll(): Promise<void> {
		for (const session of this.sessions.values()) {
			// 通知客户端
			this.broadcast(session, { type: "closed", reason: "Server shutting down" })
			for (const [ws] of session.clients) {
				ws.close()
			}
			// 只杀当前 PTY attach 客户端，不杀 tmux session — 留着给重启后 reattach
			this.disposePty(session)
		}
		this.sessions.clear()
		this.nameIndex.clear()
	}

	/** 广播消息给 session 的所有客户端 */
	private broadcast(session: Session, message: object): void {
		const data = JSON.stringify(message)
		for (const [ws] of session.clients) {
			if (ws.readyState === 1) {
				ws.send(data)
			}
		}
	}

	private disposePty(session: Session): void {
		try {
			session.dataSubscription.dispose()
		} catch {
			// ignore
		}
		try {
			session.exitSubscription.dispose()
		} catch {
			// ignore
		}
		try {
			session.ptyProcess.kill()
		} catch {
			// ignore
		}
	}

	private toInfo(session: Session): SessionInfo {
		return {
			sessionId: session.sessionId,
			name: session.name,
			state: session.state,
			connectedClients: session.clients.size,
			cols: session.cols,
			rows: session.rows,
			createdAt: session.createdAt.toISOString(),
		}
	}
}

function buildPtyEnv(): Record<string, string> {
	const env: Record<string, string> = {}
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value
	}
	env.TERM = "xterm-256color"
	return env
}
