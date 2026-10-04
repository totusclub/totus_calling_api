// backend/config/database.js
// MySQL database connection configuration

const mysql = require('mysql2/promise');
const { requireEnv, env } = require('./lib/env');

// Подключение к MySQL — только из .env (Б.1, SECURITY_AUDIT_SECRETS_RU.md), без литералов:
//   DB_HOST, DB_USER, DB_PASSWORD, DB_NAME (та же база kedam, что у totus_API), DB_PORT (опц., 3306)
const dbConfig = {
    host: requireEnv('DB_HOST'),
    port: Number(env('DB_PORT') || 3306),
    user: requireEnv('DB_USER'),
    password: requireEnv('DB_PASSWORD'),
    database: requireEnv('DB_NAME'),
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
};

// Create connection pool
const pool = mysql.createPool(dbConfig);

// Test connection
pool.getConnection()
    .then(connection => {
        console.log('✅ MySQL database connected successfully');
        connection.release();
    })
    .catch(err => {
        console.error('❌ MySQL database connection error:', err.message);
        console.error('Please check DB_HOST / DB_USER / DB_PASSWORD / DB_NAME in .env');
    });

module.exports = pool;


const userDb = {
    // Get user by email and password (for web login)
    // Only returns user if access = 0 (Доступ). access = 1 means Заблок. (blocked)
    async getUserByEmailAndPassword(email, password) {
        try {
            const [rows] = await pool.execute(
                'SELECT * FROM users WHERE email = ? AND password = ? AND COALESCE(access, 0) = 0',
                [email, password]
            );
            return rows.length > 0 ? rows[0] : null;
        } catch (error) {
            console.error('Error getting user by email and password:', error);
            throw error;
        }
    },

    // Get user by email — для входа агента с bcrypt (index.js /api/web/login).
    // Пароль сравнивается в index.js, не в SQL.
    async getUserByEmail(email) {
        try {
            const [rows] = await pool.execute(
                'SELECT * FROM users WHERE email = ? LIMIT 1',
                [email]
            );
            return rows.length > 0 ? rows[0] : null;
        } catch (error) {
            console.error('Error getting user by email:', error);
            throw error;
        }
    },

    // Update user password hash (ленивая миграция plaintext → bcrypt при первом входе)
    async updateUserPassword(userId, passwordHash) {
        try {
            const [result] = await pool.execute(
                'UPDATE users SET password = ? WHERE id = ?',
                [passwordHash, userId]
            );
            return result.affectedRows > 0;
        } catch (error) {
            console.error('Error updating user password:', error);
            throw error;
        }
    },

    // Get user device info by loyalty_id
    // Handles loyalty IDs with or without spaces (normalizes by removing spaces)
    async getUserDeviceInfoByLoyaltyId(loyaltyId) {
        try {
            // Normalize loyalty ID by removing all spaces
            const normalizedLoyaltyId = loyaltyId.replace(/\s+/g, '');
            // Search using both the normalized version and with spaces removed from database value
            // Use REPLACE to remove spaces from database value for comparison
            const [rows] = await pool.execute(
                'SELECT * FROM users WHERE REPLACE(loyalty_id, " ", "") = ?',
                [normalizedLoyaltyId]
            );
            return rows.length > 0 ? rows[0] : null;
        } catch (error) {
            console.error('Error getting user device info by loyalty_id:', error);
            throw error;
        }
    },

    // Get user by loyalty_id
    // Handles loyalty IDs with or without spaces (normalizes by removing spaces)
    async getUserByLoyaltyId(loyaltyId) {
        try {
            // Normalize loyalty ID by removing all spaces
            const normalizedLoyaltyId = loyaltyId.replace(/\s+/g, '');
            // Search using REPLACE to remove spaces from database value for comparison
            const [rows] = await pool.execute(
                'SELECT * FROM users WHERE REPLACE(loyalty_id, " ", "") = ?',
                [normalizedLoyaltyId]
            );
            return rows.length > 0 ? rows[0] : null;
        } catch (error) {
            console.error('Error getting user by loyalty_id:', error);
            throw error;
        }
    },

    // Get user by ID
    async getUserById(id) {
        try {
            const [rows] = await pool.execute(
                'SELECT * FROM users WHERE id = ?',
                [id]
            );
            return rows.length > 0 ? rows[0] : null;
        } catch (error) {
            console.error('Error getting user by ID:', error);
            throw error;
        }
    },

    // Update user device info (voipToken and socketId)
    async updateUserDeviceInfo(userId, voipToken, socketId) {
        try {
            const updates = [];
            const values = [];

            if (voipToken !== undefined) {
                updates.push('voipToken = ?');
                values.push(voipToken);
            }
            if (socketId !== undefined) {
                updates.push('socketId = ?');
                values.push(socketId);
            }

            if (updates.length === 0) {
                return await this.getUserById(userId);
            }

            values.push(userId);
            const [result] = await pool.execute(
                `UPDATE users SET ${updates.join(', ')} WHERE id = ?`,
                values
            );

            if (result.affectedRows > 0) {
                return await this.getUserById(userId);
            }
            return null;
        } catch (error) {
            console.error('Error updating user device info:', error);
            throw error;
        }
    },

    // Update user socket ID and online status
    // If socketId is provided (not null), set online = 1
    // If socketId is null, set online = 0
    async updateUserSocketId(userId, socketId) {
        try {
            const online = socketId ? 1 : 0;
            const [result] = await pool.execute(
                'UPDATE users SET socketId = ?, online = ? WHERE id = ?',
                [socketId, online, userId]
            );

            if (result.affectedRows > 0) {
                return await this.getUserById(userId);
            }
            return null;
        } catch (error) {
            console.error('Error updating user socket ID:', error);
            throw error;
        }
    },

    // Get all users (for web app user list)
    async getAllUsers() {
        try {
            const [rows] = await pool.execute(
                'SELECT id, loyalty_id, name, f_name, l_name, email, phone, role, voipToken, socketId, online, date, access FROM users'
            );
            return rows;
        } catch (error) {
            console.error('Error getting all users:', error);
            throw error;
        }
    },

    // Update user access (1 = enabled, 0 = disabled)
    async updateUserAccess(userId, access) {
        try {
            const accessVal = access ? 1 : 0;
            const [result] = await pool.execute(
                'UPDATE users SET access = ? WHERE id = ?',
                [accessVal, userId]
            );
            if (result.affectedRows > 0) {
                return await this.getUserById(userId);
            }
            return null;
        } catch (error) {
            console.error('Error updating user access:', error);
            throw error;
        }
    },
};

