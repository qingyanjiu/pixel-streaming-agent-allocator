# 手动停止 UE 进程的影响与恢复

本文说明直接结束 UE 进程和通过 Worker Agent 停止 Slot 的区别。

## 1. 先区分 UE 和 Slot

一个 Slot 包含：

```text
Slot
├── 一个 Wilbur 进程
└── 一个 UE 进程
```

直接结束 UE 只会杀掉其中一个子进程，不会同时关闭 Wilbur，也不会自动重新创建 Slot。

推荐的操作对象通常是 Slot，而不是单个操作系统进程。

## 2. 直接结束 UE 会发生什么

如果在任务管理器中结束某个 `UE_ANDA.exe`，或在 PowerShell 中执行：

```powershell
Stop-Process -Id <uePid> -Force
```

会发生：

| 项目 | 影响 |
|---|---|
| UE 进程 | 立即退出，游戏内存状态丢失 |
| 当前 Player | 视频、输入和 DataChannel 连接断开 |
| Wilbur | 不会自动停止，继续监听 Streamer、Player 和 SFU 端口 |
| Slot 状态 | Worker 标记为 `failed`，`running=false`、`ready=false` |
| GPU 和显存 | 随 UE 退出而释放 |
| 其他 Slot | 不受影响 |
| 自动恢复 | 不会自动重启 UE |

Worker 控制台会出现类似：

```text
ue exited unexpectedly (exit code ...)
event=slot_failed
```

驾驶舱下一次刷新后会显示该 Slot 未就绪或异常。

## 3. Allocator 和 Session 的影响

直接结束 UE 后：

1. Allocator 下一次轮询会看到 Slot 不再就绪。
2. 新客户端不会分配到该 Slot。
3. 原有 Session 可能先进入 `disconnected`。
4. Session 和 Slot 租约会继续保留约 10 分钟，等待原客户端重连。
5. 由于 UE 已经不存在，这段时间内实际无法恢复游戏画面。
6. 租约释放后，Slot 才能重新分配给新会话。

因此直接杀 UE 会同时造成：

```text
UE 已停止
Wilbur 还在
Slot 无法立即重新分配
原 Session 也无法真正重连
```

这是不推荐的中间状态。

## 4. 推荐停止方式

### 停止一个 Slot

同时停止指定 Slot 的 UE 和 Wilbur：

```bat
Worker\stop-slot.bat slot01
```

这是单路维护和单路故障清理的推荐方式。

### 停止本机全部 Slot

停止当前 Worker Agent 管理的全部 Slot，但保留 Agent：

```bat
Worker\stop-all-slots.bat
```

### 停止全部 Worker、UE 和 Allocator

```bat
stop-all.bat
```

## 5. 应急按 PID 停止单个 UE

如果 Agent 本身异常，只能先按 PID 处理。查看 PID：

```powershell
$config = Get-Content -Raw `
  Worker\worker01.json |
  ConvertFrom-Json

$headers = @{
    Authorization = "Bearer $($config.authToken)"
}

$state = Invoke-RestMethod `
  -Uri "http://127.0.0.1:$($config.listenPort)/slots" `
  -Headers $headers

$state.slots | Select-Object id, status, playerCount, pids
```

精确结束某个 Slot 的 UE：

```powershell
$slot = $state.slots | Where-Object id -eq "slot01"
Stop-Process -Id $slot.pids.ue -Force
```

完成应急处理后，应继续清理 Wilbur：

```bat
Worker\stop-slot.bat slot01
```

## 6. 如何恢复被杀掉的 Slot

先清理 Slot：

```bat
stop-slot.bat slot01
```

正常交给 Allocator 分配时，等待原 Session 租约释放后，下一次客户端申请会重新启动该 Slot。

如果维护人员需要立即恢复同一个 Slot，可以调用受保护的 Worker 接口：

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri "http://127.0.0.1:$($config.listenPort)/slots/slot01/start" `
  -Headers $headers `
  -TimeoutSec 200
```

接口会：

1. 清理残留 Wilbur。
2. 重新启动 Wilbur。
3. 重新启动 UE。
4. 等待 Streamer 就绪后返回。

如果原 Session 仍被分配器租用，立即启动不会自动解除 Session 租约。要提前释放，应由对应的客户端调用：

```http
DELETE /api/sessions/{sessionId}
X-API-Key: <client-api-key>
X-Session-Token: <sessionToken>
```

否则需要等待 `idleReleaseMs`，当前默认为 10 分钟。

## 7. 不要使用全局进程名清理

以下命令会杀掉当前机器上的全部 UE 实例：

```bat
taskkill /IM UE_ANDA.exe /F
taskkill /IM UE_ANDA-Win64-Shipping.exe /F
```

以下命令会杀掉机器上的全部 Node.js 服务，包括 Worker Agent、Wilbur 和其他 Node 应用：

```bat
taskkill /IM node.exe /F
```

这些命令会导致：

- 多路 Slot 同时异常。
- Wilbur 或 Agent 残留状态不一致。
- 其他业务 Node 服务被误杀。
- Allocator 只能等待超时发现故障。

优先使用 `stop-slot.bat`、`stop-all-slots.bat` 和 `stop-all.bat`。

## 8. 检查结果

停止后检查 Worker：

```text
http://Worker-IP:9101/slots
```

确认目标 Slot：

```text
status=stopped
running=false
ready=false
playerCount=0
pids.wilbur=null
pids.ue=null
```

也可以查看驾驶舱的 Slot 状态和 Worker 在线信息。
