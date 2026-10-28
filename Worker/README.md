# Worker Agent 独立部署

Worker Agent 运行在每台 GPU 机器上，负责按 Slot 启动 Wilbur 和 UE，并上报就绪、Player 数量和进程状态。

该目录可以单独部署到 Worker 机器，不需要复制 Allocator 源码。

## 目录内容

```text
Worker\
├── worker-agent.js
├── worker01.json
├── worker-template.json
├── common\
│   ├── resolve-node.ps1
│   └── runtime.js
├── test\
│   ├── worker-agent.test.js
│   └── fixtures\
├── stop-slot.bat
├── stop-all-slots.bat
├── stop-slot.ps1
└── start-worker.bat
```

## 外部依赖

Worker 机器还需要：

```text
C:\UE_PIXEL_STREAMING_SERVER\WebServers
D:\YourGameBuild\Windows
```

如果从 Git 克隆后没有 `node_modules`，先安装 WebServers 依赖：

```powershell
Set-Location C:\UE_PIXEL_STREAMING_SERVER\WebServers
npm ci
```

## 配置

从 [worker-template.json](worker-template.json) 创建实际 Worker 配置：

```powershell
Copy-Item `
  "C:\UE_PIXEL_STREAMING_SERVER\Worker\worker-template.json" `
  "C:\UE_PIXEL_STREAMING_SERVER\Worker\worker-01.json"
```

当前实际配置为 [worker01.json](worker01.json)。

关键字段：

```json
{
  "agentId": "worker-01",
  "listenPort": 9101,
  "authToken": "WORKER_01_TOKEN",
  "windowsDirectory": "D:/YourGameBuild/Windows",
  "webServersDirectory": "C:/UE_PIXEL_STREAMING_SERVER/WebServers",
  "nodeExecutable": "SignallingWebServer/platform_scripts/cmd/node/node.exe",
  "signallingDirectory": "SignallingWebServer",
  "gameExecutable": "UE_ANDA.exe",
  "logsDirectory": "logs"
}
```

`logsDirectory=logs` 会解析到：

```text
C:\UE_PIXEL_STREAMING_SERVER\Worker\logs
```

每个 Slot 必须有独立的：

- `streamerPort`
- `playerPort`
- `sfuPort`
- `publicUrl`

## 启动

```bat
C:\UE_PIXEL_STREAMING_SERVER\Worker\start-worker.bat worker01.json
```

配置省略 `.json` 也可以：

```bat
start-worker.bat worker01
```

也可以传入配置完整路径：

```bat
start-worker.bat D:\WorkerConfigs\worker-07.json
```

一个 Worker Agent 启动时不会立即拉起 UE。Allocator 分配 Slot 后才会启动 Wilbur 和 UE。

## 手动停止 Slot

关闭一个指定 Slot 的 UE 和 Wilbur，但保留 Worker Agent：

```bat
C:\UE_PIXEL_STREAMING_SERVER\Worker\stop-slot.bat W01-1
```

使用其他 Worker 配置：

```bat
stop-slot.bat W07-1 worker07.json
```

关闭当前配置中的全部 Slot，但保留 Worker Agent：

```bat
C:\UE_PIXEL_STREAMING_SERVER\Worker\stop-all-slots.bat
```

脚本自动从 Worker 配置读取 `listenPort`、`authToken` 和 Slot 列表，不会在命令行明文传入 Token。

如果 Slot 正在被 Allocator 分配，Agent 会停掉对应 UE/Wilbur，但 Allocator 中的 Session 可能先进入 `disconnected`，等待重连窗口结束后才完全释放。

关闭整个 Worker Agent、全部 Slot 和 Allocator，请使用部署根目录：

```bat
C:\UE_PIXEL_STREAMING_SERVER\stop-all.bat
```

## 健康检查

```text
http://Worker-IP:9101/health
```

## 测试

```powershell
& C:\UE_PIXEL_STREAMING_SERVER\WebServers\SignallingWebServer\platform_scripts\cmd\node\node.exe `
  --test C:\UE_PIXEL_STREAMING_SERVER\Worker\test\worker-agent.test.js
```

## 相关文档

- [架构说明](../Docs/架构说明.md)
- [认证与密钥](../Docs/认证与密钥说明.md)
- [完整启动说明](../Docs/启动说明.md)
- [调试与日志](../Docs/调试与日志说明.md)