// Device operations - using users table since voipToken and socketId are stored there
const deviceDb = {
    // Register or update device (updates user's voipToken by deviceId/loyaltyId)
    async registerDevice(deviceId, loyaltyId, voipToken, platform = 'ios') {
        try {
            // Find user by loyalty_id or deviceId (voipToken)
            let user = null;

            if (loyaltyId) {
                const [users] = await pool.execute(
                    'SELECT * FROM users WHERE loyalty_id = ?',
                    [loyaltyId]
                );
                user = users.length > 0 ? users[0] : null;
            }

            // If not found by loyaltyId, try to find by voipToken (deviceId)
            if (!user) {
                const [users] = await pool.execute(
                    'SELECT * FROM users WHERE voipToken = ?',
                    [deviceId]
                );
                user = users.length > 0 ? users[0] : null;
            }

            if (user) {
                // Update existing user's voipToken
                const [result] = await pool.execute(
                    'UPDATE users SET voipToken = ? WHERE id = ?',
                    [voipToken, user.id]
                );
                return {ok: true, updated: true, userId: user.id};
            } else {
                // User not found - device registration requires existing user
                // You might want to create a user here or return error
                console.warn('Device registration: User not found for loyaltyId:', loyaltyId, 'deviceId:', deviceId);
                return {ok: false, error: 'User not found'};
            }
        } catch (error) {
            console.error('Error registering device:', error);
            throw error;
        }
    },

    // Get device by deviceId (voipToken)
    async getDeviceByDeviceId(deviceId) {
        try {
            const [rows] = await pool.execute(
                'SELECT * FROM users WHERE voipToken = ?',
                [deviceId]
            );
            if (rows.length > 0) {
                const user = rows[0];
                return {
                    deviceId: user.voipToken,
                    userId: user.id,
                    loyaltyId: user.loyalty_id,
                    voipToken: user.voipToken,
                    platform: 'ios', // Default since we don't have platform in users table
                };
            }
            return null;
        } catch (error) {
            console.error('Error getting device by deviceId:', error);
            throw error;
        }
    },

    // Update device socket ID (updates user's socketId)
    async updateDeviceSocketId(deviceId, socketId) {
        try {
            const [result] = await pool.execute(
                'UPDATE users SET socketId = ? WHERE voipToken = ?',
                [socketId, deviceId]
            );
            return result.affectedRows > 0;
        } catch (error) {
            console.error('Error updating device socket ID:', error);
            throw error;
        }
    },
};

