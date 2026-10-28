# Pixel Streaming Agent Allocator

UE 5.8 Pixel Streaming 多机器按需分配系统。

仓库按部署职责拆分：

```text
C:\UE_PIXEL_STREAMING_SERVER\
├── Allocator\    # 中央分配服务，可单独部署
├── Worker\       # GPU 机器代理，可单独部署
├── Docs\         # 架构、启动、认证和前端文档
└── WebServers\   # Worker 共享的 Wilbur 和播放器运行环境
```

## 分离部署

### Allocator 机器

只需要：

```text
Allocator\
Node.js
```

启动：

```bat
Allocator\start-allocator.bat
```

说明：[Allocator README](Allocator/README.md)

### Worker 机器

需要：

```text
Worker\
WebServers\
Windows 游戏构建
```

启动：

```bat
Worker\start-worker.bat worker01.json
```

手动关闭一个 Slot：

```bat
Worker\stop-slot.bat slot01
```

关闭当前 Worker 的全部 Slot：

```bat
Worker\stop-all-slots.bat
```

停止所有 Worker Agent、全部 UE/Wilbur 和本地 Allocator：

```bat
stop-all.bat
```

脚本会读取 `Allocator\config\workers.json`，默认要求输入 `YES` 确认。

若当前运行的 Allocator 不支持 `/shutdown`，脚本会按本地监听端口结束对应的 Node 进程。

自动化场景：

```bat
stop-all.bat --force
```

只查看会停止哪些服务：

```bat
stop-all.bat --what-if
```

说明：[Worker README](Worker/README.md)

## WebServers

WebServers 是 Worker 的共享外部依赖，固定路径为：

```text
C:\UE_PIXEL_STREAMING_SERVER\WebServers
```

`node_modules` 不提交到 Git。新克隆后需要安装：

```powershell
Set-Location C:\UE_PIXEL_STREAMING_SERVER\WebServers
npm ci
```

## 运行配置

Allocator 配置：

```text
Allocator\allocator.json
Allocator\config\workers.json
```

Worker 配置：

```text
Worker\worker*.json
Worker\worker-template.json
```

实际运行配置已提交到 Git；日志、证书、私钥和 `.env` 不提交。

## 文档

- [流资源驾驶舱](http://Allocator-IP:9200/dashboard/)
- [驾驶舱说明](Docs/驾驶舱说明.md)
- [启动说明](Docs/启动说明.md)
- [架构说明](Docs/架构说明.md)
- [认证与密钥说明](Docs/认证与密钥说明.md)
- [客户端连接像素流说明](Docs/客户端连接像素流说明.md)
- [调试与日志说明](Docs/调试与日志说明.md)
- [UE 进程与 Slot 停止说明](Docs/UE进程与Slot停止说明.md)
- [Worker 与 Slot 命名规范](Docs/命名规范.md)
- [综合说明](Docs/综合说明.md)
