const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
require('dotenv').config();

// Импорт роутов сообщений
const messageRoutes = require('./routes/messageRoutes');

const app = express();

// НАСТРОЙКА ЗАГРУЗКИ ФАЙЛОВ (MULTER)
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// Настройки CORS и JSON-парсера
app.use(cors());
app.use(express.json());

// Раздача статики (строго один раз)
app.use('/uploads', express.static(uploadDir));

const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: ["http://localhost:5173", "http://localhost:5001"],
        methods: ["GET", "POST"]
    },
    transports: ['websocket'] // Фиксируем чистый вебсокет
});

// Настраиваем пул соединений для Prisma 7 (лимит 2 подключения)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 2,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000
});
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// Делимся клиентом со всеми контроллерами проекта
app.set('prisma', prisma);

// Регистрируем API-роут для получения истории сообщений
app.use('/api/messages', messageRoutes);

// Настраиваем хранилище Multer (сохраняем оригинальное расширение)
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, file.fieldname + '-' + uniqueSuffix + ext);
    }
});

// Ограничение типов файлов и размера (до 10 МБ) для безопасности
const upload = multer({ 
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowedExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.pdf', '.bmp','.doc', '.docx', '.txt', '.mp3', '.mp4'];
        const ext = path.extname(file.originalname).toLowerCase();
        if (!allowedExtensions.includes(ext)) {
            return cb(new Error('Недопустимый тип файла. Разрешены только изображения, документы и медиа.'));
        }
        cb(null, true);
    }
});

// HTTP-маршрут для загрузки файлов
app.post('/api/upload', (req, res) => {
    upload.single('file')(req, res, function (err) {
        if (err instanceof multer.MulterError) {
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(400).json({ error: 'Файл слишком большой. Максимальный размер: 10 МБ.' });
            }
            return res.status(400).json({ error: err.message });
        } else if (err) {
            return res.status(400).json({ error: err.message });
        }

        try {
            if (!req.file) {
                return res.status(400).json({ error: 'Файл не загружен' });
            }
            // Относительный путь без хардкода localhost для Capacitor мобилок
            const fileUrl = `/uploads/${req.file.filename}`;
            return res.json({ fileUrl });
        } catch (err) {
            console.error('Ошибка загрузки файла на сервере:', err);
            return res.status(500).json({ error: 'Ошибка сервера при сохранении файла' });
        }
    });
});

// ==========================================
// МИДЛВЕЙР ДЛЯ ПРОВЕРКИ JWT И ЗАЩИТЫ РОУТОВ (ИСПРАВЛЕНО ИНДЕКСИРОВАНИЕ МАССИВА)
// ==========================================
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    
    console.log('📡 [JWT Проверка] Получен заголовок:', authHeader);

    if (!authHeader) {
        return res.status(401).json({ error: 'Доступ запрещен. Токен отсутствует.' });
    }

    const parts = authHeader.split(' ');
    // [ИСПРАВЛЕНО] Строго проверяем первый элемент массива parts[0], а не весь массив целиком!
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
        console.error('❌ [JWT Ошибка] Некорректный формат заголовка. Ожидалось "Bearer <token>"');
        return res.status(400).json({ error: 'Некорректный формат авторизации' });
    }

    const token = parts[1]; // Берем сам токен из второго элемента массива

    jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
        if (err) {
            console.error('❌ [JWT Ошибка] Сбой валидации строки токена:', err.message);
            return res.status(403).json({ error: 'Невалидный или просроченный токен' });
        }
        req.userId = Number(decoded.userId);
        next();
    });
};



// ==========================================
// 0.1. МАРШРУТ ДЛЯ ПОЛУЧЕНИЯ СПИСКА КОНТАКТОВ
// ==========================================
app.get('/api/users', authenticateToken, async (req, res) => {
    try {
        const currentUserId = req.userId;

        const users = await prisma.user.findMany({
            where: {
                NOT: { id: currentUserId }
            },
            select: {
                id: true,
                username: true,
                avatar: true
            }
        });

        const formattedUsers = users.map(u => ({
            id: `user_${u.id}`,
            dbId: u.id,
            name: u.username,
            avatar: u.avatar || "👤",
            unreadCount: 0,
            messages: []
        }));

        res.json(formattedUsers);
    } catch (error) {
        console.error('Ошибка при получении списка пользователей:', error);
        res.status(500).json({ error: 'Не удалось загрузить список контактов' });
    }
});

