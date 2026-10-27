# Pixel Streaming 多机器按需分配

该目录在现有 UE 5.8 Wilbur 部署上增加两层服务：

```text
客户端
  -> Allocator :9200（会话分配、等待、超时回收）
  -> Worker Agent :9101（位于各 GPU 机器）
  -> Wilbur（每路独立端口）
  -> UE（每路一个进程）
```

客户端直接向 Allocator 申请空闲实例，拿到某个 Worker 节点的 UE 地址后直接连接。

服务启动、健康检查、首次分配和停止步骤见 [启动说明.md](启动说明.md)。

组件职责、层级关系、网络拓扑、生命周期和扩展边界见 [架构说明.md](架构说明.md)。

Worker Token、Client API Key、匹配规则和轮换步骤见 [认证与密钥说明.md](认证与密钥说明.md)。

前端申请实例、连接播放器和释放会话见 [客户端连接像素流说明.md](客户端连接像素流说明.md)。

旧 `_startexe-.bat` 仍用于人工启动全部槽位，不要和 Worker Agent 同时管理同一组端口。

## 组件

| 文件 | 用途 |
|---|---|
| `start-allocator.bat` | 启动中央会话分配器 |
| `start-worker.bat` | 通用 Worker Agent 启动器，接受任意 Worker 配置 |
| `agent/worker-template.json` | 新增 Worker 时使用的配置模板 |
| `allocator/allocator.json` | 中央分配器端口、回收策略、API Key 和 Worker 文件位置 |
| `config/workers.json` | Worker 的固定 ID、IP、管理地址和 Token |

当前 `allocator/allocator.json`、`config/workers.json` 和实际 Worker 配置已纳入 Git。`logs`、证书、密钥和环境文件继续由 `.gitignore` 排除。

## 1. 修改地址和密码

当前 Orchestrator 位于：

```text
C:\UE_PIXEL_STREAMING_SERVER\Orchestrator
```

推荐把 Orchestrator 和 WebServers 统一放到同一部署根目录：

```text
C:\UE_PIXEL_STREAMING_SERVER\
├── Orchestrator\
├── WebServers\
└── config\
```

Windows 游戏构建可以位于其他目录或磁盘。Worker 配置通过以下字段指定：

```json
{
  "windowsDirectory": "C:/UE_DEMO/Windows",
  "webServersDirectory": "C:/UE_PIXEL_STREAMING_SERVER/WebServers",
  "nodeExecutable": "SignallingWebServer/platform_scripts/cmd/node/node.exe",
  "signallingDirectory": "SignallingWebServer",
  "gameExecutable": "UE_ANDA.exe",
  "gameWorkingDirectory": ".",
  "logsDirectory": "logs"
}
```

路径规则：

| 字段 | 解析基准 |
|---|---|
| `windowsDirectory` | 可以填写绝对路径；相对路径以 Worker 配置文件目录为基准 |
| `webServersDirectory` | 可以填写绝对路径；相对路径以 Worker 配置文件目录为基准 |
| `gameExecutable` | 绝对路径，或相对于 `windowsDirectory` |
| `gameWorkingDirectory` | 绝对路径，或相对于 `windowsDirectory` |
| `signallingDirectory` | 绝对路径，或相对于 `webServersDirectory` |
| `nodeExecutable` | 绝对路径，或相对于 `webServersDirectory` |
| `logsDirectory` | 绝对路径，或相对于 Orchestrator 根目录 |
| `peerOptionsFile` | 绝对路径，或相对于 Worker 配置文件目录 |

因此以下目录组合是允许的：

```text
C:\UE_PIXEL_STREAMING_SERVER\Orchestrator
C:\UE_PIXEL_STREAMING_SERVER\WebServers
D:\GameBuilds\Windows
```

当前实际配置已随仓库提交。需要恢复默认配置或新增 Worker 时，可以复制示例：

