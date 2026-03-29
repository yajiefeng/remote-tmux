// ============================================================
// audit-logger.ts — 审计日志，JSONL 格式追加写入
// ============================================================

import { createWriteStream, type WriteStream } from "node:fs"

export interface AuditEvent {
	/** 事件类型 */
	event: string
	/** ISO 时间戳（自动填充） */
	ts: string
	/** 来源 IP */
	ip?: string
	/** 关联的 session ID */
	sessionId?: string
	/** 用户输入（自动截断） */
	input?: string
	/** 附加信息 */
	detail?: string
}

type AuditInput = Omit<AuditEvent, "ts"> & { ts?: string }

const MAX_INPUT_PREVIEW = 100

export class AuditLogger {
	private stream: WriteStream | null = null
	private enabled: boolean

	constructor(filePath: string) {
		this.enabled = filePath.length > 0
		if (this.enabled) {
			this.stream = createWriteStream(filePath, { flags: "a" })
		}
	}

	/** 记录一条审计事件 */
	async log(input: AuditInput): Promise<void> {
		if (!this.enabled || !this.stream) return

		const entry: AuditEvent = {
			...input,
			ts: input.ts ?? new Date().toISOString(),
		}

		// 截断过长的输入
		if (entry.input && entry.input.length > MAX_INPUT_PREVIEW) {
			entry.input = entry.input.substring(0, MAX_INPUT_PREVIEW) + "..."
		}

		const line = JSON.stringify(entry) + "\n"

		return new Promise<void>((resolve, reject) => {
			this.stream!.write(line, (err) => {
				if (err) reject(err)
				else resolve()
			})
		})
	}

	/** 强制刷盘 */
	async flush(): Promise<void> {
		if (!this.stream) return
		if (this.stream.writableLength === 0) return
		return new Promise<void>((resolve) => {
			this.stream!.once("drain", resolve)
		})
	}

	/** 关闭日志文件 */
	async close(): Promise<void> {
		if (!this.stream) return
		return new Promise<void>((resolve) => {
			this.stream!.end(() => {
				this.stream = null
				resolve()
			})
		})
	}
}
