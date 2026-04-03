/**
 * IME deduplication for CJK input in xterm.js.
 *
 * Problem: xterm.js on mobile may swallow CJK punctuation and digits that
 * don't go through composition when a CJK IME is active. We use an input
 * event fallback, but need to deduplicate against onData to avoid sending
 * the same character twice.
 *
 * Two event orderings:
 *   1. onData before input → stored in recentChars, input matches against it
 *   2. input before onData → stored in pending map, onData matches against it
 */

// Characters that may need IME fallback: anything that is NOT an ASCII
// letter and NOT a CJK ideograph / kana / hangul.  CJK IMEs may swallow
// punctuation, digits, symbols (¥ € etc.) without firing onData.
// The deduplication logic prevents double-sending when onData does fire.
// Excluded (handled normally by composition / onData):
//   a-z A-Z        ASCII letters
//   U+3040-309F    Hiragana
//   U+30A0-30FF    Katakana
//   U+4E00-9FFF    CJK Unified Ideographs
//   U+3400-4DBF    CJK Unified Ideographs Extension A
//   U+AC00-D7AF    Hangul Syllables
const IME_FALLBACK_RE = /[^a-zA-Z\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF\u3400-\u4DBF\uAC00-\uD7AF]/

/** Test if a single character matches the fallback set */
function isFallbackChar(ch: string): boolean {
	return IME_FALLBACK_RE.test(ch)
}

interface PendingEntry {
	data: string
	handled: boolean
}

interface RecentEntry {
	ch: string
	ts: number
}

const RECENT_MAX = 64
const RECENT_TTL_MS = 500

export class ImeDedupe {
	private pending = new Map<number, PendingEntry>()
	private recentChars: RecentEntry[] = []
	private nextId = 1
	private now: () => number

	constructor(nowFn?: () => number) {
		this.now = nowFn ?? (() => Date.now())
	}

	/** Check if data contains characters that may need IME fallback */
	static needsFallback(data: string | null): boolean {
		if (!data) return false
		return IME_FALLBACK_RE.test(data)
	}

	/** Called when xterm.js onData fires */
	onData(data: string): void {
		this.pruneRecent()

		// Forward match: check if a pending input event matches this data
		let matched = false
		for (const [, entry] of this.pending) {
			if (!matched && !entry.handled && entry.data === data) {
				entry.handled = true
				matched = true
			}
		}

		// Reverse record: store fallback-eligible chars for later input matching
		if (!matched) {
			const ts = this.now()
			for (const ch of data) {
				if (isFallbackChar(ch)) {
					this.recentChars.push({ ch, ts })
				}
			}
			if (this.recentChars.length > RECENT_MAX) {
				this.recentChars = this.recentChars.slice(-RECENT_MAX)
			}
		}
	}

	/** Called when input event fires. Returns an ID if fallback may be needed, null otherwise. */
	onInput(data: string | null): number | null {
		if (!ImeDedupe.needsFallback(data)) return null
		this.pruneRecent()
		const id = this.nextId++
		this.pending.set(id, { data: data!, handled: this.consumeRecent(data!) })
		return id
	}

	/** Called after a delay to check if the fallback should actually send. */
	shouldSendFallback(id: number): boolean {
		const entry = this.pending.get(id)
		if (!entry) return false
		this.pending.delete(id)
		return !entry.handled
	}

	private consumeRecent(data: string): boolean {
		const chars = [...data].filter((ch) => isFallbackChar(ch))
		if (chars.length === 0) return false

		const snapshot = this.recentChars.slice()
		for (const ch of chars) {
			const idx = snapshot.findIndex((e) => e.ch === ch)
			if (idx < 0) return false
			snapshot.splice(idx, 1)
		}
		this.recentChars = snapshot
		return true
	}

	private pruneRecent(): void {
		const cutoff = this.now() - RECENT_TTL_MS
		this.recentChars = this.recentChars.filter((e) => e.ts > cutoff)
	}
}
