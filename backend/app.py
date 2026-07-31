import os
from flask import Flask, request, jsonify
from flask_cors import CORS
from flask_login import LoginManager, login_user, logout_user, login_required, current_user
from werkzeug.security import generate_password_hash, check_password_hash
from models import db, User, Doctor, Appointment

app = Flask(__name__)
app.config['SECRET_KEY'] = 'medical-registry-secret-key-2024'
app.config['SQLALCHEMY_DATABASE_URI'] = os.environ.get('DATABASE_URL', 'sqlite:///medical.db')
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
app.config['SESSION_COOKIE_SAMESITE'] = 'None'
app.config['SESSION_COOKIE_SECURE'] = True

CORS(app, supports_credentials=True, origins="*")

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
    db.create_all()
    if User.query.first():
        return

    admin = User(
        username='shvets',
        password_hash=generate_password_hash('Admin2024!'),
        full_name='Швец О.В.',
        role='admin',
        phone='+7-999-000-00-01'
    )
    registrar = User(
        username='registratura',
        password_hash=generate_password_hash('Reg2024!'),
        full_name='Иванова М.А.',
        role='registrar',
        phone='+7-999-000-00-02'
    )
    citizen = User(
        username='petrov',
        password_hash=generate_password_hash('User2024!'),
        full_name='Петров Иван Сергеевич',
        role='citizen',
        phone='+7-999-000-00-03'
    )
    db.session.add_all([admin, registrar, citizen])

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


@app.route('/')
def home():
    return jsonify({'status': 'ok', 'message': 'API работает!'})


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
        'message': 'OK',
        'user': {'id': user.id, 'username': user.username, 'full_name': user.full_name,
                 'role': user.role, 'phone': user.phone}
    })


@app.route('/api/register', methods=['POST'])
def register():
    data = request.get_json()
    username = data.get('username', '').strip()
    password = data.get('password', '')
    full_name = data.get('full_name', '').strip()
    phone = data.get('phone', '').strip()
    if not username or not password or not full_name:
        return jsonify({'error': 'Заполните все поля'}), 400
    if len(password) < 6:
        return jsonify({'error': 'Пароль минимум 6 символов'}), 400
    if User.query.filter_by(username=username).first():
        return jsonify({'error': 'Логин занят'}), 400
    user = User(username=username, password_hash=generate_password_hash(password),
                full_name=full_name, role='citizen', phone=phone)
    db.session.add(user)
    db.session.commit()
    login_user(user, remember=True)
    return jsonify({
        'message': 'OK',
        'user': {'id': user.id, 'username': user.username, 'full_name': user.full_name,
                 'role': user.role, 'phone': user.phone}
    })


@app.route('/api/logout', methods=['POST'])
@login_required
def logout():
    logout_user()
    return jsonify({'message': 
