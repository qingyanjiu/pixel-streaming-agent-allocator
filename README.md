# Pixel Streaming Agent Allocator

UE 5.8 Pixel Streaming 多机器按需分配与 Wilbur 运行环境。

## 仓库目录

```text
C:\UE_PIXEL_STREAMING_SERVER\
├── Orchestrator\    # Allocator、Worker Agent、配置、测试和文档
└── WebServers\      # UE 5.8 Wilbur、播放器前端、Common、Signalling 和工具
```

`node_modules`、运行日志、环境变量、证书和私钥不会提交到 Git。克隆后运行前需要安装依赖：

```powershell
Set-Location C:\UE_PIXEL_STREAMING_SERVER\WebServers
npm ci
```

## 文档

- [Orchestrator README](Orchestrator/README.md)
- [服务启动说明](Orchestrator/启动说明.md)
- [架构说明](Orchestrator/架构说明.md)
- [认证与密钥说明](Orchestrator/认证与密钥说明.md)
- [客户端连接像素流说明](Orchestrator/客户端连接像素流说明.md)

## 运行配置

实际运行配置：

- `Orchestrator\allocator\allocator.json`
- `Orchestrator\config\workers.json`
- `Orchestrator\agent\worker*.json`

脱敏示例：

- `Orchestrator\allocator\allocator.example.json`
- `Orchestrator\config\workers.example.json`
- `Orchestrator\agent\worker-template.json`

固定 WebServers 路径：

```text
C:\UE_PIXEL_STREAMING_SERVER\WebServers
```
