// Generate unique worker ID for this tab
const workerId = 'worker_' + Math.random().toString(36).substr(2, 9);

// Socket.IO connection
const socket = io();

// State
let tables = { basic: [], opd: [], ipd: [] };
let tableStatuses = {}; // Track transfer status per table
let currentType = 'basic';
let allWorkerStatuses = {};
let transferStartTime = null;
let lastCheckTime = 0; // Prevent worker sync after check

// Batch pagination config
const TABLES_PER_BATCH = 1000;
let currentBatch = 'all'; // 'all', '1', '2', '3', etc.
let allTablesCache = {}; // Cache all tables before pagination

// DOM Elements
const elements = {
  workerId: document.getElementById('worker-id'),
  pgStatus: document.getElementById('pg-status'),
  mysqlStatus: document.getElementById('mysql-status'),
  btnTransfer: document.getElementById('btn-transfer'),
  btnRefresh: document.getElementById('btn-refresh'),
  btnCheck: document.getElementById('btn-check'),
  btnSettings: document.getElementById('btn-settings'),
  btnScheduler: document.getElementById('btn-scheduler'),
  selectAll: document.getElementById('select-all'),
  selectedCount: document.getElementById('selected-count'),
  tableCount: document.getElementById('table-count'),
  tableList: document.getElementById('table-list'),
  logsContainer: document.getElementById('logs-container'),
  progressSection: document.getElementById('progress-section'),
  progressFill: document.getElementById('progress-fill'),
  progressTable: document.getElementById('progress-table'),
  btnCancelTransfer: document.getElementById('btn-cancel-transfer'),
  
  // Telegram Elements
  telegramEnabled: document.getElementById('telegram-enabled'),
  telegramBotToken: document.getElementById('telegram-bot-token'),
  telegramChatId: document.getElementById('telegram-chat-id'),
  btnTestTelegram: document.getElementById('btn-test-telegram'),
  telegramTestResult: document.getElementById('telegram-test-result'),
  btnSaveTelegram: document.getElementById('btn-save-telegram'),

  startTime: document.getElementById('start-time'),
  endTime: document.getElementById('end-time'),
  // Filters
  batchSelect: document.getElementById('batch-select'),
  batchRange: document.getElementById('batch-range'),
  vnFilter: document.getElementById('vn-filter'),
  anFilter: document.getElementById('an-filter'),
  vnStart: document.getElementById('vn-start'),
  vnEnd: document.getElementById('vn-end'),
  anStart: document.getElementById('an-start'),
  anEnd: document.getElementById('an-end'),
  // Modal elements
  settingsModal: document.getElementById('settings-modal'),
  settingsModalClose: document.getElementById('settings-modal-close'),
  btnSaveDbConfig: document.getElementById('btn-save-db-config'),
  btnSaveSchedulerConfig: document.getElementById('btn-save-scheduler-config'),
  btnTestPg: document.getElementById('btn-test-pg'),
  btnTestMysql: document.getElementById('btn-test-mysql'),
  pgTestResult: document.getElementById('pg-test-result'),
  mysqlTestResult: document.getElementById('mysql-test-result'),
  // DB Config inputs
  pgHost: document.getElementById('pg-host'),
  pgPort: document.getElementById('pg-port'),
  pgDatabase: document.getElementById('pg-database'),
  pgUser: document.getElementById('pg-user'),
  pgPassword: document.getElementById('pg-password'),
  mysqlHost: document.getElementById('mysql-host'),
  mysqlPort: document.getElementById('mysql-port'),
  mysqlDatabase: document.getElementById('mysql-database'),
  mysqlUser: document.getElementById('mysql-user'),
  mysqlPassword: document.getElementById('mysql-password'),
  // Toast & Confirm
  toastContainer: document.getElementById('toast-container'),
  confirmDialog: document.getElementById('confirm-dialog'),
  confirmTitle: document.getElementById('confirm-title'),
  confirmMessage: document.getElementById('confirm-message'),
  confirmOk: document.getElementById('confirm-ok'),
  confirmCancel: document.getElementById('confirm-cancel'),
};

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  
  // Disable first tab (currently active)
  const firstTab = document.querySelector('.tab-btn[data-tab="basic"]');
  if (firstTab) {
    firstTab.classList.add('pointer-events-none');
    firstTab.disabled = true;
  }
  
  // Check URL parameters for batch and type
  const urlParams = new URLSearchParams(window.location.search);
  const urlBatch = urlParams.get('batch');
  const urlType = urlParams.get('type');
  
  if (urlType && ['basic', 'opd', 'ipd'].includes(urlType)) {
    currentType = urlType;
    // Update tab UI
    document.querySelectorAll('.tab-btn').forEach(b => {
      b.classList.remove('active', 'pointer-events-none');
      b.disabled = false;
    });
    const activeTab = document.querySelector(`.tab-btn[data-tab="${urlType}"]`);
    if (activeTab) {
      activeTab.classList.add('active', 'pointer-events-none');
      activeTab.disabled = true;
    }
  }
  
  if (urlBatch && urlBatch !== 'all') {
    currentBatch = urlBatch;
  }
  
  checkHealth();
  loadTables();
  loadLogs();
  loadDbConfig();
  loadTelegramConfig(); // Load Telegram config on startup
  setupEventListeners();
  updateFilters();
  
  // Start smart polling instead of dumb intervals
  startSmartPolling();
});

// Dynamic polling logic to save network requests when idle
let pollTimeoutId = null;
let isWorkerActive = false;

async function startSmartPolling() {
  if (pollTimeoutId) clearTimeout(pollTimeoutId);
  
  await pollWorkerStatuses();
  // loadLogs is now called inside pollWorkerStatuses when logs change
  
  // If active transfer, poll every 1 second. Otherwise, poll every 5 seconds.
  const pollInterval = isWorkerActive ? 1000 : 5000;
  pollTimeoutId = setTimeout(startSmartPolling, pollInterval);
}

// Socket events
socket.on('status', (statuses) => {
  allWorkerStatuses = statuses;
  
  const myStatus = allWorkerStatuses[workerId];
  if (myStatus) {
    isWorkerActive = myStatus.isRunning;
  }
  
  updateMyProgress();
  renderLogs();
});

// Event Listeners
function setupEventListeners() {
  elements.btnTransfer.addEventListener('click', () => {
    const selectedTables = getSelectedTables();
    if (selectedTables.length === 0) {
      showToast('กรุณาเลือกตารางที่ต้องการโอนข้อมูล', 'warning');
      return;
    }
    
    showConfirm(
      'ยืนยันการเริ่มโอนข้อมูล',
      `คุณต้องการเริ่มโอนข้อมูลทั้งสิ้น ${selectedTables.length} ตาราง ใช่หรือไม่?`,
      () => startTransfer()
    );
  });
  elements.btnRefresh.addEventListener('click', () => {
    refreshTables();
    showToast('กำลังโหลดข้อมูลตารางใหม่', 'info');
  });
  elements.btnCheck.addEventListener('click', checkTables);
  
  // Settings Modal & Tabs
  elements.btnSettings.addEventListener('click', () => openSettingsModal('db'));
  elements.btnScheduler.addEventListener('click', () => openSettingsModal('scheduler'));
  elements.settingsModalClose.addEventListener('click', closeSettingsModal);
  
  // Tab switching inside Settings
  document.querySelectorAll('.settings-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      const tabName = btn.dataset.tab;
      
      // Update sidebar buttons
      document.querySelectorAll('.settings-tab-btn').forEach(b => {
        b.classList.remove('active', 'bg-slate-200');
        b.classList.add('text-slate-600');
      });
      btn.classList.add('active', 'bg-slate-200');
      btn.classList.remove('text-slate-600');
      
      // Show corresponding content pane
      document.querySelectorAll('.settings-pane').forEach(pane => {
        pane.classList.add('hidden');
        pane.classList.remove('block');
      });
      document.getElementById(`settings-tab-${tabName}`).classList.remove('hidden');
      document.getElementById(`settings-tab-${tabName}`).classList.add('block');
    });
  });

  elements.btnSaveDbConfig.addEventListener('click', saveDbConfig);
  elements.btnSaveSchedulerConfig.addEventListener('click', saveSchedulerConfig);
  elements.btnTestPg.addEventListener('click', testPostgres);
  elements.btnTestMysql.addEventListener('click', testMysql);
  
  // Telegram Events
  if (elements.btnTestTelegram) {
    elements.btnTestTelegram.addEventListener('click', testTelegram);
  }
  if (elements.btnSaveTelegram) {
    elements.btnSaveTelegram.addEventListener('click', saveTelegramConfig);
  }
  
  // Tab buttons
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      // Skip if already on this tab
      if (btn.dataset.tab === currentType) return;
      
      document.querySelectorAll('.tab-btn').forEach(b => {
        b.classList.remove('active', 'pointer-events-none');
        b.disabled = false;
      });
      btn.classList.add('active', 'pointer-events-none');
      btn.disabled = true;
      
      currentType = btn.dataset.tab;
      updateFilters();
      await loadTables();
    });
  });
  
  // Select All checkbox
  elements.selectAll.addEventListener('change', () => {
    const checkboxes = document.querySelectorAll('.table-checkbox');
    checkboxes.forEach(cb => cb.checked = elements.selectAll.checked);
    updateSelectedCount();
  });
  
  // Batch selector
  elements.batchSelect.addEventListener('change', () => {
    const selectedBatch = elements.batchSelect.value;
    
    // If selecting numbered batch (not 'all'), open in new tab
    if (selectedBatch !== 'all' && selectedBatch !== currentBatch) {
      const url = new URL(window.location.href);
      url.searchParams.set('batch', selectedBatch);
      url.searchParams.set('type', currentType);
      window.open(url.toString(), '_blank');
      // Reset dropdown to current value
      elements.batchSelect.value = currentBatch;
    } else {
      currentBatch = selectedBatch;
      applyBatchFilter();
    }
  });
}