// ==========================================
// 0.2. МАРШРУТ ДЛЯ ПОЛУЧЕНИЯ СПИСКА ПУБЛИЧНЫХ КАНАЛОВ
// ==========================================
app.get('/api/channels', authenticateToken, async (req, res) => {
    try {
        const channelsList = await prisma.channel.findMany({
            orderBy: { id: 'asc' }
        });
        return res.json(channelsList);
    } catch (error) {
        console.error('Ошибка при получении каналов из БД:', error);
        return res.status(500).json({ error: 'База данных временно перегружена' });
    }
});

// ==========================================
// СОЗДАНИЕ НОВОГО КАНАЛА
// ==========================================
app.post('/api/channels', authenticateToken, async (req, res) => {
    try {
        const { name, avatar } = req.body;
        const creatorId = req.userId;

        if (!name) {
            return res.status(400).json({ error: 'Название канала обязательно' });
        }

        const newChannel = await prisma.channel.create({
            data: {
                name: name.trim(),
                avatar: avatar || '📢',
                creatorId: creatorId
            },
        });

        try {
            if (typeof io !== 'undefined') {
                io.emit('channel_created', newChannel);
            }
        } catch (socketError) {
            console.error('⚠️ Ошибка отправки события через сокеты:', socketError);
        }

        return res.status(201).json(newChannel);
    } catch (error) {
        console.error('💥 КРИТИЧЕСКАЯ ОШИБКА РОУТА CHANNELS:', error);
        return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// ==========================================
// 1. МАРШРУТ РЕГИСТРАЦИИ
// ==========================================
app.post('/api/auth/register', async (req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({ error: 'Заполните все поля!' });
        }

        const trimmedUsername = username.trim();

        const existingUser = await prisma.user.findFirst({
            where: { username: trimmedUsername }
        });

        if (existingUser) {
            return res.status(400).json({ error: 'Этот никнейм уже занят!' });
        }

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        const newUser = await prisma.user.create({
            data: {
                username: trimmedUsername,
                password: hashedPassword,
                email: `${trimmedUsername.toLowerCase()}@messenger.local`
            }
        });

        const token = jwt.sign({ userId: newUser.id }, process.env.JWT_SECRET, { expiresIn: '30d' });

        res.status(201).json({
            token,
            user: {
                id: newUser.id,
                username: newUser.username
            }
        });
    } catch (error) {
        console.error('Ошибка регистрации:', error);
        res.status(500).json({ error: 'Ошибка сервера при регистрации' });
    }
});

// ==========================================
// 2. МАРШРУТ АВТОРИЗАЦИИ (ВХОД)
// ==========================================
app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({ error: 'Заполните все поля!' });
        }

        const user = await prisma.user.findFirst({
            where: { username: username.trim() }
        });

        if (!user) {
            return res.status(400).json({ error: 'Неверный никнейм или пароль!' });
        }

        const isPasswordCorrect = await bcrypt.compare(password, user.password);
        if (!isPasswordCorrect) {
            return res.status(400).json({ error: 'Неверный никнейм или пароль!' });
        }

        const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '30d' });

        res.json({
            token,
            user: {
                id: user.id,
                username: user.username
            }
        });
    } catch (error) {
        console.error('Ошибка входа:', error);
        res.status(500).json({ error: 'Ошибка сервера при входе' });
    }
});
// ==========================================
// 3. БЛОК SOCKET.IO С ЗАЩИТОЙ И ТРЕКЕРОМ ОНЛАЙНА
// ==========================================
const onlineUsers = new Map();

// Сокетный мидлвейр авторизации
io.use((socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.headers['authorization']?.split(' ')[1];
    
    if (!token) {
        return next(new Error('Authentication error: Token missing'));
    }

    jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
        if (err) return next(new Error('Authentication error: Invalid token'));
        socket.userId = Number(decoded.userId);
        next();
    });
});

