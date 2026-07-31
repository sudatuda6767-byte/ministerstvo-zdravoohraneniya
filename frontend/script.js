// ==================== КОНФИГУРАЦИЯ ====================

// Для локальной разработки:
// const API = 'http://localhost:5000/api';
// Для Render (замени на свой URL после деплоя):
const API = window.location.hostname === 'localhost'
    ? 'http://localhost:5000/api'
    const API = 'https://medregistratura-api.onrender.com/api';

let currentUser = null;
let currentTab = '';

// ==================== АВТОРИЗАЦИЯ ====================

function fillLogin(username, password) {
    document.getElementById('login-username').value = username;
    document.getElementById('login-password').value = password;
}

function showRegister() {
    document.getElementById('login-form').style.display = 'none';
    document.getElementById('register-form').style.display = 'block';
}

function showLogin() {
    document.getElementById('register-form').style.display = 'none';
    document.getElementById('login-form').style.display = 'block';
}

async function doLogin() {
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;

    if (!username || !password) {
        showToast('Заполните логин и пароль', 'error');
        return;
    }

    try {
        const res = await fetch(`${API}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ username, password })
        });

        const data = await res.json();

        if (!res.ok) {
            showToast(data.error || 'Ошибка входа', 'error');
            return;
        }

        currentUser = data.user;
        localStorage.setItem('user', JSON.stringify(currentUser));
        showToast(`Добро пожаловать, ${currentUser.full_name}!`, 'success');
        showMainScreen();

    } catch (err) {
        showToast('Ошибка подключения к серверу', 'error');
        console.error(err);
    }
}

async function doRegister() {
    const full_name = document.getElementById('reg-fullname').value.trim();
    const username = document.getElementById('reg-username').value.trim();
    const password = document.getElementById('reg-password').value;
    const phone = document.getElementById('reg-phone').value.trim();

    if (!full_name || !username || !password) {
        showToast('Заполните обязательные поля', 'error');
        return;
    }

    try {
        const res = await fetch(`${API}/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ full_name, username, password, phone })
        });

        const data = await res.json();

        if (!res.ok) {
            showToast(data.error || 'Ошибка регистрации', 'error');
            return;
        }

        currentUser = data.user;
        localStorage.setItem('user', JSON.stringify(currentUser));
        showToast('Регистрация успешна!', 'success');
        showMainScreen();

    } catch (err) {
        showToast('Ошибка подключения к серверу', 'error');
    }
}

async function doLogout() {
    try {
        await fetch(`${API}/logout`, { method: 'POST', credentials: 'include' });
    } catch (e) {}

    currentUser = null;
    localStorage.removeItem('user');
    document.getElementById('main-screen').classList.remove('active');
    document.getElementById('auth-screen').classList.add('active');
    showToast('Вы вышли из системы', 'info');
}

// ==================== ГЛАВНЫЙ ЭКРАН ====================

function showMainScreen() {
    document.getElementById('auth-screen').classList.remove('active');
    document.getElementById('main-screen').classList.add('active');

    // Информация о пользователе
    const roleNames = { admin: 'Администратор', registrar: 'Регистратура', citizen: 'Пациент' };
    const roleClass = `role-${currentUser.role}`;
    document.getElementById('user-info').innerHTML =
        `${currentUser.full_name} <span class="role-badge ${roleClass}">${roleNames[currentUser.role]}</span>`;

    // Навигация по роли
    buildNavigation();
}

function buildNavigation() {
    const nav = document.getElementById('nav-tabs');
    let tabs = [];

    switch (currentUser.role) {
        case 'citizen':
            tabs = [
                { id: 'new-appointment', label: '📝 Записаться к врачу' },
                { id: 'my-appointments', label: '📋 Мои записи' }
            ];
            break;

        case 'registrar':
            tabs = [
                { id: 'pending-appointments', label: '⏳ Ожидающие' },
                { id: 'all-appointments', label: '📋 Все заявки' }
            ];
            break;

        case 'admin':
            tabs = [
                { id: 'dashboard', label: '📊 Панель' },
                { id: 'pending-appointments', label: '⏳ Ожидающие' },
                { id: 'all-appointments', label: '📋 Все заявки' },
                { id: 'doctors-manage', label: '👨‍⚕️ Врачи' },
                { id: 'users-manage', label: '👥 Пользователи' }
            ];
            break;
    }

    nav.innerHTML = tabs.map(t =>
        `<div class="nav-tab" data-tab="${t.id}" onclick="switchTab('${t.id}')">${t.label}</div>`
    ).join('');

    // Активируем первую вкладку
    switchTab(tabs[0].id);
}