function updateFilters() {
  elements.vnFilter.classList.add('hidden');
  elements.anFilter.classList.add('hidden');
  
  // Hide batch selector for OPD/IPD (only show for Basic)
  const batchFilter = document.getElementById('batch-filter');
  if (currentType === 'basic') {
    batchFilter.classList.remove('hidden');
  } else {
    batchFilter.classList.add('hidden');
  }
  
  // Get current date for default values
  const now = new Date();
  const buddhistYear = now.getFullYear() + 543; // Convert to Buddhist year
  const yearShort = String(buddhistYear).slice(-2); // Last 2 digits (e.g., 68)
  const month = String(now.getMonth() + 1).padStart(2, '0'); // 01-12
  const vnDefault = yearShort + month; // e.g., 6812
  const anDefault = yearShort; // e.g., 68
  
  if (currentType === 'opd') {
    elements.vnFilter.classList.remove('hidden');
    // Set default VN values if empty
    if (!elements.vnStart.value) elements.vnStart.value = vnDefault;
    if (!elements.vnEnd.value) elements.vnEnd.value = vnDefault;
  } else if (currentType === 'ipd') {
    elements.anFilter.classList.remove('hidden');
    // Set default AN values if empty
    if (!elements.anStart.value) elements.anStart.value = anDefault;
    if (!elements.anEnd.value) elements.anEnd.value = anDefault;
  }
}

// Batch Pagination Functions
function updateBatchSelector() {
  const allTables = allTablesCache[currentType] || [];
  const totalTables = allTables.length;
  const totalBatches = Math.ceil(totalTables / TABLES_PER_BATCH);
  
  // Clear existing options
  const allOption = document.createElement('option');
  allOption.value = 'all';
  allOption.textContent = 'ทั้งหมด';
  allOption.disabled = currentBatch === 'all';
  elements.batchSelect.innerHTML = '';
  elements.batchSelect.appendChild(allOption);
  
  // Add batch options
  for (let i = 1; i <= totalBatches; i++) {
    const start = (i - 1) * TABLES_PER_BATCH + 1;
    const end = Math.min(i * TABLES_PER_BATCH, totalTables);
    const option = document.createElement('option');
    option.value = String(i);
    option.textContent = `ชุด ${i} (${start}-${end})`;
    option.disabled = currentBatch === String(i);
    elements.batchSelect.appendChild(option);
  }
  
  // Update range display
  if (totalBatches > 1) {
    elements.batchRange.textContent = `(${totalTables.toLocaleString()} ตารางทั้งหมด)`;
  } else {
    elements.batchRange.textContent = '';
  }
  
  // Set dropdown to current batch (from URL or default)
  // Only reset to 'all' if this is a tab change (not initial load or URL param)
  const urlParams = new URLSearchParams(window.location.search);
  const urlBatch = urlParams.get('batch');
  if (urlBatch && urlBatch === currentBatch && parseInt(urlBatch) <= totalBatches) {
    elements.batchSelect.value = urlBatch;
  } else if (!urlBatch) {
    currentBatch = 'all';
    elements.batchSelect.value = 'all';
  }
}

function applyBatchFilter() {
  const allTables = allTablesCache[currentType] || [];
  
  if (currentBatch === 'all') {
    tables[currentType] = allTables;
  } else {
    const batchNum = parseInt(currentBatch);
    const start = (batchNum - 1) * TABLES_PER_BATCH;
    const end = start + TABLES_PER_BATCH;
    tables[currentType] = allTables.slice(start, end);
  }
  
  // Update range display
  const displayedTables = tables[currentType];
  if (displayedTables.length > 0 && currentBatch !== 'all') {
    const batchNum = parseInt(currentBatch);
    const globalStart = (batchNum - 1) * TABLES_PER_BATCH + 1;
    elements.batchRange.textContent = `(แสดง ${displayedTables.length.toLocaleString()} จาก ${allTablesCache[currentType].length.toLocaleString()})`;
  }
  
  renderTableList();
}

// Utility Functions for UX

function showToast(message, type = 'info', duration = 3000) {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  
  let icon = 'ℹ️';
  if (type === 'success') icon = '✅';
  if (type === 'error') icon = '❌';
  if (type === 'warning') icon = '⚠️';
  
  toast.innerHTML = `
    <span style="font-size: 1.25rem;">${icon}</span>
    <span style="flex: 1;">${escapeHtml(message)}</span>
    <button class="toast-close">&times;</button>
  `;
  
  elements.toastContainer.appendChild(toast);
  
  const closeBtn = toast.querySelector('.toast-close');
  closeBtn.addEventListener('click', () => {
    toast.style.animation = 'toast-out 0.3s ease-in forwards';
    setTimeout(() => toast.remove(), 300);
  });
  
  if (duration > 0) {
    setTimeout(() => {
      if (document.body.contains(toast)) {
        toast.style.animation = 'toast-out 0.3s ease-in forwards';
        setTimeout(() => toast.remove(), 300);
      }
    }, duration);
  }
}

function showConfirm(title, message, onConfirm) {
  elements.confirmTitle.textContent = title;
  elements.confirmMessage.textContent = message;
  elements.confirmDialog.classList.remove('hidden');
  
  const handleConfirm = () => {
    elements.confirmDialog.classList.add('hidden');
    cleanup();
    onConfirm();
  };
  
  const handleCancel = () => {
    elements.confirmDialog.classList.add('hidden');
    cleanup();
  };
  
  const handleKeydown = (e) => {
    if (e.key === 'Escape') handleCancel();
    if (e.key === 'Enter') handleConfirm();
  };
  
  const cleanup = () => {
    elements.confirmOk.removeEventListener('click', handleConfirm);
    elements.confirmCancel.removeEventListener('click', handleCancel);
    document.removeEventListener('keydown', handleKeydown);
  };
  
  elements.confirmOk.addEventListener('click', handleConfirm);
  elements.confirmCancel.addEventListener('click', handleCancel);
  document.addEventListener('keydown', handleKeydown);
  
  // Focus OK button for keyboard accessibility
  setTimeout(() => elements.confirmOk.focus(), 50);
}

// API Functions
async function checkHealth() {
  try {
    const res = await fetch('/api/health');
    const data = await res.json();
    
    // Update PG status
    if (data.postgres === 'connected') {
      elements.pgStatus.innerHTML = `<span class="status-dot status-dot-connected"></span> Source: <span class="font-mono text-green-300">Connected</span>`;
      // Only show toast on first load or reconnect
      if (elements.pgStatus.dataset.status !== 'connected') {
        showToast('เชื่อมต่อ PostgreSQL สำเร็จ', 'success', 1500);
        elements.pgStatus.dataset.status = 'connected';
      }
    } else {
      elements.pgStatus.innerHTML = `<span class="status-dot status-dot-error"></span> Source: <span class="font-mono text-red-300">Disconnected</span>`;
      if (elements.pgStatus.dataset.status !== 'error') {
        showToast('ไม่สามารถเชื่อมต่อ PostgreSQL ได้', 'error');
        elements.pgStatus.dataset.status = 'error';
      }
    }
    
    // Update MySQL status
    if (data.mysql === 'connected') {
      elements.mysqlStatus.innerHTML = `<span class="status-dot status-dot-connected"></span> Destination: <span class="font-mono text-green-300">Connected</span>`;
      if (elements.mysqlStatus.dataset.status !== 'connected') {
        showToast('เชื่อมต่อ MySQL สำเร็จ', 'success', 1500);
        elements.mysqlStatus.dataset.status = 'connected';
      }
    } else {
      elements.mysqlStatus.innerHTML = `<span class="status-dot status-dot-error"></span> Destination: <span class="font-mono text-red-300">Disconnected</span>`;
      if (elements.mysqlStatus.dataset.status !== 'error') {
        showToast('ไม่สามารถเชื่อมต่อ MySQL ได้', 'error');
        elements.mysqlStatus.dataset.status = 'error';
      }
    }
  } catch (error) {
    console.error('Health check error:', error);
    elements.pgStatus.innerHTML = `<span class="status-dot status-dot-error"></span> Source: <span class="font-mono text-red-300">Error</span>`;
    elements.mysqlStatus.innerHTML = `<span class="status-dot status-dot-error"></span> Destination: <span class="font-mono text-red-300">Error</span>`;
    
    if (elements.pgStatus.dataset.status !== 'error') {
      showToast('เกิดข้อผิดพลาดในการตรวจสอบสถานะฐานข้อมูล', 'error');
      elements.pgStatus.dataset.status = 'error';
      elements.mysqlStatus.dataset.status = 'error';
    }
  }
}

