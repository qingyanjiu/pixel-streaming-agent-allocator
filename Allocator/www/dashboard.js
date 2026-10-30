"use strict";

const API_KEY_STORAGE = "pixel-dashboard-api-key";
const REFRESH_INTERVAL_MS = 3000;
const REQUEST_TIMEOUT_MS = 20000;

const elements = {
    bootLayer: document.getElementById("bootLayer"),
    bootMessage: document.getElementById("bootMessage"),
    authLayer: document.getElementById("authLayer"),
    authForm: document.getElementById("authForm"),
    authError: document.getElementById("authError"),
    apiKey: document.getElementById("apiKey"),
    revealKey: document.getElementById("revealKey"),
    appShell: document.getElementById("appShell"),
    liveState: document.getElementById("liveState"),
    liveLabel: document.getElementById("liveLabel"),
    clock: document.getElementById("clock"),
    refreshButton: document.getElementById("refreshButton"),
    lockButton: document.getElementById("lockButton"),
    lastUpdated: document.getElementById("lastUpdated"),
    onlineWorkers: document.getElementById("onlineWorkers"),
    totalSlots: document.getElementById("totalSlots"),
    readinessOrbit: document.getElementById("readinessOrbit"),
    readinessPercent: document.getElementById("readinessPercent"),
    statTotal: document.getElementById("statTotal"),
    statAvailable: document.getElementById("statAvailable"),
    statPlayers: document.getElementById("statPlayers"),
    statLeased: document.getElementById("statLeased"),
    reservedSummary: document.getElementById("reservedSummary"),
    reservedList: document.getElementById("reservedList"),
    reservedEmpty: document.getElementById("reservedEmpty"),
    noticeBanner: document.getElementById("noticeBanner"),
    workerSummary: document.getElementById("workerSummary"),
    workerRows: document.getElementById("workerRows"),
    workerEmpty: document.getElementById("workerEmpty"),
    slotRows: document.getElementById("slotRows"),
    slotEmpty: document.getElementById("slotEmpty"),
    slotSearch: document.getElementById("slotSearch"),
    workerFilter: document.getElementById("workerFilter"),
    autoRefresh: document.getElementById("autoRefresh"),
    statusFilters: document.getElementById("statusFilters"),
    footerSync: document.getElementById("footerSync"),
    toast: document.getElementById("toast")
};

const state = {
    apiKey: sessionStorage.getItem(API_KEY_STORAGE) || "",
    data: null,
    workerById: new Map(),
    slotStatus: "all",
    workerId: "all",
    search: "",
    loading: false,
    lastUpdatedAt: null
};

let refreshTimer = null;
let toastTimer = null;

function escapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function formatTime(value) {
    if (!value) {
        return "—";
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return "—";
    }
    return new Intl.DateTimeFormat("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false
    }).format(date);
}

function formatRemaining(value) {
    if (!value) {
        return "—";
    }
    const deadline = new Date(value).getTime();
    if (Number.isNaN(deadline)) {
        return "—";
    }
    const remainingSeconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    if (remainingSeconds === 0) {
        return "即将释放";
    }
    const hours = Math.floor(remainingSeconds / 3600);
    const minutes = Math.floor((remainingSeconds % 3600) / 60);
    const seconds = remainingSeconds % 60;
    if (hours > 0) {
        return `${hours} 小时 ${minutes} 分`;
    }
    return `${minutes} 分 ${String(seconds).padStart(2, "0")} 秒`;
}

function formatRelative(value) {
    if (!value) {
        return "从未";
    }
    const elapsed = Math.max(0, Date.now() - new Date(value).getTime());
    if (elapsed < 5000) {
        return "刚刚";
    }
    if (elapsed < 60000) {
        return `${Math.floor(elapsed / 1000)} 秒前`;
    }
    if (elapsed < 3600000) {
        return `${Math.floor(elapsed / 60000)} 分钟前`;
    }
    return `${Math.floor(elapsed / 3600000)} 小时前`;
}

function normalizedStatus(slot) {
    if (slot.status === "starting" || slot.status === "stopping") {
        return slot.status;
    }
    if (slot.playerCount > 0) {
        return "busy";
    }
    if (slot.leasedTo) {
        return "leased";
    }
    if (slot.ready) {
        return "ready";
    }
    return slot.status || "stopped";
}

function statusLabel(status) {
    return {
        ready: "可用",
        busy: "使用中",
        leased: "等待用户",
        starting: "正在启动",
        stopping: "正在停止",
        stopped: "未启动",
        failed: "异常",
        offline: "服务器离线"
    }[status] || status;
}

