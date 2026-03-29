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

/** 创建 tmux session（detached） */
export async function tmuxCreate(
	name: string,
	cwd: string,
	cols: number,
	rows: number,
): Promise<void> {
	await exec("tmux", [
		"new-session",
		"-d",
		"-s",
		name,
		"-c",
		cwd,
		"-x",
		String(cols),
		"-y",
		String(rows),
	])
}

/** 检查 tmux session 是否存在 */
export async function tmuxHasSession(name: string): Promise<boolean> {
	try {
		await exec("tmux", ["has-session", "-t", name])
		return true
	} catch {
		return false
	}
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

/** 抓取 pane 内容（调试用） */
export async function tmuxCapturePaneLines(
	name: string,
	lines: number = 50,
): Promise<string[]> {
	try {
		const { stdout } = await exec("tmux", [
			"capture-pane",
			"-pt",
			`${name}:0.0`,
			"-S",
			String(-lines),
		])
		return stdout.split("\n")
	} catch {
		return []
	}
}

/** 抓取 pane 纯文本内容（用于重连恢复，不带 escape 序列避免渲染错乱） */
export async function tmuxCapturePaneText(name: string): Promise<string> {
	try {
		const { stdout } = await exec("tmux", [
			"capture-pane",
			"-pt",
			`${name}:0.0`,
			"-S",
			"-",
		])
		// 去掉尾部空行
		const lines = stdout.split("\n")
		while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") {
			lines.pop()
		}
		if (lines.length === 0) return ""
		// 用 \r\n 让 xterm.js 正确换行定位
		return lines.join("\r\n") + "\r\n"
	} catch {
		return ""
	}
}

/** 启用 pipe-pane，将输出写入文件 */
export async function tmuxPipePane(name: string, outputPath: string): Promise<void> {
	// 先关闭已有的 pipe-pane（如果有的话，比如 reattach 场景）
	try {
		await exec("tmux", ["pipe-pane", "-t", name])
	} catch {
		// ignore
	}
	// 设置新的 pipe-pane
	await exec("tmux", [
		"pipe-pane",
		"-t",
		name,
		"-o",
		`cat >> ${outputPath}`,
	])
}

/** 调整 tmux 窗口大小 */
export async function tmuxResizeWindow(name: string, cols: number, rows: number): Promise<void> {
	try {
		await exec("tmux", [
			"resize-window",
			"-t",
			name,
			"-x",
			String(cols),
			"-y",
			String(rows),
		])
	} catch {
		// ignore - window might not exist
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