async function loadTables() {
  try {
    elements.tableList.innerHTML = '<p class="text-center py-8 text-slate-400">Loading tables...</p>';
    const res = await fetch('/api/tables/classified');
    const data = await res.json();
    
    // Cache all tables
    allTablesCache = data;
    
    // Update batch selector options
    updateBatchSelector();
    
    // Apply current batch filter
    applyBatchFilter();
  } catch (error) {
    console.error('Failed to load tables:', error);
    elements.tableList.innerHTML = '<p class="text-center py-8 text-red-500">Error loading tables</p>';
    showToast('ไม่สามารถโหลดรายการตารางได้', 'error');
  }
}

async function loadLogs() {
  try {
    const res = await fetch('/api/logs');
    const logs = await res.json();
    
    if (logs.length === 0) {
      elements.logsContainer.innerHTML = '<p class="text-slate-400">No logs yet</p>';
      return;
    }
    
    // Reverse to show oldest at top, newest at bottom
    const reversedLogs = [...logs].reverse();
    elements.logsContainer.innerHTML = reversedLogs.slice(-100).map(log => {
      const levelColor = log.level === 'error' ? 'text-red-400' : log.level === 'warn' ? 'text-orange-400' : 'text-green-400';
      return `<div class="log-line ${levelColor}">${escapeHtml(log.message)}</div>`;
    }).join('');
    
    // Auto-scroll to bottom
    elements.logsContainer.scrollTop = elements.logsContainer.scrollHeight;
  } catch (error) {
    console.error('Failed to load logs:', error);
  }
}

async function loadDbConfig() {
  try {
    const res = await fetch('/api/config/database');
    const config = await res.json();
    
    elements.pgHost.value = config.postgres?.host || '';
    elements.pgPort.value = config.postgres?.port || 5432;
    elements.pgDatabase.value = config.postgres?.database || '';
    elements.pgUser.value = config.postgres?.user || '';
    elements.pgPassword.value = config.postgres?.password || '';
    
    elements.mysqlHost.value = config.mysql?.host || '';
    elements.mysqlPort.value = config.mysql?.port || 3306;
    elements.mysqlDatabase.value = config.mysql?.database || '';
    elements.mysqlUser.value = config.mysql?.user || '';
    elements.mysqlPassword.value = config.mysql?.password || '';
  } catch (error) {
    console.error('Failed to load db config:', error);
  }
}

let activeLogFilter = 'all';

function setLogFilter(filter) {
  activeLogFilter = filter;
  
  const btnAll = document.getElementById('btn-filter-all');
  const btnError = document.getElementById('btn-filter-error');
  const btnSuccess = document.getElementById('btn-filter-success');
  const btnProgress = document.getElementById('btn-filter-progress');
  
  // Reset all to inactive state
  [btnAll, btnError, btnSuccess, btnProgress].forEach(btn => {
    if (!btn) return;
    btn.className = 'badge cursor-pointer hover:bg-slate-200 text-slate-500';
    btn.style.background = 'transparent';
    btn.style.border = '1px solid #e2e8f0';
  });
  
  if (filter === 'all') {
    btnAll.className = 'badge badge-neutral cursor-pointer hover:bg-slate-200';
    btnAll.style.border = 'none';
  } else if (filter === 'error') {
    btnError.className = 'badge cursor-pointer hover:bg-red-100 bg-red-50 text-red-600 border border-red-200';
  } else if (filter === 'success') {
    btnSuccess.className = 'badge cursor-pointer hover:bg-green-100 bg-green-50 text-green-600 border border-green-200';
  } else if (filter === 'progress') {
    btnProgress.className = 'badge cursor-pointer hover:bg-blue-100 bg-blue-50 text-blue-600 border border-blue-200';
  }
  
  renderLogs();
}

function clearLogs() {
  if (allWorkerStatuses[workerId]) {
    allWorkerStatuses[workerId].transferLogs = [];
  }
  renderLogs();
}

async function pollWorkerStatuses() {
  try {
    const res = await fetch('/api/transfer/status');
    allWorkerStatuses = await res.json();
    
    const myStatus = allWorkerStatuses[workerId];
    // Update global state
    isWorkerActive = myStatus ? myStatus.isRunning : false;
    
    updateMyProgress();
    renderLogs(); // Update logs whenever status is fetched
  } catch (error) {
    console.warn('Failed to poll worker statuses:', error);
  }
}

let lastRenderedLogsHtml = '';

