import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import Database from 'better-sqlite3';
import express from 'express';
import multer from 'multer';
import { createServer } from 'node:http';
import { Server } from 'socket.io';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDirectory = path.resolve(process.env.DATA_DIR ?? path.join(root, 'data'));
fs.mkdirSync(dataDirectory, { recursive: true });

const database = new Database(path.join(dataDirectory, 'farazchat.sqlite'));
database.pragma('journal_mode = WAL');
database.pragma('foreign_keys = ON');
database.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    bio TEXT NOT NULL DEFAULT '',
    notifications_enabled INTEGER NOT NULL DEFAULT 0,
    discoverable INTEGER NOT NULL DEFAULT 1,
    dark_mode INTEGER NOT NULL DEFAULT 0,
    avatar_path TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS user_contacts (
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    contact_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    nickname TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (owner_id, contact_id),
    CHECK (owner_id != contact_id)
  );
  CREATE TABLE IF NOT EXISTS chat_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    creator_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS group_members (
    group_id INTEGER NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member',
    joined_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (group_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    group_id INTEGER REFERENCES chat_groups(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    attachment_path TEXT NOT NULL DEFAULT '',
    attachment_name TEXT NOT NULL DEFAULT '',
    attachment_type TEXT NOT NULL DEFAULT '',
    attachment_size INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS messages_conversation
    ON messages(sender_id, recipient_id, id);
  CREATE TABLE IF NOT EXISTS statuses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL DEFAULT '',
    attachment_path TEXT NOT NULL DEFAULT '',
    attachment_name TEXT NOT NULL DEFAULT '',
    attachment_type TEXT NOT NULL DEFAULT '',
    attachment_size INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS statuses_expiry ON statuses(expires_at, user_id);
  CREATE TABLE IF NOT EXISTS status_views (
    status_id INTEGER NOT NULL REFERENCES statuses(id) ON DELETE CASCADE,
    viewer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    viewed_at INTEGER NOT NULL,
    PRIMARY KEY (status_id, viewer_id)
  );
`);

const userColumns = new Set(database.pragma('table_info(users)').map((column) => column.name));
if (!userColumns.has('contact_code')) {
  database.exec("ALTER TABLE users ADD COLUMN contact_code TEXT NOT NULL DEFAULT ''");
}
if (!userColumns.has('display_name')) {
  database.exec("ALTER TABLE users ADD COLUMN display_name TEXT NOT NULL DEFAULT ''");
}
if (!userColumns.has('bio')) {
  database.exec("ALTER TABLE users ADD COLUMN bio TEXT NOT NULL DEFAULT ''");
}
if (!userColumns.has('notifications_enabled')) {
  database.exec('ALTER TABLE users ADD COLUMN notifications_enabled INTEGER NOT NULL DEFAULT 0');
}
if (!userColumns.has('discoverable')) {
  database.exec('ALTER TABLE users ADD COLUMN discoverable INTEGER NOT NULL DEFAULT 1');
}
if (!userColumns.has('dark_mode')) {
  database.exec('ALTER TABLE users ADD COLUMN dark_mode INTEGER NOT NULL DEFAULT 0');
}
if (!userColumns.has('avatar_path')) {
  database.exec("ALTER TABLE users ADD COLUMN avatar_path TEXT NOT NULL DEFAULT ''");
}
function createContactCode() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const code = String(crypto.randomInt(10000000, 100000000));
    const exists = database.prepare('SELECT 1 FROM users WHERE contact_code = ? OR username = ?').get(code, code);
    if (!exists) return code;
  }
  throw new Error('Could not allocate a unique 8-digit contact code.');
}

const usedContactCodes = new Set();
for (const account of database.prepare('SELECT id, username, contact_code FROM users ORDER BY id').all()) {
  let code = account.contact_code;
  const validCode = /^\d{8}$/.test(code) && !usedContactCodes.has(code);
  const codeTakenByUsername = database.prepare('SELECT 1 FROM users WHERE username = ? AND id != ?').get(code, account.id);
  if (!validCode || codeTakenByUsername) code = createContactCode();
  database.prepare('UPDATE users SET contact_code = ? WHERE id = ?').run(code, account.id);
  usedContactCodes.add(code);
}
database.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_contact_code ON users(contact_code)');
const messageColumns = new Set(database.pragma('table_info(messages)').map((column) => column.name));
if (!messageColumns.has('attachment_path')) {
  database.exec("ALTER TABLE messages ADD COLUMN attachment_path TEXT NOT NULL DEFAULT ''");
}
if (!messageColumns.has('attachment_name')) {
  database.exec("ALTER TABLE messages ADD COLUMN attachment_name TEXT NOT NULL DEFAULT ''");
}
if (!messageColumns.has('attachment_type')) {
  database.exec("ALTER TABLE messages ADD COLUMN attachment_type TEXT NOT NULL DEFAULT ''");
}
if (!messageColumns.has('attachment_size')) {
  database.exec('ALTER TABLE messages ADD COLUMN attachment_size INTEGER NOT NULL DEFAULT 0');
}
if (!messageColumns.has('group_id')) {
  database.exec('ALTER TABLE messages ADD COLUMN group_id INTEGER REFERENCES chat_groups(id) ON DELETE CASCADE');
}
database.exec('CREATE INDEX IF NOT EXISTS messages_group ON messages(group_id, id)');
database.exec("UPDATE users SET display_name = username WHERE display_name = ''");

const avatarDirectory = path.join(dataDirectory, 'avatars');
const messageFileDirectory = path.join(dataDirectory, 'message-files');
const statusFileDirectory = path.join(dataDirectory, 'status-files');
fs.mkdirSync(avatarDirectory, { recursive: true });
fs.mkdirSync(messageFileDirectory, { recursive: true });
fs.mkdirSync(statusFileDirectory, { recursive: true });

function cleanupExpiredStatuses() {
  const now = Date.now();
  const expiredStatuses = database.prepare('SELECT id, attachment_path FROM statuses WHERE expires_at <= ?').all(now);
  if (!expiredStatuses.length) return;
  const removeExpired = database.transaction(() => {
    database.prepare('DELETE FROM statuses WHERE expires_at <= ?').run(now);
  });
  removeExpired();
  for (const status of expiredStatuses) {
    if (status.attachment_path) {
      fs.rmSync(path.join(statusFileDirectory, path.basename(status.attachment_path)), { force: true });
    }
  }
}

cleanupExpiredStatuses();
const statusCleanupTimer = setInterval(cleanupExpiredStatuses, 60 * 60 * 1000);
statusCleanupTimer.unref();

const messageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
});
const inlineImageTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

function publicMessage(message) {
  const { attachment_path: filePath, attachment_name: name, attachment_type: type, attachment_size: size, ...publicFields } = message;
  return {
    ...publicFields,
    attachment: filePath ? {
      name,
      type,
      size,
      url: `/api/messages/${message.id}/attachment`,
      inline: inlineImageTypes.has(type),
    } : null,
  };
}

function groupMemberIds(groupId) {
  return database.prepare('SELECT user_id FROM group_members WHERE group_id = ?').all(groupId)
    .map((member) => member.user_id);
}

function isGroupMember(groupId, userId) {
  return Boolean(database.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?')
    .get(groupId, userId));
}

function publicStatus(status) {
  return {
    id: status.id,
    body: status.body,
    created_at: status.created_at,
    expires_at: status.expires_at,
    viewed: Boolean(status.viewed),
    views_count: status.views_count ?? 0,
    attachment: status.attachment_path ? {
      name: status.attachment_name,
      type: status.attachment_type,
      size: status.attachment_size,
      url: `/api/statuses/${status.id}/attachment`,
      inline: inlineImageTypes.has(status.attachment_type),
    } : null,
  };
}

const secretPath = path.join(dataDirectory, 'session-secret');
if (!fs.existsSync(secretPath)) {
  fs.writeFileSync(secretPath, crypto.randomBytes(48), { mode: 0o600, flag: 'wx' });
}
const secret = fs.readFileSync(secretPath);

function signToken(userId) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub: userId, exp: Date.now() + 7 * 24 * 60 * 60 * 1000 })).toString('base64url');
  const content = `${header}.${payload}`;
  const signature = crypto.createHmac('sha256', secret).update(content).digest('base64url');
  return `${content}.${signature}`;
}

function readToken(token) {
  const [header, payload, signature] = (token ?? '').split('.');
  if (!header || !payload || !signature) throw new Error('Invalid session');
  const content = `${header}.${payload}`;
  const expected = crypto.createHmac('sha256', secret).update(content).digest();
  const received = Buffer.from(signature, 'base64url');
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) {
    throw new Error('Invalid session');
  }
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
  if (!Number.isInteger(claims.sub) || claims.exp < Date.now()) throw new Error('Session expired');
  return claims.sub;
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.contact_code || user.username,
    contact_code: user.contact_code || user.username,
    display_name: user.display_name,
    bio: user.bio,
    notifications_enabled: Boolean(user.notifications_enabled),
    discoverable: user.discoverable !== 0,
    dark_mode: Boolean(user.dark_mode),
    avatar_url: user.avatar_path ? `/uploads/avatars/${encodeURIComponent(user.avatar_path)}` : '',
  };
}

function userFromToken(token) {
  const id = readToken(token);
  const user = database.prepare('SELECT id, username, contact_code, display_name, bio, notifications_enabled, discoverable, dark_mode, avatar_path FROM users WHERE id = ?').get(id);
  if (!user) throw new Error('Account not found');
  return user;
}

function authToken(request) {
  const value = request.headers.authorization ?? '';
  if (!value.startsWith('Bearer ')) throw new Error('Sign in to continue');
  return value.slice(7);
}

function requireAuth(request, response, next) {
  try {
    request.user = userFromToken(authToken(request));
    next();
  } catch {
    response.status(401).json({ error: 'Your session expired. Please sign in again.' });
  }
}

const app = express();
app.use(express.json({ limit: '16kb' }));
app.use('/uploads/avatars', express.static(avatarDirectory, { maxAge: '1d', immutable: true }));

app.post('/api/auth/register', async (request, response) => {
  const contactCode = typeof request.body.contactCode === 'string' ? request.body.contactCode.trim() : '';
  const password = typeof request.body.password === 'string' ? request.body.password : '';
  const displayName = typeof request.body.displayName === 'string' ? request.body.displayName.trim() : '';
  const bio = typeof request.body.bio === 'string' ? request.body.bio.trim() : '';
  if (!/^\d{8}$/.test(contactCode)) {
    return response.status(400).json({ error: 'Choose a code with exactly 8 digits.' });
  }
  if (request.body.policiesAccepted !== true) {
    return response.status(400).json({ error: 'Accept the account policies to continue.' });
  }
  if (password.length < 8 || password.length > 72) {
    return response.status(400).json({ error: 'Password must be between 8 and 72 characters.' });
  }
  if (displayName.length < 1 || displayName.length > 40) {
    return response.status(400).json({ error: 'Name must be between 1 and 40 characters.' });
  }
  if (bio.length > 160) {
    return response.status(400).json({ error: 'Bio must be 160 characters or fewer.' });
  }
  const existingCode = database.prepare('SELECT 1 FROM users WHERE contact_code = ? OR username = ?').get(contactCode, contactCode);
  if (existingCode) return response.status(409).json({ error: 'That 8-digit code is already taken. Choose another one.' });
  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const result = database.prepare(`
      INSERT INTO users (username, contact_code, password_hash, display_name, bio) VALUES (?, ?, ?, ?, ?)
    `).run(contactCode, contactCode, passwordHash, displayName, bio);
    const userId = Number(result.lastInsertRowid);
    const user = database.prepare(`
      SELECT id, username, contact_code, display_name, bio, notifications_enabled, discoverable, dark_mode, avatar_path
      FROM users WHERE id = ?
    `).get(userId);
    response.status(201).json({ token: signToken(userId), user: publicUser(user) });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return response.status(409).json({ error: 'That 8-digit contact code is already taken. Choose another one.' });
    }
    console.error(error);
    response.status(500).json({ error: 'Could not create your account.' });
  }
});

app.post('/api/auth/login', async (request, response) => {
  const code = typeof request.body.code === 'string' ? request.body.code.trim() : '';
  const password = typeof request.body.password === 'string' ? request.body.password : '';
  const user = database.prepare(`
    SELECT id, username, contact_code, password_hash, display_name, bio,
      notifications_enabled, discoverable, dark_mode, avatar_path
    FROM users WHERE contact_code = ? OR username = ? LIMIT 1
  `).get(code, code);
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return response.status(401).json({ error: 'Contact code or password is incorrect.' });
  }
  response.json({ token: signToken(user.id), user: publicUser(user) });
});

app.get('/api/me', requireAuth, (request, response) => {
  response.json({ user: publicUser(request.user) });
});

app.patch('/api/me', requireAuth, (request, response) => {
  const displayName = typeof request.body.displayName === 'string' ? request.body.displayName.trim() : '';
  const bio = typeof request.body.bio === 'string' ? request.body.bio.trim() : '';
  if (displayName.length < 1 || displayName.length > 40) {
    return response.status(400).json({ error: 'Name must be between 1 and 40 characters.' });
  }
  if (bio.length > 160) {
    return response.status(400).json({ error: 'Bio must be 160 characters or fewer.' });
  }
  if (typeof request.body.notificationsEnabled !== 'boolean') {
    return response.status(400).json({ error: 'Choose whether message notifications are enabled.' });
  }
  const discoverable = typeof request.body.discoverable === 'boolean'
    ? request.body.discoverable
    : Boolean(request.user.discoverable);
  const darkMode = typeof request.body.darkMode === 'boolean'
    ? request.body.darkMode
    : Boolean(request.user.dark_mode);
  database.prepare('UPDATE users SET display_name = ?, bio = ?, notifications_enabled = ?, discoverable = ?, dark_mode = ? WHERE id = ?')
    .run(displayName, bio, Number(request.body.notificationsEnabled), Number(discoverable), Number(darkMode), request.user.id);
  const user = database.prepare('SELECT id, username, contact_code, display_name, bio, notifications_enabled, discoverable, dark_mode, avatar_path FROM users WHERE id = ?')
    .get(request.user.id);
  response.json({ user: publicUser(user) });
});

app.patch('/api/me/avatar', requireAuth, express.raw({
  type: ['image/jpeg', 'image/png', 'image/webp'],
  limit: '2mb',
}), (request, response) => {
  const contentType = request.headers['content-type']?.split(';')[0];
  const data = request.body;
  const validImage = Buffer.isBuffer(data) && (
    (contentType === 'image/jpeg' && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff)
    || (contentType === 'image/png' && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    || (contentType === 'image/webp' && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP')
  );
  if (!validImage) {
    return response.status(400).json({ error: 'Choose a valid JPEG, PNG, or WebP image under 2 MB.' });
  }
  const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[contentType];
  const filename = `${request.user.id}-${crypto.randomUUID()}.${extension}`;
  fs.writeFileSync(path.join(avatarDirectory, filename), data, { flag: 'wx', mode: 0o644 });
  if (request.user.avatar_path) {
    fs.rmSync(path.join(avatarDirectory, path.basename(request.user.avatar_path)), { force: true });
  }
  database.prepare('UPDATE users SET avatar_path = ? WHERE id = ?').run(filename, request.user.id);
  const user = database.prepare('SELECT id, username, contact_code, display_name, bio, notifications_enabled, discoverable, dark_mode, avatar_path FROM users WHERE id = ?')
    .get(request.user.id);
  response.json({ user: publicUser(user) });
});

app.patch('/api/me/password', requireAuth, async (request, response) => {
  const currentPassword = typeof request.body.currentPassword === 'string' ? request.body.currentPassword : '';
  const newPassword = typeof request.body.newPassword === 'string' ? request.body.newPassword : '';
  const passwordHash = database.prepare('SELECT password_hash FROM users WHERE id = ?').get(request.user.id).password_hash;
  if (!(await bcrypt.compare(currentPassword, passwordHash))) {
    return response.status(401).json({ error: 'Your current password is incorrect.' });
  }
  if (newPassword.length < 8 || newPassword.length > 72) {
    return response.status(400).json({ error: 'New password must be between 8 and 72 characters.' });
  }
  database.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .run(await bcrypt.hash(newPassword, 12), request.user.id);
  response.json({ success: true });
});

app.get('/api/users/search', requireAuth, (request, response) => {
  const query = typeof request.query.q === 'string' ? request.query.q.trim() : '';
  if (!/^\d{8}$/.test(query)) return response.json({ users: [] });
  const users = database.prepare(`
    SELECT users.id, users.username, users.contact_code, users.display_name,
      users.bio, users.avatar_path, user_contacts.nickname
    FROM users
    LEFT JOIN user_contacts ON user_contacts.owner_id = ? AND user_contacts.contact_id = users.id
    WHERE users.id != ? AND users.discoverable = 1 AND users.contact_code = ?
    LIMIT 1
  `).all(request.user.id, request.user.id, query);
  response.json({ users: users.map((person) => ({
    ...publicUser(person),
    profile_name: person.display_name,
    display_name: person.nickname || person.display_name,
    nickname: person.nickname || '',
    saved_as: person.nickname || '',
  })) });
});

app.get('/api/contacts', requireAuth, (request, response) => {
  const contacts = database.prepare(`
    SELECT users.id, users.username, users.contact_code, users.display_name,
      users.bio, users.avatar_path, user_contacts.nickname
    FROM user_contacts JOIN users ON users.id = user_contacts.contact_id
    WHERE user_contacts.owner_id = ? ORDER BY user_contacts.nickname COLLATE NOCASE
  `).all(request.user.id).map((person) => ({
    ...publicUser(person),
    profile_name: person.display_name,
    display_name: person.nickname,
    nickname: person.nickname,
    saved_as: person.nickname,
  }));
  response.json({ contacts });
});

app.put('/api/contacts/:contactId', requireAuth, (request, response) => {
  const contactId = Number(request.params.contactId);
  const nickname = typeof request.body.nickname === 'string' ? request.body.nickname.trim() : '';
  if (!Number.isInteger(contactId) || contactId <= 0 || contactId === request.user.id) {
    return response.status(400).json({ error: 'Choose a valid contact.' });
  }
  if (nickname.length < 1 || nickname.length > 40) {
    return response.status(400).json({ error: 'Saved name must be between 1 and 40 characters.' });
  }
  if (!database.prepare('SELECT 1 FROM users WHERE id = ?').get(contactId)) {
    return response.status(404).json({ error: 'That account could not be found.' });
  }
  database.prepare(`
    INSERT INTO user_contacts (owner_id, contact_id, nickname) VALUES (?, ?, ?)
    ON CONFLICT(owner_id, contact_id) DO UPDATE SET nickname = excluded.nickname
  `).run(request.user.id, contactId, nickname);
  response.json({ contact: { id: contactId, nickname } });
});

app.delete('/api/contacts/:contactId', requireAuth, (request, response) => {
  const contactId = Number(request.params.contactId);
  database.prepare('DELETE FROM user_contacts WHERE owner_id = ? AND contact_id = ?')
    .run(request.user.id, contactId);
  response.json({ success: true });
});

app.get('/api/conversations', requireAuth, (request, response) => {
  const conversations = database.prepare(`
    SELECT users.id, users.username, users.contact_code, users.display_name AS profile_name,
      COALESCE(user_contacts.nickname, users.display_name) AS display_name,
      user_contacts.nickname AS saved_as, users.bio, users.avatar_path, latest.body AS last_message,
      latest.created_at AS last_message_at
    FROM users
    LEFT JOIN user_contacts ON user_contacts.owner_id = ? AND user_contacts.contact_id = users.id
    LEFT JOIN messages AS latest ON latest.id = (
      SELECT id FROM messages
      WHERE (sender_id = ? AND recipient_id = users.id)
         OR (sender_id = users.id AND recipient_id = ?)
      ORDER BY id DESC LIMIT 1
    )
    WHERE users.id != ? AND EXISTS (
      SELECT 1 FROM messages
      WHERE (sender_id = ? AND recipient_id = users.id)
         OR (sender_id = users.id AND recipient_id = ?)
    )
    ORDER BY latest.id DESC
  `).all(request.user.id, request.user.id, request.user.id, request.user.id, request.user.id, request.user.id);
  response.json({ conversations: conversations.map((conversation) => ({
    ...publicUser(conversation),
    last_message: conversation.last_message,
    last_message_at: conversation.last_message_at,
  })) });
});

app.get('/api/conversations/:userId/messages', requireAuth, (request, response) => {
  const otherId = Number(request.params.userId);
  if (!Number.isInteger(otherId) || otherId <= 0 || otherId === request.user.id) {
    return response.status(400).json({ error: 'Choose a valid conversation.' });
  }
  const messages = database.prepare(`
    SELECT messages.id, messages.sender_id, messages.recipient_id, messages.body,
      messages.attachment_path, messages.attachment_name, messages.attachment_type,
      messages.attachment_size, messages.created_at, users.username AS sender_username
    FROM messages JOIN users ON users.id = messages.sender_id
    WHERE (messages.sender_id = ? AND messages.recipient_id = ?)
       OR (messages.sender_id = ? AND messages.recipient_id = ?)
    ORDER BY messages.id DESC LIMIT 100
  `).all(request.user.id, otherId, otherId, request.user.id).reverse();
  response.json({ messages: messages.map(publicMessage) });
});

const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: true, credentials: true } });

io.use((socket, next) => {
  try {
    socket.user = userFromToken(socket.handshake.auth?.token);
    next();
  } catch {
    next(new Error('Authentication required'));
  }
});

const onlineSockets = new Map();

io.on('connection', (socket) => {
  socket.join(`user:${socket.user.id}`);
  const socketIds = onlineSockets.get(socket.user.id) ?? new Set();
  const wasOnline = socketIds.size > 0;
  socketIds.add(socket.id);
  onlineSockets.set(socket.user.id, socketIds);
  socket.emit('presence:sync', [...onlineSockets.keys()].filter((userId) => userId !== socket.user.id));
  if (!wasOnline) io.emit('presence:update', { userId: socket.user.id, online: true });

  socket.on('typing', (event) => {
    const groupId = Number(event?.groupId);
    if (Number.isInteger(groupId) && groupId > 0) {
      if (!isGroupMember(groupId, socket.user.id)) return;
      for (const userId of groupMemberIds(groupId)) {
        if (userId === socket.user.id) continue;
        io.to(`user:${userId}`).emit('typing', {
          userId: socket.user.id,
          username: socket.user.username,
          groupId,
          isTyping: Boolean(event?.isTyping),
        });
      }
      return;
    }
    const recipientId = Number(event?.recipientId);
    if (!Number.isInteger(recipientId) || recipientId <= 0 || recipientId === socket.user.id) return;
    io.to(`user:${recipientId}`).emit('typing', {
      userId: socket.user.id,
      isTyping: Boolean(event?.isTyping),
    });
  });

  socket.on('disconnect', () => {
    const currentSockets = onlineSockets.get(socket.user.id);
    if (!currentSockets) return;
    currentSockets.delete(socket.id);
    if (currentSockets.size === 0) {
      onlineSockets.delete(socket.user.id);
      io.emit('presence:update', { userId: socket.user.id, online: false });
    }
  });
});

app.get('/api/messages/:messageId/attachment', requireAuth, (request, response) => {
  const messageId = Number(request.params.messageId);
  if (!Number.isInteger(messageId) || messageId <= 0) {
    return response.status(404).json({ error: 'Attachment not found.' });
  }
  const message = database.prepare(`
    SELECT attachment_path, attachment_name, attachment_type, group_id, sender_id, recipient_id
    FROM messages WHERE id = ?
  `).get(messageId);
  if (!message?.attachment_path) return response.status(404).json({ error: 'Attachment not found.' });
  if (message.group_id ? !isGroupMember(message.group_id, request.user.id)
    : message.sender_id !== request.user.id && message.recipient_id !== request.user.id) {
    return response.status(404).json({ error: 'Attachment not found.' });
  }
  const filename = path.basename(message.attachment_path);
  const safeName = message.attachment_name.replace(/[\r\n"]/g, '_');
  const disposition = inlineImageTypes.has(message.attachment_type) ? 'inline' : 'attachment';
  response.set({
    'Content-Type': message.attachment_type || 'application/octet-stream',
    'Content-Disposition': `${disposition}; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(message.attachment_name)}`,
    'Cache-Control': 'private, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
  });
  fs.createReadStream(path.join(messageFileDirectory, filename)).pipe(response);
});

app.post('/api/messages', requireAuth, (request, response, next) => {
  messageUpload.single('file')(request, response, (error) => {
    if (error) {
      const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      return response.status(status).json({ error: status === 413 ? 'Files must be 15 MB or smaller.' : 'Could not read that file.' });
    }
    next();
  });
}, (request, response) => {
  const recipientId = Number(request.body.recipientId);
  const body = typeof request.body.body === 'string' ? request.body.body.trim() : '';
  if (!Number.isInteger(recipientId) || recipientId <= 0 || recipientId === request.user.id) {
    return response.status(400).json({ error: 'Choose a valid recipient.' });
  }
  if ((!body && !request.file) || body.length > 4000) {
    return response.status(400).json({ error: 'Add a message or choose a file. Messages are limited to 4000 characters.' });
  }
  const recipient = database.prepare('SELECT id FROM users WHERE id = ?').get(recipientId);
  if (!recipient) return response.status(404).json({ error: 'That account could not be found.' });
  const file = request.file;
  const attachmentPath = file ? `${crypto.randomUUID()}.upload` : '';
  if (file) fs.writeFileSync(path.join(messageFileDirectory, attachmentPath), file.buffer, { flag: 'wx', mode: 0o600 });
  try {
    const result = database.prepare(`
      INSERT INTO messages (
        sender_id, recipient_id, body, attachment_path, attachment_name, attachment_type, attachment_size
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      request.user.id,
      recipientId,
      body,
      attachmentPath,
      file ? path.basename(file.originalname).slice(0, 180) : '',
      file ? file.mimetype : '',
      file ? file.size : 0,
    );
    const message = publicMessage(database.prepare(`
      SELECT messages.id, messages.sender_id, messages.recipient_id, messages.body,
        messages.attachment_path, messages.attachment_name, messages.attachment_type,
        messages.attachment_size, messages.created_at, users.username AS sender_username
      FROM messages JOIN users ON users.id = messages.sender_id WHERE messages.id = ?
    `).get(result.lastInsertRowid));
    io.to(`user:${request.user.id}`).to(`user:${recipientId}`).emit('message', message);
    response.status(201).json({ message });
  } catch (error) {
    if (attachmentPath) fs.rmSync(path.join(messageFileDirectory, attachmentPath), { force: true });
    console.error(error);
    response.status(500).json({ error: 'Could not send this message.' });
  }
});