```powershell
Copy-Item `
  "C:\UE_PIXEL_STREAMING_SERVER\Orchestrator\allocator\allocator.example.json" `
  "C:\UE_PIXEL_STREAMING_SERVER\Orchestrator\allocator\allocator.json"

Copy-Item `
  "C:\UE_PIXEL_STREAMING_SERVER\Orchestrator\config\workers.example.json" `
  "C:\UE_PIXEL_STREAMING_SERVER\Orchestrator\config\workers.json"

Copy-Item `
  "C:\UE_PIXEL_STREAMING_SERVER\Orchestrator\agent\worker-template.json" `
  "C:\UE_PIXEL_STREAMING_SERVER\Orchestrator\agent\worker-01.json"
```

复制示例前确认目标文件是否需要保留；不要覆盖正在使用的实际配置。

先修改所有 Worker 配置：

1. 将 `publicUrl` 改成客户端实际可直连的地址。
2. 将 `authToken` 改成足够长的随机值。
3. 每个 Worker 的 `authToken` 应与 Allocator 中的对应值一致。
4. 如果使用 TURN，填写 `peerOptionsFile`，其内容格式为：

```json
{
  "iceServers": [
    {
      "urls": ["stun:stun.example.com:3478"]
    },
    {
      "urls": ["turn:turn.example.com:3478?transport=udp"],
      "username": "pixel",
      "credential": "replace-me"
    }
  ]
}
```

Worker 的固定 IP、管理地址和 Token 统一修改：

```text
C:\UE_PIXEL_STREAMING_SERVER\Orchestrator\config\workers.json
```

修改 `allocator/allocator.json` 时只需要处理：

1. `apiKey`：客户端调用分配接口时使用的密钥。
2. `corsAllowedOrigins`：哪些网页来源可以直接调用 Allocator。
3. `workersFile`：Worker 地址文件的位置。

示例地址 `192.168.1.11` 和 `192.168.1.12` 必须替换成实际地址。

示例配置中的 `corsAllowedOrigins` 为 `["*"]`，便于客户端接入。正式环境建议改成明确来源，例如：

```json
{
  "corsAllowedOrigins": [
    "http://localhost:3000",
    "https://app.example.com"
  ]
}
```

## 2. 启动服务

第一台 Worker 创建配置后运行：

```bat
C:\UE_PIXEL_STREAMING_SERVER\Orchestrator\start-worker.bat worker-01.json
```

第二台 Worker 创建配置后运行：

```bat
C:\UE_PIXEL_STREAMING_SERVER\Orchestrator\start-worker.bat worker-02.json
```

在中央机器运行：

```bat
C:\UE_PIXEL_STREAMING_SERVER\Orchestrator\start-allocator.bat
```

Worker Agent 不会在启动时拉起所有 UE。收到分配请求后，它才会启动一个槽位。

如果配置位于其他目录，也可以传入完整路径：

```bat
C:\UE_PIXEL_STREAMING_SERVER\Orchestrator\start-worker.bat D:\Workers\worker-01.json
```

启动脚本会从 JSON 配置读取 `nodeExecutable`。如果配置路径不可用，也可以在执行脚本前设置：

```bat
set "PS_NODE_EXE=D:\Tools\node\node.exe"
```

### 2.1 同一个 UE exe 启动多个实例

可以。同一个 Worker 的 `W01-1`、`W01-2` 可以共用：

```text
C:\UE_DEMO\Windows\UE_ANDA.exe
```

每次 Worker Agent 启动槽位时，都会创建新的操作系统进程，不会在同一个 UE 进程里启动两个流。两个进程可以读取同一个已打包 `Windows` 目录，但每个进程必须使用不同的：

- `streamerPort`
- `playerPort`
- `sfuPort`
- `-PixelStreamingURL`

从 `worker-template.json` 创建的槽位配置必须分别使用不同的推流、玩家和 SFU 端口。

同一个 exe 路径不意味着运行状态完全隔离。多个 UE 进程仍会分别消耗 CPU、内存、显存和视频编码器资源，并可能共享打包目录中的 `Saved`、缓存和日志。生产部署建议：