function renderLogs() {
  const container = elements.logsContainer;
  
  const status = allWorkerStatuses[workerId];
  const allLogs = status ? status.transferLogs : [];

  if (!allLogs || allLogs.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">📋</div>
        <div class="empty-state-text">รอรับ log จากระบบ...</div>
        <div style="font-size: 0.75rem; color: #94a3b8;">เริ่ม transfer เพื่อดู log แบบ real-time</div>
      </div>
    `;
    lastRenderedLogsHtml = container.innerHTML;
    return;
  }
  
  let logsToRender = status.transferLogs;
  
  // Filter logs
  if (activeLogFilter === 'error') {
    logsToRender = logsToRender.filter(log => log.type === 'error' || log.type === 'warning');
  } else if (activeLogFilter === 'success') {
    logsToRender = logsToRender.filter(log => log.type === 'success');
  } else if (activeLogFilter === 'progress') {
    logsToRender = logsToRender.filter(log => log.type === 'progress');
  }
  
  // Group duplicate logs (only sequential duplicates for same table/type)
  const groupedLogs = [];
  for (let rawLog of logsToRender) {
    // Handle old string logs gracefully
    const log = typeof rawLog === 'string' ? { time: '', type: 'info', message: rawLog } : rawLog;
    
    const last = groupedLogs[groupedLogs.length - 1];
    
    // Group logic: Only if it's the SAME type, SAME table, and NOT a progress log
    if (last && last.type === log.type && last.table === log.table && log.type !== 'progress' && last.message === log.message) {
      last.count = (last.count || 1) + 1;
    } else {
      groupedLogs.push({ ...log, count: 1 });
    }
  }
  
  const html = groupedLogs.map(log => {
    // Determine styles based on type
    let colorClass, iconClass, iconName;
    
    switch (log.type) {
      case 'success':
        colorClass = 'text-green-600';
        iconName = 'check-circle-2';
        iconClass = 'text-green-500';
        break;
      case 'error':
        colorClass = 'text-red-600';
        iconName = 'x-circle';
        iconClass = 'text-red-500';
        break;
      case 'warning':
        colorClass = 'text-amber-600';
        iconName = 'alert-triangle';
        iconClass = 'text-amber-500';
        break;
      case 'progress':
        colorClass = 'text-blue-600';
        iconName = 'refresh-cw';
        iconClass = 'text-blue-500 animate-spin';
        break;
      default: // info
        colorClass = 'text-slate-600';
        iconName = 'info';
        iconClass = 'text-slate-400';
    }
    
    // Badge for grouped count
    const countBadge = log.count > 1 
      ? `<span class="ml-2 inline-flex items-center px-1.5 py-0.5 rounded-full text-[0.65rem] font-medium bg-slate-100 text-slate-500 border border-slate-200">x${log.count}</span>` 
      : '';
      
    // Mini progress bar inline if rows exist AND type is progress
    let progressHtml = '';
    if (log.type === 'progress' && log.rows && log.rows.total > 0) {
      const percentage = Math.min(100, Math.round((log.rows.current / log.rows.total) * 100));
      progressHtml = `
        <div class="inline-flex items-center gap-2 ml-2 min-w-[150px]">
          <div class="flex-1 bg-slate-200 rounded-sm h-2 overflow-hidden border border-slate-300">
            <div class="bg-blue-500 h-2" style="width: ${percentage}%"></div>
          </div>
          <span class="text-[0.7rem] text-slate-600 font-mono">${percentage}% (${log.rows.current.toLocaleString()}/${log.rows.total.toLocaleString()})</span>
        </div>
      `;
    }
    
    // Table prefix if present
    const tablePrefix = log.table 
      ? `<span class="font-semibold text-slate-700 mr-1">${log.table}:</span>` 
      : '';
      
    const messageText = log.message || '';
      
    // Time format (HH:mm:ss only)
    let timeStr = log.time || '';
    if (timeStr && timeStr.includes(' ')) {
      // If time string has date (e.g. 25/02/2026 14:52:01), extract just the time
      timeStr = timeStr.split(' ')[1] || timeStr;
    }
    
    // For summary logs (contain 📋), render as a special block
    if (messageText.includes('📋')) {
      return `
        <div class="my-3 font-mono text-[0.8rem] text-slate-700 bg-slate-50 p-3 rounded border border-slate-200 shadow-sm leading-relaxed whitespace-pre-line">
          ${escapeHtml(messageText)}
        </div>
      `;
    }
      
    // Format message string for progress vs regular
    let contentHtml = '';
    if (log.type === 'progress') {
       contentHtml = `<span class="${colorClass}">${tablePrefix} </span> ${progressHtml}`;
    } else {
       contentHtml = `<span class="${colorClass}">${tablePrefix} ${escapeHtml(messageText)}</span> ${progressHtml}`;
    }

    return `
      <div class="flex gap-2 py-1 items-start text-[0.8rem] border-b border-slate-50 last:border-0 hover:bg-slate-50 transition-colors">
        <div class="mt-0.5"><i data-lucide="${iconName}" class="w-3.5 h-3.5 ${iconClass}"></i></div>
        <div class="flex-1 min-w-0">
          <div class="flex items-center flex-wrap">
            <span class="text-[0.7rem] text-slate-400 font-mono mr-2 shrink-0">${timeStr}</span>
            ${contentHtml}
            ${countBadge}
          </div>
        </div>
      </div>
    `;
  }).join('');
  
  if (lastRenderedLogsHtml !== html) {
    lastRenderedLogsHtml = html;
    container.innerHTML = html;
    
    // Auto-scroll to top (or bottom depending on your sorting)
    // container.scrollTop = 0; 

    // Create icons for new HTML
    if (window.lucide) {
      window.lucide.createIcons();
    }
  }
}

async function refreshTables() {
  elements.btnRefresh.disabled = true;
  elements.btnRefresh.textContent = 'Loading...';
  
  try {
    await fetch('/api/tables/refresh', { method: 'POST' });
    await loadTables();
    await checkHealth();
    showToast('โหลดข้อมูลตารางใหม่สำเร็จ', 'success');
  } catch (error) {
    console.error('Failed to refresh:', error);
    showToast('เกิดข้อผิดพลาดในการโหลดข้อมูลตารางใหม่', 'error');
  } finally {
    elements.btnRefresh.disabled = false;
    elements.btnRefresh.innerHTML = '<i data-lucide="refresh-cw" class="w-4 h-4"></i> Refresh';
    lucide.createIcons();
  }
}

async function checkTables() {
  const selectedTables = getSelectedTables();
  if (selectedTables.length === 0) {
    showToast('กรุณาเลือกตารางที่ต้องการตรวจสอบ', 'warning');
    return;
  }
  
  elements.btnCheck.classList.add('btn-loading');
  elements.btnCheck.disabled = true;
  elements.btnCheck.textContent = '☑ Checking...';
  showToast(`กำลังตรวจสอบจำนวนข้อมูล ${selectedTables.length} ตาราง...`, 'info', 2000);
  
  try {
    // Build request with VN/AN filters
    const body = {
      type: currentType,
      vnStart: elements.vnStart.value || null,
      vnEnd: elements.vnEnd.value || null,
      anStart: elements.anStart.value || null,
      anEnd: elements.anEnd.value || null,
      tableNames: selectedTables, // Only check these tables if specified
      workerId: workerId, // Reset worker status on server
    };
    
    const res = await fetch('/api/tables/check-counts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    
    const data = await res.json();
    
    if (res.ok && data.tables) {
      // User had pre-selected tables - only update those tables' row counts
      // Keep existing tables list, just update counts for checked tables
      const updatedTablesMap = new Map(data.tables.map(t => [t.name, t]));
      tables[currentType] = tables[currentType].map(t => {
        const updated = updatedTablesMap.get(t.name);
        return updated ? { ...t, rowCount: updated.rowCount } : t;
      });
      
      // Keep pre-selected tables marked as 'รอโอน' if they have data
      data.tables.forEach(table => {
        if ((table.rowCount || 0) > 0) {
          tableStatuses[table.name] = 'รอโอน';
        } else {
          // No data, remove from selection
          tableStatuses[table.name] = '-';
        }
      });
      
      // Mark check time to prevent worker sync overwriting
      lastCheckTime = Date.now();
      
      renderTableList();
      showToast('ตรวจสอบจำนวนข้อมูลสำเร็จ', 'success');
    } else {
      elements.tableList.innerHTML = '<p class="text-center py-8 text-red-500">Error: ' + (data.error || 'Failed to check') + '</p>';
      showToast('เกิดข้อผิดพลาดในการตรวจสอบข้อมูล: ' + (data.error || 'Unknown error'), 'error');
    }
  } catch (error) {
    console.error('Failed to check tables:', error);
    elements.tableList.innerHTML = '<p class="text-center py-8 text-red-500">Error: ' + error.message + '</p>';
    showToast('เกิดข้อผิดพลาดในการตรวจสอบข้อมูล: ' + error.message, 'error');
  } finally {
    elements.btnCheck.classList.remove('btn-loading');
    elements.btnCheck.disabled = false;
    elements.btnCheck.textContent = '☑ Check';
  }
}

async function startTransfer() {
  const type = currentType;
  const dryRun = false;
  
  // Get selected tables
  const selectedTables = getSelectedTables();
  
  // This check should ideally be done before calling startTransfer, but as a fallback:
  if (selectedTables.length === 0) {
    showToast('กรุณาเลือกตารางที่ต้องการถ่ายโอน', 'warning');
    return;
  }
  
  // Get VN/AN range if applicable
  let from = null, to = null;
  if (type === 'opd' && elements.vnStart.value) {
    from = elements.vnStart.value;
    to = elements.vnEnd.value;
  } else if (type === 'ipd' && elements.anStart.value) {
    from = elements.anStart.value;
    to = elements.anEnd.value;
  }
  
  elements.btnTransfer.classList.add('btn-loading');
  elements.btnTransfer.disabled = true;
  elements.progressSection.classList.remove('hidden');
  transferStartTime = new Date();
  elements.startTime.textContent = formatDateTime(transferStartTime);
  elements.endTime.textContent = '--';
  
  // Clear status of non-selected tables, mark selected tables as transferring
  const tableData = tables[currentType] || [];
  tableData.forEach(table => {
    if (selectedTables.includes(table.name)) {
      tableStatuses[table.name] = 'กำลังโอน';
    } else {
      tableStatuses[table.name] = '-'; // Clear non-selected
    }
  });
  renderTableList();
  
  try {
    // Step 1: Auto-create tables in MySQL
    updateProgress(0, 'Creating tables...');
    const createRes = await fetch('/api/tables/create-all', { method: 'POST' });
    const createData = await createRes.json();
    
    if (!createRes.ok) {
      throw new Error('Failed to create tables: ' + createData.error);
    }
    
    // Step 2: Start transfer
    updateProgress(5, 'Starting transfer...');
    
    const res = await fetch('/api/transfer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, tables: selectedTables, from, to, dryRun, workerId }),
    });
    
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to start transfer');
    }
    
    switchRightTab('logs');
    showToast('เริ่มโอนข้อมูลแล้ว (ดูสถานะในแท็บ Log)', 'success');
    
  } catch (error) {
    console.error('Transfer error:', error);
    showToast(error.message || 'เกิดข้อผิดพลาดในการเริ่มทำงาน', 'error');
  } finally {
    elements.btnTransfer.classList.remove('btn-loading');
    elements.btnTransfer.disabled = false;
  }
}

// ==================== System Settings Modal ====================

function openSettingsModal(tab = 'db') {
  // Reset test results
  elements.pgTestResult.textContent = '';
  elements.mysqlTestResult.textContent = '';
  
  // Load configuration for all tabs so they are ready
  loadDbConfig();
  loadSchedulerConfig();
  loadTelegramConfig();
  
  // Switch to the requested tab
  const tabBtn = document.querySelector(`.settings-tab-btn[data-tab="${tab}"]`);
  if (tabBtn) tabBtn.click();
  
  elements.settingsModal.classList.remove('hidden');
}

function closeSettingsModal() {
  elements.settingsModal.classList.add('hidden');
}

async function saveDbConfig() {
  const config = {
    postgres: {
      host: elements.pgHost.value,
      port: parseInt(elements.pgPort.value) || 5432,
      database: elements.pgDatabase.value,
      user: elements.pgUser.value,
      password: elements.pgPassword.value,
    },
    mysql: {
      host: elements.mysqlHost.value,
      port: parseInt(elements.mysqlPort.value) || 3306,
      database: elements.mysqlDatabase.value,
      user: elements.mysqlUser.value,
      password: elements.mysqlPassword.value,
    }
  };

  try {
    const res = await fetch('/api/config/database', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    
    const data = await res.json();
    
    if (res.ok) {
      showToast('บันทึกการเชื่อมต่อฐานข้อมูลสำเร็จ!', 'success');
      closeSettingsModal();
      
      // Update UI after saving
      await checkHealth();
      await loadTables();
    } else {
      showToast('Error: ' + data.error, 'error');
    }
  } catch (error) {
    showToast('Error saving config: ' + error.message, 'error');
  }
}

async function testPostgres() {
  const config = {
    host: elements.pgHost.value,
    port: parseInt(elements.pgPort.value) || 5432,
    database: elements.pgDatabase.value,
    user: elements.pgUser.value,
    password: elements.pgPassword.value,
  };
  
  elements.pgTestResult.textContent = 'Testing...';
  elements.pgTestResult.className = 'ml-2 text-sm';
  
  try {
    const res = await fetch('/api/config/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'postgres', config }),
    });
    
    const data = await res.json();
    
    if (res.ok) {
      elements.pgTestResult.textContent = '✓ Connected!';
      elements.pgTestResult.className = 'ml-2 text-sm text-green-600';
      showToast('เชื่อมต่อ PostgreSQL สำเร็จ', 'success', 1500);
    } else {
      elements.pgTestResult.textContent = '✗ ' + data.error;
      elements.pgTestResult.className = 'ml-2 text-sm text-red-600';
      showToast('ไม่สามารถเชื่อมต่อ PostgreSQL ได้: ' + data.error, 'error');
    }
  } catch (error) {
    elements.pgTestResult.textContent = '✗ ' + error.message;
    elements.pgTestResult.className = 'ml-2 text-sm text-red-600';
    showToast('เกิดข้อผิดพลาดในการทดสอบ PostgreSQL: ' + error.message, 'error');
  }
}

async function testMysql() {
  const config = {
    host: elements.mysqlHost.value,
    port: parseInt(elements.mysqlPort.value) || 3306,
    database: elements.mysqlDatabase.value,
    user: elements.mysqlUser.value,
    password: elements.mysqlPassword.value,
  };
  
  elements.mysqlTestResult.textContent = 'Testing...';
  elements.mysqlTestResult.className = 'ml-2 text-sm';
  
  try {
    const res = await fetch('/api/config/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'mysql', config }),
    });
    
    const data = await res.json();
    
    if (res.ok) {
      elements.mysqlTestResult.textContent = '✓ Connected!';
      elements.mysqlTestResult.className = 'ml-2 text-sm text-green-600';
      showToast('เชื่อมต่อ MySQL สำเร็จ', 'success', 1500);
    } else {
      elements.mysqlTestResult.textContent = '✗ ' + data.error;
      elements.mysqlTestResult.className = 'ml-2 text-sm text-red-600';
      showToast('ไม่สามารถเชื่อมต่อ MySQL ได้: ' + data.error, 'error');
    }
  } catch (error) {
    elements.mysqlTestResult.textContent = '✗ ' + error.message;
    elements.mysqlTestResult.className = 'ml-2 text-sm text-red-600';
    showToast('เกิดข้อผิดพลาดในการทดสอบ MySQL: ' + error.message, 'error');
  }
}

// UI Functions
function renderTableList() {
  // If there's an active search filter, use the filter function instead
  const searchInput = document.getElementById('table-search');
  if (searchInput && searchInput.value.trim()) {
    doFilterTables(searchInput.value);
    return;
  }
  
  const tableData = tables[currentType] || [];
  
  elements.tableCount.textContent = `${tableData.length} ตาราง`;
  
  if (tableData.length === 0) {
    elements.tableList.innerHTML = '<p class="text-center py-8 text-slate-400">No tables found</p>';
    elements.selectAll.checked = false;
    updateSelectedCount();
    return;
  }
  
  let html = tableData.map((table, index) => {
    let status = tableStatuses[table.name] || '-';
    const isChecked = status === 'รอโอน' || status === 'กำลังโอน' || status === 'โอนสำเร็จ';
    
    let statusClass = 'text-slate-500';
    if (status === 'โอนสำเร็จ') statusClass = 'text-green-600 font-medium';
    else if (status === 'กำลังโอน') statusClass = 'text-orange-500 animate-pulse';
    else if (status === 'ไม่สำเร็จ') statusClass = 'text-red-600';
    else if (status === 'รอโอน') statusClass = 'text-blue-600';
    
    return `<div class="table-grid px-2 py-2 border-b hover:bg-slate-50 text-sm" data-table="${table.name}">
      <span class="text-slate-500">${index + 1}</span>
      <span><input type="checkbox" class="table-checkbox w-4 h-4" value="${table.name}" ${isChecked ? 'checked' : ''} onchange="onTableCheckChange('${table.name}', this.checked)"></span>
      <span class="font-mono">${table.name}</span>
      <span class="table-status ${statusClass}">${status}</span>
      <span class="text-right font-mono">${formatNumber(table.rowCount || 0)}</span>
    </div>`;
  }).join('');
  
  elements.tableList.innerHTML = html;
  updateSelectedCount();
}

// Search/Filter tables by name
// Search/Filter tables by name
let searchQuery = '';
let filterTimeoutId = null;

function filterTables(query) {
  const clearBtn = document.getElementById('btn-clear-search');
  if (clearBtn) {
    if (query && query.trim()) {
      clearBtn.classList.remove('hidden');
    } else {
      clearBtn.classList.add('hidden');
    }
  }

  // Use 150ms debounce to prevent UI lag while typing
  if (filterTimeoutId) clearTimeout(filterTimeoutId);
  filterTimeoutId = setTimeout(() => {
    doFilterTables(query);
  }, 150);
}

function clearTableSearch() {
  const searchInput = document.getElementById('table-search');
  const clearBtn = document.getElementById('btn-clear-search');
  if (searchInput) {
    searchInput.value = '';
    if (clearBtn) clearBtn.classList.add('hidden');
    doFilterTables('');
    searchInput.focus();
  }
}

function doFilterTables(query) {
  searchQuery = (query || '').toLowerCase().trim();
  
  const tableData = tables[currentType] || [];
  const filteredData = searchQuery 
    ? tableData.filter(t => t.name.toLowerCase().includes(searchQuery))
    : tableData;
  
  // Cap max displayed rows when searching to prevent DOM rendering lag
  const MAX_DISPLAY = 300;
  const isLimited = filteredData.length > MAX_DISPLAY;
  const displayData = isLimited ? filteredData.slice(0, MAX_DISPLAY) : filteredData;

  elements.tableCount.textContent = searchQuery 
    ? `${filteredData.length.toLocaleString()} / ${tableData.length.toLocaleString()} ตาราง${isLimited ? ` (แสดง ${MAX_DISPLAY} รายการ)` : ''}`
    : `${tableData.length.toLocaleString()} ตาราง`;
  
  if (filteredData.length === 0) {
    elements.tableList.innerHTML = searchQuery
      ? `<p class="text-center py-8 text-slate-400">ไม่พบตาราง "${escapeHtml(searchQuery)}"</p>`
      : '<p class="text-center py-8 text-slate-400">No tables found</p>';
    return;
  }
  
  let html = displayData.map((table, index) => {
    let status = tableStatuses[table.name] || '-';
    const isChecked = status === 'รอโอน' || status === 'กำลังโอน' || status === 'โอนสำเร็จ';
    
    let statusClass = 'text-slate-500';
    if (status === 'โอนสำเร็จ') statusClass = 'text-green-600 font-medium';
    else if (status === 'กำลังโอน') statusClass = 'text-orange-500 animate-pulse';
    else if (status === 'ไม่สำเร็จ') statusClass = 'text-red-600';
    else if (status === 'รอโอน') statusClass = 'text-blue-600';
    
    // Highlight matching query text
    let displayName = escapeHtml(table.name);
    if (searchQuery) {
      const idx = table.name.toLowerCase().indexOf(searchQuery);
      if (idx >= 0) {
        displayName = escapeHtml(table.name.substring(0, idx)) + 
          '<mark class="bg-yellow-200 font-semibold text-slate-900 rounded-sm px-0.5">' + escapeHtml(table.name.substring(idx, idx + searchQuery.length)) + '</mark>' + 
          escapeHtml(table.name.substring(idx + searchQuery.length));
      }
    }
    
    return `<div class="table-grid px-2 py-2 border-b hover:bg-slate-50 text-sm" data-table="${table.name}">
      <span class="text-slate-500">${index + 1}</span>
      <span><input type="checkbox" class="table-checkbox w-4 h-4" value="${table.name}" ${isChecked ? 'checked' : ''} onchange="onTableCheckChange('${table.name}', this.checked)"></span>
      <span class="font-mono">${displayName}</span>
      <span class="table-status ${statusClass}">${status}</span>
      <span class="text-right font-mono">${formatNumber(table.rowCount || 0)}</span>
    </div>`;
  }).join('');
  
  if (isLimited) {
    html += `<div class="p-2 text-center text-xs text-slate-500 bg-slate-50 border-t">แสดง ${MAX_DISPLAY} ตารางแรกจาก ${filteredData.length.toLocaleString()} ตารางที่พบ (พิมพ์ระบุชื่อตารางเพิ่มเติมเพื่อเจาะจงผลลัพธ์)</div>`;
  }

  elements.tableList.innerHTML = html;
}

// Handle checkbox change
function onTableCheckChange(tableName, checked) {
  // Only allow changes when not transferring
  const currentStatus = tableStatuses[tableName];
  if (currentStatus === 'กำลังโอน' || currentStatus === 'โอนสำเร็จ') {
    // Revert checkbox - can't change during/after transfer
    const checkbox = document.querySelector(`input.table-checkbox[value="${tableName}"]`);
    if (checkbox) checkbox.checked = true;
    return;
  }
  
  // Update status based on checkbox state
  tableStatuses[tableName] = checked ? 'รอโอน' : '-';
  
  // Update status display
  const row = document.querySelector(`[data-table="${tableName}"]`);
  if (row) {
    const statusEl = row.querySelector('.table-status');
    if (statusEl) {
      statusEl.textContent = tableStatuses[tableName];
      statusEl.className = 'table-status ' + (checked ? 'text-blue-600' : 'text-slate-500');
    }
  }
  
  updateSelectedCount();
}

function getSelectedTables() {
  const selectedCheckboxes = document.querySelectorAll('.table-checkbox:checked');
  return Array.from(selectedCheckboxes).map(cb => cb.value);
}

function updateSelectedCount() {
  const selectedTables = getSelectedTables();
  const allCheckboxes = document.querySelectorAll('.table-checkbox');
  
  elements.selectedCount.textContent = `${formatNumber(selectedTables.length)} / ${formatNumber(allCheckboxes.length)} ตารางที่เลือก`;
  
  // Update Select All checkbox state
  if (allCheckboxes.length > 0 && selectedTables.length === allCheckboxes.length) {
    elements.selectAll.checked = true;
    elements.selectAll.indeterminate = false;
  } else if (selectedTables.length > 0) {
    elements.selectAll.indeterminate = true;
  } else {
    elements.selectAll.checked = false;
    elements.selectAll.indeterminate = false;
  }

  // Enable/Disable Start button based on selection
  if (selectedTables.length > 0) {
    elements.btnTransfer.disabled = false;
  } else {
    elements.btnTransfer.disabled = true;
  }
}

function updateProgress(currentTablePercent, overallPercent, tableName, completedTables, totalTables) {
  const safeCurrentPercent = Math.min(100, Math.max(0, Math.round(currentTablePercent || 0)));
  const safeOverallPercent = Math.min(100, Math.max(0, Math.round(overallPercent || 0)));

  // Current Table Bar (Blue)
  if (elements.progressFill) {
    elements.progressFill.style.width = `${safeCurrentPercent}%`;
  }
  if (elements.progressTable) {
    elements.progressTable.textContent = tableName || '--';
  }
  const percentEl = document.getElementById('progress-percent');
  if (percentEl) {
    percentEl.textContent = `${safeCurrentPercent}%`;
  }

  // Overall Batch Bar (Green)
  const overallFill = document.getElementById('overall-progress-fill');
  if (overallFill) {
    overallFill.style.width = `${safeOverallPercent}%`;
  }
  const overallPercentEl = document.getElementById('overall-percent');
  if (overallPercentEl) {
    overallPercentEl.textContent = `${safeOverallPercent}%`;
  }
  const overallCountEl = document.getElementById('overall-tables-count');
  if (overallCountEl) {
    overallCountEl.textContent = `${completedTables || 0}/${totalTables || 0}`;
  }
}

function updateMyProgress() {
  const myStatus = allWorkerStatuses[workerId];
  
  if (!myStatus) return;
  
  if (myStatus.isRunning) {
    elements.progressSection.classList.remove('hidden');
    elements.btnTransfer.disabled = true;
    
    // 1. Calculate Current Table Progress (Row Percentage - Blue Bar)
    let currentTablePercent = 0;
    if (myStatus.totalRecords > 0 && myStatus.currentRecords > 0) {
      currentTablePercent = Math.min(100, (myStatus.currentRecords / myStatus.totalRecords) * 100);
    }

    // 2. Calculate Overall Batch Progress (Table Count Percentage - Green Bar)
    const completedTables = myStatus.completedTables || 0;
    const totalTables = Math.max(1, myStatus.totalTables || 1);
    const tableWeight = 100 / totalTables;
    const overallPercent = Math.min(100, Math.round((completedTables * tableWeight) + (currentTablePercent * tableWeight / 100)));

    // Record count info
    const tableInfo = myStatus.currentTable || '--';
    const recordInfo = myStatus.totalRecords > 0 
      ? ` (${myStatus.currentRecords?.toLocaleString() || 0}/${myStatus.totalRecords?.toLocaleString()})` 
      : '';

    updateProgress(currentTablePercent, overallPercent, tableInfo + recordInfo, completedTables, myStatus.totalTables);
    
    // Only sync table statuses from worker when transfer is running
    if (myStatus.isRunning && myStatus.tableStatuses) {
      Object.assign(tableStatuses, myStatus.tableStatuses);
      // Update UI for each table
      Object.keys(myStatus.tableStatuses).forEach(tableName => {
        const status = myStatus.tableStatuses[tableName];
        const row = document.querySelector(`[data-table="${tableName}"]`);
        if (row) {
          const statusEl = row.querySelector('.table-status');
          if (statusEl) {
            statusEl.textContent = status;
            let statusClass = 'table-status text-slate-500';
            if (status === 'โอนสำเร็จ') statusClass = 'table-status text-green-600 font-medium';
            else if (status === 'กำลังโอน') statusClass = 'table-status text-orange-500 animate-pulse';
            else if (status === 'ไม่สำเร็จ') statusClass = 'table-status text-red-600';
            statusEl.className = statusClass;
          }
        }
      });
    }
  } else {
    elements.btnTransfer.disabled = false;
    if (myStatus.progress >= 100) {
      updateProgress(100, 100, 'Complete!', myStatus.totalTables || 1, myStatus.totalTables || 1);
      elements.endTime.textContent = formatDateTime(new Date());
      
      // Always sync final statuses when transfer is complete
      if (myStatus.tableStatuses) {
        Object.assign(tableStatuses, myStatus.tableStatuses);
        renderTableList();
      }
      
      setTimeout(() => {
        elements.progressSection.classList.add('hidden');
      }, 3000);
    }
  }
}

// Utility Functions
function formatDateTime(date) {
  return date.toLocaleString('th-TH', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

function formatNumber(num) {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1) + 'M';
  } else if (num >= 1000) {
    return (num / 1000).toFixed(1) + 'K';
  }
  return num.toLocaleString('th-TH');
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function togglePassword(inputId, btn) {
  const input = document.getElementById(inputId);
  const eyeIcon = btn.querySelector('.icon-eye');
  const eyeOffIcon = btn.querySelector('.icon-eye-off');
  if (input.type === 'password') {
    input.type = 'text';
    if (eyeIcon) eyeIcon.classList.add('hidden');
    if (eyeOffIcon) eyeOffIcon.classList.remove('hidden');
  } else {
    input.type = 'password';
    if (eyeIcon) eyeIcon.classList.remove('hidden');
    if (eyeOffIcon) eyeOffIcon.classList.add('hidden');
  }
}

// Scheduler Configuration Elements (inside Settings Modal)
const schedulerElements = {
  // Basic
  basicEnabled: document.getElementById('sched-basic-enabled'),
  basicType: document.getElementById('sched-basic-type'),
  basicTime: document.getElementById('sched-basic-time'),
  basicDayWrapper: document.getElementById('sched-basic-day-wrapper'),
  basicDay: document.getElementById('sched-basic-day'),
  // OPD
  opdEnabled: document.getElementById('sched-opd-enabled'),
  opdInterval: document.getElementById('sched-opd-interval'),
  opdUnit: document.getElementById('sched-opd-unit'),
  opdDays: document.getElementById('sched-opd-days'),
  // IPD
  ipdEnabled: document.getElementById('sched-ipd-enabled'),
  ipdInterval: document.getElementById('sched-ipd-interval'),
  ipdUnit: document.getElementById('sched-ipd-unit'),
  ipdDays: document.getElementById('sched-ipd-days'),
  // Status displays
  basicStatus: document.getElementById('scheduler-basic-status'),
  opdStatus: document.getElementById('scheduler-opd-status'),
  ipdStatus: document.getElementById('scheduler-ipd-status'),
};

// Initialize scheduler inputs (modals are handled in Settings block)
if (schedulerElements.basicType) {
  schedulerElements.basicType.addEventListener('change', updateBasicTypeUI);
  
  // Load initial status
  loadSchedulerStatus();
  setInterval(loadSchedulerStatus, 10000); // Update every 10 seconds
}

async function loadSchedulerConfig() {
  try {
    const res = await fetch('/api/config/scheduler');
    const config = await res.json();
    
    // Parse Basic schedule
    const basicCron = config.basic?.schedule || '0 2 * * *';
    const basicParts = basicCron.split(' ');
    const minute = basicParts[0];
    const hour = basicParts[1];
    const dayOfWeek = basicParts[4];
    
    schedulerElements.basicEnabled.checked = config.basic?.enabled !== false;
    schedulerElements.basicTime.value = `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
    
    if (dayOfWeek === '*') {
      schedulerElements.basicType.value = 'daily';
      schedulerElements.basicDayWrapper.classList.add('hidden');
    } else {
      schedulerElements.basicType.value = 'weekly';
      schedulerElements.basicDay.value = dayOfWeek;
      schedulerElements.basicDayWrapper.classList.remove('hidden');
    }
    
    // Parse OPD schedule
    const opdCron = config.opd?.schedule || '*/30 * * * *';
    // Match minute-based: */30 * * * * -> captures 30
    const opdMinMatch = opdCron.match(/^\*\/(\d+)\s+\*/);
    // Match hour-based: 0 */1 * * * -> captures 1
    const opdHourMatch = opdCron.match(/^0\s+\*\/(\d+)\s+/);
    
    schedulerElements.opdEnabled.checked = config.opd?.enabled !== false;
    if (opdHourMatch) {
      schedulerElements.opdInterval.value = opdHourMatch[1];
      schedulerElements.opdUnit.value = 'hours';
    } else if (opdMinMatch) {
      schedulerElements.opdInterval.value = opdMinMatch[1];
      schedulerElements.opdUnit.value = 'minutes';
    } else {
      schedulerElements.opdInterval.value = 30;
      schedulerElements.opdUnit.value = 'minutes';
    }
    schedulerElements.opdDays.value = config.opd?.opdDaysBack || 7;
    
    // Parse IPD schedule
    const ipdCron = config.ipd?.schedule || '*/30 * * * *';
    // Match minute-based: */30 * * * * -> captures 30
    const ipdMinMatch = ipdCron.match(/^\*\/(\d+)\s+\*/);
    // Match hour-based: 0 */1 * * * -> captures 1
    const ipdHourMatch = ipdCron.match(/^0\s+\*\/(\d+)\s+/);
    
    schedulerElements.ipdEnabled.checked = config.ipd?.enabled !== false;
    if (ipdHourMatch) {
      schedulerElements.ipdInterval.value = ipdHourMatch[1];
      schedulerElements.ipdUnit.value = 'hours';
    } else if (ipdMinMatch) {
      schedulerElements.ipdInterval.value = ipdMinMatch[1];
      schedulerElements.ipdUnit.value = 'minutes';
    } else {
      schedulerElements.ipdInterval.value = 30;
      schedulerElements.ipdUnit.value = 'minutes';
    }
    
    schedulerElements.ipdDays.value = config.ipd?.ipdDaysBack || 45;
    
  } catch (error) {
    console.error('Failed to load scheduler config:', error);
  }
}

