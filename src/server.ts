// ============================================================
// server.ts — HTTP + WebSocket 服务入口
// ============================================================

import { createServer } from "node:http"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
import { WebSocketServer } from "ws"
import type { Config } from "./config.js"
import { SessionManager } from "./core/session-manager.js"
import { IdleMonitor } from "./core/idle-monitor.js"
import { authMiddleware, extractToken, verifyToken } from "./middleware/auth.js"
import { AuditLogger } from "./middleware/audit-logger.js"
import { RateLimiter } from "./middleware/rate-limiter.js"
import { handleSessionsRoute } from "./routes/sessions.js"
import { handleWsTerminal } from "./routes/ws-terminal.js"

export async function startServer(config: Config): Promise<void> {
	const manager = new SessionManager(config)
	const audit = new AuditLogger(config.auditLogPath)
	const idleMonitor = new IdleMonitor(config.idleTimeoutMs, (sessionId) => {
		console.log(`[idle] Session ${sessionId} idle timeout, destroying`)
		audit.log({ event: "session.idle_timeout", sessionId })
		manager.destroy(sessionId)
	})
	const rateLimiter = new RateLimiter({
		maxRequests: config.rateLimitMax,
		windowMs: config.rateLimitWindowMs,
	})

	// 定期清理过期的频率限制条目
	const cleanupInterval = setInterval(() => rateLimiter.cleanup(), 60000)

	// HTTP server
	const server = createServer(async (req, res) => {
		// CORS（开发用）
		res.setHeader("Access-Control-Allow-Origin", "*")
		res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
		res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization")

		if (req.method === "OPTIONS") {
			res.writeHead(204)
			res.end()
			return
		}

		// 静态文件：/ 返回前端页面
		const url = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`)
		if (url.pathname === "/" || url.pathname === "/index.html") {
			res.writeHead(200, {
				"Content-Type": "text/html",
				"Cache-Control": "private, max-age=3600",
			})
			res.end(getClientHtml())
			return
		}

		// 字体文件：从 assets 目录提供
		if (url.pathname === "/fonts/MapleMono-NF-CN-Regular.woff2") {
			try {
				const fontPath = join(__dirname, "../assets/fonts/MapleMono-NF-CN-Regular.woff2")
				const data = await readFile(fontPath)
				res.writeHead(200, {
					"Content-Type": "font/woff2",
					"Cache-Control": "public, max-age=31536000",
					"Access-Control-Allow-Origin": "*",
				})
				res.end(data)
			} catch {
				res.writeHead(404)
				res.end("Font not found")
			}
			return
		}

		// 频率限制（API 路由）
		const clientIp = req.socket.remoteAddress ?? "unknown"
		if (!rateLimiter.check(clientIp)) {
			res.writeHead(429, { "Content-Type": "application/json" })
			res.end(JSON.stringify({ code: "RATE_LIMITED", message: "Too many requests" }))
			return
		}

		// 鉴权
		if (!authMiddleware(config, req, res)) {
			audit.log({ event: "auth.failure", ip: clientIp, detail: url.pathname })
			return
		}

		// 路由到 /api/sessions
		if (url.pathname.startsWith("/api/sessions")) {
			await handleSessionsRoute(req, res, manager, config, audit, idleMonitor)
			return
		}

		// 404
		res.writeHead(404, { "Content-Type": "application/json" })
		res.end(JSON.stringify({ code: "NOT_FOUND", message: "Not found" }))
	})

	// WebSocket server
	const wss = new WebSocketServer({ noServer: true })

	server.on("upgrade", (req, socket, head) => {
		const url = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`)

		// 只处理 /api/ws/terminal
		if (!url.pathname.startsWith("/api/ws/terminal")) {
			socket.destroy()
			return
		}

		// 频率限制
		const upgradeIp = req.socket.remoteAddress ?? "unknown"
		if (!rateLimiter.check(upgradeIp)) {
			socket.write("HTTP/1.1 429 Too Many Requests\r\n\r\n")
			socket.destroy()
			return
		}

		// 鉴权
		const token = extractToken(req)
		if (!verifyToken(token, config)) {
			const ip = req.socket.remoteAddress ?? "unknown"
			audit.log({ event: "auth.failure", ip, detail: "ws upgrade" })
			socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n")
			socket.destroy()
			return
		}

		const sessionId = url.searchParams.get("sessionId")
		if (!sessionId) {
			socket.write("HTTP/1.1 400 Bad Request\r\n\r\n")
			socket.destroy()
			return
		}

		wss.handleUpgrade(req, socket, head, (ws) => {
			const ip = req.socket.remoteAddress ?? "unknown"
			audit.log({ event: "ws.connected", sessionId: sessionId!, ip })
			handleWsTerminal(ws, sessionId!, manager, config, audit, idleMonitor)
		})
	})

	// Graceful shutdown
	let shuttingDown = false
	function shutdown(): void {
		if (shuttingDown) return
		shuttingDown = true
		console.log("\nShutting down...")

		// Force exit after 5 seconds if graceful shutdown hangs
		const forceTimer = setTimeout(() => {
			console.log("Force exit (timeout)")
			process.exit(1)
		}, 5000)
		forceTimer.unref()

		// Close all WS connections first
		wss.clients.forEach((client) => client.close())

		clearInterval(cleanupInterval)
		idleMonitor.dispose()
		manager.destroyAll().then(() => {
			return audit.close()
		}).then(() => {
			server.close(() => {
				console.log("Server closed")
				process.exit(0)
			})
		}).catch(() => {
			process.exit(1)
		})
	}

	process.on("SIGINT", shutdown)
	process.on("SIGTERM", shutdown)

	// Reattach existing tmux sessions before accepting connections
	try {
		const count = await manager.reattachAll()
		if (count > 0) {
			console.log(`Reattached ${count} existing tmux session(s)`)
			// 通知 idleMonitor：reattach 的 session 初始无客户端
			for (const info of manager.list()) {
				idleMonitor.onSessionCreated(info.sessionId)
			}
		}
	} catch (err: unknown) {
		console.error("Failed to reattach sessions:", (err as Error).message)
	}

	// Start
	server.listen(config.port, config.host, () => {
		console.log(`WebShell server listening on http://${config.host}:${config.port}`)
		console.log(`Open http://localhost:${config.port} in your browser`)
	})
}

