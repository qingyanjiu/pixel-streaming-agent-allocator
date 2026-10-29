# Gateway 网关说明

本文说明 Pixel Streaming Gateway 在多机部署中的位置、Ticket 校验、网络端口、直接端口保护、启动和故障处理。

相关文档：

- [启动说明.md](启动说明.md)
- [架构说明.md](架构说明.md)
- [客户端连接像素流说明.md](客户端连接像素流说明.md)
- [认证与密钥说明.md](认证与密钥说明.md)
- [调试与日志说明.md](调试与日志说明.md)

## 1. 为什么需要 Gateway

Wilbur 的 `801/802` 同时承载播放器网页和 WebSocket 信令。只在 Allocator 返回的 URL 中隐藏端口，并不能阻止其他客户端直接访问该端口。

Gateway 提供统一保护入口：

```text
客户端
  -> Allocator :9200，申请 Session
  <- 返回带 Ticket 的 Gateway URL

客户端
  -> Gateway :9300/play/<ticket>/
  -> Gateway :9300/play/<ticket>/ws
  -> 本机 Wilbur 127.0.0.1:801/802

客户端 <==== WebRTC UDP ====> UE
```

Gateway 不承载 WebRTC 视频和音频，也不是 SFU。

## 2. 部署位置

推荐每个 Worker 机器部署一个 Gateway：

```text
worker01 机器
├── Worker\worker01.json
├── Windows 游戏构建
├── WebServers\
└── Gateway\
    ├── gateway.json，读取 worker01.json
    └── :9300

worker02 机器
├── Worker\worker02.json
├── Windows 游戏构建
├── WebServers\
└── Gateway\
    ├── gateway.json，读取 worker02.json
    └── :9300
```

中央配置：

```text
Allocator\config\workers.json
```

每个 Worker 同时配置控制面和 Gateway：

```json
{
  "id": "worker01",
  "baseUrl": "http://192.168.1.188:9101",
  "gatewayUrl": "http://192.168.1.188:9300",
  "token": "<worker-token>"
}
```

`baseUrl` 是 Allocator 到 Worker 的管理地址；`gatewayUrl` 是客户端可访问的播放器入口，两者职责不同。

## 3. Ticket 和 Session

Allocator 在预留 Slot 时生成随机 `playTicket`。返回给客户端的 `url` 类似：

```text
http://WorkerIP:9300/play/<ticket>/?ss=ws%3A%2F%2FWorkerIP%3A9300%2Fplay%2F<ticket>%2Fws
```

`ss` 是 Wilbur 播放器支持的信令 URL 参数，使 WebSocket 也连接 Gateway，而不是直接连接 `801/802`。

Gateway 每次处理播放器资源或 WebSocket 升级时，会调用：

```http
POST /api/gateway/validate
X-Gateway-Token: <gateway-token>

{"ticket":"<ticket>"}
```

Allocator 只有在以下条件全部满足时才返回 `valid=true`：

- Ticket 属于 Allocator 当前内存中的 Session。
- Session 状态为 `ready`、`active` 或 `disconnected`。
- Session 仍然绑定原来的 Worker 和 Slot。

因此：

- Session 被主动释放后，旧 Ticket 立即失效。
- 断线 10 分钟重连窗口内，原 Ticket 仍可使用。
- Slot 被新用户重新分配后，旧 Ticket 不能连到新用户的流。
- Ticket 发给错误的 Worker Gateway 时，Worker ID 不匹配并返回 `403`。

Ticket 是短期能力凭证，不应写入公开日志、工单或监控系统。

## 4. Gateway Token

Gateway Token 只保护 Gateway 与 Allocator 之间的校验接口以及 Gateway `/shutdown`，不是 Client API Key，也不是 Worker Token。

生成：

```bat
scripts\initialize-gateway-token.bat
```

三个值的用途：

| 名称 | 用途 |
|---|---|
| Client API Key | 客户端申请、查询、释放 Session |
| Worker Token | Allocator 管理 Worker Agent |
| Gateway Token | Gateway 校验 Ticket、关闭 Gateway |
| Session Token | 查询和释放具体 Session |
| Play Ticket | 仅访问一个 Session 的播放器路径和信令 |

不要把 Gateway Token 发给浏览器或客户端。