function switchTab(tabId) {
    currentTab = tabId;

    // Обновляем навигацию
    document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
    const activeTab = document.querySelector(`.nav-tab[data-tab="${tabId}"]`);
    if (activeTab) activeTab.classList.add('active');

    // Загружаем контент
    switch (tabId) {
        case 'new-appointment': loadNewAppointmentForm(); break;
        case 'my-appointments': loadMyAppointments(); break;
        case 'pending-appointments': loadAppointments('pending'); break;
        case 'all-appointments': loadAppointments(''); break;
        case 'dashboard': loadDashboard(); break;
        case 'doctors-manage': loadDoctorsManage(); break;
        case 'users-manage': loadUsersManage(); break;
    }
}

// ==================== ПАЦИЕНТ: ЗАПИСЬ К ВРАЧУ ====================

async function loadNewAppointmentForm() {
    const content = document.getElementById('content');

    try {
        const res = await fetch(`${API}/doctors`, { credentials: 'include' });
        const data = await res.json();
        const doctors = data.doctors || [];

        // Минимальная дата — завтра
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const minDate = tomorrow.toISOString().split('T')[0];

        content.innerHTML = `
            <div class="card" style="max-width:600px;">
                <h2 style="color:#16537e; margin-bottom:20px;">📝 Запись на приём</h2>

                <div class="form-group">
                    <label>Выберите врача *</label>
                    <select id="apt-doctor">
                        <option value="">— Выберите врача —</option>
                        ${doctors.map(d => `<option value="${d.id}">${d.full_name} — ${d.specialty} (каб. ${d.cabinet})</option>`).join('')}
                    </select>
                </div>

                <div class="form-group">
                    <label>Желаемая дата *</label>
                    <input type="date" id="apt-date" min="${minDate}">
                </div>

                <div class="form-group">
                    <label>Желаемое время *</label>
                    <select id="apt-time">
                        <option value="">— Выберите время —</option>
                        <option value="08:00">08:00</option>
                        <option value="08:30">08:30</option>
                        <option value="09:00">09:00</option>
                        <option value="09:30">09:30</option>
                        <option value="10:00">10:00</option>
                        <option value="10:30">10:30</option>
                        <option value="11:00">11:00</option>
                        <option value="11:30">11:30</option>
                        <option value="12:00">12:00</option>
                        <option value="13:00">13:00</option>
                        <option value="13:30">13:30</option>
                        <option value="14:00">14:00</option>
                        <option value="14:30">14:30</option>
                        <option value="15:00">15:00</option>
                        <option value="15:30">15:30</option>
                        <option value="16:00">16:00</option>
                        <option value="16:30">16:30</option>
                        <option value="17:00">17:00</option>
                    </select>
                </div>

                <div class="form-group">
                    <label>Причина обращения</label>
                    <textarea id="apt-reason" placeholder="Опишите кратко причину визита..."></textarea>
                </div>

                <button class="btn btn-primary btn-full" onclick="submitAppointment()">
                    Отправить заявку
                </button>

                <p style="margin-top:12px; font-size:13px; color:#888; text-align:center;">
                    После отправки заявка уйдёт в регистратуру.<br>
                    Вам подтвердят дату и время.
                </p>
            </div>
        `;

    } catch (err) {
        content.innerHTML = '<div class="card"><p>Ошибка загрузки. Попробуйте позже.</p></div>';
    }
}

async function submitAppointment() {
    const doctor_id = document.getElementById('apt-doctor').value;
    const desired_date = document.getElementById('apt-date').value;
    const desired_time = document.getElementById('apt-time').value;
    const reason = document.getElementById('apt-reason').value.trim();

    if (!doctor_id || !desired_date || !desired_time) {
        showToast('Заполните все обязательные поля', 'error');
        return;
    }

    try {
        const res = await fetch(`${API}/appointments`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ doctor_id: parseInt(doctor_id), desired_date, desired_time, reason })
        });

        const data = await res.json();

        if (!res.ok) {
            showToast(data.error || 'Ошибка', 'error');
            return;
        }

        showToast('Заявка отправлена! ✅', 'success');
        switchTab('my-appointments');

    } catch (err) {
        showToast('Ошибка отправки', 'error');
    }
}