app.post('/api/groups', requireAuth, (request, response) => {
  const name = typeof request.body.name === 'string' ? request.body.name.trim() : '';
  const requestedIds = Array.isArray(request.body.memberIds) ? request.body.memberIds : [];
  const memberIds = [...new Set(requestedIds.map(Number))]
    .filter((id) => Number.isInteger(id) && id > 0 && id !== request.user.id);
  if (name.length < 1 || name.length > 40) {
    return response.status(400).json({ error: 'Group name must be between 1 and 40 characters.' });
  }
  if (memberIds.length < 1 || memberIds.length > 49) {
    return response.status(400).json({ error: 'Choose between 1 and 49 other members.' });
  }
  const placeholders = memberIds.map(() => '?').join(', ');
  const validMembers = database.prepare(`
    SELECT id FROM users WHERE discoverable = 1 AND id IN (${placeholders})
  `).all(...memberIds);
  if (validMembers.length !== memberIds.length) {
    return response.status(400).json({ error: 'One or more selected members are unavailable.' });
  }
  const createGroup = database.transaction(() => {
    const result = database.prepare('INSERT INTO chat_groups (name, creator_id) VALUES (?, ?)')
      .run(name, request.user.id);
    const groupId = Number(result.lastInsertRowid);
    const addMember = database.prepare('INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, ?)');
    addMember.run(groupId, request.user.id, 'admin');
    for (const userId of memberIds) addMember.run(groupId, userId, 'member');
    return groupId;
  });
  const groupId = createGroup();
  const group = {
    id: groupId,
    name,
    display_name: name,
    type: 'group',
    member_count: memberIds.length + 1,
    last_message: '',
    last_message_at: null,
  };
  for (const userId of [request.user.id, ...memberIds]) {
    io.to(`user:${userId}`).emit('group:created', group);
  }
  response.status(201).json({ group });
});