// Call operations
const callDb = {
    // Create a new call
    async createCall(callId, fromDeviceId, fromLoyaltyId, toDeviceId, toLoyaltyId, callerName, offer) {
        try {
            const [result] = await pool.execute(
                `INSERT INTO calls (call_id, from_device_id, from_loyalty_id, to_device_id, to_loyalty_id, caller_name, offer_sdp, offer_type, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ringing')`,
                [callId, fromDeviceId, fromLoyaltyId, toDeviceId, toLoyaltyId, callerName, offer.sdp, offer.type]
            );
            return {ok: true, id: result.insertId};
        } catch (error) {
            console.error('Error creating call:', error);
            throw error;
        }
    },

    // Get call by callId
    async getCallByCallId(callId) {
        try {
            const [rows] = await pool.execute(
                'SELECT * FROM calls WHERE call_id = ?',
                [callId]
            );
            if (rows.length > 0) {
                const call = rows[0];
                return {
                    callId: call.call_id,
                    fromDeviceId: call.from_device_id,
                    fromLoyaltyId: call.from_loyalty_id,
                    toDeviceId: call.to_device_id,
                    toLoyaltyId: call.to_loyalty_id,
                    callerName: call.caller_name,
                    offer: call.offer_sdp ? {
                        type: call.offer_type,
                        sdp: call.offer_sdp
                    } : null,
                    answer: call.answer_sdp ? {
                        type: call.answer_type,
                        sdp: call.answer_sdp
                    } : null,
                    status: call.status,
                };
            }
            return null;
        } catch (error) {
            console.error('Error getting call by callId:', error);
            throw error;
        }
    },

    // Update call answer
    async updateCallAnswer(callId, answer) {
        try {
            const [result] = await pool.execute(
                `UPDATE calls SET answer_sdp = ?, answer_type = ?, status = 'answered', updated_at = CURRENT_TIMESTAMP WHERE call_id = ?`,
                [answer.sdp, answer.type, callId]
            );
            return result.affectedRows > 0;
        } catch (error) {
            console.error('Error updating call answer:', error);
            throw error;
        }
    },

    // Update call status
    async updateCallStatus(callId, status) {
        try {
            const [result] = await pool.execute(
                'UPDATE calls SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE call_id = ?',
                [status, callId]
            );
            return result.affectedRows > 0;
        } catch (error) {
            console.error('Error updating call status:', error);
            throw error;
        }
    },
};