// ==================== ПАЦИЕНТ: МОИ ЗАПИСИ ====================

async function loadMyAppointments() {
    const content = document.getElementById('content');
    content.innerHTML = '<p style="text-align:center; padding:40px;">Загрузка...</p>';

    try {
        const res = await fetch(`${API}/appointments`, { credentials: 'include' });
        const data = await res.json();
        const apps = data.appointments || [];

        if (apps.length === 0) {
            content.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">📭</div>
                    <h3>Записей пока нет</h3>
                    <p>Запишитесь к врачу на вкладке "Записаться"</p>
                </div>
            `;
            return;
        }

        content.innerHTML = apps.map(a => `
            <div class="card">
                <div class="card-header">
                    <div class="card-title">👨‍⚕️ ${a.doctor_name}</div>
                    <span class="status status-${a.status}">${statusText(a.status)}</span>
                </div>
                <div class="info-grid">
                    <div class="info-item">
                        <div class="info-label">Специальность</div>
                        <div class="info-value">${a.doctor_specialty}</div>
                    </div>
                    <div class="info-item">
                        <div class="info-label">Кабинет</div>
                        <div class="info-value">${a.doctor_cabinet}</div>
                    </div>
                    <div class="info-item">
                        <div class="info-label">Желаемая дата</div>
                        <div class="info-value">${formatDate(a.desired_date)} в ${a.desired_time}</div>
                    </div>
                    ${a.status === 'approved' ? `
                    <div class="info-item">
                        <div class="info-label">✅ Подтверждённая дата</div>
                        <div class="info-value" style="color:#27ae60; font-weight:700;">
                            ${formatDate(a.approved_date)} в ${a.approved_time}
                        </div>
                    </div>` : ''}
                    ${a.reason ? `
                    <div class="info-item">
                        <div class="info-label">Причина обращения</div>
                        <div class="info-value">${a.reason}</div>
                    </div>` : ''}
                    ${a.comment ? `
                    <div class="info-item">
                        <div class="info-label">Комментарий регистратуры</div>
                        <div class="info-value">${a.comment}</div>
                    </div>` : ''}
                    <div class="info-item">
                        <div class="info-label">Дата заявки</div>
                        <div class="info-value">${a.created_at}</div>
                    </div>
                </div>
                ${a.status === 'pending' ? `
                <div class="card-actions">
                    <button class="btn btn-danger btn-sm" onclick="cancelAppointment(${a.id})">
                        Отменить заявку
                    </button>
                </div>` : ''}
            </div>
        `).join('');

    } catch (err) {
        content.innerHTML = '<div class="card"><p>Ошибка загрузки</p></div>';
    }
}

async function cancelAppointment(id) {
    if (!confirm('Отменить заявку?')) return;

    try {
        const res = await fetch(`${API}/appointments/${id}`, {
            method: 'DELETE',
            credentials: 'include'
        });

        if (res.ok) {
            showToast('Заявка отменена', 'info');
            loadMyAppointments();
        }
    } catch (err) {
        showToast('Ошибка', 'error');
    }
}

// ==================== РЕГИСТРАТУРА: ЗАЯВКИ ====================

async function loadAppointments(statusFilter) {
    const content = document.getElementById('content');
    content.innerHTML = '<p style="text-align:center; padding:40px;">Загрузка...</p>';

    try {
        const url = statusFilter ? `${API}/appointments?status=${statusFilter}` : `${API}/appointments`;
        const res = await fetch(url, { credentials: 'include' });
        const data = await res.json();
        const apps = data.appointments || [];

        if (apps.length === 0) {
            content.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">✅</div>
                    <h3>${statusFilter === 'pending' ? 'Нет ожидающих заявок' : 'Заявок нет'}</h3>
                    <p>Всё чисто!</p>
                </div>
            `;
            return;
        }

        // Фильтры (только для "все заявки")
        let filtersHtml = '';
        if (!statusFilter) {
            filtersHtml = `
                <div class="filters-bar">
                    <span style="font-size:14px; color:#888;">Фильтр:</span>
                    <button class="filter-btn active" onclick="filterAppointments('')">Все</button>
                    <button class="filter-btn" onclick="filterAppointments('pending')">⏳ Ожидающие</button>
                    <button class="filter-btn" onclick="filterAppointments('approved')">✅ Принятые</button>
                    <button class="filter-btn" onclick="filterAppointments('rejected')">❌ Отклонённые</button>
                </div>
            `;
        }

        content.innerHTML = filtersHtml + apps.map(a => `
            <div class="card appointment-card" data-status="${a.status}">
                <div class="card-header">
                    <div>
                        <div class="card-title">👤 ${a.patient_name}</div>
                        <div style="font-size:13px; color:#888; margin-top:4px;">📞 ${a.patient_phone || 'Не указан'}</div>
                    </div>
                    <span class="status status-${a.status}">${statusText(a.status)}</span>
                </div>

                <div class="info-grid">
                    <div class="info-item">
                        <div class="info-label">Врач</div>
                        <div class="info-value">${a.doctor_name} (${a.doctor_specialty})</div>
                    </div>
                    <div class="info-item">
                        <div class="info-label">Кабинет</div>
                        <div class="info-value">${a.doctor_cabinet}</div>
                    </div>
                    <div class="info-item">
                        <div class="info-label">Желаемая дата</div>
                        <div class="info-value">${formatDate(a.desired_date)} в ${a.desired_time}</div>
                    </div>
                    ${a.reason ? `
                    <div class="info-item">
                        <div class="info-label">Причина</div>
                        <div class="info-value">${a.reason}</div>
                    </div>` : ''}
                    ${a.approved_date ? `
                    <div class="info-item">
                        <div class="info-label">Подтверждённая дата</div>
                        <div class="info-value" style="color:#27ae60; font-weight:700;">${formatDate(a.approved_date)} в ${a.approved_time}</div>
                    </div>` : ''}
                    ${a.comment ? `
                    <div class="info-item">
                        <div class="info-label">Комментарий</div>
                        <div class="info-value">${a.comment}</div>
                    </div>` : ''}
                    <div class="info-item">
                        <div class="info-label">Создана</div>
                        <div class="info-value">${a.created_at}</div>
                    </div>
                </div>

                ${a.status === 'pending' ? `
                <div class="card-actions">
                    <button class="btn btn-success btn-sm" onclick="openApproveModal(${a.id}, '${a.desired_date}', '${a.desired_time}')">
                        ✅ Принять
                    </button>
                    <button class="btn btn-danger btn-sm" onclick="openRejectModal(${a.id})">
                        ❌ Отклонить
                    </button>
                </div>` : ''}
            </div>
        `).join('');

    } catch (err) {
        content.innerHTML = '<div class="card"><p>Ошибка загрузки</p></div>';
    }
}