function statusClass(status) {
    if (status === "ready") {
        return "status-ready";
    }
    if (status === "busy") {
        return "status-busy";
    }
    if (status === "leased") {
        return "status-leased";
    }
    if (status === "starting" || status === "stopping") {
        return `status-${status}`;
    }
    if (status === "failed" || status === "offline") {
        return "status-failed";
    }
    return "status-stopped";
}

function playerDots(current, capacity) {
    const max = Math.max(1, Math.min(6, Number(capacity) || 1));
    return Array.from({ length: max }, (_, index) =>
        `<span class="player-dot${index < current ? " filled" : ""}"></span>`
    ).join("");
}

function setConnectionState(mode, label) {
    elements.liveState.classList.remove("online", "error");
    if (mode === "online") {
        elements.liveState.classList.add("online");
    } else if (mode === "error") {
        elements.liveState.classList.add("error");
    }
    elements.liveLabel.textContent = label;
}

function showToast(message, type = "error") {
    window.clearTimeout(toastTimer);
    elements.toast.textContent = message;
    elements.toast.classList.remove("toast-success", "toast-error");
    elements.toast.classList.add(type === "success" ? "toast-success" : "toast-error");
    elements.toast.classList.remove("hidden");
    toastTimer = window.setTimeout(() => elements.toast.classList.add("hidden"), 5000);
}

function showAuth(message = "") {
    elements.bootLayer.classList.add("hidden");
    elements.authLayer.classList.remove("hidden");
    elements.appShell.setAttribute("aria-hidden", "true");
    elements.authError.textContent = message;
    elements.apiKey.focus();
}

function hideAuth() {
    elements.bootLayer.classList.add("hidden");
    elements.authLayer.classList.add("hidden");
    elements.appShell.setAttribute("aria-hidden", "false");
}

function showBoot(message = "正在验证当前会话...") {
    elements.bootMessage.textContent = message;
    elements.bootLayer.classList.remove("hidden");
    elements.authLayer.classList.add("hidden");
    elements.appShell.setAttribute("aria-hidden", "true");
}

async function fetchSlots() {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const response = await fetch("/api/slots", {
            headers: {
                Accept: "application/json",
                "X-API-Key": state.apiKey
            },
            cache: "no-store",
            signal: controller.signal
        });
        const body = await response.json().catch(() => ({}));
        if (response.status === 401) {
            throw Object.assign(new Error("Client API Key 无效"), { code: 401 });
        }
        if (!response.ok) {
            throw new Error(body.error || `HTTP ${response.status}`);
        }
        return body;
    } finally {
        window.clearTimeout(timeout);
        if (button.isConnected) {
            button.disabled = false;
            button.textContent = "释放并停止";
        }
    }
}

function calculateSummary(data) {
    const slots = data.slots || [];
    const workers = data.workers || [];
    const onlineWorkerIds = new Set(
        workers.filter((worker) => worker.online).map((worker) => worker.id)
    );
    let available = 0;
    let inUse = 0;
    let unavailableSlots = 0;
    let leased = 0;

    for (const slot of slots) {
        const playerCount = Number(slot.playerCount) || 0;
        const workerOnline = onlineWorkerIds.has(slot.workerId);
        const healthy = workerOnline && slot.status !== "failed";
        if (!healthy) {
            unavailableSlots += 1;
        } else if (playerCount > 0) {
            inUse += 1;
        } else if (slot.leasedTo) {
            leased += 1;
        } else {
            available += 1;
        }
    }

    const players = slots.reduce((sum, slot) => sum + (Number(slot.playerCount) || 0), 0);
    return {
        slots,
        workers,
        total: slots.length,
        available,
        leased,
        inUse,
        players,
        onlineWorkers: workers.filter((worker) => worker.online).length,
        failedWorkers: workers.filter((worker) => !worker.online).length,
        normal: slots.length - unavailableSlots
    };
}

