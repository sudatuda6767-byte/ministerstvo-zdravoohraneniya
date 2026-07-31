from flask_sqlalchemy import SQLAlchemy
from flask_login import UserMixin
from datetime import datetime

db = SQLAlchemy()


class User(UserMixin, db.Model):
    __tablename__ = 'users'

    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(100), unique=True, nullable=False)
    password_hash = db.Column(db.String(256), nullable=False)
    full_name = db.Column(db.String(200), nullable=False)
    role = db.Column(db.String(20), nullable=False)  # admin, registrar, citizen
    phone = db.Column(db.String(20), default='')
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    # Заявки от граждан
    appointments = db.relationship('Appointment', backref='patient', lazy=True,
                                   foreign_keys='Appointment.patient_id')


class Doctor(db.Model):
    __tablename__ = 'doctors'

    id = db.Column(db.Integer, primary_key=True)
    full_name = db.Column(db.String(200), nullable=False)
    specialty = db.Column(db.String(100), nullable=False)
    cabinet = db.Column(db.String(20), default='')
    is_active = db.Column(db.Boolean, default=True)


class Appointment(db.Model):
    __tablename__ = 'appointments'

    id = db.Column(db.Integer, primary_key=True)
    patient_id = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=False)
    doctor_id = db.Column(db.Integer, db.ForeignKey('doctors.id'), nullable=False)
    desired_date = db.Column(db.String(10), nullable=False)       # Желаемая дата
    desired_time = db.Column(db.String(5), nullable=False)        # Желаемое время
    approved_date = db.Column(db.String(10), default='')          # Утверждённая дата
    approved_time = db.Column(db.String(5), default='')           # Утверждённое время
    status = db.Column(db.String(20), default='pending')
    # pending = ожидает, approved = принята, rejected = отклонена
    comment = db.Column(db.Text, default='')                      # Комментарий регистратуры
    reason = db.Column(db.Text, default='')                       # Причина обращения
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    doctor = db.relationship('Doctor', backref='appointments')