function filterAppointments(status) {
    // Клиентская фильтрация
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    event.target.classList.add('active');

    document.querySelectorAll('.appointment-card').forEach(card => {
        if (!status || card.dataset.status === status) {
            card.style.display = 'block';
        } else {
            card.style.display = 'none';
        }
    });
}

// Модалка одобрения
function openApproveModal(id, defaultDate, defaultTime) {
    const modal = document.getElementById('modal-content');
    modal.innerHTML = `
        <h2>✅ Подтверждение записи</h2>
        <p style="margin-bottom:16px; color:#666;">Укажите подтверждённую дату и время (можно изменить)</p>

        <div class="form-group">
            <label>Дата приёма</label>
            <input type="date" id="approve-date" value="${defaultDate}">
        </div>
        <div class="form-group">
            <label>Время приёма</label>
            <input type="time" id="approve-time" value="${defaultTime}">
        </div>
        <div class="form-group">
            <label>Комментарий (необязательно)</label>
            <textarea id="approve-comment" placeholder="Например: Приходите за 10 минут до приёма"></textarea>
        </div>

        <div class="modal-actions">
            <button class="btn btn-success" onclick="approveAppointment(${id})">Подтвердить</button>
            <button class="btn btn-outline" onclick="closeModal()">Отмена</button>
        </div>
    `;
    document.getElementById('modal-overlay').style.display = 'flex';
}

// Модалка отклонения
function openRejectModal(id) {
    const modal = document.getElementById('modal-content');
    modal.innerHTML = `
        <h2>❌ Отклонение заявки</h2>

        <div class="form-group">
            <label>Причина отклонения</label>
            <textarea id="reject-comment" placeholder="Укажите причину..."></textarea>
        </div>

        <div class="modal-actions">
            <button class="btn btn-danger" onclick="rejectAppointment(${id})">Отклонить</button>
            <button class="btn btn-outline" onclick="closeModal()">Отмена</button>
        </div>
    `;
    document.getElementById('modal-overlay').style.display = 'flex';
}

