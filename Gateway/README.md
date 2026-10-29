# Pixel Streaming Gateway

Gateway 与 Windows 游戏构建、WebServers 和 Worker Agent 部署在同一台机器上。它把播放器页面与 WebSocket 信令统一代理到本机 Wilbur，避免把 `801/802` 直接暴露给客户端。

完整架构和安全边界见 [Gateway 网关说明](../Docs/Gateway网关说明.md)。

## 职责

```text
客户端 -> Gateway :9300 -> 本机 Wilbur 127.0.0.1:801/802
```

Gateway 会：

- 校验 URL 中的随机 Play Ticket。
- 向 Allocator 查询该 Ticket 是否仍属于有效 Session。
- 只允许访问当前 Worker 配置中声明过的 Slot。
- 同时代理播放器 HTTP 资源和 WebSocket 升级。
- 兼容把页面 URL 直接作为 WebSocket 地址的客户端。
- Session 释放、Slot 停止或 Worker 不匹配后立即拒绝旧 URL。

WebRTC 视频、音频和输入数据仍然由客户端直接连接 UE，不经过 Gateway。

## 文件

```text
Gateway\
├── gateway.js
├── gateway.json
├── gateway.example.json
├── start-gateway.bat
├── stop-gateway.bat
├── configure-firewall.bat
└── common\
```

## 配置

默认配置：

```text
Gateway/gateway.json
```

关键字段：

| 字段 | 用途 |
|---|---|
| `listenPort` | Gateway 对外监听端口，默认 `9300` |
| `workerConfigFile` | 本机 Worker 配置，默认 `../Worker/worker01.json` |
| `allocatorUrl` | 中央 Allocator 地址 |
| `allocatorTokenFile` | Gateway 访问 Allocator 校验接口的 Token 文件 |
| `upstreamHost` | 本机 Wilbur 地址，只允许回环地址 |
| `nodeExecutable` | 可选 Node.js 路径 |
| `tlsKeyFile` / `tlsCertFile` | 可选 HTTPS/WSS 证书 |

`worker02` 所在机器应把 `workerConfigFile` 改为：

```json
"workerConfigFile": "../Worker/worker02.json"
```

同一 Worker 上的 Slot 端口由 Worker 配置自动读取，不需要在 Gateway 再抄一份。Gateway 会增加以下白名单约束：

- `workerConfigFile` 中的 `agentId` 必须等于 Allocator 返回的 `workerId`。
- `slotId` 必须存在于该 Worker 配置中。
- 上游端口只能使用该 Slot 的 `playerPort`。
- `upstreamHost` 只能是 `127.0.0.1`、`localhost` 或 `::1`。

## 生成 Gateway Token

在项目根目录运行一次：

```bat
scripts\initialize-gateway-token.bat
```

它会生成：

```text
secrets/gateway-token.txt
```

该目录已被 `.gitignore` 忽略。Allocator 和每台 Gateway 必须使用完全相同的 Token 文件内容。多机部署时通过受控运维通道复制，不要通过聊天、Git 或公开链接传递。

也可以在配置中使用：

```text
allocatorToken
allocatorTokenEnv
allocatorTokenFile
```

实际优先级为环境变量、Token 文件、配置内明文值。

## 启动

先启动 Allocator 和 Worker Agent，再启动本机 Gateway：

```bat
Gateway\start-gateway.bat
```

指定其他配置：

```bat
Gateway\start-gateway.bat gateway-worker02.json
```

启动后检查：

```text
http://WorkerIP:9300/health
```

正常响应：

```json
{
  "ok": true,
  "agentId": "worker01",
  "slots": ["slot01", "slot02"]
}
```

`9300/` 根路径不提供播放器页面，只接受带有效 Ticket 的 `/play/...` 路径。

`/play/<ticket>/ws` 是标准信令路径。Gateway 也接受对 `/play/<ticket>/` 的 WebSocket Upgrade，并同样代理到本机 Wilbur 根 WebSocket，以兼容现有客户端。

## 防火墙

以管理员身份打开 PowerShell，在本机项目根目录运行：

```powershell
powershell -ExecutionPolicy Bypass -File Gateway\configure-firewall.ps1
```

脚本会：

- 放行 TCP `9300`。
- 阻止远端直接访问 Worker 配置中的 `801/802`。
- 保留本机 Gateway 对 `127.0.0.1:801/802` 的访问。

撤销规则：

```powershell
powershell -ExecutionPolicy Bypass -File Gateway\configure-firewall.ps1 -Remove
```

防火墙不会改变 WebRTC UDP/TURN 配置。跨公网时仍需单独配置 TURN 和媒体网络。

## 停止

```bat
Gateway\stop-gateway.bat
```

根目录 `stop-all.bat` 会先关闭 `workers.json` 中配置的全部 Gateway，再关闭 Worker、UE/Wilbur 和 Allocator。

## HTTPS/WSS

如果业务页面使用 HTTPS，Gateway 也必须使用 HTTPS。配置：

```json
"tlsKeyFile": "../secrets/gateway-key.pem",
"tlsCertFile": "../secrets/gateway-cert.pem"
```

然后确保 `Allocator/config/workers.json` 中对应 Worker 的 `gatewayUrl` 使用 `https://`。Allocator 会自动生成 `wss://` 信令地址。

## 日志

控制台会输出：

```text
event=http_request
event=websocket_connected
event=ticket_rejected
event=upstream_http_failed
event=upstream_websocket_failed
```

日志包含 Session、Worker、Slot 和客户端地址，不输出 Ticket 或 Token。
