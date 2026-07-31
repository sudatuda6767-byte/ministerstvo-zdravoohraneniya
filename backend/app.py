import os
from flask import Flask, request, jsonify, session
from flask_cors import CORS
from flask_login import LoginManager, login_user, logout_user, login_required, current_user
from werkzeug.security import generate_password_hash, check_password_hash
from models import db, User, Doctor, Appointment
from datetime import datetime

app = Flask(__name__)
app.config['SECRET_KEY'] = 'medical-registry-secret-key-2024'
app.config['SQLALCHEMY_DATABASE_URI'] = os.environ.get('DATABASE_URL', 'sqlite:///medical.db')
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
app.config['SESSION_COOKIE_SAMESITE'] = 'None'
app.config['SESSION_COOKIE_SECURE'] = True

CORS(app, supports_credentials=True, origins=["*"])

db.init_app(app)
login_manager = LoginManager()
login_manager.init_app(app)


@login_manager.user_loader
def load_user(user_id):
    return User.query.get(int(user_id))


@login_manager.unauthorized_handler
def unauthorized():
    return jsonify({'error': 'Необходима авторизация'}), 401


def init_db():
    """Создание базы и тестовых данных"""
    db.create_all()

    # Проверяем, есть ли уже данные
    if User.query.first():
        return

    # === ТЕСТОВЫЕ ПОЛЬЗОВАТЕЛИ ===

    # 1. Админ — Швец О.В.
    admin = User(
        username='shvets',
        password_hash=generate_password_hash('Admin2024!'),
        full_name='Швец О.В.',
        role='admin',
        phone='+7-999-000-00-01'
    )

    # 2. Регистратура
    registrar = User(
        username='registratura',
        password_hash=generate_password_hash('Reg2024!'),
        full_name='Иванова М.А.',
        role='registrar',
        phone='+7-999-000-00-02'
    )

    # 3. Гражданин (пациент)
    citizen = User(
        username='petrov',
        password_hash=generate_password_hash('User2024!'),
        full_name='Петров Иван Сергеевич',
        role='citizen',
        phone='+7-999-000-00-03'
    )

    db.session.add_all([admin, registrar, citizen])

    # === ТЕСТОВЫЕ ВРАЧИ ===
    doctors = [
        Doctor(full_name='Смирнова Елена Павловна', specialty='Терапевт', cabinet='101'),
        Doctor(full_name='Козлов Дмитрий Андреевич', specialty='Хирург', cabinet='205'),
        Doctor(full_name='Волкова Анна Игоревна', specialty='Офтальмолог', cabinet='303'),
        Doctor(full_name='Новиков Сергей Валерьевич', specialty='Кардиолог', cabinet='110'),
        Doctor(full_name='Морозова Ольга Николаевна', specialty='Невролог', cabinet='208'),
        Doctor(full_name='Соколов Артём Викторович', specialty='ЛОР', cabinet='115'),
        Doctor(full_name='Лебедева Татьяна Юрьевна', specialty='Дерматолог', cabinet='312'),
    ]

    db.session.add_all(doctors)
    db.session.commit()
    print("База данных инициализирована!")


# ==================== АВТОРИЗАЦИЯ ====================

@app.route('/api/login', methods=['POST'])
def login():
    data = request.get_json()
    username = data.get('username', '').strip()
    password = data.get('password', '')

    user = User.query.filter_by(username=username).first()

    if not user or not check_password_hash(user.password_hash, password):
        return jsonify({'error': 'Неверный логин или пароль'}), 401

    login_user(user, remember=True)

    return jsonify({
        'message': 'Успешный вход',
        'user': {
            'id': user.id,
            'username': user.username,
            'full_name': user.full_name,
            'role': user.role,
            'phone': user.phone
        }
    })


@app.route('/api/register', methods=['POST'])
def register():
    data = request.get_json()
    username = data.get('username', '').strip()
    password = data.get('password', '')
    full_name = data.get('full_name', '').strip()
    phone = data.get('phone', '').strip()

    if not username or not password or not full_name:
        return jsonify({'error': 'Заполните все обязательные поля'}), 400

    if len(password) < 6:
        return jsonify({'error': 'Пароль минимум 6 символов'}), 400

    if User.query.filter_by(username=username).first():
        return jsonify({'error': 'Такой логин уже занят'}), 400

    user = User(
        username=username,
        password_hash=generate_password_hash(password),
        full_name=full_name,
        role='citizen',
        phone=phone
    )

    db.session.add(user)
    db.session.commit()

    login_user(user, remember=True)

    return jsonify({
        'message': 'Регистрация успешна',
        'user': {
            'id': user.id,
            'username': user.username,
            'full_name': user.full_name,
            'role': user.role,
            'phone': user.phone
        }
    })


