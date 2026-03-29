// ============================================================
// config.ts — 服务配置，从环境变量读取
// ============================================================

export interface Config {
	/** HTTP/WS 监听端口 */
	port: number
	/** 监听地址，0.0.0.0 允许外部访问 */
	host: string
	/** 静态鉴权 token（P0） */
	token: string
	/** 默认终端列数 */
	defaultCols: number
	/** 默认终端行数 */
	defaultRows: number
	/** RingBuffer 最大 chunk 数 */
	maxBufferChunks: number
	/** 单次输入最大字节数 */
	maxInputBytes: number
	/** WS 心跳超时（ms），超时断开 */
	pingTimeoutMs: number
	/** 频率限制：窗口内最大请求数 */
	rateLimitMax: number
	/** 频率限制：窗口时间（ms） */
	rateLimitWindowMs: number
	/** 审计日志文件路径，空字符串表示禁用 */
	auditLogPath: string
	/** 空闲超时（ms），session 无客户端连接超过此时间后自动清理，0 表示禁用 */
	idleTimeoutMs: number
}

export function loadConfig(): Config {
	const token = process.env.WEBSHELL_TOKEN
	if (!token) {
		console.error("WEBSHELL_TOKEN environment variable is required")
		process.exit(1)
	}

	return {
		port: parseInt(process.env.WEBSHELL_PORT ?? "3000", 10),
		host: process.env.WEBSHELL_HOST ?? "0.0.0.0",
		token,
		defaultCols: parseInt(process.env.WEBSHELL_COLS ?? "120", 10),
		defaultRows: parseInt(process.env.WEBSHELL_ROWS ?? "36", 10),
		maxBufferChunks: parseInt(process.env.WEBSHELL_BUFFER_SIZE ?? "50000", 10),
		maxInputBytes: parseInt(process.env.WEBSHELL_MAX_INPUT ?? "4096", 10),
		pingTimeoutMs: parseInt(process.env.WEBSHELL_PING_TIMEOUT ?? "45000", 10),
		rateLimitMax: parseInt(process.env.WEBSHELL_RATE_LIMIT_MAX ?? "60", 10),
		rateLimitWindowMs: parseInt(process.env.WEBSHELL_RATE_LIMIT_WINDOW ?? "10000", 10),
		auditLogPath: process.env.WEBSHELL_AUDIT_LOG ?? "",
		idleTimeoutMs: parseInt(process.env.WEBSHELL_IDLE_TIMEOUT ?? "0", 10),
	}
}