// ICE Candidate operations
const candidateDb = {
    // Add ICE candidate
    async addCandidate(callId, side, candidate) {
        try {
            const [result] = await pool.execute(
                'INSERT INTO call_candidates (call_id, side, candidate_data) VALUES (?, ?, ?)',
                [callId, side, JSON.stringify(candidate)]
            );
            return {ok: true, id: result.insertId};
        } catch (error) {
            console.error('Error adding ICE candidate:', error);
            throw error;
        }
    },

    // Get candidates for a call
    async getCandidates(callId, side) {
        try {
            const otherSide = side === 'caller' ? 'callee' : 'caller';
            const [rows] = await pool.execute(
                'SELECT candidate_data FROM call_candidates WHERE call_id = ? AND side = ?',
                [callId, otherSide]
            );

            const candidates = rows.map(row => JSON.parse(row.candidate_data));

            // Delete delivered candidates
            await pool.execute(
                'DELETE FROM call_candidates WHERE call_id = ? AND side = ?',
                [callId, otherSide]
            );

            return candidates;
        } catch (error) {
            console.error('Error getting ICE candidates:', error);
            throw error;
        }
    },
};

// Contacts operations
const contactDb = {
    // Add a contact (user adds another user to their contacts)
    // Handles loyalty IDs with or without spaces (normalizes by removing spaces)
    async addContact(userId, contactLoyaltyId) {
        try {
            // Normalize loyalty ID by removing all spaces
            const normalizedContactLoyaltyId = contactLoyaltyId.replace(/\s+/g, '');
            
            // Check if contact already exists (using COLLATE to handle collation mismatch)
            // Compare normalized values
            const [existing] = await pool.execute(
                'SELECT * FROM contacts WHERE user_id = ? AND REPLACE(contact_loyalty_id, " ", "") COLLATE utf8mb4_general_ci = ? COLLATE utf8mb4_general_ci',
                [userId, normalizedContactLoyaltyId]
            );
            
            if (existing.length > 0) {
                return {ok: true, alreadyExists: true, id: existing[0].id};
            }

            // Verify that the contact user exists (using COLLATE to handle collation mismatch)
            // Search using normalized loyalty ID
            const [contactUser] = await pool.execute(
                'SELECT id FROM users WHERE REPLACE(loyalty_id, " ", "") COLLATE utf8mb4_general_ci = ? COLLATE utf8mb4_general_ci',
                [normalizedContactLoyaltyId]
            );

            if (contactUser.length === 0) {
                throw new Error('Contact user not found');
            }

            // Add contact - store normalized loyalty ID (without spaces)
            const [result] = await pool.execute(
                'INSERT INTO contacts (user_id, contact_loyalty_id, created_at) VALUES (?, ?, NOW())',
                [userId, normalizedContactLoyaltyId]
            );
            return {ok: true, id: result.insertId};
        } catch (error) {
            console.error('Error adding contact:', error);
            throw error;
        }
    },

    // Get all contacts for a user
    async getUserContacts(userId) {
        try {
            const [rows] = await pool.execute(
                `SELECT 
                    c.id as contact_id,
                    c.contact_loyalty_id,
                    c.created_at,
                    u.id,
                    u.loyalty_id,
                    u.name,
                    u.f_name,
                    u.l_name,
                    u.email,
                    u.phone,
                    u.online,
                    u.voipToken,
                    u.socketId
                FROM contacts c
                INNER JOIN users u ON REPLACE(u.loyalty_id, " ", "") COLLATE utf8mb4_general_ci = REPLACE(c.contact_loyalty_id, " ", "") COLLATE utf8mb4_general_ci
                WHERE c.user_id = ?
                ORDER BY c.created_at DESC`,
                [userId]
            );
            console.log(`[contactDb] Found ${rows.length} contacts for userId ${userId}`);
            return rows;
        } catch (error) {
            console.error('Error getting user contacts:', error);
            // If table doesn't exist, return empty array
            if (error.message && (error.message.includes('doesn\'t exist') || error.message.includes('Unknown table'))) {
                console.log('[contactDb] Contacts table does not exist');
                return [];
            }
            throw error;
        }
    },

    // Check if contact exists
    // Handles loyalty IDs with or without spaces (normalizes by removing spaces)
    async contactExists(userId, contactLoyaltyId) {
        try {
            // Normalize loyalty ID by removing all spaces
            const normalizedContactLoyaltyId = contactLoyaltyId.replace(/\s+/g, '');
            const [rows] = await pool.execute(
                'SELECT id FROM contacts WHERE user_id = ? AND REPLACE(contact_loyalty_id, " ", "") COLLATE utf8mb4_general_ci = ? COLLATE utf8mb4_general_ci',
                [userId, normalizedContactLoyaltyId]
            );
            return rows.length > 0;
        } catch (error) {
            console.error('Error checking contact existence:', error);
            throw error;
        }
    },
};

