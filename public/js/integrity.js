// ==================== Data Integrity Check - Client JS ====================

let lastResults = [];

// Convert date to Buddhist calendar prefix (YYMMDD)
function dateToBuddhistPrefix(dateStr) {
  const d = new Date(dateStr);
  const buddhistYear = (d.getFullYear() + 543) % 100;
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const yy = buddhistYear.toString().padStart(2, '0');
  return `${yy}${month}${day}`;
}

function toggleDateMode() {
  const mode = document.getElementById('date-mode').value;
  document.getElementById('range-inputs').classList.toggle('hidden', mode === 'month');
  document.getElementById('month-input').classList.toggle('hidden', mode !== 'month');
  updatePrefixPreview();
}

function updatePrefixPreview() {
  const type = document.getElementById('check-type').value;
  const mode = document.getElementById('date-mode').value;
  const preview = document.getElementById('prefix-preview');

  if (type === 'basic') {
    preview.textContent = 'Basic: นับทั้งตาราง (ไม่ filter วันที่)';
    return;
  }

  if (type === 'ipd') {
    // AN is running number per year, not date-based prefix
    let dateFrom, dateTo;
    if (mode === 'month') {
      const monthVal = document.getElementById('month-picker').value;
      if (!monthVal) { preview.textContent = ''; return; }
      dateFrom = monthVal + '-01';
      const lastDay = new Date(parseInt(monthVal.split('-')[0]), parseInt(monthVal.split('-')[1]), 0).getDate();
      dateTo = monthVal + '-' + lastDay;
    } else {
      dateFrom = document.getElementById('date-from').value;
      dateTo = document.getElementById('date-to').value || dateFrom;
    }
    preview.textContent = dateFrom ? `IPD: หา AN จาก an_stat.dchdate (${dateFrom} ~ ${dateTo})` : '';
    return;
  }

  // OPD: VN prefix
  let from, to;
  if (mode === 'month') {
    const monthVal = document.getElementById('month-picker').value;
    if (!monthVal) { preview.textContent = ''; return; }
    from = dateToBuddhistPrefix(monthVal + '-01');
    const lastDay = new Date(parseInt(monthVal.split('-')[0]), parseInt(monthVal.split('-')[1]), 0).getDate();
    to = dateToBuddhistPrefix(monthVal + '-' + lastDay);
  } else {
    const dateFrom = document.getElementById('date-from').value;
    const dateTo = document.getElementById('date-to').value;
    if (!dateFrom) { preview.textContent = ''; return; }
    from = dateToBuddhistPrefix(dateFrom);
    to = dateTo ? dateToBuddhistPrefix(dateTo) : from;
  }

  if (from === to) {
    preview.textContent = `VN prefix: ${from}`;
  } else {
    preview.textContent = `VN prefix: ${from} ~ ${to}`;
  }

  // Type 'all': show combined info
  if (type === 'all') {
    preview.textContent += ' | IPD: หา AN จาก dchdate';
  }
}

// Attach event listeners for live preview
document.getElementById('check-type').addEventListener('change', updatePrefixPreview);
document.getElementById('date-from').addEventListener('change', updatePrefixPreview);
document.getElementById('date-to').addEventListener('change', updatePrefixPreview);
document.getElementById('month-picker').addEventListener('change', updatePrefixPreview);