async function approveAppointment(id) {
    const approved_date = document.getElementById('approve-date').value;
    const approved_time = document.getElementById('approve-time').value;
    const comment = document.getElementById('approve-comment').value.trim();

    if (!approved_date || !approved_time) {
        showToast('Укажите дату и время', 'error');
        return;
    }

    try {
        const res = await fetch(`${API}/appointments/${id}/approve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ approved_date, approved_time, comment })
        });

        if (res.ok) {
            showToast('Заявка одобрена ✅', 'success');
            closeModal();
            switchTab(currentTab);
        }
    } catch (err) {
        showToast('Ошибка', 'error');
    }
}

async function rejectAppointment(id) {
    const comment = document.getElementById('reject-comment').value.trim();

    try {
        const res = await fetch(`${API}/appointments/${id}/reject`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ comment: comment || 'Отклонено регистратурой' })
        });

        if (res.ok) {
            showToast('Заявка отклонена', 'info');
            closeModal();
            switchTab(currentTab);
        }
    } catch (err) {
        showToast('Ошибка', 'error');
    }
}

function closeModal() {
    document.getElementById('modal-overlay').style.display = 'none';
}

// Закрытие модалки по клику на оверлей
document.getElementById('modal-overlay').addEventListener('click', function (e) {
    if (e.target === this) closeModal();
});

// ==================== АДМИН: ДАШБОРД ====================

async function loadDashboard() {
    const content = document.getElementById('content');

    try {
        const res = await fetch(`${API}/stats`, { credentials: 'include' });
        const s = await res.json();

        content.innerHTML = `
            <h2 style="margin-bottom:20px; color:#16537e;">📊 Панель управления</h2>

            <div class="stats-grid">
                <div class="stat-card">
                    <div class="stat-number">${s.total_users}</div>
                    <div class="stat-label">Пользователей</div>
                </div>
                <div class="stat-card">
                    <div class="stat-number">${s.total_doctors}</div>
                    <div class="stat-label">Врачей</div>
                </div>
                <div class="stat-card">
                    <div class="stat-number">${s.total_appointments}</div>
                    <div class="stat-label">Всего заявок</div>
                </div>
                <div class="stat-card">
                    <div class="stat-number" style="color:#f39c12;">${s.pending}</div>
                    <div class="stat-label">Ожидают</div>
                </div>
                <div class="stat-card">
                    <div class="stat-number" style="color:#27ae60;">${s.approved}</div>
                    <div class="stat-label">Одобрено</div>
                </div>
                <div class="stat-card">
                    <div class="stat-number" style="color:#e74c3c;">${s.rejected}</div>
                    <div class="stat-label">Отклонено</div>
                </div>
            </div>
        `;

    } catch (err) {
        content.innerHTML = '<div class="card"><p>Ошибка загрузки статистики</p></div>';
    }
}

// ==================== АДМИН: ВРАЧИ ====================

async function loadDoctorsManage() {
    const content = document.getElementById('content');

    try {
        const res = await fetch(`${API}/doctors`, { credentials: 'include' });
        const data = await res.json();
        const doctors = data.doctors || [];

        content.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px;">
                <h2 style="color:#16537e;">👨‍⚕️ Управление врачами</h2>
                <button class="btn btn-primary btn-sm" onclick="openAddDoctorModal()">+ Добавить врача</button>
            </div>

            ${doctors.map(d => `
                <div class="card" style="display:flex; justify-content:space-between; align-items:center;">
                    <div>
                        <strong>${d.full_name}</strong><br>
                        <span style="color:#888; font-size:14px;">${d.specialty} | Кабинет ${d.cabinet}</span>
                    </div>
                    <button class="btn btn-danger btn-sm" onclick="deleteDoctor(${d.id})">Удалить</button>
                </div>
            `).join('')}
        `;

    } catch (err) {
        content.innerHTML = '<div class="card"><p>Ошибка</p></div>';
    }
}

function openAddDoctorModal() {
    const modal = document.getElementById('modal-content');
    modal.innerHTML = `
        <h2>Добавить врача</h2>
        <div class="form-group">
            <label>ФИО</label>
            <input type="text" id="doc-name" placeholder="Фамилия Имя Отчество">
        </div>
        <div class="form-group">
            <label>Специальность</label>
            <input type="text" id="doc-specialty" placeholder="Терапевт, Хирург...">
        </div>
        <div class="form-group">
            <label>Кабинет</label>
            <input type="text" id="doc-cabinet" placeholder="101">
        </div>
        <div class="modal-actions">
            <button class="btn btn-primary" onclick="addDoctor()">Добавить</button>
            <button class="btn btn-outline" onclick="closeModal()">Отмена</button>
        </div>
    `;
    document.getElementById('modal-overlay').style.display = 'flex';
}

async function addDoctor() {
    const full_name = document.getElementById('doc-name').value.trim();
    const specialty = document.getElementById('doc-specialty').value.trim();
    const cabinet = document.getElementById('doc-cabinet').value.trim();

    if (!full_name || !specialty) {
        showToast('Заполните ФИО и специальность', 'error');
        return;
    }

    try {
        const res = await fetch(`${API}/doctors`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ full_name, specialty, cabinet })
        });

        if (res.ok) {
            showToast('Врач добавлен', 'success');
            closeModal();
            loadDoctorsManage();
        }
    } catch (err) {
        showToast('Ошибка', 'error');
    }
}

