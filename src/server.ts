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
			res.writeHead(200, { "Content-Type": "text/html" })
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
	function shutdown(): void {
		console.log("\nShutting down...")
		clearInterval(cleanupInterval)
		idleMonitor.dispose()
		manager.destroyAll().then(() => {
			return audit.close()
		}).then(() => {
			server.close(() => {
				console.log("Server closed")
				process.exit(0)
			})
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
function getClientHtml(): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>WebShell</title>
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
  body { background: #1e1e1e; color: #fff; font-family: system-ui; height: 100dvh; display: flex; flex-direction: column; overflow: hidden; }
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
  const term = new window.Terminal({
    fontSize: 14,
    fontFamily: '"Maple Mono NF CN", "JetBrains Mono", monospace',
    theme: { background: '#1e1e1e' },
    cursorBlink: true,
    allowProposedApi: true,
    scrollback: 5000,
    smoothScrollDuration: 100,
    overviewRuler: { width: 0 },
  });
  const fitAddon = new window.FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  const unicode11Addon = new window.Unicode11Addon.Unicode11Addon();
  term.loadAddon(unicode11Addon);
  term.unicode.activeVersion = '11';
  term.open(document.getElementById('terminal-container'));

  // --- 移动端触摸滚动加速 ---
  (function() {
    var container = document.querySelector('#terminal-container .xterm-screen');
    if (!container) return;
    var SCROLL_MULTIPLIER = 6;
    var lastTouchY = 0;
    var scrolling = false;

    container.addEventListener('touchstart', function(e) {
      if (e.touches.length === 1) {
        lastTouchY = e.touches[0].clientY;
        scrolling = true;
      }
    }, { passive: true });

    container.addEventListener('touchmove', function(e) {
      if (!scrolling || e.touches.length !== 1) return;
      var currentY = e.touches[0].clientY;
      var delta = lastTouchY - currentY;
      lastTouchY = currentY;

      // 每 15px 滚一行，乘以加速系数
      var lines = Math.round(delta / 15 * SCROLL_MULTIPLIER);
      if (lines !== 0) {
        term.scrollLines(lines);
      }
    }, { passive: true });

    container.addEventListener('touchend', function() {
      scrolling = false;
    }, { passive: true });
  })();

  // Wait for web font to load before fitting, otherwise xterm measures with wrong font
  document.fonts.ready.then(function() {
    fitAddon.fit();
  });

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

    // Only reset terminal when switching to a different session
    var isNewSession = (sid !== lastLoadedSid);
    if (isNewSession) {
      term.reset();
      lastSeq = 0;
      lastLoadedSid = sid;
    }

    try {
      var url = '/api/sessions/' + sid + '/history?after=' + lastSeq + '&limit=1000';
      var res = await fetch(url, { headers: { 'Authorization': 'Bearer ' + TOKEN } });
      var h = await res.json();
      if (h.chunks && h.chunks.length > 0) {
        h.chunks.forEach(function(c) {
          if (c.seq > lastSeq) {
            term.write(c.data);
            lastSeq = c.seq;
          }
        });
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

    // Always scroll to bottom after history replay
    term.scrollToBottom();
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
          // Send current size
          ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
          // Always load history (works for both fresh page load and reconnect)
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

  // --- Input ---
  term.onData(function(data) {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'input', data: data }));
    }
  });

  // --- Mobile IME fix: xterm.js may swallow punctuation from composition ---
  (function() {
    var xtermTextarea = document.querySelector('#terminal-container .xterm-helper-textarea');
    if (!xtermTextarea) return;
    var lastCompositionData = '';

    xtermTextarea.addEventListener('compositionstart', function() {
      lastCompositionData = '';
    });

    xtermTextarea.addEventListener('compositionupdate', function(e) {
      lastCompositionData = e.data || '';
    });

    xtermTextarea.addEventListener('compositionend', function(e) {
      var data = e.data || '';
      // xterm.js onData normally fires for compositionend,
      // but on mobile it sometimes misses Chinese punctuation.
      // We detect this by checking if the composed text looks like
      // punctuation-only that xterm might drop.
      if (data && /^[\u3000-\u303f\uff00-\uffef\u2000-\u206f\u2e00-\u2e7f]+$/.test(data)) {
        // Punctuation-only composition result — force send
        if (ws && ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'input', data: data }));
        }
      }
    });
  })();

  // --- Resize ---
  function handleResize() {
    fitAddon.fit();
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    }
  }
  window.addEventListener('resize', handleResize);

  // --- Soft keyboard adaptation (mobile) ---
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', function() {
      // When soft keyboard opens, visualViewport shrinks
      // Adjust body height so terminal fits above keyboard
      document.body.style.height = window.visualViewport.height + 'px';
      handleResize();
    });
    window.visualViewport.addEventListener('scroll', function() {
      // Prevent page scroll when keyboard pushes content
      window.scrollTo(0, 0);
    });
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

  // --- Paste button ---
  document.getElementById('paste-btn').addEventListener('click', function() {
    if (navigator.clipboard && navigator.clipboard.readText) {
      navigator.clipboard.readText().then(function(text) {
        if (text && ws && ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'input', data: text }));
        }
        term.focus();
      }).catch(function() {
        // Clipboard API 失败，fallback 弹 prompt
        var text = prompt('Paste content:');
        if (text && ws && ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'input', data: text }));
        }
        term.focus();
      });
    } else {
      // 不支持 Clipboard API，用 prompt
      var text = prompt('Paste content:');
      if (text && ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'input', data: text }));
      }
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