- 先用同一台机器的两个槽位实测 GPU 显存、编码器数量和稳定性。
- 如果应用会写入用户配置、缓存或存档，为不同槽位配置独立的 UE 用户数据目录或工作目录。
- 如果游戏自身带“单实例锁”，需要关闭该锁，否则第二个进程会主动退出。

### 2.2 启动 20 个 Worker

Allocator 使用统一的 `workers` 数组，不限制 Worker 数量。每一台 Worker 执行一次通用启动器即可：

```text
Worker-01 -> start-worker.bat worker-01.json
Worker-02 -> start-worker.bat worker-02.json
...
Worker-20 -> start-worker.bat worker-20.json
```

创建配置时可以从模板复制：

```powershell
Copy-Item `
  "C:\UE_PIXEL_STREAMING_SERVER\Orchestrator\agent\worker-template.json" `
  "C:\UE_PIXEL_STREAMING_SERVER\Orchestrator\agent\worker-01.json"
```

每份配置至少需要修改：

- `agentId`，例如 `worker-01`、`worker-02`。
- `authToken`，建议每台 Worker 使用不同随机值。
- 每个槽位的 `id`。
- 每个槽位的 `publicUrl`。
- 如果各机器目录不同，还要修改路径字段。

不同物理机器可以继续共同使用 `listenPort=9101`、`streamerPort=8001/8002`、`playerPort=801/802`，因为 IP 不同。

在 `config/workers.json` 中为每个 Worker 增加一项：

```json
{
  "id": "worker-01",
  "baseUrl": "http://192.168.1.21:9101",
  "token": "worker-01-random-token"
}
```

这里的 `id` 应与 Worker 配置中的 `agentId` 一致，`token` 应与该 Worker 的 `authToken` 一致。

修改 `workers.json` 后需要重启 Allocator。Worker Agent 自身不需要因为该文件变化而重启。

启动顺序为：先启动 20 个 Worker Agent，确认每台的 `/health` 正常，再启动 Allocator。

## 3. 客户端接入流程

客户端只调用 Allocator，不直接查询各 Worker 的 Agent：

```text
1. POST /api/sessions
2. status=ready    -> 使用 url
   status=starting -> 按 message 显示启动提示，并轮询 pollUrl
3. 保存 sessionId 和 sessionToken
4. 打开返回的 url
5. 用户退出时 DELETE 对应 session
```

不要让客户端分别查询各 Worker 的 Agent 后自行选择节点。两个客户端可能同时发现同一个空闲实例。Allocator 会在返回 URL 前预留槽位，保证唯一分配。

### 3.1 申请实例

```http
POST http://Allocator-IP:9200/api/sessions
X-API-Key: replace-with-your-allocator-api-key
Idempotency-Key: client-request-unique-id
Content-Type: application/json

{
  "ttlSeconds": 3600
}
```

`Idempotency-Key` 用于防止客户端超时重试时重复占用两个实例。同一个客户端请求重试时应继续使用原来的 Key。

热实例可用时返回 `201`：

```json
{
  "sessionId": "1ab9d0f6-6a02-4d4c-b764-1b349b95f7a5",
  "sessionToken": "temporary-session-capability-token",
  "status": "ready",
  "message": "服务已就绪，正在等待播放器连接。",
  "url": "http://192.168.1.21:801/",
  "pollUrl": "/api/sessions/1ab9d0f6-6a02-4d4c-b764-1b349b95f7a5",
  "workerId": "worker-01",
  "slotId": "W01-1",
  "createdAt": "2026-10-27T08:00:00.000Z",
  "readyAt": "2026-10-27T08:00:00.000Z",
  "disconnectedAt": null,
  "reconnectDeadline": null,
  "expiresAt": "2026-10-27T09:00:00.000Z",
  "reason": null,
  "error": null
}
```

冷启动时返回 `202`：

