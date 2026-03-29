#!/usr/bin/env node
// ============================================================
// cli.ts — 启动入口
// ============================================================

import { loadConfig } from "./config.js"
import { startServer } from "./server.js"

const config = loadConfig()
await startServer(config)