app.get('/api/groups', requireAuth, (request, response) => {
  const groups = database.prepare(`
    SELECT groups.id, groups.name, groups.creator_id,
      (SELECT COUNT(*) FROM group_members AS members WHERE members.group_id = groups.id) AS member_count,
      latest.body AS last_message, latest.created_at AS last_message_at
    FROM chat_groups AS groups
    JOIN group_members AS mine ON mine.group_id = groups.id AND mine.user_id = ?
    LEFT JOIN messages AS latest ON latest.id = (
      SELECT id FROM messages WHERE group_id = groups.id ORDER BY id DESC LIMIT 1
    )
    ORDER BY COALESCE(latest.id, groups.id) DESC
  `).all(request.user.id).map((group) => ({
    ...group,
    display_name: group.name,
    type: 'group',
  }));
  response.json({ groups });
});

app.get('/api/groups/:groupId', requireAuth, (request, response) => {
  const groupId = Number(request.params.groupId);
  if (!Number.isInteger(groupId) || groupId <= 0 || !isGroupMember(groupId, request.user.id)) {
    return response.status(404).json({ error: 'Group not found.' });
  }
  const group = database.prepare('SELECT id, name, creator_id, created_at FROM chat_groups WHERE id = ?').get(groupId);
  const members = database.prepare(`
    SELECT users.id, users.username, users.contact_code, users.display_name, users.bio, users.avatar_path,
      group_members.role, group_members.joined_at
    FROM group_members JOIN users ON users.id = group_members.user_id
    WHERE group_members.group_id = ? ORDER BY group_members.role DESC, users.display_name COLLATE NOCASE
  `).all(groupId).map((member) => ({ ...publicUser(member), role: member.role, joined_at: member.joined_at }));
  response.json({ group: { ...group, type: 'group', member_count: members.length }, members });
});