## 5. 路由

| 方法和路径 | 用途 |
|---|---|
| `GET /health` | Gateway 健康检查 |
| `GET /play/<ticket>/` | 播放器首页 |
| `GET /play/<ticket>/*` | 同 Slot 的静态资源和 REST 资源 |
| `WS /play/<ticket>/ws` | 代理到本机 Wilbur 根 WebSocket |
| `POST /shutdown` | 使用 Gateway Token 停止 Gateway |

根路径 `/` 返回 `404`。Gateway 没有登录页，也没有公开播放器页面。

## 6. 端口和防火墙

| 来源 | 目标 | 协议和端口 |
|---|---|---|
| 客户端/业务页面 | Gateway | TCP `9300` |
| Gateway | 本机 Wilbur | TCP `127.0.0.1:801/802` |
| Allocator | Worker Agent | TCP `9101` |
| 客户端 | UE | WebRTC UDP 或 TURN |

为了让 `801/802` 只能由本机访问，在每台 Worker 上以管理员权限运行：

```powershell
powershell -ExecutionPolicy Bypass -File Gateway\configure-firewall.ps1
```

它会创建：

- `PixelStreaming Gateway TCP`：允许 `9300`。
- `PixelStreaming Block Direct Player TCP`：阻止远端直接访问该 Worker 配置的 `801/802`。

Windows 回环地址不经过远端入站规则，所以本机 Gateway 仍可访问 Wilbur。

撤销：

```powershell
powershell -ExecutionPolicy Bypass -File Gateway\configure-firewall.ps1 -Remove
```

如果暂时没有执行防火墙脚本，客户端仍可能绕过 Gateway 直接访问 `801/802`。

## 7. HTTPS 和 WSS

正式 HTTPS 页面必须使用 HTTPS Gateway：

1. 在 `Gateway/gateway.json` 配置 `tlsKeyFile` 和 `tlsCertFile`。
2. 把 `Allocator/config/workers.json` 中的 `gatewayUrl` 改成 `https://...`。
3. 重启 Allocator 和对应 Gateway。

Allocator 会根据 `gatewayUrl` 自动生成 `wss://.../play/<ticket>/ws`。

Wilbur 仍可只监听本机 HTTP/WS；客户端与 Gateway 之间使用 HTTPS/WSS。

## 8. 启动和停止

启动顺序：

1. 启动 Worker Agent。
2. 启动 Allocator。
3. 启动每台 Worker 的 Gateway。
4. 客户端申请 Session。

```bat
Worker\start-worker.bat worker01.json
Allocator\start-allocator.bat
Gateway\start-gateway.bat
```

停止单个 Gateway：

```bat
Gateway\stop-gateway.bat
```

停止所有 Gateway、Worker、UE/Wilbur 和 Allocator：

```bat
stop-all.bat
```

## 9. 故障处理

### 客户端打开 URL 返回 403

检查 Allocator 和 Gateway 控制台：

- Session 是否已经 `released` 或 `failed`。
- Gateway Token 是否一致。
- 返回 URL 中的 Worker 是否与 `gatewayUrl` 对应。
- Gateway 的 `workerConfigFile` 是否是同一台 Worker。

### Gateway 返回 503

Gateway 无法访问 Allocator 的 `/api/gateway/validate`。检查：

- Allocator 是否启动。
- `gateway.json` 中的 `allocatorUrl`。
- Allocator `9200` 防火墙。
- Gateway Token 文件是否存在。

### 页面能打开但黑屏

Gateway 只负责网页和 WebSocket。继续检查：

- WebSocket 是否显示 `websocket_connected`。
- WebRTC UDP 是否可达。
- 跨公网时是否配置 TURN。
- UE/Wilbur 日志中的 ICE 和编码错误。

### 直接访问 801 仍能打开

说明本机防火墙规则没有生效，或运行 Gateway 的不是同一台机器。重新以管理员身份运行 `configure-firewall.ps1`，并在客户端机器验证。

## 10. 当前边界

Gateway 不包含：

- Nginx 配置。
- WebRTC 媒体转发。
- 用户登录和业务权限。
- 多 Allocator 高可用。

业务用户身份仍应由业务后端校验。Gateway 只保证 Allocator 分配出的 Session Ticket 可以访问对应 Slot。
