// ============================================================
// session-manager.ts — Session 生命周期管理
// shell 运行在 tmux 里（进程持久化），通过 pipe-pane 读输出，
// 通过 load-buffer + paste-buffer 写输入。
// 服务重启后可 reattach 已有 tmux session。
// ============================================================

import { execFile, spawn } from "node:child_process"
import { open, unlink } from "node:fs/promises"
import { promisify } from "node:util"
import { v4 as uuidv4 } from "uuid"
import type WebSocket from "ws"
import type { Config } from "../config.js"
import type { CreateSessionRequest, SessionInfo } from "../types.js"
import { RingBuffer } from "./ring-buffer.js"
import {
	tmuxCapturePaneEscape,
	tmuxCapturePaneText,
	tmuxCreate,
	tmuxGetCursorPosition,
	tmuxGetSize,
	tmuxKillSession,
	tmuxListSessions,
	tmuxPipePane,
	tmuxResizeWindow,
} from "./tmux.js"

const execFileAsync = promisify(execFile)

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
	/** 输出文件路径 */
	outputPath: string
	/** tail -f 进程 */
	tailProcess: ReturnType<typeof spawn> | null
	/** 写入队列，保证顺序 */
	writeQueue: Promise<void>
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

		// shell 运行在 tmux 里
		await tmuxCreate(tmuxName, workspace, cols, rows)

		const session = await this.attachToTmux(sessionId, req.name, tmuxName, cols, rows)

		// 如果指定了启动命令，发送它
		if (req.command && req.command !== "bash" && req.command !== "zsh") {
			await this.sendKeys(tmuxName, req.command)
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

			const session = await this.attachToTmux(
				sessionId,
				name,
				ts.name,
				size.cols,
				size.rows,
			)

			// 用 capture-pane 恢复可见屏幕内容到 buffer（纯文本，避免 escape 序列错乱）
			const screen = await tmuxCapturePaneText(ts.name)
			if (screen.length > 0) {
				session.buffer.append(screen)
			}

			console.log(
				`[session ${sessionId}] Reattached: tmux=${ts.name}`,
			)
			count++
		}

		return count
	}

	/** 连接到已有 tmux session，设置 pipe-pane + tail */
	private async attachToTmux(
		sessionId: string,
		name: string,
		tmuxName: string,
		cols: number,
		rows: number,
	): Promise<Session> {
		const outputPath = `/tmp/webshell_${tmuxName}.out`

		// 截断旧输出文件，避免 tail -f 读到上次残留数据
		const fd = await open(outputPath, "w")
		await fd.close()

		const buffer = new RingBuffer(this.config.maxBufferChunks)

		const session: Session = {
			sessionId,
			name,
			tmuxName,
			buffer,
			clients: new Map(),
			cols,
			rows,
			createdAt: new Date(),
			outputPath,
			tailProcess: null,
			writeQueue: Promise.resolve(),
		}

		// pipe-pane 将 tmux 输出写入文件
		await tmuxPipePane(tmuxName, outputPath)

		// tail -f 实时读取输出
		this.startOutputReader(session)

		this.sessions.set(sessionId, session)
		this.nameIndex.set(name, sessionId)

		return session
	}

	/** 启动 tail -f 输出读取器 */
	private startOutputReader(session: Session): void {
		const tail = spawn("tail", ["-f", session.outputPath], {
			stdio: ["ignore", "pipe", "ignore"],
		})

		// Screen-scraping approach: pipe-pane detects output activity,
		// then we periodically capture-pane to get the fully rendered screen.
		// This avoids forwarding raw escape sequences with cursor movements
		// that xterm.js can't render atomically (no DEC mode 2026 support).
		let activityDetected = false
		let captureTimer: ReturnType<typeof setInterval> | null = null
		let lastScreen = ""
		const CAPTURE_INTERVAL_MS = 50

		const captureAndBroadcast = async (): Promise<void> => {
			if (!activityDetected) return
			activityDetected = false
			try {
				const [screen, pos] = await Promise.all([
					tmuxCapturePaneEscape(session.tmuxName),
					tmuxGetCursorPosition(session.tmuxName),
				])
				if (screen === lastScreen) return
				lastScreen = screen
				// Overwrite from (1,1) without clearing — eliminates flicker.
				// \x1b[H  = cursor home (1,1)
				// \x1b[J  = erase from cursor to end of screen (clean up shorter frames)
				const cursorSeq = `\x1b[${pos.y + 1};${pos.x + 1}H`
				const data = "\x1b[H" + screen + "\x1b[J" + cursorSeq
				const seq = session.buffer.append(data)
				this.broadcast(session, { type: "output", data, seq })
			} catch {
				// tmux pane might be gone
			}
		}

		tail.stdout!.on("data", () => {
			activityDetected = true
		})

		captureTimer = setInterval(() => void captureAndBroadcast(), CAPTURE_INTERVAL_MS)

		tail.on("exit", () => {
			if (captureTimer) clearInterval(captureTimer)
			console.log(`[session ${session.sessionId}] tail process exited`)
		})

		session.tailProcess = tail
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

		// 停止 tail 进程
		if (session.tailProcess) {
			session.tailProcess.kill()
			session.tailProcess = null
		}

		// 杀 tmux session
		await tmuxKillSession(session.tmuxName)

		// 清理输出文件
		try {
			await unlink(session.outputPath)
		} catch {
			// ignore
		}

		// 清理索引
		this.nameIndex.delete(session.name)
		this.sessions.delete(sessionId)

		console.log(`[session ${sessionId}] Destroyed`)
		return true
	}

	/** 写入到 tmux session（load-buffer + paste-buffer，串行队列） */
	write(sessionId: string, data: string, bracketed?: boolean): boolean {
		const session = this.sessions.get(sessionId)
		if (!session) return false

		session.writeQueue = session.writeQueue
			.then(() => this.doWrite(session.tmuxName, data, bracketed))
			.catch((err: Error) => {
				console.error(`[session ${sessionId}] Write failed:`, err.message)
			})

		return true
	}

	/** 执行单次写入 */
	private doWrite(tmuxName: string, data: string, bracketed?: boolean): Promise<void> {
		return new Promise((resolve, reject) => {
			const loadBuffer = spawn("tmux", ["load-buffer", "-"], {
				stdio: ["pipe", "ignore", "pipe"],
			})

			let stderr = ""
			loadBuffer.stderr!.on("data", (chunk: Buffer) => {
				stderr += chunk.toString()
			})

			loadBuffer.stdin!.write(data)
			loadBuffer.stdin!.end()

			loadBuffer.on("close", (code) => {
				if (code !== 0) {
					reject(new Error(`load-buffer exited ${code}: ${stderr}`))
					return
				}
				const pasteArgs = ["paste-buffer", "-t", tmuxName, "-d"]
				if (bracketed) pasteArgs.push("-p")
				execFileAsync("tmux", pasteArgs)
					.then(() => resolve())
					.catch(reject)
			})

			loadBuffer.on("error", reject)
		})
	}

	/** 客户端报告尺寸，取所有客户端最小值 resize tmux */
	resize(sessionId: string, cols: number, rows: number, ws?: WebSocket): boolean {
		const session = this.sessions.get(sessionId)
		if (!session) return false

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

		// 只在尺寸真正变化时才 resize tmux
		if (minCols !== session.cols || minRows !== session.rows) {
			session.cols = minCols
			session.rows = minRows
			tmuxResizeWindow(session.tmuxName, minCols, minRows).catch(() => {})
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
			if (session.clients.size > 0) {
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
					tmuxResizeWindow(session.tmuxName, minCols, minRows).catch(() => {})
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
			// 停止 tail
			if (session.tailProcess) {
				session.tailProcess.kill()
				session.tailProcess = null
			}
			// 不杀 tmux session — 留着给重启后 reattach
		}
		this.sessions.clear()
		this.nameIndex.clear()
	}

	/** 通过 send-keys 发送命令（用于初始命令） */
	private async sendKeys(tmuxName: string, command: string): Promise<void> {
		await execFileAsync("tmux", ["send-keys", "-t", tmuxName, command, "Enter"])
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

	private toInfo(session: Session): SessionInfo {
		return {
			sessionId: session.sessionId,
			name: session.name,
			state: "running",
			connectedClients: session.clients.size,
			cols: session.cols,
			rows: session.rows,
			createdAt: session.createdAt.toISOString(),
		}
	}
}
