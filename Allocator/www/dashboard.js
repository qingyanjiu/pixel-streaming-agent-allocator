"use strict";

const API_KEY_STORAGE = "pixel-dashboard-api-key";
const REFRESH_INTERVAL_MS = 3000;
const REQUEST_TIMEOUT_MS = 20000;

const elements = {
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
    totalCapacity: document.getElementById("totalCapacity"),
    readinessOrbit: document.getElementById("readinessOrbit"),
    readinessPercent: document.getElementById("readinessPercent"),
    statTotal: document.getElementById("statTotal"),
    statReady: document.getElementById("statReady"),
    statUnready: document.getElementById("statUnready"),
    statAvailable: document.getElementById("statAvailable"),
    statPlayers: document.getElementById("statPlayers"),
    statLeased: document.getElementById("statLeased"),
    noticeBanner: document.getElementById("noticeBanner"),
    workerSummary: document.getElementById("workerSummary"),
    workerRows: document.getElementById("workerRows"),
    workerEmpty: document.getElementById("workerEmpty"),
    distributionList: document.getElementById("distributionList"),
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

function truncateMiddle(value, visible = 12) {
    const text = String(value ?? "");
    if (text.length <= visible) {
        return text;
    }
    const side = Math.max(4, Math.floor((visible - 1) / 2));
    return `${text.slice(0, side)}…${text.slice(-side)}`;
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
        ready: "就绪",
        busy: "占用",
        leased: "预留",
        starting: "启动中",
        stopping: "停止中",
        stopped: "已停止",
        failed: "异常"
    }[status] || status;
}