async function saveSchedulerConfig() {
  try {
    // Build cron expressions
    const timeParts = schedulerElements.basicTime.value.split(':');
    const hour = timeParts[0];
    const minute = timeParts[1];
    const dayOfWeek = schedulerElements.basicType.value === 'weekly' 
      ? schedulerElements.basicDay.value 
      : '*';
    const basicCron = `${minute} ${hour} * * ${dayOfWeek}`;
    
    // OPD interval
    const opdInterval = parseInt(schedulerElements.opdInterval.value) || 30;
    const opdCron = schedulerElements.opdUnit.value === 'hours'
      ? `0 */${opdInterval} * * *`
      : `*/${opdInterval} * * * *`;
    
    // IPD interval
    const ipdInterval = parseInt(schedulerElements.ipdInterval.value) || 30;
    const ipdCron = schedulerElements.ipdUnit.value === 'hours'
      ? `0 */${ipdInterval} * * *`
      : `*/${ipdInterval} * * * *`;
    
    const config = {
      basic: {
        schedule: basicCron,
        enabled: schedulerElements.basicEnabled.checked,
        description: schedulerElements.basicType.value === 'weekly' 
          ? `ข้อมูลพื้นฐาน - วัน${getDayName(dayOfWeek)} เวลา ${hour}:${minute}`
          : `ข้อมูลพื้นฐาน - ทุกวันเวลา ${hour}:${minute}`,
      },
      opd: {
        schedule: opdCron,
        enabled: schedulerElements.opdEnabled.checked,
        description: `ข้อมูล OPD - ทุก ${opdInterval} ${schedulerElements.opdUnit.value === 'hours' ? 'ชั่วโมง' : 'นาที'}`,
        opdDaysBack: parseInt(schedulerElements.opdDays.value) || 7,
      },
      ipd: {
        schedule: ipdCron,
        enabled: schedulerElements.ipdEnabled.checked,
        description: `ข้อมูล IPD - ทุก ${ipdInterval} ${schedulerElements.ipdUnit.value === 'hours' ? 'ชั่วโมง' : 'นาที'}`,
        ipdDaysBack: parseInt(schedulerElements.ipdDays.value) || 45,
      }
    };
    
    const res = await fetch('/api/config/scheduler', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    
    const data = await res.json();
    
    if (res.ok) {
      showToast('บันทึกการตั้งค่า Scheduler สำเร็จ!', 'success');
      closeSettingsModal();
      loadSchedulerStatus();
    } else {
      showToast('Error: ' + data.error, 'error');
    }
  } catch (error) {
    showToast('Error saving scheduler config: ' + error.message, 'error');
  }
}

function updateBasicTypeUI() {
  if (schedulerElements.basicType.value === 'weekly') {
    schedulerElements.basicDayWrapper.classList.remove('hidden');
  } else {
    schedulerElements.basicDayWrapper.classList.add('hidden');
  }
}

function getDayName(day) {
  const days = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];
  return days[parseInt(day)] || day;
}