io.on('connection', (socket) => {
    const currentUserId = socket.userId;
    console.log(`📡 Пользователь ${currentUserId} подключился через сокет: ${socket.id}`);

    // Добавляем пользователя в онлайн трекер
    onlineUsers.set(currentUserId, socket.id);
    io.emit('user_status_change', { userId: currentUserId, status: 'online' });

    // Подключение пользователя к комнате чата
    socket.on('join_chat', (chatId) => {
        if (!chatId) return;
        socket.join(chatId);
        console.log(`🚪 Сокет ${socket.id} (Юзер ${currentUserId}) зафиксирован в комнате: ${chatId}`);
    });

    // === 1. ОБРАБОТКА ОТПРАВКИ СООБЩЕНИЯ ===
    socket.on('send_message', async (messageData) => {
        try {
            const { text, mediaUrl, mediaType, activeChatId } = messageData;
            const senderId = socket.userId; 
            
            let receiverId = null;
            let channelId = null;
            let targetRoom = 'chat_general';

            if (!activeChatId) return;

            if (activeChatId.startsWith('user_')) {
                receiverId = parseInt(activeChatId.replace('user_', ''), 10);
                if (isNaN(receiverId)) return;

                const ids = [senderId, receiverId].sort((a, b) => a - b);
                targetRoom = `room_${ids[0]}_${ids[1]}`;
            }
            else if (activeChatId.startsWith('channel_')) {
                channelId = parseInt(activeChatId.replace('channel_', ''), 10);
                if (isNaN(channelId)) return;

                targetRoom = `channel_${channelId}`;

                const channel = await prisma.channel.findUnique({
                    where: { id: channelId }
                });

                if (!channel || channel.creatorId !== senderId) {
                    console.warn(`[🔒 SECURITY] Юзер ${senderId} пытался спамить в канал ${channelId} без прав!`);
                    return;
                }
            }

            const savedMessage = await prisma.message.create({
                data: {
                    text: text || null,
                    mediaUrl: mediaUrl || null,
                    mediaType: mediaType || null,
                    senderId: senderId,
                    receiverId: receiverId,
                    channelId: channelId
                },
                include: {
                    sender: { select: { id: true, username: true } }
                }
            });

            const newMessage = { ...savedMessage, status: 'unread', activeChatId };

            if (channelId) {
                io.to(targetRoom).emit('receive_message', newMessage);
            } else if (receiverId) {
                const targetSocketId = onlineUsers.get(receiverId);
                socket.emit('receive_message', newMessage); 
                if (targetSocketId) {
                    io.to(targetSocketId).emit('receive_message', newMessage); 
                }
            } else {
                io.to('chat_general').emit('receive_message', newMessage);
            }

            if (activeChatId === 'user_1') {
                socket.emit('typing');

                setTimeout(async () => {
                    try {
                        socket.emit('stop_typing');

                        const savedBotMessage = await prisma.message.create({
                            data: {
                                text: `Автоответ: Я получил твое сообщение "${text || 'Медиафайл'}"! 🤔`,
                                senderId: 1,
                                receiverId: senderId
                            },
                            include: {
                                sender: { select: { id: true, username: true } }
                            }
                        });

                        const botMessage = { ...savedBotMessage, status: 'unread', activeChatId: `user_1` };
                        socket.emit('receive_message', botMessage);
                    } catch (botErr) {
                        console.error('Ошибка бота:', botErr);
                        socket.emit('stop_typing');
                    }
                }, 2000);
            }
        } catch (error) {
            console.error('Ошибка сохранения сообщения:', error);
        }
    });
    // === 2. ОБРАБОТКА УДАЛЕНИЯ СООБЩЕНИЯ ===
    socket.on('delete_message', async ({ messageId, activeChatId }) => {
        try {
            const message = await prisma.message.findUnique({
                where: { id: Number(messageId) }
            });

            if (!message || message.senderId !== socket.userId) {
                console.warn(`[🔒 SECURITY] Юзер ${socket.userId} пытался удалить чужое сообщение №${messageId}`);
                return;
            }

            const updatedMessage = await prisma.message.update({
                where: { id: Number(messageId) },
                data: { text: "Сообщение удалено" }
            });

            const deletePayload = {
                messageId: updatedMessage.id,
                activeChatId,
                isDeleted: true
            };

            if (activeChatId && activeChatId.startsWith('user_')) {
                const receiverId = parseInt(activeChatId.replace('user_', ''), 10);
                socket.emit('message_deleted', deletePayload);
                const targetSocketId = onlineUsers.get(receiverId);
                if (targetSocketId) {
                    io.to(targetSocketId).emit('message_deleted', deletePayload);
                }
            } else if (activeChatId && activeChatId.startsWith('channel_')) {
                const channelId = parseInt(activeChatId.replace('channel_', ''), 10);
                io.to(`channel_${channelId}`).emit('message_deleted', deletePayload);
            } else {
                io.to('chat_general').emit('message_deleted', deletePayload);
            }
            console.log(`🗑️ Сообщение №${messageId} успешно удалено`);
        } catch (err) {
            console.error('Ошибка удаления:', err);
        }
    });

    // === 2.1. ОБРАБОТКА ПРОЧТЕНИЯ СООБЩЕНИЙ ===
    socket.on('read_messages', async (data) => {
        try {
            if (!data) return;
            const { activeChatId } = data;
            const myId = socket.userId;

            if (!activeChatId) return;

            console.log(`👁️ Юзер ${myId} прочитал историю чата: ${activeChatId}`);
            const readPayload = { activeChatId, readerId: myId };

            if (activeChatId.startsWith('user_')) {
                const cleanId = parseInt(activeChatId.replace('user_', ''), 10);
                socket.emit('messages_read_update', readPayload);
                const targetSocketId = onlineUsers.get(cleanId);
                if (targetSocketId) {
                    io.to(targetSocketId).emit('messages_read_update', readPayload);
                }
            } else if (activeChatId.startsWith('channel_')) {
                const cleanId = parseInt(activeChatId.replace('channel_', ''), 10);
                io.to(`channel_${cleanId}`).emit('messages_read_update', readPayload);
            } else {
                io.to('chat_general').emit('messages_read_update', readPayload);
            }
        } catch (err) {
            console.error('Ошибка в обработчике read_messages:', err);
        }
    });

    // === 3. ТРАНСЛЯЦИЯ СТАТУСА ПЕЧАТАНИЯ ===
    socket.on('typing', (data) => {
        if (!data || !data.activeChatId) return;
        const { activeChatId } = data;
        const senderId = socket.userId; 

        if (activeChatId === 'chat_general') {
            socket.to('chat_general').emit('typing', { senderId, isGeneral: true });
        } else if (activeChatId.startsWith('channel_')) {
            socket.to(activeChatId).emit('typing', { senderId, isGeneral: false });
        } else if (activeChatId.startsWith('user_')) {
            const targetUserId = parseInt(activeChatId.replace('user_', ''), 10);
            if (!isNaN(targetUserId)) {
                const targetSocketId = onlineUsers.get(targetUserId);
                if (targetSocketId) {
                    io.to(targetSocketId).emit('typing', { senderId, isGeneral: false });
                }
            }
        }
    });

    socket.on('stop_typing', (data) => {
        if (!data || !data.activeChatId) return;
        const { activeChatId } = data;

        if (activeChatId === 'chat_general') {
            socket.to('chat_general').emit('stop_typing');
        } else if (activeChatId.startsWith('channel_')) {
            socket.to(activeChatId).emit('stop_typing');
        } else if (activeChatId.startsWith('user_')) {
            const targetUserId = parseInt(activeChatId.replace('user_', ''), 10);
            if (!isNaN(targetUserId)) {
                const targetSocketId = onlineUsers.get(targetUserId);
                if (targetSocketId) {
                    io.to(targetSocketId).emit('stop_typing');
                }
            }
        }
    });

    // === 4. ОБРАБОТКА ОТКЛЮЧЕНИЯ ПОЛЬЗОВАТЕЛЯ ===
    socket.on('disconnect', () => {
        const userId = socket.userId;
        console.log(`🔌 Пользователь ${userId} отключился`);

        if (userId && onlineUsers.get(userId) === socket.id) {
            onlineUsers.delete(userId);
            io.emit('user_status_change', { userId, status: 'offline' });
        }
    });
}); // <--- Вот здесь закрывается io.on('connection')

// === ЗАПУСК СЕРВЕРА ===
const PORT = 5001;
server.listen(PORT, () => {
    console.log(`🚀 Сервер успешно запущен на http://localhost:${PORT}`);
});
