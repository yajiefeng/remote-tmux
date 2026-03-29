// ============================================================
// types.ts — 共享类型定义
// ============================================================

// ----- Session -----

export interface SessionInfo {
	sessionId: string
	name: string
	state: "running" | "exited"
	connectedClients: number
	cols: number
	rows: number
	createdAt: string
}

export interface CreateSessionRequest {
	name: string
	workspace?: string
	command?: string
}

// ----- WebSocket Messages: Client -> Server -----

export interface WsInputMessage {
	type: "input"
	data: string
}

export interface WsResizeMessage {
	type: "resize"
	cols: number
	rows: number
}

export interface WsPingMessage {
	type: "ping"
	ts: number
}

export type WsClientMessage = WsInputMessage | WsResizeMessage | WsPingMessage

// ----- WebSocket Messages: Server -> Client -----

export interface WsReadyMessage {
	type: "ready"
	sessionId: string
	cols: number
	rows: number
}

export interface WsOutputMessage {
	type: "output"
	data: string
	seq: number
}

export interface WsPongMessage {
	type: "pong"
	ts: number
}

export interface WsClosedMessage {
	type: "closed"
	reason: string
}

export interface WsErrorMessage {
	type: "error"
	code: string
	message: string
}

export type WsServerMessage =
	| WsReadyMessage
	| WsOutputMessage
	| WsPongMessage
	| WsClosedMessage
	| WsErrorMessage

// ----- History -----

export interface OutputChunk {
	seq: number
	data: string
	timestamp: number
}

export interface HistoryResponse {
	sessionId: string
	cursor: number
	chunks: OutputChunk[]
}

// ----- Error -----

export interface ApiError {
	code: string
	message: string
}

export const ErrorCodes = {
	UNAUTHORIZED: { status: 401, code: "UNAUTHORIZED" },
	SESSION_NOT_FOUND: { status: 404, code: "SESSION_NOT_FOUND" },
	SESSION_ALREADY_EXISTS: { status: 409, code: "SESSION_ALREADY_EXISTS" },
	INPUT_TOO_LONG: { status: 400, code: "INPUT_TOO_LONG" },
	INVALID_MESSAGE: { status: 400, code: "INVALID_MESSAGE" },
	RATE_LIMITED: { status: 429, code: "RATE_LIMITED" },
	BODY_TOO_LARGE: { status: 413, code: "BODY_TOO_LARGE" },
	PTY_SPAWN_FAILED: { status: 500, code: "PTY_SPAWN_FAILED" },
	TMUX_ERROR: { status: 500, code: "TMUX_ERROR" },
} as const
