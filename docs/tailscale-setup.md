# Tailscale 配置指南

通过 Tailscale 在手机上安全访问 Mac 上的 WebShell，无需 HTTPS 证书。

## 原理

Tailscale 基于 WireGuard，在设备之间建立加密隧道。Mac 和手机加入同一个 tailnet 后，
手机可以通过 Tailscale 分配的内网 IP 直接访问 Mac 上的服务，流量全程加密。

## 步骤

### 1. Mac 端

```bash
# 安装
brew install tailscale

# 启动并登录
sudo tailscaled &
tailscale up

# 获取 Tailscale IP
tailscale ip -4
# 输出类似: 100.x.y.z
```

### 2. 手机端

1. App Store / Google Play 搜索 **Tailscale** 并安装
2. 用同一个账号登录
3. 确认手机已连入 tailnet（状态显示 Connected）

### 3. 启动 WebShell

```bash
cd packages/webshell
WEBSHELL_TOKEN=your_secret_token npx tsx src/cli.ts
```

### 4. 手机访问

在手机浏览器输入：

```
http://100.x.y.z:3000?token=your_secret_token
```

将 `100.x.y.z` 替换为步骤 1 中获取的 Tailscale IP。

## 安全说明

- Tailscale 隧道已加密（WireGuard），HTTP 即可，不需要 HTTPS
- Token 在 URL query 中传输，但因为是加密隧道，不会被中间人截获
- 不要将 WebShell 端口暴露到公网（`0.0.0.0` 监听没问题，因为公网无法路由到 Tailscale IP）

## 常见问题

**Q: 手机无法访问？**
- 确认两端都已登录同一 Tailscale 账号
- 确认手机 Tailscale 状态为 Connected
- `tailscale ping <手机IP>` 测试连通性

**Q: 可以用 MagicDNS 吗？**
- 可以。Tailscale 启用 MagicDNS 后，用 `http://<hostname>:3000` 访问
- 在 Tailscale Admin Console 开启 MagicDNS
