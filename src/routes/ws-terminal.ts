// ============================================================
// ws-terminal.ts — WebSocket 路由: /api/ws/terminal
// ============================================================

import type WebSocket from "ws"
import type { Config } from "../config.js"
import type { SessionManager } from "../core/session-manager.js"
import type { IdleMonitor } from "../core/idle-monitor.js"
import type { AuditLogger } from "../middleware/audit-logger.js"
import type { WsClientMessage } from "../types.js"

function send(ws: WebSocket, message: object): void {
	if (ws.readyState === 1) {
		ws.send(JSON.stringify(message))
	}
}

function sendError(ws: WebSocket, code: string, message: string): void {
	send(ws, { type: "error", code, message })
}

export function handleWsTerminal(
	ws: WebSocket,
	sessionId: string,
	manager: SessionManager,
	config: Config,
	audit?: AuditLogger,
	idleMonitor?: IdleMonitor,
): void {
	const session = manager.get(sessionId)
	if (!session) {
		sendError(ws, "SESSION_NOT_FOUND", "Session not found")
		ws.close()
		return
	}

	// 注册客户端
	manager.addClient(sessionId, ws)
	idleMonitor?.onClientChange(sessionId, session.clients.size)

	// 发送 ready
	send(ws, {
		type: "ready",
		sessionId: session.sessionId,
		cols: session.cols,
		rows: session.rows,
	})

	console.log(
		`[ws ${sessionId}] Client connected (total: ${session.clients.size})`,
	)

	// 心跳超时检测
	let pingTimer: ReturnType<typeof setTimeout> | null = null

	function resetPingTimer(): void {
		if (pingTimer) clearTimeout(pingTimer)
		pingTimer = setTimeout(() => {
			console.log(`[ws ${sessionId}] Ping timeout, closing`)
			ws.close()
		}, config.pingTimeoutMs)
	}

	resetPingTimer()

	// 处理客户端消息
	ws.on("message", (raw: Buffer | string) => {
		resetPingTimer()

		let msg: WsClientMessage
		try {
			msg = JSON.parse(typeof raw === "string" ? raw : raw.toString()) as WsClientMessage
		} catch {
			sendError(ws, "INVALID_MESSAGE", "Invalid JSON")
			return
		}

		switch (msg.type) {
			case "input": {
				if (typeof msg.data !== "string") {
					sendError(ws, "INVALID_MESSAGE", "data must be a string")
					return
				}
				if (Buffer.byteLength(msg.data) > config.maxInputBytes) {
					sendError(ws, "INPUT_TOO_LONG", `Max ${config.maxInputBytes} bytes`)
					return
				}
				manager.write(sessionId, msg.data)
				audit?.log({ event: "session.input", sessionId, input: msg.data })
				break
			}

			case "resize": {
				const cols = msg.cols
				const rows = msg.rows
				if (typeof cols !== "number" || typeof rows !== "number" || cols < 1 || rows < 1) {
					sendError(ws, "INVALID_MESSAGE", "Invalid cols/rows")
					return
				}
				manager.resize(sessionId, cols, rows)
				break
			}

			case "ping": {
				send(ws, { type: "pong", ts: msg.ts })
				break
			}

			default: {
				sendError(ws, "INVALID_MESSAGE", `Unknown message type`)
			}
		}
	})

	function cleanup(): void {
		if (pingTimer) {
			clearTimeout(pingTimer)
			pingTimer = null
		}
		manager.removeClient(sessionId, ws)
		idleMonitor?.onClientChange(sessionId, session.clients.size)
	}

	// 连接关闭
	ws.on("close", () => {
		cleanup()
		console.log(
			`[ws ${sessionId}] Client disconnected (remaining: ${session.clients.size})`,
		)
	})

	ws.on("error", (err) => {
		cleanup()
		console.error(`[ws ${sessionId}] Error:`, err.message)
	})
}
