// ============================================================
// ring-buffer.ts — 输出历史环形缓冲区
// ============================================================

import type { OutputChunk } from "../types.js"

export class RingBuffer {
	private chunks: OutputChunk[]
	private maxChunks: number
	private writeIndex: number = 0
	private count: number = 0
	private nextSeq: number = 1

	constructor(maxChunks: number = 50000) {
		this.maxChunks = maxChunks
		this.chunks = new Array(maxChunks)
	}

	/** 追加一条输出，返回分配的 seq */
	append(data: string): number {
		const seq = this.nextSeq++
		const chunk: OutputChunk = {
			seq,
			data,
			timestamp: Date.now(),
		}
		this.chunks[this.writeIndex] = chunk
		this.writeIndex = (this.writeIndex + 1) % this.maxChunks
		if (this.count < this.maxChunks) {
			this.count++
		}
		return seq
	}

	/** 获取 seq > afterSeq 的 chunks，最多返回 limit 条 */
	getAfter(afterSeq: number, limit: number = 500): OutputChunk[] {
		const result: OutputChunk[] = []
		const startIndex = this.count < this.maxChunks ? 0 : this.writeIndex

		for (let i = 0; i < this.count && result.length < limit; i++) {
			const idx = (startIndex + i) % this.maxChunks
			const chunk = this.chunks[idx]
			if (chunk && chunk.seq > afterSeq) {
				result.push(chunk)
			}
		}
		return result
	}

	/** 获取最新的 limit 条 */
	getLatest(limit: number = 200): OutputChunk[] {
		const result: OutputChunk[] = []
		const startOffset = Math.max(0, this.count - limit)
		const baseIndex = this.count < this.maxChunks ? 0 : this.writeIndex

		for (let i = startOffset; i < this.count; i++) {
			const idx = (baseIndex + i) % this.maxChunks
			const chunk = this.chunks[idx]
			if (chunk) {
				result.push(chunk)
			}
		}
		return result
	}

	/** 当前最新 seq，无数据时返回 0 */
	getCurrentSeq(): number {
		return this.nextSeq - 1
	}

	/** 当前存储的 chunk 数量 */
	size(): number {
		return this.count
	}
}