function renderWorkers(summary) {
    state.workerById = new Map(summary.workers.map((worker) => [worker.id, worker]));
    elements.workerSummary.textContent = `${summary.onlineWorkers} / ${summary.workers.length} 在线`;
    elements.workerRows.innerHTML = "";

    for (const worker of summary.workers) {
        const workerSlots = summary.slots.filter((slot) => slot.workerId === worker.id);
        const availableSlots = workerSlots.filter(
            (slot) => Number(slot.playerCount) === 0 && !slot.leasedTo
        ).length;
        const players = workerSlots.reduce(
            (sum, slot) => sum + (Number(slot.playerCount) || 0),
            0
        );
        const row = document.createElement("tr");
        row.innerHTML = `
            <td>
                <div class="worker-name">
                    <span class="worker-symbol">${escapeHtml(worker.id.slice(0, 2).toUpperCase())}</span>
                    <span class="worker-meta">
                        <strong>${escapeHtml(worker.id)}</strong>
                        <small title="${escapeHtml(worker.baseUrl || "")}">${escapeHtml(worker.baseUrl || "未配置地址")}</small>
                    </span>
                </div>
            </td>
            <td><span class="status-badge ${worker.online ? "status-online" : "status-offline"}">${worker.online ? "在线" : "离线"}</span></td>
            <td><span class="mono">${worker.online ? `${availableSlots} / ${workerSlots.length}` : "0 / " + workerSlots.length}</span></td>
            <td><span class="mono">${players}</span></td>
            <td title="${escapeHtml(worker.lastError || worker.lastSeenAt || "")}">${escapeHtml(formatRelative(worker.lastSeenAt))}</td>
        `;
        elements.workerRows.appendChild(row);
    }

    elements.workerEmpty.classList.toggle("hidden", summary.workers.length > 0);

    const currentWorker = elements.workerFilter.value || "all";
    const options = ['<option value="all">全部节点</option>']
        .concat(
            summary.workers.map(
                (worker) =>
                    `<option value="${escapeHtml(worker.id)}">${escapeHtml(worker.id)}</option>`
            )
        )
        .join("");
    elements.workerFilter.innerHTML = options;
    elements.workerFilter.value = summary.workers.some((worker) => worker.id === currentWorker)
        ? currentWorker
        : "all";
    state.workerId = elements.workerFilter.value;
}

function reservationStatusLabel(status) {
    return {
        starting: "启动中",
        ready: "等待连接",
        disconnected: "等待重连",
        active: "已连接"
    }[status] || statusLabel(status);
}

function updateReservationCountdowns() {
    for (const item of elements.reservedList.querySelectorAll("[data-deadline]")) {
        item.textContent = formatRemaining(item.dataset.deadline);
    }
}

function renderReservations(summary) {
    const reservations = summary.slots.filter(
        (slot) => slot.lease && Number(slot.playerCount) === 0
    );
    elements.reservedSummary.textContent = `${reservations.length} 条`;
    elements.reservedList.innerHTML = reservations
        .map(
            (slot) => `
                <article class="reserved-item">
                    <div class="reserved-resource">
                        <strong>${escapeHtml(slot.workerId)} / ${escapeHtml(slot.id)}</strong>
                        <span class="status-badge ${statusClass(slot.lease.status)}">${escapeHtml(reservationStatusLabel(slot.lease.status))}</span>
                    </div>
                    <div class="reserved-detail">
                        <span>预约 IP</span>
                        <strong class="mono">${escapeHtml(slot.lease.clientAddress || "未知")}</strong>
                    </div>
                    <div class="reserved-detail">
                        <span>剩余时间</span>
                        <strong
                            class="reserved-time"
                            data-deadline="${escapeHtml(slot.lease.deadline)}"
                            title="截止 ${escapeHtml(slot.lease.deadline)}"
                        >${escapeHtml(formatRemaining(slot.lease.deadline))}</strong>
                    </div>
                    <button
                        class="release-button"
                        type="button"
                        data-release-worker="${escapeHtml(slot.workerId)}"
                        data-release-slot="${escapeHtml(slot.id)}"
                    >释放并停止</button>
                </article>
            `
        )
        .join("");
    elements.reservedEmpty.classList.toggle("hidden", reservations.length > 0);
}

async function releaseReservation(button) {
    const workerId = button.dataset.releaseWorker;
    const slotId = button.dataset.releaseSlot;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 35_000);
    button.disabled = true;
    button.textContent = "正在停止...";
    try {
        const response = await fetch(
            `/api/slots/${encodeURIComponent(workerId)}/${encodeURIComponent(slotId)}/release`,
            {
                method: "POST",
                headers: {
                    Accept: "application/json",
                    "Content-Type": "application/json",
                    "X-API-Key": state.apiKey
                },
                body: "{}",
                cache: "no-store",
                signal: controller.signal
            }
        );
        const body = await response.json().catch(() => ({}));
        if (response.status === 401) {
            throw Object.assign(new Error("Client API Key 无效"), { code: 401 });
        }
        if (!response.ok) {
            throw new Error(body.error || `HTTP ${response.status}`);
        }
        showToast(`已释放 ${workerId}/${slotId} 并停止线路`, "success");
        await refreshDashboard({ silent: true });
    } catch (error) {
        if (error.code === 401) {
            sessionStorage.removeItem(API_KEY_STORAGE);
            state.apiKey = "";
            showAuth("API Key 无效，请重新输入。");
            return;
        }
        const message =
            error.name === "AbortError"
                ? "释放超时，请刷新后检查线路状态"
                : `释放失败：${error.message}`;
        showToast(message);
        button.disabled = false;
        button.textContent = "释放并停止";
    } finally {
        window.clearTimeout(timeout);
    }
}

