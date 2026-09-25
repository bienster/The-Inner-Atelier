const loginView = document.querySelector('[data-login-view]');
const dashboard = document.querySelector('[data-dashboard]');
const loginForm = document.querySelector('[data-login-form]');
const loginMessage = document.querySelector('[data-login-message]');
const listMessage = document.querySelector('[data-list-message]');
const tableWrap = document.querySelector('[data-table-wrap]');
const tableBody = document.querySelector('[data-table-body]');
const searchInput = document.querySelector('[data-search]');
const statusFilter = document.querySelector('[data-status-filter]');
const detailDialog = document.querySelector('[data-detail-dialog]');
const confirmDialog = document.querySelector('[data-confirm-dialog]');
let submissions = [];
let selectedId = null;

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    credentials: 'same-origin'
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && path !== '/api/admin/login') showLogin();
    throw new Error(result.message || 'Something went wrong.');
  }
  return result;
}

function showLogin() {
  dashboard.hidden = true;
  loginView.hidden = false;
}

function showDashboard(email) {
  loginView.hidden = true;
  dashboard.hidden = false;
  document.querySelector('[data-admin-email]').textContent = email || 'Authorized user';
}

function escapeText(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
}

function formatDate(value, includeTime = true) {
  if (!value) return '—';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', ...(includeTime ? { timeStyle: 'short' } : {}) }).format(new Date(value));
}

function statusLabel(status) {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function visibleSubmissions() {
  const query = searchInput.value.trim().toLowerCase();
  if (!query) return submissions;
  return submissions.filter((item) => [item.first_name, item.last_name, item.email, item.phone, item.state]
    .some((value) => String(value || '').toLowerCase().includes(query)));
}

function updateStats() {
  document.querySelector('[data-stat="total"]').textContent = submissions.length;
  ['pending', 'contacted', 'scheduled'].forEach((status) => {
    document.querySelector(`[data-stat="${status}"]`).textContent = submissions.filter((item) => item.status === status).length;
  });
}

function renderRows() {
  const items = visibleSubmissions();
  tableBody.innerHTML = items.map((item) => `<tr data-id="${escapeText(item.id)}" tabindex="0">
    <td><strong>${escapeText(item.first_name)} ${escapeText(item.last_name)}</strong><small>${escapeText(item.email)}</small></td>
    <td>${escapeText(item.phone)}</td><td>${escapeText(item.state)}</td><td>${escapeText(statusLabel(item.preferred_contact_method))}</td>
    <td>${escapeText(formatDate(item.created_at, false))}</td><td><span class="status-pill status-${escapeText(item.status)}">${escapeText(statusLabel(item.status))}</span></td>
    <td><button class="row-button" type="button" data-view="${escapeText(item.id)}">View</button></td></tr>`).join('');
  document.querySelector('[data-results-count]').textContent = `${items.length} ${items.length === 1 ? 'request' : 'requests'} shown`;
  tableWrap.hidden = items.length === 0;
  listMessage.hidden = items.length !== 0;
  if (!items.length) listMessage.textContent = submissions.length ? 'No requests match your search.' : 'No waitlist requests in this view.';
}

async function loadWaitlist() {
  listMessage.hidden = false;
  listMessage.textContent = 'Loading waitlist…';
  tableWrap.hidden = true;
  try {
    const result = await api('/api/admin/query', { method: 'POST', body: JSON.stringify({ status: statusFilter.value }) });
    submissions = result.submissions || [];
    updateStats();
    renderRows();
  } catch (error) {
    listMessage.hidden = false;
    listMessage.textContent = error.message;
  }
}

function openDetails(id) {
  const item = submissions.find((entry) => entry.id === id);
  if (!item) return;
  selectedId = id;
  document.querySelector('[data-detail-name]').textContent = `${item.first_name} ${item.last_name}`;
  const email = document.querySelector('[data-detail-email]');
  email.textContent = item.email; email.href = `mailto:${item.email}`;
  const phone = document.querySelector('[data-detail-phone]');
  phone.textContent = item.phone; phone.href = `tel:${item.phone.replace(/[^+\d]/g, '')}`;
  document.querySelector('[data-detail-state]').textContent = item.state;
  document.querySelector('[data-detail-contact]').textContent = statusLabel(item.preferred_contact_method);
  document.querySelector('[data-detail-created]').textContent = formatDate(item.created_at);
  document.querySelector('[data-detail-updated]').textContent = formatDate(item.updated_at);
  document.querySelector('[data-detail-support]').textContent = item.support_description || 'No description provided.';
  document.querySelector('[data-detail-status]').value = item.status;
  document.querySelector('[data-dialog-message]').textContent = '';
  detailDialog.showModal();
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = loginForm.querySelector('button');
  button.disabled = true; loginMessage.textContent = '';
  const values = Object.fromEntries(new FormData(loginForm));
  try {
    const result = await api('/api/admin/login', { method: 'POST', body: JSON.stringify(values) });
    loginForm.reset(); showDashboard(result.user.email); await loadWaitlist();
  } catch (error) { loginMessage.textContent = error.message; }
  finally { button.disabled = false; }
});

searchInput.addEventListener('input', renderRows);
statusFilter.addEventListener('change', loadWaitlist);
document.querySelector('[data-refresh]').addEventListener('click', loadWaitlist);
tableBody.addEventListener('click', (event) => { const button = event.target.closest('[data-view]'); if (button) openDetails(button.dataset.view); });
tableBody.addEventListener('keydown', (event) => { if (event.key === 'Enter') openDetails(event.target.closest('tr')?.dataset.id); });
document.querySelector('[data-close-dialog]').addEventListener('click', () => detailDialog.close());
detailDialog.addEventListener('click', (event) => { if (event.target === detailDialog) detailDialog.close(); });

document.querySelector('[data-detail-status]').addEventListener('change', async (event) => {
  const message = document.querySelector('[data-dialog-message]');
  event.target.disabled = true; message.textContent = 'Saving…';
  try {
    const result = await api('/api/admin/update', { method: 'POST', body: JSON.stringify({ id: selectedId, status: event.target.value }) });
    const index = submissions.findIndex((item) => item.id === selectedId);
    if (index >= 0) submissions[index] = { ...submissions[index], ...result.submission };
    message.textContent = 'Status updated.'; updateStats(); renderRows();
  } catch (error) { message.textContent = error.message; }
  finally { event.target.disabled = false; }
});

document.querySelector('[data-remove]').addEventListener('click', () => confirmDialog.showModal());
document.querySelector('[data-cancel-remove]').addEventListener('click', () => confirmDialog.close());
document.querySelector('[data-confirm-remove]').addEventListener('click', async (event) => {
  event.target.disabled = true;
  try {
    await api('/api/admin/remove', { method: 'POST', body: JSON.stringify({ id: selectedId }) });
    submissions = submissions.filter((item) => item.id !== selectedId);
    confirmDialog.close(); detailDialog.close(); updateStats(); renderRows();
  } catch (error) { document.querySelector('[data-dialog-message]').textContent = error.message; confirmDialog.close(); }
  finally { event.target.disabled = false; }
});

document.querySelector('[data-logout]').addEventListener('click', async () => {
  await api('/api/admin/logout', { method: 'POST', body: '{}' }).catch(() => {});
  submissions = []; showLogin();
});

(async function initialize() {
  try {
    const session = await api('/api/admin/session');
    showDashboard(session.user.email); await loadWaitlist();
  } catch { showLogin(); }
})();
