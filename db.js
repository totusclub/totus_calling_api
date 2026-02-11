// backend/config/database.js
// MySQL database connection configuration

const mysql = require('mysql2/promise');


// Database configuration from environment variables or defaults
const dbConfig = {
    host:  '213.109.202.180',
    port:  3306,
    user: 'root',
    password: 'your_secure_password',
    database: 'kedam',
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
        console.error('Please check your database configuration in .env file');
    });

module.exports = pool;


const userDb = {
    // Get user by email and password (for web login)
    async getUserByEmailAndPassword(email, password) {
        try {
            const [rows] = await pool.execute(
                'SELECT * FROM users WHERE email = ? AND password = ?',
                [email, password]
            );
            return rows.length > 0 ? rows[0] : null;
        } catch (error) {
            console.error('Error getting user by email and password:', error);
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
                'SELECT id, loyalty_id, name, f_name, l_name, email, phone, role, voipToken, socketId, online, date FROM users'
            );
            return rows;
        } catch (error) {
            console.error('Error getting all users:', error);
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

module.exports = {userDb, deviceDb, callDb, candidateDb, contactDb};



