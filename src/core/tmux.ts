// ============================================================
// tmux.ts — tmux 命令封装
// ============================================================

import { execFile } from "node:child_process"
import { promisify } from "node:util"

const exec = promisify(execFile)

export interface TmuxSessionInfo {
	name: string
	windows: number
	created: string
}

/** 列出所有 tmux session */
export async function tmuxListSessions(): Promise<TmuxSessionInfo[]> {
	try {
		const { stdout } = await exec("tmux", [
			"list-sessions",
			"-F",
			"#{session_name}\t#{session_windows}\t#{session_created}",
		])
		return stdout
			.trim()
			.split("\n")
			.filter((line) => line.length > 0)
			.map((line) => {
				const [name, windows, created] = line.split("\t")
				return {
					name: name ?? "",
					windows: parseInt(windows ?? "0", 10),
					created: created ?? "",
				}
			})
	} catch {
		// tmux server not running = no sessions
		return []
	}
}

/** 销毁 tmux session */
export async function tmuxKillSession(name: string): Promise<void> {
	try {
		await exec("tmux", ["kill-session", "-t", name])
	} catch {
		// session already gone, ignore
	}
}

/** 抓取当前屏幕快照（带 escape 序列 + scrollback，用于 session 切换时快速恢复画面） */
export async function tmuxCapturePaneEscape(name: string, scrollbackLines: number = 500): Promise<string> {
	try {
		const { stdout } = await exec("tmux", [
			"capture-pane",
			"-p",
			"-e",
			"-S",
			String(-scrollbackLines),
			"-t",
			`${name}:0.0`,
		])
		// tmux outputs \n but xterm.js needs \r\n to return cursor to column 0.
		// Do NOT strip trailing blank lines — they're needed to keep the viewport
		// aligned with tmux's visible area for correct cursor positioning.
		const lines = stdout.split("\n")
		// stdout ends with a trailing \n, producing one extra empty element
		if (lines.length > 0 && lines[lines.length - 1] === "") {
			lines.pop()
		}
		if (lines.length === 0) return ""
		return lines.join("\r\n")
	} catch {
		return ""
	}
}

/** 获取 tmux 窗口大小 */
export async function tmuxGetSize(name: string): Promise<{ cols: number; rows: number }> {
	try {
		const { stdout } = await exec("tmux", [
			"display-message",
			"-t",
			name,
			"-p",
			"#{window_width}\t#{window_height}",
		])
		const [cols, rows] = stdout.trim().split("\t").map(Number)
		return { cols: cols || 120, rows: rows || 36 }
	} catch {
		return { cols: 120, rows: 36 }
	}
}

/** 获取 pane 中的光标位置（0-based） */
export async function tmuxGetCursorPosition(name: string): Promise<{ x: number; y: number }> {
	try {
		const { stdout } = await exec("tmux", [
			"display-message",
			"-t",
			name,
			"-p",
			"#{cursor_x}\t#{cursor_y}",
		])
		const [x, y] = stdout.trim().split("\t").map(Number)
		return { x: x || 0, y: y || 0 }
	} catch {
		return { x: 0, y: 0 }
	}
}