function slotMatches(slot) {
    const worker = state.workerById.get(slot.workerId);
    const status = worker && worker.online === false ? "offline" : normalizedStatus(slot);
    const playerCount = Number(slot.playerCount) || 0;
    if (
        state.slotStatus === "available" &&
        (
            slot.leasedTo ||
            playerCount > 0 ||
            status === "failed" ||
            status === "offline"
        )
    ) {
        return false;
    }
    if (state.slotStatus === "busy" && playerCount === 0) {
        return false;
    }
    if (
        state.slotStatus === "leased" &&
        (!slot.leasedTo || playerCount > 0)
    ) {
        return false;
    }
    if (
        state.slotStatus === "attention" &&
        !["failed", "offline"].includes(status)
    ) {
        return false;
    }
    if (state.workerId !== "all" && slot.workerId !== state.workerId) {
        return false;
    }
    if (state.search) {
        const haystack = [
            slot.id,
            slot.workerId,
            statusLabel(status),
            slot.status
        ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();
        if (!haystack.includes(state.search)) {
            return false;
        }
    }
    return true;
}

function slotDescription(status, slot) {
    if (status === "offline") {
        return "服务器当前离线";
    }
    if (status === "failed") {
        return slot.lastError || "实例运行异常";
    }
    if (status === "starting") {
        return "正在启动，请稍候";
    }
    if (status === "stopping") {
        return "正在关闭，请稍候";
    }
    if (status === "busy") {
        return "用户正在使用";
    }
    if (status === "leased") {
        return "已分配，等待用户连接";
    }
    if (status === "ready") {
        return "可以接受新用户";
    }
    if (status === "stopped") {
        return "有新请求时自动启动";
    }
    return "状态未知";
}

function renderSlots(summary) {
    const slots = summary.slots.filter(slotMatches);
    elements.slotRows.innerHTML = "";

    for (const slot of slots) {
        const worker = state.workerById.get(slot.workerId);
        const status = worker && worker.online === false ? "offline" : normalizedStatus(slot);

        const row = document.createElement("tr");
        row.innerHTML = `
            <td><span class="slot-name">${escapeHtml(slot.id)}</span></td>
            <td>${escapeHtml(slot.workerId)}</td>
            <td><span class="status-badge ${statusClass(status)}">${escapeHtml(statusLabel(status))}</span></td>
            <td>
                <span class="player-meter">
                    <span class="player-dots">${playerDots(Number(slot.playerCount) || 0, slot.capacity)}</span>
                    <span class="mono">${Number(slot.playerCount) || 0} / ${Number(slot.capacity) || 0}</span>
                </span>
            </td>
            <td class="description-cell" title="${escapeHtml(slot.lastError || "")}">${escapeHtml(slotDescription(status, slot))}</td>
        `;
        elements.slotRows.appendChild(row);
    }

    elements.slotEmpty.classList.toggle("hidden", slots.length > 0);
}

function renderNotice(summary) {
    const failedSlots = summary.slots.filter((slot) => slot.status === "failed");
    const offlineWorkers = summary.workers.filter((worker) => !worker.online);
    const messages = [];
    if (offlineWorkers.length) {
        messages.push(`${offlineWorkers.length} 个 Worker 离线：${offlineWorkers.map((worker) => worker.id).join("、")}`);
    }
    if (failedSlots.length) {
        messages.push(`${failedSlots.length} 个 Slot 异常：${failedSlots.map((slot) => slot.id).join("、")}`);
    }
    elements.noticeBanner.textContent = messages.join(" · ");
    elements.noticeBanner.classList.toggle("hidden", messages.length === 0);
}

function renderDashboard(data) {
    const summary = calculateSummary(data);
    state.data = data;
    state.lastUpdatedAt = new Date();

    elements.statTotal.textContent = summary.total;
    elements.statAvailable.textContent = summary.available;
    elements.statPlayers.textContent = summary.inUse;
    elements.statLeased.textContent = summary.leased;
    elements.onlineWorkers.textContent = `${summary.onlineWorkers} / ${summary.workers.length}`;
    elements.totalSlots.textContent = summary.total;

    const normalPercent =
        summary.total > 0 ? Math.round((summary.normal / summary.total) * 100) : 0;
    elements.readinessPercent.textContent = `${normalPercent}%`;
    elements.readinessOrbit.style.setProperty("--readiness", `${normalPercent * 3.6}deg`);

    elements.lastUpdated.textContent = `最后同步 ${formatTime(state.lastUpdatedAt.toISOString())}`;
    elements.footerSync.textContent = `最近同步 ${formatTime(state.lastUpdatedAt.toISOString())}`;

    renderWorkers(summary);
    renderReservations(summary);
    renderSlots(summary);
    renderNotice(summary);
}

async function refreshDashboard({ silent = false, fromForm = false } = {}) {
    if (!state.apiKey || state.loading) {
        return;
    }
    state.loading = true;
    elements.refreshButton.disabled = true;
    if (!silent) {
        setConnectionState("loading", "同步中");
    }

    try {
        const data = await fetchSlots();
        hideAuth();
        renderDashboard(data);
        setConnectionState("online", "实时在线");
    } catch (error) {
        if (error.code === 401) {
            sessionStorage.removeItem(API_KEY_STORAGE);
            state.apiKey = "";
            showAuth("API Key 无效，请重新输入。");
            setConnectionState("error", "认证失败");
            return;
        }
        const message =
            error.name === "AbortError"
                ? "刷新超时：Worker 状态查询时间过长"
                : `刷新失败：${error.message}`;
        setConnectionState("error", "连接异常");
        if (fromForm) {
            showAuth(message);
        } else {
            hideAuth();
        }
        if (!silent && !fromForm) {
            showToast(message);
        }
    } finally {
        state.loading = false;
        elements.refreshButton.disabled = false;
    }
}

function scheduleRefresh() {
    window.clearInterval(refreshTimer);
    refreshTimer = window.setInterval(() => {
        if (elements.autoRefresh.checked && document.visibilityState === "visible") {
            void refreshDashboard({ silent: true });
        }
    }, REFRESH_INTERVAL_MS);
}

elements.authForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const apiKey = elements.apiKey.value.trim();
    if (!apiKey) {
        elements.authError.textContent = "请输入 Client API Key。";
        return;
    }
    state.apiKey = apiKey;
    elements.authError.textContent = "";
    await refreshDashboard({ fromForm: true });
    if (elements.authLayer.classList.contains("hidden")) {
        sessionStorage.setItem(API_KEY_STORAGE, apiKey);
        elements.apiKey.value = "";
    }
});

