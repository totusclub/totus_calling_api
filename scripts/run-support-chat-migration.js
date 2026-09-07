// Миграция Support Chat: node scripts/run-support-chat-migration.js
// Создаёт таблицы support_chats и support_messages в той же MySQL kedam (DB_* из .env).
// Идемпотентна (CREATE TABLE IF NOT EXISTS). После неё: pm2 restart api_calling.
'use strict';

const { pool } = require('../db');

const DDL = [
  `CREATE TABLE IF NOT EXISTS support_chats (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    status ENUM('open','pending','closed') NOT NULL DEFAULT 'open',
    assigned_role ENUM('staff','agent') NULL,
    assigned_id INT NULL,
    subject VARCHAR(255) NULL,
    order_id VARCHAR(64) NULL,
    last_message_id BIGINT NULL,
    last_message_at DATETIME NULL,
    last_message_preview VARCHAR(255) NULL,
    user_unread INT NOT NULL DEFAULT 0,
    staff_unread INT NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY idx_user (user_id),
    KEY idx_status_last (status, last_message_at),
    KEY idx_assigned (assigned_role, assigned_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
  `CREATE TABLE IF NOT EXISTS support_messages (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    chat_id INT NOT NULL,
    sender_role ENUM('user','staff','agent','system') NOT NULL,
    sender_id INT NOT NULL,
    sender_name VARCHAR(128) NULL,
    body TEXT NOT NULL,
    meta JSON NULL,
    client_msg_id VARCHAR(64) NULL,
    read_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_chat_id (chat_id, id),
    UNIQUE KEY uq_client (chat_id, client_msg_id),
    CONSTRAINT fk_sm_chat FOREIGN KEY (chat_id) REFERENCES support_chats(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
];

(async () => {
  try {
    for (const sql of DDL) {
      const name = /TABLE IF NOT EXISTS (\w+)/.exec(sql)[1];
      await pool.query(sql);
      const [rows] = await pool.query('SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?', [name]);
      console.log(`[migration] ${name}: ${rows[0].n ? 'ok' : 'MISSING'}`);
    }
    console.log('[migration] support chat tables ready. Now: pm2 restart api_calling');
    process.exit(0);
  } catch (e) {
    console.error('[migration] failed:', e.message);
    process.exit(1);
  }
})();