async function deleteDoctor(id) {
    if (!confirm('Удалить врача?')) return;

    try {
        const res = await fetch(`${API}/doctors/${id}`, {
            method: 'DELETE',
            credentials: 'include'
        });

        if (res.ok) {
            showToast('Врач удалён', 'info');
            loadDoctorsManage();
        }
    } catch (err) {
        showToast('Ошибка', 'error');
    }
}

// ==================== АДМИН: ПОЛЬЗОВАТЕЛИ ====================

async function loadUsersManage() {
    const content = document.getElementById('content');

    try {
        const res = await fetch(`${API}/users`, { credentials: 'include' });
        const data = await res.json();
        const users = data.users || [];

        const roleNames = { admin: '👑 Админ', registrar: '📋 Регистратура', citizen: '👤 Пациент' };

        content.innerHTML = `
            <h2 style="color:#16537e; margin-bottom:20px;">👥 Пользователи</h2>
            <table class="users-table">
                <thead>
                    <tr>
                        <th>ID</th>
                        <th>ФИО</th>
                        <th>Логин</th>
                        <th>Телефон</th>
                        <th>Роль</th>
                        <th>Дата рег.</th>
                        <th>Действия</th>
                    </tr>
                </thead>
                <tbody>
                    ${users.map(u => `
                        <tr>
                            <td>${u.id}</td>
                            <td><strong>${u.full_name}</strong></td>
                            <td>${u.username}</td>
                            <td>${u.phone || '—'}</td>
                            <td>${roleNames[u.role] || u.role}</td>
                            <td>${u.created_at}</td>
                            <td>
                                <select onchange="changeUserRole(${u.id}, this.value)" style="padding:4px 8px; border-radius:6px; border:1px solid #ddd; font-size:12px;">
                                    <option value="citizen" ${u.role === 'citizen' ? 'selected' : ''}>Пациент</option>
                                    <option value="registrar" ${u.role === 'registrar' ? 'selected' : ''}>Регистратура</option>
                                    <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Админ</option>
                                </select>
                            </td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;

    } catch (err) {
        content.innerHTML = '<div class="card"><p>Ошибка</p></div>';
    }
}

async function changeUserRole(userId, newRole) {
    try {
        const res = await fetch(`${API}/users/${userId}/role`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ role: newRole })
        });

        if (res.ok) {
            showToast('Роль изменена', 'success');
        }
    } catch (err) {
        showToast('Ошибка', 'error');
    }
}

// ==================== УТИЛИТЫ ====================

function statusText(status) {
    const map = {
        pending: '⏳ Ожидает',
        approved: '✅ Подтверждено',
        rejected: '❌ Отклонено'
    };
    return map[status] || status;
}

function formatDate(dateStr) {
    if (!dateStr) return '';
    const parts = dateStr.split('-');
    if (parts.length === 3) return `${parts[2]}.${parts[1]}.${parts[0]}`;
    return dateStr;
}

function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
}

// ==================== ПРОВЕРКА СЕССИИ ПРИ ЗАГРУЗКЕ ====================

window.addEventListener('load', () => {
    const saved = localStorage.getItem('user');
    if (saved) {
        currentUser = JSON.parse(saved);
        showMainScreen();
    }
});
