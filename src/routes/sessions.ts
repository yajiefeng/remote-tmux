// ============================================================
// sessions.ts — REST 路由: /api/sessions
// ============================================================

import type { IncomingMessage, ServerResponse } from "node:http"
import type { Config } from "../config.js"
import type { SessionManager } from "../core/session-manager.js"
import type { IdleMonitor } from "../core/idle-monitor.js"
import type { AuditLogger } from "../middleware/audit-logger.js"
import type { CreateSessionRequest } from "../types.js"

const MAX_BODY_BYTES = 65536 // 64KB

/** 读取请求 body（JSON），限制大小 */
async function readBody<T>(req: IncomingMessage): Promise<T> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = []
		let size = 0
		let tooLarge = false
		req.on("data", (chunk: Buffer) => {
			if (tooLarge) return
			size += chunk.length
			if (size > MAX_BODY_BYTES) {
				tooLarge = true
				req.resume() // drain remaining data
				reject(new BodyTooLargeError())
				return
			}
			chunks.push(chunk)
		})
		req.on("end", () => {
			if (tooLarge) return
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString()) as T)
			} catch {
				reject(new InvalidJsonError())
			}
		})
		req.on("error", (err) => {
			if (!tooLarge) reject(err)
		})
	})
}

class InvalidJsonError extends Error {
	constructor() { super("Invalid JSON body") }
}

class BodyTooLargeError extends Error {
	constructor() { super(`Body exceeds ${MAX_BODY_BYTES} bytes`) }
}

/** 发送 JSON 响应 */
function json(res: ServerResponse, status: number, data: unknown): void {
	res.writeHead(status, { "Content-Type": "application/json" })
	res.end(JSON.stringify(data))
}

/** 从 URL 提取 sessionId: /api/sessions/<sessionId>[/...] */
function extractSessionId(pathname: string): string | null {
	const match = pathname.match(/^\/api\/sessions\/([^/]+)/)
	return match?.[1] ?? null
}