function statusClass(status) {
    if (["ready", "busy"].includes(status)) {
        return status === "ready" ? "status-ready" : "status-busy";
    }
    if (status === "leased") {
        return "status-leased";
    }
    if (status === "starting" || status === "stopping") {
        return `status-${status}`;
    }
    if (status === "failed") {
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

function showToast(message) {
    window.clearTimeout(toastTimer);
    elements.toast.textContent = message;
    elements.toast.classList.remove("hidden");
    toastTimer = window.setTimeout(() => elements.toast.classList.add("hidden"), 5000);
}

function showAuth(message = "") {
    elements.authLayer.classList.remove("hidden");
    elements.appShell.setAttribute("aria-hidden", "true");
    elements.authError.textContent = message;
    elements.apiKey.focus();
}

function hideAuth() {
    elements.authLayer.classList.add("hidden");
    elements.appShell.setAttribute("aria-hidden", "false");
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
    }
}

function calculateSummary(data) {
    const slots = data.slots || [];
    const workers = data.workers || [];
    const ready = slots.filter((slot) => slot.ready).length;
    const available = slots.filter(
        (slot) => slot.ready && Number(slot.playerCount) === 0 && !slot.leasedTo
    ).length;
    const leased = slots.filter((slot) => Boolean(slot.leasedTo)).length;
    const players = slots.reduce((sum, slot) => sum + (Number(slot.playerCount) || 0), 0);
    const capacity = slots.reduce((sum, slot) => sum + (Number(slot.capacity) || 0), 0);
    return {
        slots,
        workers,
        total: slots.length,
        ready,
        unready: slots.length - ready,
        available,
        leased,
        players,
        capacity,
        onlineWorkers: workers.filter((worker) => worker.online).length,
        failedWorkers: workers.filter((worker) => !worker.online).length
    };
}

function renderWorkers(summary) {
    state.workerById = new Map(summary.workers.map((worker) => [worker.id, worker]));
    elements.workerSummary.textContent = `${summary.workers.length} 个节点`;
    elements.workerRows.innerHTML = "";

    for (const worker of summary.workers) {
        const workerSlots = summary.slots.filter((slot) => slot.workerId === worker.id);
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
            <td><span class="mono">${workerSlots.filter((slot) => slot.ready).length} / ${workerSlots.length}</span></td>
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

function renderDistribution(summary) {
    const counts = {
        ready: 0,
        busy: 0,
        leased: 0,
        starting: 0,
        stopped: 0,
        failed: 0
    };
    for (const slot of summary.slots) {
        const status = normalizedStatus(slot);
        if (status === "busy") {
            counts.busy += 1;
        } else if (status === "leased") {
            counts.leased += 1;
        } else if (status === "ready") {
            counts.ready += 1;
        } else if (status === "starting" || status === "stopping") {
            counts.starting += 1;
        } else if (status === "failed") {
            counts.failed += 1;
        } else {
            counts.stopped += 1;
        }
    }

    const rows = [
        ["就绪", counts.ready, "var(--green)"],
        ["占用", counts.busy, "var(--violet)"],
        ["预留", counts.leased, "var(--amber)"],
        ["启动/切换", counts.starting, "var(--blue)"],
        ["停止", counts.stopped, "#8295a7"],
        ["异常", counts.failed, "var(--red)"]
    ];

    elements.distributionList.innerHTML = rows
        .map(([label, count, color]) => {
            const percent = summary.total > 0 ? Math.round((count / summary.total) * 100) : 0;
            return `
                <div class="distribution-row">
                    <span class="distribution-label">${label}</span>
                    <span class="distribution-track">
                        <span class="distribution-fill" style="width: ${percent}%; --bar-color: ${color}"></span>
                    </span>
                    <span class="distribution-value">${count}</span>
                </div>
            `;
        })
        .join("");
}

function slotMatches(slot) {
    const status = normalizedStatus(slot);
    if (state.slotStatus === "ready" && status !== "ready") {
        return false;
    }
    if (state.slotStatus === "busy" && status !== "busy") {
        return false;
    }
    if (state.slotStatus === "stopped" && !["stopped", "leased"].includes(status)) {
        return false;
    }
    if (state.slotStatus === "failed" && status !== "failed") {
        return false;
    }
    if (state.workerId !== "all" && slot.workerId !== state.workerId) {
        return false;
    }
    if (state.search) {
        const haystack = [
            slot.id,
            slot.workerId,
            slot.publicUrl,
            slot.leasedTo,
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

function renderSlots(summary) {
    const slots = summary.slots.filter(slotMatches);
    elements.slotRows.innerHTML = "";

    for (const slot of slots) {
        const status = normalizedStatus(slot);
        const ports = [
            `S ${slot.ports?.streamer ?? "—"}`,
            `P ${slot.ports?.player ?? "—"}`,
            `F ${slot.ports?.sfu ?? "—"}`
        ].join(" · ");
        const pids = [
            slot.pids?.ue ? `UE ${slot.pids.ue}` : null,
            slot.pids?.wilbur ? `W ${slot.pids.wilbur}` : null
        ]
            .filter(Boolean)
            .join(" / ");
        const sessionValue = slot.leasedTo
            ? `<span class="mono" title="${escapeHtml(slot.leasedTo)}">${escapeHtml(truncateMiddle(slot.leasedTo, 16))}</span>`
            : '<span class="muted">—</span>';
        const urlValue = slot.publicUrl
            ? `<a class="url-link mono" href="${escapeHtml(slot.publicUrl)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(slot.publicUrl)}">${escapeHtml(slot.publicUrl)}</a>`
            : '<span class="muted">—</span>';

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
            <td><span class="mono">${escapeHtml(ports)}</span></td>
            <td>${urlValue}</td>
            <td><span class="mono">${escapeHtml(pids || "—")}</span></td>
            <td>${sessionValue}</td>
            <td class="error-cell" title="${escapeHtml(slot.lastError || "")}">${escapeHtml(slot.lastError || "—")}</td>
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
    elements.statReady.textContent = summary.ready;
    elements.statUnready.textContent = summary.unready;
    elements.statAvailable.textContent = summary.available;
    elements.statPlayers.textContent = summary.players;
    elements.statLeased.textContent = summary.leased;
    elements.onlineWorkers.textContent = `${summary.onlineWorkers} / ${summary.workers.length}`;
    elements.totalCapacity.textContent = summary.capacity;

    const readiness = summary.total > 0 ? Math.round((summary.ready / summary.total) * 100) : 0;
    elements.readinessPercent.textContent = `${readiness}%`;
    elements.readinessOrbit.style.setProperty("--readiness", `${readiness * 3.6}deg`);

    elements.lastUpdated.textContent = `最后同步 ${formatTime(state.lastUpdatedAt.toISOString())}`;
    elements.footerSync.textContent = `最近同步 ${formatTime(state.lastUpdatedAt.toISOString())}`;

    renderWorkers(summary);
    renderDistribution(summary);
    renderSlots(summary);
    renderNotice(summary);
}

async function refreshDashboard({ silent = false } = {}) {
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
        if (!silent) {
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
    await refreshDashboard();
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
}, 1000);

scheduleRefresh();

if (state.apiKey) {
    void refreshDashboard();
} else {
    showAuth();
}