async function loadSchedulerStatus() {
  try {
    const res = await fetch('/api/schedule');
    const status = await res.json();
    renderSchedulerStatus(status);
  } catch (error) {
    console.error('Failed to load scheduler status:', error);
  }
}

function renderSchedulerStatus(data) {
  const renderBadge = (config) => {
    if (!config || !config.enabled) return '<span class="sched-badge sched-badge-disabled">Disabled</span>';
    return `<span class="sched-badge">${config.schedule}</span>`;
  };
  
  document.getElementById('scheduler-basic-status').innerHTML = `Basic: ${renderBadge(data.basic)}`;
  document.getElementById('scheduler-opd-status').innerHTML = `OPD: ${renderBadge(data.opd)}`;
  document.getElementById('scheduler-ipd-status').innerHTML = `IPD: ${renderBadge(data.ipd)}`;

  const masterSyncContainer = document.getElementById('master-sync-container');
  const masterSyncToggle = document.getElementById('master-sync-toggle');
  const masterSyncLabel = document.getElementById('master-sync-label');
  const anyEnabled = (data.basic && data.basic.enabled) || (data.opd && data.opd.enabled) || (data.ipd && data.ipd.enabled);

  if (masterSyncContainer) {
    masterSyncContainer.className = `master-sync-box ${anyEnabled ? 'enabled' : 'disabled'}`;
    const toggleBg = masterSyncContainer.querySelector('.toggle-bg');
    const toggleKnob = masterSyncContainer.querySelector('.toggle-knob');
    if (toggleBg) toggleBg.style.backgroundColor = anyEnabled ? '#10b981' : '#f43f5e';
    if (toggleKnob) toggleKnob.style.transform = anyEnabled ? 'translateX(16px)' : 'translateX(0px)';
  }
  if (masterSyncToggle) {
    masterSyncToggle.checked = !!anyEnabled;
  }
  if (masterSyncLabel) {
    masterSyncLabel.textContent = anyEnabled ? 'เปิดทำงาน (ACTIVE)' : 'ปิดการทำงาน (PAUSED)';
    masterSyncLabel.style.color = anyEnabled ? '#047857' : '#dc2626';
  }
}