/** 处理 /api/sessions 路由 */
export async function handleSessionsRoute(
	req: IncomingMessage,
	res: ServerResponse,
	manager: SessionManager,
	_config: Config,
	audit?: AuditLogger,
	idleMonitor?: IdleMonitor,
): Promise<void> {
	const url = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`)
	const pathname = url.pathname
	const method = req.method ?? "GET"
	const clientIp = req.socket.remoteAddress ?? "unknown"

	// POST /api/sessions — 创建会话
	if (method === "POST" && pathname === "/api/sessions") {
		try {
			const body = await readBody<CreateSessionRequest>(req)
			if (!body.name || typeof body.name !== "string") {
				json(res, 400, { code: "INVALID_MESSAGE", message: "name is required" })
				return
			}
			const info = await manager.create(body)
			audit?.log({ event: "session.created", sessionId: info.sessionId, ip: clientIp, detail: body.name })
			idleMonitor?.onSessionCreated(info.sessionId)
			json(res, 201, info)
		} catch (e) {
			if (e instanceof InvalidJsonError) {
				json(res, 400, { code: "INVALID_MESSAGE", message: e.message })
			} else if (e instanceof BodyTooLargeError) {
				json(res, 413, { code: "BODY_TOO_LARGE", message: e.message })
			} else {
				const message = e instanceof Error ? e.message : "Unknown error"
				json(res, 500, { code: "TMUX_ERROR", message })
			}
		}
		return
	}

	// GET /api/sessions — 列出会话
	if (method === "GET" && pathname === "/api/sessions") {
		json(res, 200, { items: manager.list() })
		return
	}

	// GET /api/sessions/:id — 会话详情
	if (method === "GET" && pathname.match(/^\/api\/sessions\/[^/]+$/)) {
		const sessionId = extractSessionId(pathname)
		if (!sessionId) {
			json(res, 400, { code: "INVALID_MESSAGE", message: "Missing sessionId" })
			return
		}
		const session = manager.get(sessionId)
		if (!session) {
			json(res, 404, { code: "SESSION_NOT_FOUND", message: "Session not found" })
			return
		}
		json(res, 200, {
			sessionId: session.sessionId,
			name: session.name,
			state: "running",
			connectedClients: session.clients.size,
			cols: session.cols,
			rows: session.rows,
			createdAt: session.createdAt.toISOString(),
		})
		return
	}

	// GET /api/sessions/:id/history — 历史输出
	if (method === "GET" && pathname.match(/^\/api\/sessions\/[^/]+\/history$/)) {
		const sessionId = extractSessionId(pathname)
		if (!sessionId) {
			json(res, 400, { code: "INVALID_MESSAGE", message: "Missing sessionId" })
			return
		}
		const session = manager.get(sessionId)
		if (!session) {
			json(res, 404, { code: "SESSION_NOT_FOUND", message: "Session not found" })
			return
		}

		const afterParam = url.searchParams.get("after")
		const limitParam = url.searchParams.get("limit")
		const latestParam = url.searchParams.get("latest")

		let chunks
		if (latestParam) {
			// Fetch the most recent N chunks (for session switch / initial load)
			const n = Math.min(parseInt(latestParam, 10) || 5000, 10000)
			chunks = session.buffer.getLatest(n)
		} else {
			// Incremental fetch after a known seq
			const after = afterParam ? parseInt(afterParam, 10) : 0
			const limit = limitParam ? Math.min(parseInt(limitParam, 10), 1000) : 500
			chunks = session.buffer.getAfter(after, limit)
		}

		json(res, 200, {
			sessionId,
			cursor: session.buffer.getCurrentSeq(),
			chunks,
		})
		return
	}

	// POST /api/sessions/:id/input — HTTP 备用输入
	if (method === "POST" && pathname.match(/^\/api\/sessions\/[^/]+\/input$/)) {
		const sessionId = extractSessionId(pathname)
		if (!sessionId) {
			json(res, 400, { code: "INVALID_MESSAGE", message: "Missing sessionId" })
			return
		}
		try {
			const body = await readBody<{ data: string }>(req)
			if (!body.data || typeof body.data !== "string") {
				json(res, 400, { code: "INVALID_MESSAGE", message: "data is required" })
				return
			}
			if (Buffer.byteLength(body.data) > _config.maxInputBytes) {
				json(res, 400, { code: "INPUT_TOO_LONG", message: `Max ${_config.maxInputBytes} bytes` })
				return
			}
			const ok = manager.write(sessionId, body.data)
			if (!ok) {
				json(res, 404, { code: "SESSION_NOT_FOUND", message: "Session not found" })
				return
			}
			audit?.log({ event: "session.input", sessionId, ip: clientIp, input: body.data.replace(/[\r\n]+$/, "") })
			json(res, 200, { ok: true })
		} catch (e) {
			if (e instanceof InvalidJsonError) {
				json(res, 400, { code: "INVALID_MESSAGE", message: e.message })
			} else if (e instanceof BodyTooLargeError) {
				json(res, 413, { code: "BODY_TOO_LARGE", message: e.message })
			} else {
				const message = e instanceof Error ? e.message : "Unknown error"
				json(res, 500, { code: "TMUX_ERROR", message })
			}
		}
		return
	}

	// DELETE /api/sessions/:id — 销毁会话
	if (method === "DELETE" && pathname.match(/^\/api\/sessions\/[^/]+$/)) {
		const sessionId = extractSessionId(pathname)
		if (!sessionId) {
			json(res, 400, { code: "INVALID_MESSAGE", message: "Missing sessionId" })
			return
		}
		const ok = await manager.destroy(sessionId)
		if (!ok) {
			json(res, 404, { code: "SESSION_NOT_FOUND", message: "Session not found" })
			return
		}
		audit?.log({ event: "session.destroyed", sessionId, ip: clientIp })
		idleMonitor?.removeSession(sessionId)
		json(res, 200, { ok: true, sessionId })
		return
	}

	// 404 fallback
	json(res, 404, { code: "NOT_FOUND", message: `${method} ${pathname} not found` })
}