/** P0: 内联的最小前端 HTML（后续移到 client/ 目录） */
export function getClientHtml(): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>WebShell</title>
<link rel="preload" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.js" as="script">
<link rel="preload" href="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.js" as="script">
<link rel="preload" href="https://cdn.jsdelivr.net/npm/@xterm/addon-unicode11@0.8.0/lib/addon-unicode11.js" as="script">
<link rel="preload" href="/fonts/MapleMono-NF-CN-Regular.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.css">
<style>
  @font-face {
    font-family: 'Maple Mono NF CN';
    src: url('/fonts/MapleMono-NF-CN-Regular.woff2') format('woff2');
    font-weight: normal;
    font-style: normal;
    font-display: swap;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html { overflow: hidden; overscroll-behavior: none; }
  body { background: #1e1e1e; color: #fff; font-family: system-ui; height: 100dvh; display: flex; flex-direction: column; overflow: hidden; overscroll-behavior: none; }
  #status-bar { padding: 6px 12px; font-size: 13px; display: flex; justify-content: space-between; align-items: center; background: #2d2d2d; flex-shrink: 0; }
  #status-bar .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 6px; }
  #status-bar .dot.connected { background: #4caf50; }
  #status-bar .dot.connecting { background: #ff9800; }
  #status-bar .dot.disconnected { background: #f44336; }
  #terminal-container { flex: 1; overflow: hidden; min-height: 0; }
  #shortcut-bar { display: flex; gap: 4px; padding: 6px 8px; background: #2d2d2d; overflow-x: auto; flex-shrink: 0; -webkit-overflow-scrolling: touch; }
  #shortcut-bar button { background: #444; color: #fff; border: none; padding: 8px 14px; border-radius: 4px; font-size: 14px; font-family: monospace; white-space: nowrap; touch-action: manipulation; }
  #shortcut-bar button:active { background: #666; }
  /* 横屏隐藏快捷栏，最大化终端 */
  @media (orientation: landscape) and (max-height: 500px) {
    #shortcut-bar { display: none; }
    #status-bar { padding: 3px 8px; font-size: 11px; }
  }
  /* 软键盘弹出时用 visualViewport 调整 */
  /* Session 管理面板 */
  #session-panel { position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: #1e1e1e; z-index: 100; display: flex; flex-direction: column; }
  #session-panel .panel-header { padding: 12px 16px; font-size: 16px; font-weight: bold; display: flex; justify-content: space-between; align-items: center; background: #2d2d2d; }
  #session-panel .panel-header button { background: none; border: none; color: #aaa; font-size: 22px; cursor: pointer; padding: 0 4px; }
  #session-list { flex: 1; overflow-y: auto; padding: 8px; }
  #session-list .session-item { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; margin: 4px 0; background: #2d2d2d; border-radius: 6px; cursor: pointer; }
  #session-list .session-item:active { background: #3d3d3d; }
  #session-list .session-item.active { border-left: 3px solid #4caf50; }
  #session-list .session-item .name { font-size: 15px; }
  #session-list .session-item .meta { font-size: 12px; color: #888; }
  #session-list .session-item .del-btn { background: none; border: none; color: #f44336; font-size: 18px; padding: 4px 8px; cursor: pointer; }
  #session-panel .panel-footer { display: flex; gap: 8px; padding: 12px 16px; background: #2d2d2d; }
  #session-panel .panel-footer input { flex: 1; background: #444; border: 1px solid #555; color: #fff; padding: 8px 12px; border-radius: 4px; font-size: 14px; }
  #session-panel .panel-footer button { background: #4caf50; color: #fff; border: none; padding: 8px 16px; border-radius: 4px; font-size: 14px; cursor: pointer; }
  #session-panel .panel-footer button:active { background: #388e3c; }
</style>
</head>
<body>

<div id="status-bar">
  <span><span id="dot" class="dot disconnected"></span><span id="session-name" style="cursor:pointer">Not connected</span></span>
  <span id="status-text">Disconnected</span>
</div>

<!-- Session 管理面板 -->
<div id="session-panel" style="display:none">
  <div class="panel-header">
    <span>Sessions</span>
    <button id="panel-close">&times;</button>
  </div>
  <div id="session-list"></div>
  <div class="panel-footer">
    <input id="new-session-name" type="text" placeholder="Session name..." />
    <button id="create-session-btn">Create</button>
  </div>
</div>

<div id="terminal-container"></div>

<div id="shortcut-bar">
  <button>Tab</button>
  <button>Ctrl-C</button>
  <button>Ctrl-D</button>
  <button>↑</button>
  <button>↓</button>
  <button>Esc</button>
  <button>Clear</button>
  <button id="paste-btn">Paste</button>
</div>

<script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-unicode11@0.8.0/lib/addon-unicode11.js"></script>
<script>
(function() {
  // --- Config ---
  const TOKEN = new URLSearchParams(location.search).get('token') || prompt('Enter token:');
  const SESSION_ID = new URLSearchParams(location.search).get('session') || '';

  if (!TOKEN) { document.body.innerText = 'Token required'; return; }

  // --- Terminal ---
  window._term = new window.Terminal({
    fontSize: 14,
    fontFamily: '"Maple Mono NF CN", "JetBrains Mono", monospace',
    theme: { background: '#1e1e1e' },
    cursorBlink: true,
    allowProposedApi: true,
    scrollback: 5000,
    smoothScrollDuration: 100,
    overviewRuler: { width: 0 },
  });
  var term = window._term;
  const fitAddon = new window.FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  const unicode11Addon = new window.Unicode11Addon.Unicode11Addon();
  term.loadAddon(unicode11Addon);
  term.unicode.activeVersion = '11';
  term.open(document.getElementById('terminal-container'));

  // --- 移动端触摸滚动（带惯性） ---
  (function() {
    var container = document.querySelector('#terminal-container .xterm-screen');
    if (!container) return;

    var LINE_HEIGHT = 15;
    var SCROLL_MULTIPLIER = 3;
    var DEAD_ZONE = 8;
    var FRICTION = 0.92;
    var MIN_VELOCITY = 0.5;
    var VELOCITY_WINDOW = 80;
    var MAX_INERTIA_LINES = 8;

    var startY = 0;
    var lastTouchY = 0;
    var scrolling = false;
    var didScroll = false;
    var touchHistory = [];
    var inertiaId = null;
    var inertiaVelocity = 0;

    function stopInertia() {
      if (inertiaId !== null) {
        cancelAnimationFrame(inertiaId);
        inertiaId = null;
      }
      inertiaVelocity = 0;
    }

    function startInertia(velocity) {
      stopInertia();
      inertiaVelocity = velocity;
      function step() {
        inertiaVelocity *= FRICTION;
        if (Math.abs(inertiaVelocity) < MIN_VELOCITY) { inertiaId = null; return; }
        var lines = Math.round(Math.min(Math.abs(inertiaVelocity), MAX_INERTIA_LINES)
                               * (inertiaVelocity > 0 ? 1 : -1));
        if (lines !== 0) term.scrollLines(lines);
        inertiaId = requestAnimationFrame(step);
      }
      inertiaId = requestAnimationFrame(step);
    }

    function computeReleaseVelocity() {
      var now = Date.now();
      var recent = touchHistory.filter(function(p) { return now - p.t < VELOCITY_WINDOW; });
      if (recent.length < 2) return 0;
      var first = recent[0];
      var last = recent[recent.length - 1];
      var dt = last.t - first.t;
      if (dt === 0) return 0;
      var dy = first.y - last.y;
      return (dy / dt * 16.67) / LINE_HEIGHT * SCROLL_MULTIPLIER;
    }

    container.addEventListener('touchstart', function(e) {
      if (e.touches.length !== 1) return;
      stopInertia();
      startY = e.touches[0].clientY;
      lastTouchY = startY;
      scrolling = true;
      didScroll = false;
      touchHistory = [{ y: startY, t: Date.now() }];
    }, { passive: true });

    container.addEventListener('touchmove', function(e) {
      if (!scrolling || e.touches.length !== 1) return;
      var currentY = e.touches[0].clientY;
      if (!didScroll && Math.abs(currentY - startY) < DEAD_ZONE) return;
      didScroll = true;
      var delta = lastTouchY - currentY;
      lastTouchY = currentY;
      touchHistory.push({ y: currentY, t: Date.now() });
      if (touchHistory.length > 10) touchHistory = touchHistory.slice(-10);
      var lines = Math.round(delta / LINE_HEIGHT * SCROLL_MULTIPLIER);
      if (lines !== 0) term.scrollLines(lines);
    }, { passive: true });

    container.addEventListener('touchend', function() {
      if (!scrolling) return;
      scrolling = false;
      if (!didScroll) {
        // Tap (no swipe) while scrolled up → back to bottom to type
        if (userScrolledUp) {
          userScrolledUp = false;
          term.scrollToBottom();
          scrollIndicator.style.display = 'none';
        }
        return;
      }
      var velocity = computeReleaseVelocity();
      if (Math.abs(velocity) > MIN_VELOCITY) startInertia(velocity);
      touchHistory = [];
    }, { passive: true });

    container.addEventListener('touchcancel', function() {
      scrolling = false;
      touchHistory = [];
    }, { passive: true });
  })();

  // Wait for web font to load before fitting, otherwise xterm measures with wrong font
  document.fonts.ready.then(function() {
    fitAddon.fit();
  });

  // --- Sticky Scroll ---
  var userScrolledUp = false;

  function isAtBottom() {
    var buf = term.buffer.active;
    return buf.viewportY >= buf.baseY - 1;
  }

  term.onScroll(function() {
    userScrolledUp = !isAtBottom();
    scrollIndicator.style.display = userScrolledUp ? 'block' : 'none';
  });

  var scrollIndicator = document.createElement('div');
  scrollIndicator.textContent = '\u2193 New output';
  scrollIndicator.style.cssText = 'display:none;position:fixed;bottom:60px;left:50%;' +
    'transform:translateX(-50%);background:rgba(76,175,80,0.9);color:#fff;' +
    'padding:6px 16px;border-radius:16px;font-size:13px;z-index:50;' +
    'cursor:pointer;backdrop-filter:blur(4px);transition:opacity 0.2s;';
  document.body.appendChild(scrollIndicator);

  scrollIndicator.addEventListener('click', function() {
    userScrolledUp = false;
    term.scrollToBottom();
    scrollIndicator.style.display = 'none';
    term.focus();
  });

  function smartScrollToBottom() {
    if (userScrolledUp) {
      scrollIndicator.style.display = 'block';
      return;
    }
    scrollIndicator.style.display = 'none';
    term.scrollToBottom();
  }

  // --- State ---
  const dot = document.getElementById('dot');
  const sessionName = document.getElementById('session-name');
  const statusText = document.getElementById('status-text');
  let ws = null;
  let lastSeq = 0;
  let reconnectAttempts = 0;
  let currentSid = null;       // remember session across reconnects
  let historyLoaded = false;   // gate: don't render realtime until history is done
  let pendingOutputs = [];     // buffer realtime outputs during history fetch
  const MAX_RECONNECT = 10;

  function setStatus(state, text) {
    dot.className = 'dot ' + state;
    statusText.textContent = text;
  }

  // --- Session ---
  const sessionPanel = document.getElementById('session-panel');
  const sessionList = document.getElementById('session-list');
  const newSessionInput = document.getElementById('new-session-name');
  const createSessionBtn = document.getElementById('create-session-btn');
  const panelCloseBtn = document.getElementById('panel-close');

  // API helpers
  async function apiGet(path) {
    const res = await fetch(path, { headers: { 'Authorization': 'Bearer ' + TOKEN } });
    return res.json();
  }
  async function apiPost(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + TOKEN },
      body: JSON.stringify(body),
    });
    return res.json();
  }
  async function apiDelete(path) {
    return fetch(path, { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + TOKEN } });
  }

  function showPanel() { sessionPanel.style.display = 'flex'; refreshSessionList(); }
  function hidePanel() { sessionPanel.style.display = 'none'; term.focus(); }

  panelCloseBtn.addEventListener('click', hidePanel);
  sessionName.addEventListener('click', showPanel);

  async function refreshSessionList() {
    const data = await apiGet('/api/sessions');
    var items = (data.items || []);
    sessionList.innerHTML = '';
    if (items.length === 0) {
      sessionList.innerHTML = '<div style="padding:20px;text-align:center;color:#888">No sessions. Create one below.</div>';
      return;
    }
    items.forEach(function(s) {
      var div = document.createElement('div');
      div.className = 'session-item' + (s.sessionId === currentSid ? ' active' : '');
      div.innerHTML = '<div><div class="name">' + s.name + '</div><div class="meta">' +
        s.sessionId.substring(0, 8) + ' · ' + s.connectedClients + ' clients</div></div>' +
        '<button class="del-btn" data-id="' + s.sessionId + '">&times;</button>';
      div.addEventListener('click', function(e) {
        if (e.target.classList.contains('del-btn')) return;
        switchSession(s.sessionId, s.name);
      });
      div.querySelector('.del-btn').addEventListener('click', async function(e) {
        e.stopPropagation();
        await apiDelete('/api/sessions/' + s.sessionId);
        if (s.sessionId === currentSid) { currentSid = null; }
        refreshSessionList();
      });
      sessionList.appendChild(div);
    });
  }

  function switchSession(sid, name) {
    // Close existing WS
    if (ws) { ws.onclose = null; ws.close(); ws = null; }
    currentSid = sid;
    sessionName.textContent = name || sid.substring(0, 8);
    hidePanel();
    connect();
  }

  createSessionBtn.addEventListener('click', async function() {
    var name = newSessionInput.value.trim();
    if (!name) { name = 'session-' + Date.now().toString(36); }
    var created = await apiPost('/api/sessions', { name: name });
    newSessionInput.value = '';
    switchSession(created.sessionId, created.name);
  });

  newSessionInput.addEventListener('focus', function() {
    setTimeout(function() {
      newSessionInput.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 80);
  });

  newSessionInput.addEventListener('blur', function() {
    setTimeout(syncViewportInsets, 120);
  });

  async function ensureSession() {
    // 已有 sid 且通过 WS 验证过，直接返回（重连场景）
    if (currentSid) return currentSid;

    // URL 指定了 session
    if (SESSION_ID) { currentSid = SESSION_ID; return SESSION_ID; }

    // 一次请求：列出已有 session
    var data = await apiGet('/api/sessions');
    if (data.items && data.items.length > 0) {
      currentSid = data.items[0].sessionId;
      sessionName.textContent = data.items[0].name || currentSid.substring(0, 8);
      return currentSid;
    }

    // 没有就创建
    var created = await apiPost('/api/sessions', { name: 'default' });
    currentSid = created.sessionId;
    sessionName.textContent = created.name || currentSid.substring(0, 8);
    return currentSid;
  }

  // --- History fetch + dedup ---
  var lastLoadedSid = null;

  async function loadHistory(sid) {
    historyLoaded = false;
    pendingOutputs = [];

    // Hide terminal during history replay to avoid flashing top content
    var tc = document.getElementById('terminal-container');
    tc.style.visibility = 'hidden';

    // Only reset terminal when switching to a different session
    var isNewSession = (sid !== lastLoadedSid);
    if (isNewSession) {
      term.reset();
      lastSeq = 0;
      lastLoadedSid = sid;
    }

    try {
      if (isNewSession) {
        // Fresh session switch: capture current screen (with resize to match client)
        var url = '/api/sessions/' + sid + '/snapshot?cols=' + term.cols + '&rows=' + term.rows;
        var res = await fetch(url, { headers: { 'Authorization': 'Bearer ' + TOKEN } });
        var snap = await res.json();
        if (snap.screen) {
          term.write(snap.screen);
          // Restore cursor position from tmux (cursorY is 0-based, ESC[H is 1-based)
          if (snap.cursorY !== undefined) {
            term.write('\\x1b[' + (snap.cursorY + 1) + ';' + (snap.cursorX + 1) + 'H');
          }
        }
        lastSeq = snap.cursor || 0;
      } else {
        // Reconnect: incremental fetch from where we left off
        var hasMore = true;
        while (hasMore) {
          var url = '/api/sessions/' + sid + '/history?after=' + lastSeq + '&limit=1000';
          var res = await fetch(url, { headers: { 'Authorization': 'Bearer ' + TOKEN } });
          var h = await res.json();
          if (h.chunks && h.chunks.length > 0) {
            var batch = '';
            h.chunks.forEach(function(c) {
              if (c.seq > lastSeq) {
                batch += c.data;
                lastSeq = c.seq;
              }
            });
            if (batch) term.write(batch);
            hasMore = (h.chunks.length >= 1000);
          } else {
            hasMore = false;
          }
        }
      }
    } catch (e) {
      console.error('History fetch failed:', e);
    }

    // Now flush any realtime outputs that arrived during the fetch, dedup by seq
    historyLoaded = true;
    pendingOutputs.forEach(function(msg) {
      if (msg.seq > lastSeq) {
        term.write(msg.data);
        lastSeq = msg.seq;
      }
    });
    pendingOutputs = [];

    // Scroll to bottom then reveal — user sees only the latest content
    userScrolledUp = false;
    scrollIndicator.style.display = 'none';
    term.scrollToBottom();
    tc.style.visibility = 'visible';
    term.focus();
  }

  // --- WebSocket ---
  async function connect() {
    setStatus('connecting', 'Connecting...');
    let sid;
    try {
      sid = await ensureSession();
    } catch (e) {
      setStatus('disconnected', 'Failed to get session');
      scheduleReconnect();
      return;
    }

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(proto + '://' + location.host + '/api/ws/terminal?sessionId=' + sid + '&token=' + TOKEN);

    ws.onopen = function() {
      reconnectAttempts = 0;
    };

    ws.onmessage = function(e) {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }

      switch (msg.type) {
        case 'ready':
          setStatus('connected', 'Connected');
          sessionName.textContent = sid.substring(0, 8);
          // Send current size (for reconnect; session switch resizes via snapshot)
          ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
          // Load history/snapshot
          loadHistory(sid);
          break;
        case 'output':
          if (!historyLoaded) {
            // History still loading, buffer this to dedup later
            pendingOutputs.push(msg);
          } else {
            if (msg.seq > lastSeq) {
              term.write(msg.data);
              lastSeq = msg.seq;
              smartScrollToBottom();
            }
          }
          break;
        case 'pong':
          break;
        case 'error':
          console.error('WS error:', msg.code, msg.message);
          // Session lost (e.g. server restarted) — clear stale sid so reconnect creates a new one
          if (msg.code === 'SESSION_NOT_FOUND') {
            currentSid = null;
          }
          break;
        case 'closed':
          setStatus('disconnected', msg.reason || 'Closed');
          break;
      }
    };

    ws.onclose = function() {
      setStatus('disconnected', 'Disconnected');
      scheduleReconnect();
    };

    ws.onerror = function() {};
  }

  function scheduleReconnect() {
    if (reconnectAttempts >= MAX_RECONNECT) {
      setStatus('disconnected', 'Max retries reached');
      return;
    }
    reconnectAttempts++;
    var delay = Math.min(1000 * Math.pow(2, reconnectAttempts - 1), 30000);
    var remaining = Math.round(delay / 1000);
    setStatus('connecting', 'Reconnecting in ' + remaining + 's...');
    var countdown = setInterval(function() {
      remaining--;
      if (remaining > 0) {
        setStatus('connecting', 'Reconnecting in ' + remaining + 's...');
      } else {
        clearInterval(countdown);
      }
    }, 1000);
    setTimeout(function() { clearInterval(countdown); connect(); }, delay);
  }

  // --- Input + Mobile IME fix ---

  // Shift+Enter: send ESC[13;2~ (recognized by pi editor as newline)
  // pi editor hardcodes: data === ESC + "[13;2~"
  var SHIFT_ENTER = String.fromCharCode(27) + '[13;2~';
  var shiftEnterSent = false;
  term.attachCustomKeyEventHandler(function(e) {
    if (e.key === 'Enter' && e.shiftKey) {
      if (e.type === 'keydown') {
        shiftEnterSent = true;
        if (ws && ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'input', data: SHIFT_ENTER }));
        }
      }
      return false; // block both keydown and keypress for Shift+Enter
    }
    if (shiftEnterSent && e.type === 'keypress') {
      shiftEnterSent = false;
      return false; // block any lingering keypress from Shift+Enter
    }
    shiftEnterSent = false;
    // Intercept Ctrl+V / Cmd+V paste — handle via paste event instead
    if (e.type === 'keydown' && e.key === 'v' && (e.ctrlKey || e.metaKey)) {
      return true; // let browser fire paste event
    }
    return true;
  });

  // Intercept paste events to use bracketed paste mode
  var xtermEl = document.querySelector('#terminal-container');
  if (xtermEl) {
    xtermEl.addEventListener('paste', function(e) {
      e.preventDefault();
      e.stopPropagation();
      var text = (e.clipboardData || window.clipboardData).getData('text');
      if (text && ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'paste', data: text }));
      }
    }, true); // capture phase to beat xterm.js
  }
  // xterm.js on mobile may swallow CJK punctuation and digits that don't go
  // through composition when a CJK IME is active. Use a deduper so input
  // fallback only sends when onData truly didn't deliver that character.
  var imePending = new Map();
  var imeRecentChars = [];
  var imeNextId = 1;
  var IME_RECENT_TTL = 500;
  var IME_FALLBACK_RE = /[^a-zA-Z\\u3040-\\u309F\\u30A0-\\u30FF\\u4E00-\\u9FFF\\u3400-\\u4DBF\\uAC00-\\uD7AF]/;

  function isFallbackChar(ch) {
    return IME_FALLBACK_RE.test(ch);
  }

  function imePruneRecent() {
    var cutoff = Date.now() - IME_RECENT_TTL;
    imeRecentChars = imeRecentChars.filter(function(e) { return e.ts > cutoff; });
  }

  function imeConsumeRecent(data) {
    var chars = Array.from(data).filter(isFallbackChar);
    if (chars.length === 0) return false;

    var snapshot = imeRecentChars.slice();
    for (var i = 0; i < chars.length; i++) {
      var idx = -1;
      for (var j = 0; j < snapshot.length; j++) {
        if (snapshot[j].ch === chars[i]) { idx = j; break; }
      }
      if (idx < 0) return false;
      snapshot.splice(idx, 1);
    }
    imeRecentChars = snapshot;
    return true;
  }

  function imeOnData(data) {
    imePruneRecent();
    var matched = false;
    imePending.forEach(function(entry) {
      if (!matched && !entry.handled && entry.data === data) {
        entry.handled = true;
        matched = true;
      }
    });

    if (!matched) {
      var ts = Date.now();
      Array.from(data).forEach(function(ch) {
        if (isFallbackChar(ch)) imeRecentChars.push({ ch: ch, ts: ts });
      });
      if (imeRecentChars.length > 64) {
        imeRecentChars = imeRecentChars.slice(-64);
      }
    }
  }

  function imeOnInput(data) {
    if (!data) return null;
    if (!IME_FALLBACK_RE.test(data)) return null;
    imePruneRecent();
    var id = imeNextId++;
    imePending.set(id, { data: data, handled: imeConsumeRecent(data) });
    return id;
  }

  function imeShouldSendFallback(id) {
    var entry = imePending.get(id);
    if (!entry) return false;
    imePending.delete(id);
    return !entry.handled;
  }

  term.onData(function(data) {
    imeOnData(data);
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'input', data: data }));
    }
  });

  (function() {
    var xtermTextarea = document.querySelector('#terminal-container .xterm-helper-textarea');
    if (!xtermTextarea) return;

    xtermTextarea.addEventListener('input', function(e) {
      // During IME composition (e.g. pinyin → 汉字), skip fallback.
      // Space/punctuation pressed to select a candidate should NOT
      // be sent as literal characters.
      if (e.isComposing) return;
      var data = e.data;
      var id = imeOnInput(data);
      if (id === null) return;

      setTimeout(function() {
        if (imeShouldSendFallback(id) && ws && ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'input', data: data }));
        }
      }, 50);
    });
  })();

  // --- Resize ---
  var lastCols = 0;
  var lastRows = 0;
  var resizeTimer = null;

  function handleResize() {
    fitAddon.fit();
    // Only send resize if dimensions actually changed
    if (term.cols !== lastCols || term.rows !== lastRows) {
      lastCols = term.cols;
      lastRows = term.rows;
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    }
    // Keep viewport at bottom after resize (unless user scrolled up)
    smartScrollToBottom();
  }

  function debouncedResize() {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(handleResize, 100);
  }

  window.addEventListener('resize', debouncedResize);

  // --- Soft keyboard adaptation (mobile) ---
  var settleTimer = null;
  function syncViewportInsets() {
    if (!window.visualViewport) return;
    var vv = window.visualViewport;
    document.body.style.height = vv.height + 'px';
    var keyboardInset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    if (keyboardInset < 80) keyboardInset = 0;
    sessionPanel.style.paddingBottom = keyboardInset + 'px';
    // Prevent browser-level page scroll during keyboard animation
    window.scrollTo(0, 0);
    // Fit + scroll immediately on every viewport change.
    // fitAddon.fit() is a no-op when cell dimensions don't change,
    // so calling it on each animation frame is cheap. This ensures
    // scrollToBottom() always uses the correct row count.
    handleResize();
    // Safety: one final pass after animation fully settles
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(function() {
      handleResize();
      window.scrollTo(0, 0);
    }, 300);
  }

  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', syncViewportInsets);
    window.visualViewport.addEventListener('scroll', function() {
      syncViewportInsets();
    });
    syncViewportInsets();
  }

  // --- Shortcut buttons ---
  var SHORTCUT_MAP = {
    'Tab': '\\t',
    'Ctrl-C': '\\x03',
    'Ctrl-D': '\\x04',
    '\\u2191': '\\x1b[A',
    '\\u2193': '\\x1b[B',
    'Esc': '\\x1b',
    'Clear': '\\x0c'
  };
  document.querySelectorAll('#shortcut-bar button:not(#paste-btn)').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var label = btn.textContent;
      var key = SHORTCUT_MAP[label] || '';
      if (key && ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'input', data: key }));
      }
      term.focus();
    });
  });

  // --- Paste ---
  function sendPaste(text) {
    if (text && ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'paste', data: text }));
    }
  }

  // Paste button
  document.getElementById('paste-btn').addEventListener('click', function() {
    if (navigator.clipboard && navigator.clipboard.readText) {
      navigator.clipboard.readText().then(function(text) {
        sendPaste(text);
        term.focus();
      }).catch(function() {
        var text = prompt('Paste content:');
        sendPaste(text);
        term.focus();
      });
    } else {
      var text = prompt('Paste content:');
      sendPaste(text);
      term.focus();
    }
  });

  // --- Ping ---
  setInterval(function() {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
    }
  }, 15000);

  // --- Start ---
  connect();
})();
</script>
</body>
</html>`;
}