// Master Auto-Sync Switch Toggle Event Handler
const masterSyncToggle = document.getElementById('master-sync-toggle');
if (masterSyncToggle) {
  masterSyncToggle.addEventListener('change', async () => {
    const isEnabled = masterSyncToggle.checked;
    
    // Animate UI toggle immediately for responsiveness
    const container = document.getElementById('master-sync-container');
    if (container) {
      container.className = `master-sync-box ${isEnabled ? 'enabled' : 'disabled'}`;
      const toggleBg = container.querySelector('.toggle-bg');
      const toggleKnob = container.querySelector('.toggle-knob');
      if (toggleBg) toggleBg.style.backgroundColor = isEnabled ? '#10b981' : '#f43f5e';
      if (toggleKnob) toggleKnob.style.transform = isEnabled ? 'translateX(16px)' : 'translateX(0px)';
    }
    const label = document.getElementById('master-sync-label');
    if (label) {
      label.textContent = isEnabled ? 'เปิดทำงาน (ACTIVE)' : 'ปิดการทำงาน (PAUSED)';
      label.style.color = isEnabled ? '#047857' : '#dc2626';
    }

    try {
      const res = await fetch('/api/config/scheduler/global-toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: isEnabled }),
      });
      const data = await res.json();
      if (res.ok) {
        showToast(isEnabled ? 'เปิดระบบ Sync อัตโนมัติเรียบร้อยแล้ว!' : 'ปิดระบบ Sync อัตโนมัติเรียบร้อยแล้ว!', isEnabled ? 'success' : 'info');
        loadSchedulerStatus();
      } else {
        showToast('Error: ' + data.error, 'error');
        masterSyncToggle.checked = !isEnabled;
        loadSchedulerStatus();
      }
    } catch (err) {
      showToast('Failed to toggle master sync: ' + err.message, 'error');
      masterSyncToggle.checked = !isEnabled;
      loadSchedulerStatus();
    }
  });
}