app.get('/api/groups/:groupId/messages', requireAuth, (request, response) => {
  const groupId = Number(request.params.groupId);
  if (!Number.isInteger(groupId) || groupId <= 0 || !isGroupMember(groupId, request.user.id)) {
    return response.status(404).json({ error: 'Group not found.' });
  }
  const messages = database.prepare(`
    SELECT messages.id, messages.sender_id, messages.recipient_id, messages.group_id, messages.body,
      messages.attachment_path, messages.attachment_name, messages.attachment_type,
      messages.attachment_size, messages.created_at,
      users.username AS sender_username, users.display_name AS sender_display_name
    FROM messages JOIN users ON users.id = messages.sender_id
    WHERE messages.group_id = ? ORDER BY messages.id DESC LIMIT 100
  `).all(groupId).reverse();
  response.json({ messages: messages.map(publicMessage) });
});

app.post('/api/groups/:groupId/messages', requireAuth, (request, response, next) => {
  messageUpload.single('file')(request, response, (error) => {
    if (error) {
      const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      return response.status(status).json({ error: status === 413 ? 'Files must be 15 MB or smaller.' : 'Could not read that file.' });
    }
    next();
  });
}, (request, response) => {
  const groupId = Number(request.params.groupId);
  if (!Number.isInteger(groupId) || groupId <= 0 || !isGroupMember(groupId, request.user.id)) {
    return response.status(404).json({ error: 'Group not found.' });
  }
  const body = typeof request.body.body === 'string' ? request.body.body.trim() : '';
  if ((!body && !request.file) || body.length > 4000) {
    return response.status(400).json({ error: 'Add a message or choose a file. Messages are limited to 4000 characters.' });
  }
  const file = request.file;
  const attachmentPath = file ? `${crypto.randomUUID()}.upload` : '';
  if (file) fs.writeFileSync(path.join(messageFileDirectory, attachmentPath), file.buffer, { flag: 'wx', mode: 0o600 });
  try {
    const result = database.prepare(`
      INSERT INTO messages (
        sender_id, recipient_id, group_id, body, attachment_path, attachment_name, attachment_type, attachment_size
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      request.user.id,
      request.user.id,
      groupId,
      body,
      attachmentPath,
      file ? path.basename(file.originalname).slice(0, 180) : '',
      file ? file.mimetype : '',
      file ? file.size : 0,
    );
    const message = publicMessage(database.prepare(`
      SELECT messages.id, messages.sender_id, messages.recipient_id, messages.group_id, messages.body,
        messages.attachment_path, messages.attachment_name, messages.attachment_type,
        messages.attachment_size, messages.created_at,
        users.username AS sender_username, users.display_name AS sender_display_name
      FROM messages JOIN users ON users.id = messages.sender_id WHERE messages.id = ?
    `).get(result.lastInsertRowid));
    for (const userId of groupMemberIds(groupId)) io.to(`user:${userId}`).emit('message', message);
    response.status(201).json({ message });
  } catch (error) {
    if (attachmentPath) fs.rmSync(path.join(messageFileDirectory, attachmentPath), { force: true });
    console.error(error);
    response.status(500).json({ error: 'Could not send this group message.' });
  }
});

app.post('/api/statuses', requireAuth, (request, response, next) => {
  messageUpload.single('file')(request, response, (error) => {
    if (error) {
      const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      return response.status(status).json({ error: status === 413 ? 'Status media must be 15 MB or smaller.' : 'Could not read that media.' });
    }
    next();
  });
}, (request, response) => {
  const body = typeof request.body.body === 'string' ? request.body.body.trim() : '';
  if ((!body && !request.file) || body.length > 700) {
    return response.status(400).json({ error: 'Add text or choose a photo/video. Status text is limited to 700 characters.' });
  }
  if (request.file && !request.file.mimetype.startsWith('image/') && !request.file.mimetype.startsWith('video/')) {
    return response.status(400).json({ error: 'Status media must be an image or video.' });
  }
  const file = request.file;
  const attachmentPath = file ? `status-${crypto.randomUUID()}.upload` : '';
  if (file) fs.writeFileSync(path.join(statusFileDirectory, attachmentPath), file.buffer, { flag: 'wx', mode: 0o600 });
  try {
    const createdAt = Date.now();
    const expiresAt = createdAt + 24 * 60 * 60 * 1000;
    const result = database.prepare(`
      INSERT INTO statuses (
        user_id, body, attachment_path, attachment_name, attachment_type, attachment_size, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      request.user.id,
      body,
      attachmentPath,
      file ? path.basename(file.originalname).slice(0, 180) : '',
      file ? file.mimetype : '',
      file ? file.size : 0,
      createdAt,
      expiresAt,
    );
    const status = database.prepare('SELECT * FROM statuses WHERE id = ?').get(result.lastInsertRowid);
    const visibleUserIds = database.prepare('SELECT id FROM users WHERE discoverable = 1 OR id = ?')
      .all(request.user.id).map((user) => user.id);
    for (const userId of visibleUserIds) io.to(`user:${userId}`).emit('status:new', { userId: request.user.id });
    response.status(201).json({ status: publicStatus(status) });
  } catch (error) {
    if (attachmentPath) fs.rmSync(path.join(statusFileDirectory, attachmentPath), { force: true });
    console.error(error);
    response.status(500).json({ error: 'Could not publish this status.' });
  }
});

app.get('/api/statuses', requireAuth, (request, response) => {
  const now = Date.now();
  const statuses = database.prepare(`
    SELECT statuses.*, users.id AS profile_id, users.username, users.contact_code, users.display_name,
      users.bio, users.notifications_enabled, users.discoverable, users.dark_mode,
      users.avatar_path,
      EXISTS(SELECT 1 FROM status_views WHERE status_id = statuses.id AND viewer_id = ?) AS viewed,
      (SELECT COUNT(*) FROM status_views WHERE status_id = statuses.id) AS views_count
    FROM statuses JOIN users ON users.id = statuses.user_id
    WHERE statuses.expires_at > ? AND (statuses.user_id = ? OR users.discoverable = 1)
    ORDER BY statuses.created_at
  `).all(request.user.id, now, request.user.id);
  const feed = new Map();
  for (const status of statuses) {
    if (!feed.has(status.user_id)) {
      feed.set(status.user_id, {
        user: publicUser({
          id: status.profile_id,
          username: status.username,
          contact_code: status.contact_code,
          display_name: status.display_name,
          bio: status.bio,
          notifications_enabled: status.notifications_enabled,
          discoverable: status.discoverable,
          dark_mode: status.dark_mode,
          avatar_path: status.avatar_path,
        }),
        own: status.user_id === request.user.id,
        statuses: [],
      });
    }
    feed.get(status.user_id).statuses.push(publicStatus(status));
  }
  response.json({ updates: [...feed.values()] });
});

app.post('/api/statuses/:statusId/view', requireAuth, (request, response) => {
  const statusId = Number(request.params.statusId);
  const status = database.prepare(`
    SELECT statuses.id, statuses.user_id FROM statuses JOIN users ON users.id = statuses.user_id
    WHERE statuses.id = ? AND statuses.expires_at > ? AND (statuses.user_id = ? OR users.discoverable = 1)
  `).get(statusId, Date.now(), request.user.id);
  if (!status) return response.status(404).json({ error: 'Status not found.' });
  if (status.user_id !== request.user.id) {
    database.prepare(`
      INSERT INTO status_views (status_id, viewer_id, viewed_at) VALUES (?, ?, ?)
      ON CONFLICT(status_id, viewer_id) DO UPDATE SET viewed_at = excluded.viewed_at
    `).run(statusId, request.user.id, Date.now());
  }
  response.json({ success: true });
});

app.get('/api/statuses/:statusId/attachment', requireAuth, (request, response) => {
  const statusId = Number(request.params.statusId);
  const status = database.prepare(`
    SELECT statuses.user_id, statuses.attachment_path, statuses.attachment_name, statuses.attachment_type
    FROM statuses JOIN users ON users.id = statuses.user_id
    WHERE statuses.id = ? AND statuses.expires_at > ? AND (statuses.user_id = ? OR users.discoverable = 1)
  `).get(statusId, Date.now(), request.user.id);
  if (!status?.attachment_path) return response.status(404).json({ error: 'Status media not found.' });
  const filename = path.basename(status.attachment_path);
  const safeName = status.attachment_name.replace(/[\r\n"]/g, '_');
  const disposition = inlineImageTypes.has(status.attachment_type) ? 'inline' : 'attachment';
  response.set({
    'Content-Type': status.attachment_type || 'application/octet-stream',
    'Content-Disposition': `${disposition}; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(status.attachment_name)}`,
    'Cache-Control': 'private, max-age=300',
    'X-Content-Type-Options': 'nosniff',
  });
  fs.createReadStream(path.join(statusFileDirectory, filename)).pipe(response);
});

app.delete('/api/statuses/:statusId', requireAuth, (request, response) => {
  const statusId = Number(request.params.statusId);
  const status = database.prepare('SELECT user_id, attachment_path FROM statuses WHERE id = ?').get(statusId);
  if (!status || status.user_id !== request.user.id) return response.status(404).json({ error: 'Status not found.' });
  database.prepare('DELETE FROM statuses WHERE id = ?').run(statusId);
  if (status.attachment_path) fs.rmSync(path.join(statusFileDirectory, path.basename(status.attachment_path)), { force: true });
  response.json({ success: true });
});

const productionClient = path.join(root, 'dist');
if (fs.existsSync(productionClient)) {
  app.use(express.static(productionClient));
  app.get('*path', (_request, response) => response.sendFile(path.join(productionClient, 'index.html')));
}

const port = Number(process.env.PORT ?? 3000);
httpServer.listen(port, '0.0.0.0', () => {
  console.log(`FarazChat server listening on http://localhost:${port}`);
});