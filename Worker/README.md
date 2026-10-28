# Worker Agent 独立部署

Worker Agent 运行在每台 GPU 机器上，负责按 Slot 启动 Wilbur 和 UE，并上报就绪、Player 数量和进程状态。

除特别说明外，本文路径和命令都相对于项目根目录。

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
WebServers
<Windows构建目录>
```

如果从 Git 克隆后没有 `node_modules`，先安装 WebServers 依赖：

```powershell
Set-Location WebServers
npm ci
```

## 配置

从 [worker-template.json](worker-template.json) 创建实际 Worker 配置：

```powershell
Copy-Item `
  "Worker\worker-template.json" `
  "Worker\worker01.json"
```

当前实际配置为 [worker01.json](worker01.json)。

关键字段：

```json
{
  "agentId": "worker01",
  "listenPort": 9101,
  "authToken": "WORKER01_TOKEN",
  "windowsDirectory": "<Windows构建目录>",
  "webServersDirectory": "../WebServers",
  "nodeExecutable": "SignallingWebServer/platform_scripts/cmd/node/node.exe",
  "signallingDirectory": "SignallingWebServer",
  "gameExecutable": "UE_ANDA.exe",
  "logsDirectory": "logs"
}
```

`logsDirectory=logs` 会解析到：

```text
Worker\logs
```

每个 Slot 必须有独立的：

- `streamerPort`
- `playerPort`
- `sfuPort`
- `publicUrl`

Worker 和 Slot 统一使用 `worker01`、`slot01` 格式。Slot ID 只要求在同一个 Worker 内唯一，不同 Worker 可以都包含 `slot01`。完整规则见
[Worker 与 Slot 命名规范](../Docs/命名规范.md)。

## 启动

```bat
Worker\start-worker.bat worker01.json
```

配置省略 `.json` 也可以：

```bat
start-worker.bat worker01
```

也可以传入配置完整路径：

```bat
start-worker.bat Worker\worker07.json
```

一个 Worker Agent 启动时不会立即拉起 UE。Allocator 分配 Slot 后才会启动 Wilbur 和 UE。

## 手动停止 Slot

关闭一个指定 Slot 的 UE 和 Wilbur，但保留 Worker Agent：

```bat
Worker\stop-slot.bat slot01
```

使用其他 Worker 配置：

```bat
stop-slot.bat slot01 worker07.json
```

关闭当前配置中的全部 Slot，但保留 Worker Agent：

```bat
Worker\stop-all-slots.bat
```

脚本自动从 Worker 配置读取 `listenPort`、`authToken` 和 Slot 列表，不会在命令行明文传入 Token。

如果 Slot 正在被 Allocator 分配，Agent 会停掉对应 UE/Wilbur，但 Allocator 中的 Session 可能先进入 `disconnected`，等待重连窗口结束后才完全释放。

直接结束 UE 进程与停止 Slot 的差异，以及异常恢复步骤，见
[UE 进程与 Slot 停止说明](../Docs/UE进程与Slot停止说明.md)。

关闭整个 Worker Agent、全部 Slot 和 Allocator，请使用部署根目录：

```bat
stop-all.bat
```

## 健康检查

```text
http://Worker-IP:9101/health
```

## 测试

```powershell
& WebServers\SignallingWebServer\platform_scripts\cmd\node\node.exe `
  --test Worker\test\worker-agent.test.js
```

## 相关文档

- [架构说明](../Docs/架构说明.md)
- [认证与密钥](../Docs/认证与密钥说明.md)
- [完整启动说明](../Docs/启动说明.md)
- [调试与日志](../Docs/调试与日志说明.md)
