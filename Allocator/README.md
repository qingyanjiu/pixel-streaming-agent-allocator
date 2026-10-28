# Allocator 独立部署

Allocator 是中央会话分配服务，负责管理 Worker 清单、申请 Session、冷启动实例、断线保留和超时回收。

该目录可以单独复制到 Allocator 机器，不需要复制 Worker Agent 源码、WebServers 或 UE 游戏构建。

## 目录内容

```text
Allocator\
├── allocator.js
├── allocator.json
├── allocator.example.json
├── config\
│   ├── workers.json
│   └── workers.example.json
├── common\
│   ├── resolve-node.ps1
│   └── runtime.js
├── test\
│   └── allocator.test.js
└── start-allocator.bat
```

## 运行要求

- Node.js 18 或更高版本，推荐使用 Node.js 22。
- 能够访问所有 Worker 的 TCP `9101`。
- 允许客户端访问 TCP `9200`。

`allocator.json` 默认使用：

```json
"nodeExecutable": "node.exe"
```

如果 `node.exe` 不在系统 PATH 中，可以填写绝对路径，或启动前设置：

```bat
set "PS_NODE_EXE=D:\Tools\node\node.exe"
```

## 配置

修改 [allocator.json](allocator.json)：

- `apiKey`：客户端访问 Allocator 使用的 Key。
- `corsAllowedOrigins`：允许直接访问的网页来源。
- `listenPort`：默认 `9200`。
- `connectTimeoutMs`：实例就绪后等待首次连接的时间，默认 10 分钟。
- `idleReleaseMs`：断线后等待同一 Session 重连的时间，默认 10 分钟。
- `workersFile`：Worker 清单路径，默认 `./config/workers.json`。

修改 [config/workers.json](config/workers.json)：

```json
{
  "workers": [
    {
      "id": "worker-01",
      "baseUrl": "http://WORKER_01_IP:9101",
      "token": "WORKER_01_TOKEN"
    }
  ]
}
```

`token` 必须与对应 Worker 的 `authToken` 一致。

## 启动

```bat
C:\UE_PIXEL_STREAMING_SERVER\Allocator\start-allocator.bat
```

如果只复制了 Allocator 目录，也可以直接从该目录运行：

```bat
start-allocator.bat
```

## 健康检查

```text
http://Allocator-IP:9200/health
```

需要 Client API Key 的 Worker 和 Slot 状态：

```http
GET http://Allocator-IP:9200/api/slots
X-API-Key: <apiKey>
```

受 Client API Key 保护的关闭接口：

```http
POST http://Allocator-IP:9200/shutdown
X-API-Key: <apiKey>
Content-Type: application/json

{}
```

通常不需要手工调用，建议使用部署根目录的 `stop-all.bat`。

## 流资源驾驶舱

Allocator 内置只读驾驶舱：

```text
http://Allocator-IP:9200/dashboard/
```

页面提供总路数、就绪/未就绪统计、Worker、Slot、Player、Session 和异常列表。

使用 `allocator.json` 中的 `apiKey` 登录。详细说明：

- [驾驶舱说明](../Docs/驾驶舱说明.md)

## 测试

Allocator 测试只依赖 Node.js：

```powershell
Set-Location C:\UE_PIXEL_STREAMING_SERVER\Allocator
node --test test\allocator.test.js
```

## 相关文档

- [客户端连接](../Docs/客户端连接像素流说明.md)
- [认证与密钥](../Docs/认证与密钥说明.md)
- [完整启动说明](../Docs/启动说明.md)
- [架构说明](../Docs/架构说明.md)
- [调试与日志](../Docs/调试与日志说明.md)
