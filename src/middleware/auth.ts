// ============================================================
// auth.ts — 鉴权中间件（P0: 静态 token）
// ============================================================

import type { IncomingMessage, ServerResponse } from "node:http"
import type { Config } from "../config.js"

/** 从请求中提取 token（Header 或 query param） */
export function extractToken(req: IncomingMessage): string | null {
	// 1. Authorization header
	const authHeader = req.headers.authorization
	if (authHeader?.startsWith("Bearer ")) {
		return authHeader.slice(7)
	}

	// 2. Query param (?token=xxx) — 用于 WebSocket
	const url = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`)
	return url.searchParams.get("token")
}

/** 验证 token */
export function verifyToken(token: string | null, config: Config): boolean {
	if (!token) return false
	return token === config.token
}

/** HTTP 中间件：验证请求 */
export function authMiddleware(
	config: Config,
	req: IncomingMessage,
	res: ServerResponse,
): boolean {
	const token = extractToken(req)
	if (!verifyToken(token, config)) {
		res.writeHead(401, { "Content-Type": "application/json" })
		res.end(JSON.stringify({ code: "UNAUTHORIZED", message: "Invalid or missing token" }))
		return false
	}
	return true
}