async function runCheck() {
  const type = document.getElementById('check-type').value;
  const mode = document.getElementById('date-mode').value;
  const btn = document.getElementById('btn-check');

  let dateFrom, dateTo;

  if (type !== 'basic') {
    if (mode === 'month') {
      const monthVal = document.getElementById('month-picker').value;
      if (!monthVal) { showToast('กรุณาเลือกเดือน', 'warning'); return; }
      dateFrom = monthVal + '-01';
      const lastDay = new Date(parseInt(monthVal.split('-')[0]), parseInt(monthVal.split('-')[1]), 0).getDate();
      dateTo = monthVal + '-' + String(lastDay).padStart(2, '0');
    } else {
      dateFrom = document.getElementById('date-from').value;
      dateTo = document.getElementById('date-to').value;
      if (!dateFrom) { showToast('กรุณาเลือกวันที่เริ่มต้น', 'warning'); return; }
      if (!dateTo) dateTo = dateFrom;
    }
  }

  // Show loading
  btn.disabled = true;
  btn.innerHTML = '<span class="loading-spinner"></span> กำลังตรวจสอบ...';
  document.getElementById('results-body').innerHTML = `
    <div class="empty-state" style="padding: 3rem;">
      <div class="loading-spinner" style="width: 2rem; height: 2rem; border-width: 3px;"></div>
      <div class="empty-state-text" style="margin-top: 1rem;">กำลังตรวจสอบข้อมูล... อาจใช้เวลาสักครู่</div>
    </div>
  `;

  // Prepare UI for streaming
  const progressContainer = document.getElementById('progress-container');
  const progressText = document.getElementById('progress-text');
  const progressFill = document.getElementById('progress-fill');
  const progressPercent = document.getElementById('progress-percent');
  const summarySection = document.getElementById('summary-section');
  const exportSection = document.getElementById('export-section');
  const resultsBody = document.getElementById('results-body');
  const statusBar = document.getElementById('status-bar');

  progressContainer.classList.remove('hidden');
  summarySection.classList.add('hidden');
  exportSection.classList.add('hidden');
  statusBar.classList.add('hidden');
  resultsBody.innerHTML = '';
  progressText.textContent = 'กำลังเตรียมการเชื่อมต่อ...';
  progressPercent.textContent = '0%';
  progressFill.style.width = '0%';

  let currentTables = [];
  let prefixInfoSaved = {};

  let url = `/api/integrity/stream?type=${type}`;
  if (dateFrom) url += `&dateFrom=${dateFrom}`;
  if (dateTo) url += `&dateTo=${dateTo}`;
  
  const source = new EventSource(url);

  source.onmessage = function(event) {
    const data = JSON.parse(event.data);
    
    if (data.action === 'init') {
      progressText.textContent = `กำลังเตรียมตรวจสอบ ${data.totalTables} ตาราง...`;
      prefixInfoSaved = data.prefixInfo;
    } 
    else if (data.action === 'table') {
      currentTables.push(data.table);
      const percent = Math.round((data.checkedCount / data.totalTables) * 100) || 0;
      progressText.textContent = `ตรวจสอบแล้ว ${data.checkedCount} / ${data.totalTables} ตาราง (${data.table.name})`;
      progressPercent.textContent = `${percent}%`;
      progressFill.style.width = `${percent}%`;
    } 
    else if (data.action === 'complete') {
      source.close();
      lastResults = currentTables;
      renderResults(currentTables, data.summary, prefixInfoSaved);
      
      setTimeout(() => {
        progressContainer.classList.add('hidden');
      }, 1000);
      
      showToast(`ตรวจสอบเสร็จ: ${data.summary.total} ตาราง (ตรง ${data.summary.matched}, ไม่ตรง ${data.summary.mismatched})`,
        data.summary.mismatched > 0 ? 'warning' : 'success');
        
      btn.disabled = false;
      btn.innerHTML = '<i data-lucide="search" class="w-4 h-4"></i> ตรวจสอบ';
      lucide.createIcons();
    }
    else if (data.action === 'error') {
      source.close();
      handleStreamError(new Error(data.message));
    }
  };

  source.onerror = function(err) {
    source.close();
    handleStreamError(new Error('Network error or server disconnected'));
  };

  function handleStreamError(err) {
    document.getElementById('results-body').innerHTML = `
      <div class="empty-state" style="padding: 3rem;">
        <div class="empty-state-icon">❌</div>
        <div class="empty-state-text" style="color: #dc2626;">${err.message}</div>
      </div>
    `;
    showToast('เกิดข้อผิดพลาด: ' + err.message, 'error');
    progressContainer.classList.add('hidden');
    btn.disabled = false;
    btn.innerHTML = '<i data-lucide="search" class="w-4 h-4"></i> ตรวจสอบ';
    lucide.createIcons();
  }
}

