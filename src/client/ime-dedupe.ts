export class ImeDeduper {
	private pending = new Map<number, { data: string; handled: boolean }>()
	private recentNonAscii: string[] = []
	private nextId = 1

	onData(data: string): void {
		let matched = false
		for (const entry of this.pending.values()) {
			if (!entry.handled && entry.data === data) {
				entry.handled = true
				matched = true
				break
			}
		}

		if (!matched) {
			for (const ch of Array.from(data)) {
				if (ch.charCodeAt(0) >= 128) {
					this.recentNonAscii.push(ch)
				}
			}
			if (this.recentNonAscii.length > 64) {
				this.recentNonAscii = this.recentNonAscii.slice(-64)
			}
		}
	}

	onInput(data: string): number | null {
		if (!this.isFallbackCandidate(data)) {
			return null
		}

		const id = this.nextId++
		const handled = this.consumeRecent(data)
		this.pending.set(id, { data, handled })
		return id
	}

	shouldSendFallback(id: number): boolean {
		const entry = this.pending.get(id)
		if (!entry) return false
		this.pending.delete(id)
		return !entry.handled
	}

	private isFallbackCandidate(data: string): boolean {
		if (!data) return false
		// Keep fallback narrow: only CJK/full-width punctuation where some
		// mobile keyboards may skip xterm onData.
		return /[\u3000-\u303F\uFF00-\uFFEF]/u.test(data)
	}

	private consumeRecent(data: string): boolean {
		const chars = Array.from(data).filter((ch) => ch.charCodeAt(0) >= 128)
		if (chars.length === 0) return false

		const snapshot = [...this.recentNonAscii]
		for (const ch of chars) {
			const idx = snapshot.indexOf(ch)
			if (idx < 0) {
				return false
			}
			snapshot.splice(idx, 1)
		}

		this.recentNonAscii = snapshot
		return true
	}
}