elements.revealKey.addEventListener("click", () => {
    const showing = elements.apiKey.type === "text";
    elements.apiKey.type = showing ? "password" : "text";
    elements.revealKey.setAttribute("aria-label", showing ? "显示密钥" : "隐藏密钥");
});

elements.refreshButton.addEventListener("click", () => void refreshDashboard());

elements.lockButton.addEventListener("click", () => {
    sessionStorage.removeItem(API_KEY_STORAGE);
    state.apiKey = "";
    state.data = null;
    showAuth();
    setConnectionState("loading", "已锁定");
});

elements.statusFilters.addEventListener("click", (event) => {
    const button = event.target.closest("[data-status]");
    if (!button) {
        return;
    }
    state.slotStatus = button.dataset.status;
    for (const item of elements.statusFilters.querySelectorAll("[data-status]")) {
        item.classList.toggle("active", item === button);
    }
    if (state.data) {
        renderSlots(calculateSummary(state.data));
    }
});

elements.reservedList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-release-worker]");
    if (button) {
        void releaseReservation(button);
    }
});

elements.workerFilter.addEventListener("change", () => {
    state.workerId = elements.workerFilter.value;
    if (state.data) {
        renderSlots(calculateSummary(state.data));
    }
});

elements.slotSearch.addEventListener("input", () => {
    state.search = elements.slotSearch.value.trim().toLowerCase();
    if (state.data) {
        renderSlots(calculateSummary(state.data));
    }
});

elements.autoRefresh.addEventListener("change", scheduleRefresh);

document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && elements.autoRefresh.checked) {
        void refreshDashboard({ silent: true });
    }
});

window.setInterval(() => {
    elements.clock.textContent = new Intl.DateTimeFormat("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false
    }).format(new Date());
    updateReservationCountdowns();
}, 1000);

scheduleRefresh();

if (state.apiKey) {
    showBoot("正在验证已保存的会话...");
    void refreshDashboard({ silent: true });
} else {
    showAuth();
}