function renderResults(tables, summary, prefixInfo) {
  // Show summary
  const summarySection = document.getElementById('summary-section');
  summarySection.classList.remove('hidden');
  summarySection.style.display = 'grid';

  document.getElementById('sum-total').textContent = summary.total;
  document.getElementById('sum-matched').textContent = summary.matched;
  document.getElementById('sum-mismatched').textContent = summary.mismatched;

  const totalDiff = tables.reduce((sum, t) => sum + Math.max(0, t.diff), 0);
  document.getElementById('sum-diff').textContent = totalDiff.toLocaleString();

  // Show export button
  document.getElementById('export-section').classList.remove('hidden');

  // Render table rows
  const body = document.getElementById('results-body');

  // Sort: mismatched first, then by diff descending
  const sorted = [...tables].sort((a, b) => {
    if (a.isMatch !== b.isMatch) return a.isMatch ? 1 : -1;
    return Math.abs(b.diff) - Math.abs(a.diff);
  });

  let html = '';
  sorted.forEach((t, i) => {
    const catClass = t.category === 'basic' ? 'cat-basic' : t.category === 'opd' ? 'cat-opd' : 'cat-ipd';
    const catLabel = t.category.toUpperCase();

    const diffClass = t.diff > 0 ? 'diff-positive' : t.diff === 0 ? 'diff-zero' : 'diff-negative';
    const diffSign = t.diff > 0 ? '+' : '';
    const statusIcon = t.isMatch
      ? '<span style="color: #16a34a; font-weight: 600;">✅</span>'
      : `<button class="btn btn-sm btn-outline" style="border-color: #fca5a5; color: #dc2626; padding: 2px 8px; font-size: 0.75rem;" onclick="repairTable('${t.name}', '${t.category}', this)">
          <i data-lucide="wrench" class="w-3 h-3 inline"></i> ซ่อม
        </button>`;

    const pgDisplay = t.pgCount >= 0 ? t.pgCount.toLocaleString() : 'Error';
    const mysqlDisplay = t.mysqlCount >= 0 ? t.mysqlCount.toLocaleString() : 'Error';

    html += `
      <div class="integrity-grid data-row" id="row-${t.name}">
        <span class="text-muted">${i + 1}</span>
        <span>
          <span class="font-medium">${t.name}</span>
          <span class="text-xs text-muted ml-1">${t.filterUsed !== 'ทั้งหมด' ? '(' + t.filterUsed + ')' : ''}</span>
        </span>
        <span><span class="category-badge ${catClass}">${catLabel}</span></span>
        <span class="num-cell" id="pg-${t.name}">${pgDisplay}</span>
        <span class="num-cell" id="mysql-${t.name}">${mysqlDisplay}</span>
        <span class="num-cell ${diffClass}" id="diff-${t.name}">${t.pgCount >= 0 ? diffSign + t.diff.toLocaleString() : '-'}</span>
        <span style="text-align: center;" id="status-${t.name}">${statusIcon}</span>
      </div>
    `;
  });

  body.innerHTML = html;

  // Status bar
  const statusBar = document.getElementById('status-bar');
  statusBar.classList.remove('hidden');
  const now = new Date().toLocaleTimeString('th-TH');
  let parts = [];
  if (prefixInfo.vnFrom) {
    const vnStr = prefixInfo.vnTo && prefixInfo.vnTo !== prefixInfo.vnFrom
      ? `VN prefix: ${prefixInfo.vnFrom} ~ ${prefixInfo.vnTo}`
      : `VN prefix: ${prefixInfo.vnFrom}`;
    parts.push(vnStr);
  }
  if (prefixInfo.anFrom) {
    const anStr = prefixInfo.anTo && prefixInfo.anTo !== prefixInfo.anFrom
      ? `AN range: ${prefixInfo.anFrom} ~ ${prefixInfo.anTo} (จาก dchdate)`
      : `AN: >= ${prefixInfo.anFrom}`;
    parts.push(anStr);
  }
  statusBar.textContent = `ตรวจสอบเมื่อ ${now} | ${parts.length > 0 ? parts.join(' | ') : 'นับทั้งตาราง'}`;

  // Also update the preview to show found AN range
  if (prefixInfo.anFrom) {
    const preview = document.getElementById('prefix-preview');
    const currentText = preview.textContent;
    if (currentText.includes('IPD:')) {
      preview.textContent = `IPD: AN range ${prefixInfo.anFrom} ~ ${prefixInfo.anTo || '?'} (จาก dchdate)`;
    }
  }

  lucide.createIcons();
}