```json
{
  "sessionId": "1ab9d0f6-6a02-4d4c-b764-1b349b95f7a5",
  "sessionToken": "temporary-session-capability-token",
  "status": "starting",
  "message": "正在启动 Pixel Streaming 服务，请稍候...",
  "url": null,
  "pollUrl": "/api/sessions/1ab9d0f6-6a02-4d4c-b764-1b349b95f7a5"
}
```

所有可用实例都忙时返回：

```http
HTTP/1.1 503 Service Unavailable
Retry-After: 5
```

```json
{
  "error": "No free or startable Pixel Streaming slots are currently available.",
  "message": "当前没有可用的 Pixel Streaming 实例，请稍后重试。",
  "retryAfterMs": 5000
}
```

### 3.2 查询启动状态

```http
GET http://Allocator-IP:9200/api/sessions/{sessionId}
X-API-Key: replace-with-your-allocator-api-key
X-Session-Token: temporary-session-capability-token
```

建议每秒查询一次。状态定义：

| 状态 | 含义 | 客户端动作 |
|---|---|---|
| `starting` | UE/Wilbur 正在启动 | 继续轮询 |
| `ready` | 实例已就绪，尚未检测到玩家连接 | 打开 `url` |
| `active` | Wilbur 检测到玩家已经连接 | 继续使用 `url` |
| `disconnected` | 玩家断开，Slot 正在保留等待重连 | 10 分钟内重试原 `url` |
| `released` | 会话已释放 | 停止使用该实例 |
| `failed` | 槽位启动或运行失败 | 提示重试或重新申请 |

拿到 `url` 后，浏览器可以直接跳转，也可以放进 iframe：

```html
<iframe id="pixel-stream" allow="autoplay; fullscreen; gamepad"></iframe>

<script>
  const iframe = document.getElementById("pixel-stream");
  iframe.src = session.url;
</script>
```

返回的 `url` 已经是完整播放器页面，页面、脚本、信令地址和 WebRTC 参数由对应 Wilbur 提供。

### 3.3 JavaScript 客户端示例

```js
const ALLOCATOR_URL = "http://192.168.1.10:9200";
const API_KEY = "replace-with-your-allocator-api-key";

async function allocatorRequest(path, options = {}) {
  const response = await fetch(`${ALLOCATOR_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": API_KEY,
      ...(options.headers || {})
    }
  });

  const body = await response.json();
  if (!response.ok && response.status !== 503) {
    throw new Error(body.error || `HTTP ${response.status}`);
  }
  return { response, body };
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function allocatePixelStream(showMessage) {
  const idempotencyKey = crypto.randomUUID();
  const allocation = await allocatorRequest("/api/sessions", {
    method: "POST",
    headers: {
      "Idempotency-Key": idempotencyKey
    },
    body: JSON.stringify({
      ttlSeconds: 3600
    })
  });

  if (allocation.response.status === 503) {
    throw new Error("当前没有空闲实例，请稍后重试");
  }

  let session = allocation.body;
  const sessionToken = session.sessionToken;
  showMessage(session.message);
  const deadline = Date.now() + 210_000;

  while (session.status === "starting") {
    showMessage(session.message);
    if (Date.now() >= deadline) {
      throw new Error("UE 实例启动超时");
    }
    await sleep(1000);
    const result = await allocatorRequest(session.pollUrl, {
      headers: {
        "X-Session-Token": sessionToken
      }
    });
    session = {
      ...result.body,
      sessionToken
    };
  }

  if (
    session.status !== "ready" &&
    session.status !== "active" &&
    session.status !== "disconnected"
  ) {
    throw new Error(session.error || `实例分配失败：${session.status}`);
  }

  return session;
}