@app.route('/api/logout', methods=['POST'])
@login_required
def logout():
    logout_user()
    return jsonify({'message': 'Вы вышли из системы'})


@app.route('/api/me', methods=['GET'])
@login_required
def me():
    return jsonify({
        'user': {
            'id': current_user.id,
            'username': current_user.username,
            'full_name': current_user.full_name,
            'role': current_user.role,
            'phone': current_user.phone
        }
    })


# ==================== ВРАЧИ ====================

@app.route('/api/doctors', methods=['GET'])
@login_required
def get_doctors():
    doctors = Doctor.query.filter_by(is_active=True).all()
    return jsonify({
        'doctors': [{
            'id': d.id,
            'full_name': d.full_name,
            'specialty': d.specialty,
            'cabinet': d.cabinet
        } for d in doctors]
    })


@app.route('/api/doctors', methods=['POST'])
@login_required
def add_doctor():
    if current_user.role != 'admin':
        return jsonify({'error': 'Недостаточно прав'}), 403

    data = request.get_json()
    doctor = Doctor(
        full_name=data.get('full_name', ''),
        specialty=data.get('specialty', ''),
        cabinet=data.get('cabinet', '')
    )
    db.session.add(doctor)
    db.session.commit()

    return jsonify({'message': 'Врач добавлен', 'id': doctor.id})


@app.route('/api/doctors/<int:doctor_id>', methods=['DELETE'])
@login_required
def delete_doctor(doctor_id):
    if current_user.role != 'admin':
        return jsonify({'error': 'Недостаточно прав'}), 403

    doctor = Doctor.query.get_or_404(doctor_id)
    doctor.is_active = False
    db.session.commit()

    return jsonify({'message': 'Врач удалён'})


# ==================== ЗАПИСИ (APPOINTMENTS) ====================

@app.route('/api/appointments', methods=['POST'])
@login_required
def create_appointment():
    """Гражданин создаёт заявку на запись к врачу"""
    if current_user.role not in ['citizen', 'admin']:
        return jsonify({'error': 'Только пациенты могут записываться'}), 403

    data = request.get_json()
    doctor_id = data.get('doctor_id')
    desired_date = data.get('desired_date', '')
    desired_time = data.get('desired_time', '')
    reason = data.get('reason', '')

    if not doctor_id or not desired_date or not desired_time:
        return jsonify({'error': 'Заполните все поля'}), 400

    doctor = Doctor.query.get(doctor_id)
    if not doctor:
        return jsonify({'error': 'Врач не найден'}), 404

    appointment = Appointment(
        patient_id=current_user.id,
        doctor_id=doctor_id,
        desired_date=desired_date,
        desired_time=desired_time,
        reason=reason,
        status='pending'
    )

    db.session.add(appointment)
    db.session.commit()

    return jsonify({'message': 'Заявка отправлена! Ожидайте подтверждения регистратуры.', 'id': appointment.id})


@app.route('/api/appointments', methods=['GET'])
@login_required
def get_appointments():
    """Получить заявки в зависимости от роли"""

    if current_user.role == 'citizen':
        # Гражданин видит только свои заявки
        apps = Appointment.query.filter_by(patient_id=current_user.id)\
            .order_by(Appointment.created_at.desc()).all()

    elif current_user.role in ['registrar', 'admin']:
        # Регистратура и админ видят все заявки
        status_filter = request.args.get('status', '')
        query = Appointment.query

        if status_filter:
            query = query.filter_by(status=status_filter)

        apps = query.order_by(Appointment.created_at.desc()).all()
    else:
        return jsonify({'error': 'Нет доступа'}), 403

    result = []
    for a in apps:
        patient = User.query.get(a.patient_id)
        doctor = Doctor.query.get(a.doctor_id)
        result.append({
            'id': a.id,
            'patient_name': patient.full_name if patient else 'Неизвестно',
            'patient_phone': patient.phone if patient else '',
            'doctor_name': doctor.full_name if doctor else 'Неизвестно',
            'doctor_specialty': doctor.specialty if doctor else '',
            'doctor_cabinet': doctor.cabinet if doctor else '',
            'desired_date': a.desired_date,
            'desired_time': a.desired_time,
            'approved_date': a.approved_date or '',
            'approved_time': a.approved_time or '',
            'status': a.status,
            'reason': a.reason or '',
            'comment': a.comment or '',
            'created_at': a.created_at.strftime('%d.%m.%Y %H:%M') if a.created_at else ''
        })

    return jsonify({'appointments': result})