// ==================== Telegram Notification Modal ====================

async function loadTelegramConfig() {
  try {
    const res = await fetch('/api/config/telegram');
    if (res.ok) {
      const config = await res.json();
      elements.telegramEnabled.checked = config.enabled || false;
      elements.telegramBotToken.value = config.botToken || '';
      elements.telegramChatId.value = config.chatId || '';
    }
  } catch (error) {
    console.error('Failed to load Telegram config:', error);
  }
}

async function saveTelegramConfig() {
  const config = {
    enabled: elements.telegramEnabled.checked,
    botToken: elements.telegramBotToken.value.trim(),
    chatId: elements.telegramChatId.value.trim()
  };

  try {
    const res = await fetch('/api/config/telegram', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    
    if (res.ok) {
      showToast('บันทึกการตั้งค่าแจ้งเตือนแล้ว!', 'success');
      closeSettingsModal();
    } else {
      const data = await res.json();
      showToast('Error: ' + data.error, 'error');
    }
  } catch (error) {
    showToast('Error saving config: ' + error.message, 'error');
  }
}

async function testTelegram() {
  const token = elements.telegramBotToken.value.trim();
  const chatId = elements.telegramChatId.value.trim();
  
  if (!token || !chatId) {
    elements.telegramTestResult.textContent = 'กรุณากรอก Token และ Chat ID';
    elements.telegramTestResult.className = 'text-xs ml-2 text-red-500';
    return;
  }
  
  elements.telegramTestResult.textContent = 'กำลังทดสอบ...';
  elements.telegramTestResult.className = 'text-xs ml-2 text-blue-500';
  elements.btnTestTelegram.disabled = true;
  
  try {
    const res = await fetch('/api/config/telegram/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ botToken: token, chatId: chatId }),
    });
    
    if (res.ok) {
      elements.telegramTestResult.textContent = '✓ ส่งข้อความสำเร็จ!';
      elements.telegramTestResult.className = 'text-xs ml-2 text-green-600';
      showToast('ทดสอบแจ้งเตือนผ่าน Telegram สำเร็จ', 'success', 2000);
    } else {
      const data = await res.json();
      elements.telegramTestResult.textContent = '✗ ' + (data.error || 'ล้มเหลว');
      elements.telegramTestResult.className = 'text-xs ml-2 text-red-500';
    }
  } catch (error) {
    elements.telegramTestResult.textContent = '✗ ' + error.message;
    elements.telegramTestResult.className = 'text-xs ml-2 text-red-500';
  } finally {
    elements.btnTestTelegram.disabled = false;
  }
}

// ==================== Right Panel Tab Switching ====================

function switchRightTab(tab) {
  // Toggle tab buttons
  document.querySelectorAll('.right-tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.rightTab === tab);
  });
  // Toggle tab content
  document.getElementById('right-tab-logs').classList.toggle('hidden', tab !== 'logs');
  document.getElementById('right-tab-history').classList.toggle('hidden', tab !== 'history');
  
  if (tab === 'history') {
    loadHistory();
    loadStats();
  }
}

// ==================== Transfer History ====================

async function loadStats() {
  try {
    const res = await fetch('/api/history/stats');
    const stats = await res.json();
    
    document.getElementById('stat-success').textContent = stats.todaySuccess.toLocaleString();
    document.getElementById('stat-failed').textContent = stats.todayFailed.toLocaleString();
    document.getElementById('stat-transfers').textContent = stats.todayTransfers.toLocaleString();
    document.getElementById('stat-rows').textContent = stats.todayRows.toLocaleString();
  } catch (error) {
    console.error('Failed to load stats:', error);
  }
}

async function loadHistory() {
  try {
    const res = await fetch('/api/history?limit=50');
    const { records, total } = await res.json();
    
    const container = document.getElementById('history-list');
    
    if (records.length === 0) {
      container.innerHTML = '<p class="text-muted text-center" style="padding: 1rem;">ยังไม่มีประวัติ</p>';
      return;
    }
    
    let html = '';
    for (const record of records) {
      const date = new Date(record.timestamp);
      const timeStr = date.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
      const dateStr = date.toLocaleDateString('th-TH', { day: '2-digit', month: '2-digit' });
      
      const isSuccess = record.failedTables === 0;
      const statusIcon = isSuccess ? '✅' : '⚠️';
      const statusColor = isSuccess ? '#16a34a' : '#dc2626';
      
      const typeBadge = {
        basic: '<span style="background:#fef9c3;color:#854d0e;padding:1px 6px;border-radius:99px;font-size:0.7rem;">Basic</span>',
        opd: '<span style="background:#dbeafe;color:#1e40af;padding:1px 6px;border-radius:99px;font-size:0.7rem;">OPD</span>',
        ipd: '<span style="background:#dcfce7;color:#166534;padding:1px 6px;border-radius:99px;font-size:0.7rem;">IPD</span>',
      }[record.type] || record.type;
      
      const sourceBadge = record.source === 'scheduler'
        ? '<span style="background:#f3e8ff;color:#6b21a8;padding:1px 4px;border-radius:99px;font-size:0.65rem;">⏰ auto</span>'
        : '<span style="background:#e0e7ff;color:#3730a3;padding:1px 4px;border-radius:99px;font-size:0.65rem;">👤 manual</span>';
      
      // Validation summary
      let validationHTML = '';
      if (record.validation && record.validation.length > 0) {
        const mismatched = record.validation.filter(v => !v.isMatch);
        if (mismatched.length > 0) {
          validationHTML = `<span style="color:#dc2626;font-size:0.7rem;">⚠️ ${mismatched.length} ตารางไม่ตรง</span>`;
        } else {
          validationHTML = '<span style="color:#16a34a;font-size:0.7rem;">✅ ข้อมูลตรง</span>';
        }
      }
      
      // Retry button for failed
      const retryBtn = record.failedTables > 0
        ? `<button onclick="retryFailed('${record.id}')" style="background:#fef2f2;color:#dc2626;border:1px solid #fecaca;padding:1px 6px;border-radius:4px;font-size:0.7rem;cursor:pointer;">🔄 Retry (${record.failedTables})</button>`
        : '';
      
      html += `
        <div style="padding:0.5rem;border-bottom:1px solid #f1f5f9;display:flex;align-items:flex-start;gap:0.5rem;">
          <div style="font-size:1.1rem;line-height:1;">${statusIcon}</div>
          <div style="flex:1;min-width:0;">
            <div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;">
              ${typeBadge} ${sourceBadge}
              <span style="color:#64748b;font-size:0.7rem;">${dateStr} ${timeStr}</span>
            </div>
            <div style="margin-top:2px;color:#334155;">
              ${record.successTables}/${record.totalTables} ตาราง · ${record.totalRows.toLocaleString()} rows · ${record.duration}
            </div>
            <div style="display:flex;align-items:center;gap:6px;margin-top:2px;">
              ${validationHTML} ${retryBtn}
            </div>
          </div>
        </div>`;
    }
    
    container.innerHTML = html;
  } catch (error) {
    console.error('Failed to load history:', error);
  }
}

async function retryFailed(historyId) {
  if (!confirm('ต้องการ retry tables ที่ล้มเหลว?')) return;
  
  try {
    const res = await fetch('/api/transfer/retry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ historyId, workerId }),
    });
    
    const data = await res.json();
    if (res.ok) {
      alert(`เริ่ม retry ${data.tables.length} tables`);
      switchRightTab('logs'); // Switch to logs to see progress
    } else {
      alert('Error: ' + data.error);
    }
  } catch (error) {
    alert('Error: ' + error.message);
  }
}