async function endPixelStream(sessionId, sessionToken) {
  await allocatorRequest(`/api/sessions/${sessionId}`, {
    method: "DELETE",
    headers: {
      "X-Session-Token": sessionToken
    }
  });
}
```

如果客户端使用同一个页面跳转到工作节点，不要在该页面的 `pagehide` 中立即释放会话，因为跳转本身也会触发 `pagehide`。可以让播放器窗口在用户明确退出时调用 `endPixelStream`；异常断开则由 Allocator 根据 Wilbur 的 `player_count` 自动回收。

### 3.4 API Key 安全

在公共网站中，不能把长期有效的 `apiKey` 直接写进浏览器 JavaScript。推荐由你的业务后端负责调用 Allocator，再把分配结果返回给浏览器。

如果是受控内网客户端或桌面客户端，可以直接调用 Allocator。正式环境至少应：

- 将 `corsAllowedOrigins` 限制为客户端实际来源。
- 使用足够长的随机 API Key。
- 限制 Allocator `9200` 的访问网络。
- 对公网客户端使用短期令牌，而不是长期固定 Key。

## 4. 分配和回收规则

Allocator 会：

1. 优先使用已经就绪且 `player_count=0` 的槽位。
2. 没有热实例且 `autoStart=true` 时，调用空闲 Worker Agent 启动一个槽位。
3. 返回 URL 后立即预留槽位，避免重复分配。
4. 在 `connectTimeoutMs=600000` 内没有玩家连接时回收槽位。
5. 玩家断开后进入 `disconnected`，Slot 保留 `idleReleaseMs=600000`。
6. 同一 Session 在 10 分钟内可以重连；新用户不会获得这个保留中的 Slot。
7. 10 分钟内没有重连时，`stopOnRelease=true` 会结束对应 UE 和 Wilbur。
8. 会话超过 `expiresAt` 后自动释放。

`stopOnRelease=false` 会缩短下一客户启动时间，但 UE 世界状态不会自动重置。

## 5. 健康状态

无需认证的健康检查：

```text
http://Worker-IP:9101/health
http://Allocator-IP:9200/health
```

需要 API Key 的槽位状态：

```text
GET http://Allocator-IP:9200/api/slots
```

Worker 内部接口：

```text
GET  /slots
GET  /slots/{slotId}
POST /slots/{slotId}/start
POST /slots/{slotId}/stop
```

Worker 接口只应开放给 Allocator 和运维网络，不提供给普通客户端。

## 6. 网络和直连地址

每个 Worker 配置中的 `publicUrl` 必须填写客户端真实能够访问的地址，例如：

```json
"publicUrl": "http://192.168.1.11:801/"
```

需要连通：

- 客户端到 Allocator `9200`。
- Allocator 到各 Worker Agent `9101`。
- 客户端到各 Worker 的玩家端口 `801/802`。
- 客户端到各 Worker 的 WebRTC UDP，或配置 TURN。

不要把 `8001/8002` 推流端口和 `9101` Worker API 直接开放给普通客户端。

如果播放器页面通过 HTTPS 访问，对应实例也必须提供 HTTPS/WSS。可以在每个槽位配置中给 Wilbur 增加不同的 HTTPS 端口：

```json
{
  "id": "W01-1",
  "publicUrl": "https://192.168.1.21:8443/",
  "wilburArgs": [
    "--https",
    "--https_port",
    "8443"
  ]
}
```

证书路径继续由 `WebServers\SignallingWebServer\config.json` 的 `ssl_key_path` 和 `ssl_cert_path` 指定。

## 7. 测试

测试使用模拟 Wilbur 和模拟 UE，不会启动真实游戏：

```powershell
WebServers\SignallingWebServer\platform_scripts\cmd\node\node.exe ^
  --test Orchestrator\test\worker-agent.test.js Orchestrator\test\allocator.test.js
```

## 当前实现边界

- 会话分配状态保存在 Allocator 内存中。Allocator 重启后，客户端需要重新申请会话。
- Agent 重启前正在运行的进程不会被新 Agent 自动接管。生产环境应把 Agent 作为 Windows 服务运行，并用 Job Object 或 PID 文件管理进程树。
- 当前 `start-*.bat` 是前台进程，便于测试。生产环境建议用任务计划程序、NSSM 或 WinSW 启动它们。