@app.route('/api/appointments/<int:app_id>/approve', methods=['POST'])
@login_required
def approve_appointment(app_id):
    """Регистратура ВРУЧНУЮ одобряет заявку"""
    if current_user.role not in ['registrar', 'admin']:
        return jsonify({'error': 'Недостаточно прав'}), 403

    appointment = Appointment.query.get_or_404(app_id)
    data = request.get_json()

    appointment.status = 'approved'
    appointment.approved_date = data.get('approved_date', appointment.desired_date)
    appointment.approved_time = data.get('approved_time', appointment.desired_time)
    appointment.comment = data.get('comment', '')

    db.session.commit()

    return jsonify({'message': 'Заявка одобрена'})


@app.route('/api/appointments/<int:app_id>/reject', methods=['POST'])
@login_required
def reject_appointment(app_id):
    """Регистратура ВРУЧНУЮ отклоняет заявку"""
    if current_user.role not in ['registrar', 'admin']:
        return jsonify({'error': 'Недостаточно прав'}), 403

    appointment = Appointment.query.get_or_404(app_id)
    data = request.get_json()

    appointment.status = 'rejected'
    appointment.comment = data.get('comment', 'Отклонено регистратурой')

    db.session.commit()

    return jsonify({'message': 'Заявка отклонена'})


@app.route('/api/appointments/<int:app_id>', methods=['DELETE'])
@login_required
def cancel_appointment(app_id):
    """Пациент отменяет свою заявку или админ удаляет"""
    appointment = Appointment.query.get_or_404(app_id)

    if current_user.role == 'citizen' and appointment.patient_id != current_user.id:
        return jsonify({'error': 'Это не ваша заявка'}), 403

    if current_user.role not in ['citizen', 'admin', 'registrar']:
        return jsonify({'error': 'Нет прав'}), 403

    db.session.delete(appointment)
    db.session.commit()

    return jsonify({'message': 'Заявка отменена'})


# ==================== АДМИН: УПРАВЛЕНИЕ ПОЛЬЗОВАТЕЛЯМИ ====================

@app.route('/api/users', methods=['GET'])
@login_required
def get_users():
    if current_user.role != 'admin':
        return jsonify({'error': 'Недостаточно прав'}), 403

    users = User.query.all()
    return jsonify({
        'users': [{
            'id': u.id,
            'username': u.username,
            'full_name': u.full_name,
            'role': u.role,
            'phone': u.phone,
            'created_at': u.created_at.strftime('%d.%m.%Y') if u.created_at else ''
        } for u in users]
    })


@app.route('/api/users/<int:user_id>/role', methods=['PUT'])
@login_required
def change_role(user_id):
    if current_user.role != 'admin':
        return jsonify({'error': 'Недостаточно прав'}), 403

    user = User.query.get_or_404(user_id)
    data = request.get_json()
    new_role = data.get('role', '')

    if new_role not in ['citizen', 'registrar', 'admin']:
        return jsonify({'error': 'Некорректная роль'}), 400

    user.role = new_role
    db.session.commit()

    return jsonify({'message': f'Роль изменена на {new_role}'})


# ==================== СТАТИСТИКА (для админа) ====================

@app.route('/api/stats', methods=['GET'])
@login_required
def get_stats():
    if current_user.role != 'admin':
        return jsonify({'error': 'Недостаточно прав'}), 403

    total_users = User.query.count()
    total_appointments = Appointment.query.count()
    pending = Appointment.query.filter_by(status='pending').count()
    approved = Appointment.query.filter_by(status='approved').count()
    rejected = Appointment.query.filter_by(status='rejected').count()
    total_doctors = Doctor.query.filter_by(is_active=True).count()

    return jsonify({
        'total_users': total_users,
        'total_appointments': total_appointments,
        'pending': pending,
        'approved': approved,
        'rejected': rejected,
        'total_doctors': total_doctors
    })


if __name__ == '__main__':
    with app.app_context():
        init_db()
    app.run(debug=True, port=5000)