async function repairTable(tableName, category, btn) {
  const originalHtml = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="loading-spinner" style="width:12px; height:12px; display:inline-block; margin-right:4px;"></span> กำลังซ่อม...';
  
  // Prepare dates if currently filtered
  let dateFrom, dateTo;
  const mode = document.getElementById('date-mode').value;
  if (category !== 'basic') {
    if (mode === 'month') {
      const monthVal = document.getElementById('month-picker').value;
      if (monthVal) {
        dateFrom = monthVal + '-01';
        const lastDay = new Date(parseInt(monthVal.split('-')[0]), parseInt(monthVal.split('-')[1]), 0).getDate();
        dateTo = monthVal + '-' + String(lastDay).padStart(2, '0');
      }
    } else {
      dateFrom = document.getElementById('date-from').value;
      dateTo = document.getElementById('date-to').value || dateFrom;
    }
  }

  try {
    const resp = await fetch('/api/transfer/table', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tableName, type: category, dateFrom, dateTo })
    });
    
    const data = await resp.json();
    if (!data.success) throw new Error(data.error);
    
    showToast(`กำลังซ่อมแซมลบข้อมูลส่วนเกินและดึงข้อมูลใหม่สำหรับ ${tableName}...`, 'info');
    
    const workerId = data.workerId;
    if (workerId) {
      const pollInterval = setInterval(async () => {
        try {
          const statusResp = await fetch(`/api/transfer/status/${workerId}`);
          const statusData = await statusResp.json();
          // If the worker is no longer running, it has finished transferring
          if (!statusData || !statusData.isRunning) {
            clearInterval(pollInterval);
            showToast(`ซ่อมแซมและดึงข้อมูล ${tableName} เสร็จแล้ว กำลังตรวจสอบผลลัพธ์...`, 'success');
            runCheck(); // Re-run check to update numbers
          }
        } catch (e) {
          clearInterval(pollInterval); // Fallback on error
          showToast(`ไม่สามารถดึงสถานะได้ กำลังตรวจสอบผลลัพธ์ใหม่...`, 'warning');
          runCheck();
        }
      }, 2000); // Poll every 2 seconds
    } else {
      // Fallback if no workerId returned
      setTimeout(() => {
        runCheck();
      }, 3000);
    }
    
  } catch (err) {
    showToast(`ซ่อมแซม ${tableName} ล้มเหลว: ${err.message}`, 'error');
    btn.disabled = false;
    btn.innerHTML = originalHtml;
  }
}

function exportCSV() {
  if (lastResults.length === 0) return;

  const header = 'ชื่อตาราง,ประเภท,PG Count,MySQL Count,ส่วนต่าง,ตรงกัน,Filter\n';
  const rows = lastResults.map(t =>
    `${t.name},${t.category},${t.pgCount},${t.mysqlCount},${t.diff},${t.isMatch ? 'YES' : 'NO'},${t.filterUsed}`
  ).join('\n');

  const bom = '\uFEFF';
  const blob = new Blob([bom + header + rows], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `integrity-check-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('Export CSV สำเร็จ', 'success');
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
  toast.innerHTML = `
    <span>${icons[type] || 'ℹ️'}</span>
    <span>${message}</span>
    <button class="toast-close" onclick="this.parentElement.remove()">&times;</button>
  `;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.animation = 'toast-out 0.3s ease-in forwards';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}