// Favorites operations
const favoriteDb = {
    // Add a hotel to favorites
    async addFavorite(userId, hotelId, hotelData) {
        try {
            // Check if favorite already exists
            const [existing] = await pool.execute(
                'SELECT * FROM favorites WHERE user_id = ? AND hotel_id = ?',
                [userId, hotelId]
            );
            
            if (existing.length > 0) {
                return {ok: true, alreadyExists: true, id: existing[0].id};
            }

            // Add favorite - store hotel data as JSON
            const hotelDataJson = JSON.stringify(hotelData);
            const [result] = await pool.execute(
                'INSERT INTO favorites (user_id, hotel_id, hotel_data, created_at) VALUES (?, ?, ?, NOW())',
                [userId, hotelId, hotelDataJson]
            );
            return {ok: true, id: result.insertId};
        } catch (error) {
            console.error('Error adding favorite:', error);
            throw error;
        }
    },

    // Remove a hotel from favorites
    async removeFavorite(userId, hotelId) {
        try {
            const [result] = await pool.execute(
                'DELETE FROM favorites WHERE user_id = ? AND hotel_id = ?',
                [userId, hotelId]
            );
            return {ok: true, deleted: result.affectedRows > 0};
        } catch (error) {
            console.error('Error removing favorite:', error);
            throw error;
        }
    },

    // Get all favorites for a user
    async getUserFavorites(userId) {
        try {
            const [rows] = await pool.execute(
                'SELECT id, hotel_id, hotel_data, created_at FROM favorites WHERE user_id = ? ORDER BY created_at DESC',
                [userId]
            );
            return rows.map(row => ({
                id: row.id,
                hotelId: row.hotel_id,
                hotelData: JSON.parse(row.hotel_data),
                createdAt: row.created_at,
            }));
        } catch (error) {
            console.error('Error getting user favorites:', error);
            throw error;
        }
    },

    // Check if hotel is favorited
    async isFavorite(userId, hotelId) {
        try {
            const [rows] = await pool.execute(
                'SELECT id FROM favorites WHERE user_id = ? AND hotel_id = ?',
                [userId, hotelId]
            );
            return rows.length > 0;
        } catch (error) {
            console.error('Error checking favorite:', error);
            throw error;
        }
    },
};

// ----------------------------------------------------------------------------
// Телефоны пользователя для звонков (05.10.2026, сценарий «отбой на сайте»).
// Раньше токен звонков был один на пользователя (users.voipToken) и его перезаписывал
// последний открытый телефон: второй телефон в фоне / выгруженный не звонил вообще.
// Теперь у каждого телефона своя строка: push звонка уходит на все телефоны пользователя.
// supports_cancel = приложение умеет «отменяющий» push (type=call_ended): только таким
// телефонам он отправляется (старое приложение показало бы его как новый входящий).
// Таблица создаётся сама при старте (CREATE TABLE IF NOT EXISTS); если прав нет —
// работает прежняя схема с users.voipToken.
// ----------------------------------------------------------------------------
const CALL_DEVICE_MAX_PER_USER = 5;
const CALL_DEVICE_MAX_AGE_DAYS = 60;

