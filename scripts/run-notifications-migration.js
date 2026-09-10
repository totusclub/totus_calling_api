// Миграция хаба уведомлений: node scripts/run-notifications-migration.js
// Создаёт таблицы push_devices, notifications, notification_settings, push_campaigns,
// push_reminder_rules, push_reminder_log в той же MySQL kedam (DB_* из .env).
// Идемпотентна (CREATE TABLE IF NOT EXISTS). После неё: pm2 restart api_calling.
// План: claude/PUSH_NOTIFICATIONS_PLAN_RU.md §2.
'use strict';

const { pool } = require('../db');

const DDL = [
  `CREATE TABLE IF NOT EXISTS push_devices (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    platform ENUM('ios','android','web','desktop') NOT NULL,
    channel ENUM('fcm','webpush') NOT NULL,
    token VARCHAR(4096) NOT NULL,
    subscription JSON NULL,
    device_id VARCHAR(64) NULL,
    device_name VARCHAR(64) NULL,
    app_version VARCHAR(32) NULL,
    locale VARCHAR(8) NULL,
    enabled TINYINT(1) NOT NULL DEFAULT 1,
    fail_count INT NOT NULL DEFAULT 0,
    last_seen_at DATETIME NULL,
    last_push_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_token (token(191)),
    KEY idx_user (user_id, enabled),
    KEY idx_device (device_id, platform)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,

  `CREATE TABLE IF NOT EXISTS notifications (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    type VARCHAR(48) NOT NULL,
    category VARCHAR(24) NOT NULL DEFAULT 'system',
    title VARCHAR(160) NOT NULL,
    body VARCHAR(512) NOT NULL,
    data JSON NULL,
    source VARCHAR(64) NOT NULL DEFAULT 'system',
    campaign_id INT NULL,
    rule_id INT NULL,
    inapp TINYINT(1) NOT NULL DEFAULT 1,
    push_status ENUM('none','pending','deferred','sent','failed','no_devices','skipped') NOT NULL DEFAULT 'none',
    push_sent INT NOT NULL DEFAULT 0,
    push_failed INT NOT NULL DEFAULT 0,
    deliver_after DATETIME NULL,
    pushed_at DATETIME NULL,
    read_at DATETIME NULL,
    opened_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_user_id (user_id, id),
    KEY idx_user_unread (user_id, read_at),
    KEY idx_created (created_at),
    KEY idx_campaign (campaign_id),
    KEY idx_rule (rule_id),
    KEY idx_deferred (push_status, deliver_after)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,

  `CREATE TABLE IF NOT EXISTS notification_settings (
    user_id INT PRIMARY KEY,
    prefs JSON NOT NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,

  `CREATE TABLE IF NOT EXISTS push_campaigns (
    id INT AUTO_INCREMENT PRIMARY KEY,
    staff_id INT NULL,
    staff_name VARCHAR(128) NULL,
    title VARCHAR(160) NOT NULL,
    body VARCHAR(512) NOT NULL,
    type VARCHAR(48) NOT NULL DEFAULT 'promo',
    data JSON NULL,
    segment JSON NULL,
    status ENUM('draft','scheduled','sending','sent','failed','cancelled') NOT NULL DEFAULT 'draft',
    respect_quiet TINYINT(1) NOT NULL DEFAULT 1,
    scheduled_at DATETIME NULL,
    audience_count INT NOT NULL DEFAULT 0,
    device_count INT NOT NULL DEFAULT 0,
    sent_count INT NOT NULL DEFAULT 0,
    failed_count INT NOT NULL DEFAULT 0,
    error VARCHAR(255) NULL,
    started_at DATETIME NULL,
    finished_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY idx_status_sched (status, scheduled_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,

  `CREATE TABLE IF NOT EXISTS push_reminder_rules (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(120) NOT NULL,
    enabled TINYINT(1) NOT NULL DEFAULT 1,
    event ENUM('departure','checkin','trip_end','order_created') NOT NULL DEFAULT 'departure',
    offset_value INT NOT NULL DEFAULT 1,
    offset_unit ENUM('hours','days') NOT NULL DEFAULT 'days',
    offset_direction ENUM('before','after') NOT NULL DEFAULT 'before',
    send_time VARCHAR(5) NULL,
    quiet_behavior ENUM('shift','skip','send') NOT NULL DEFAULT 'shift',
    type VARCHAR(48) NOT NULL DEFAULT 'trip_reminder',
    title VARCHAR(160) NOT NULL,
    body VARCHAR(512) NOT NULL,
    channels JSON NULL,
    audience ENUM('paid','all') NOT NULL DEFAULT 'paid',
    sent_count INT NOT NULL DEFAULT 0,
    last_run_at DATETIME NULL,
    last_sent_at DATETIME NULL,
    created_by VARCHAR(128) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,

  `CREATE TABLE IF NOT EXISTS push_reminder_log (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    rule_id INT NOT NULL,
    order_id VARCHAR(64) NOT NULL,
    user_id INT NULL,
    status VARCHAR(24) NOT NULL DEFAULT 'sent',
    notification_id BIGINT NULL,
    sent_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_rule_order (rule_id, order_id),
    KEY idx_user (user_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
];

// Стартовые правила напоминаний (только если таблица пустая) — редактируются в Totus_admin
const SEED_RULES = [
  ['За 3 дня до вылета', 'departure', 3, 'days', 'before', '10:00', 'shift', 'trip_reminder',
    'До поездки 3 дня', 'Вылет {дата_вылета} в {время_вылета}, {аэропорт}. Проверьте документы по заказу №{номер} в приложении.',
    JSON.stringify({ push: true, inapp: true, email: false }), 'paid'],
  ['За сутки до вылета', 'departure', 24, 'hours', 'before', null, 'shift', 'trip_reminder',
    'Вылет завтра', 'Завтра в {время_вылета} — {аэропорт} → {город}. Хорошей поездки! Документы по заказу №{номер} — в приложении.',
    JSON.stringify({ push: true, inapp: true, email: false }), 'paid'],
];

async function run() {
  for (const sql of DDL) {
    const name = /TABLE IF NOT EXISTS (\w+)/.exec(sql)[1];
    await pool.query(sql);
    console.log(`✅ ${name}`);
  }
  const [[cnt]] = await pool.query('SELECT COUNT(*) AS n FROM push_reminder_rules');
  if (Number(cnt.n) === 0) {
    for (const r of SEED_RULES) {
      await pool.query(
        `INSERT INTO push_reminder_rules (name, event, offset_value, offset_unit, offset_direction, send_time, quiet_behavior, type, title, body, channels, audience, enabled, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'migration')`,
        r,
      );
    }
    console.log(`✅ seeded ${SEED_RULES.length} reminder rules (disabled — включить в Totus_admin → Уведомления → Напоминания)`);
  }
  console.log('Done. Now: pm2 restart api_calling');
  await pool.end();
}

run().catch((e) => {
  console.error('❌ migration failed:', e.message);
  process.exit(1);
});