const callDeviceDb = {
    available: false,

    async ensureTable() {
        try {
            await pool.execute(`CREATE TABLE IF NOT EXISTS call_devices (
                token VARCHAR(255) NOT NULL PRIMARY KEY,
                user_id INT NOT NULL,
                platform VARCHAR(16) NOT NULL,
                supports_cancel TINYINT(1) NOT NULL DEFAULT 0,
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                KEY idx_call_devices_user (user_id, updated_at)
            )`);
            callDeviceDb.available = true;
            console.log('[call-devices] table ready');
        } catch (error) {
            callDeviceDb.available = false;
            console.error('[call-devices] table not available, single users.voipToken is used:', error.message);
        }
        return callDeviceDb.available;
    },

    /** Таблица не создалась при старте (БД ещё не готова): повторяем не чаще раза в минуту. */
    async ensureAvailable() {
        if (callDeviceDb.available) return true;
        const now = Date.now();
        if (callDeviceDb._lastTry && now - callDeviceDb._lastTry < 60000) return false;
        callDeviceDb._lastTry = now;
        return callDeviceDb.ensureTable();
    },

    /** Телефон вошёл под пользователем (токен переезжает к новому пользователю при смене аккаунта). */
    async upsert(userId, token, platform, supportsCancel) {
        if (!(await callDeviceDb.ensureAvailable()) || !userId || !token) return false;
        try {
            await pool.execute(
                `INSERT INTO call_devices (token, user_id, platform, supports_cancel, updated_at)
                 VALUES (?, ?, ?, ?, NOW())
                 ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), platform = VALUES(platform),
                   supports_cancel = VALUES(supports_cancel), updated_at = NOW()`,
                [String(token), Number(userId), String(platform || 'ios'), supportsCancel ? 1 : 0]
            );
            return true;
        } catch (error) {
            console.error('[call-devices] upsert failed:', error.message);
            return false;
        }
    },

    /** Свежие телефоны пользователя (новые первыми). */
    async listByUser(userId) {
        if (!(await callDeviceDb.ensureAvailable()) || !userId) return [];
        try {
            const [rows] = await pool.execute(
                `SELECT token, platform, supports_cancel FROM call_devices
                 WHERE user_id = ? AND updated_at > (NOW() - INTERVAL ${CALL_DEVICE_MAX_AGE_DAYS} DAY)
                 ORDER BY updated_at DESC LIMIT ${CALL_DEVICE_MAX_PER_USER}`,
                [Number(userId)]
            );
            return rows.map((r) => ({token: r.token, platform: r.platform, supportsCancel: Boolean(r.supports_cancel)}));
        } catch (error) {
            console.error('[call-devices] list failed:', error.message);
            return [];
        }
    },

    /** Телефон перешёл к другому пользователю: снять его токен с users.voipToken прежнего владельца. */
    async releaseFromOtherUsers(token, userId) {
        if (!token || !userId) return false;
        try {
            await pool.execute('UPDATE users SET voipToken = NULL WHERE voipToken = ? AND id <> ?', [String(token), Number(userId)]);
            return true;
        } catch (error) {
            console.error('[call-devices] release failed:', error.message);
            return false;
        }
    },

    async remove(token) {
        if (!callDeviceDb.available || !token) return false;
        try {
            await pool.execute('DELETE FROM call_devices WHERE token = ?', [String(token)]);
            return true;
        } catch (error) {
            console.error('[call-devices] remove failed:', error.message);
            return false;
        }
    },

    async removeAllForUser(userId) {
        if (!callDeviceDb.available || !userId) return false;
        try {
            await pool.execute('DELETE FROM call_devices WHERE user_id = ?', [Number(userId)]);
            return true;
        } catch (error) {
            console.error('[call-devices] remove for user failed:', error.message);
            return false;
        }
    },
};

module.exports = {userDb, deviceDb, callDb, candidateDb, contactDb, favoriteDb, callDeviceDb, pool}; // pool — для lib/supportChat.js и scripts/run-support-chat-migration.js



