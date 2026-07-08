const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
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
    transports: ['websocket']
});

// ==========================================
// ПОДКЛЮЧЕНИЕ К БАЗЕ ДАННЫХ
// ==========================================
const prisma = new PrismaClient();

// Проверка подключения
prisma.$connect()
    .then(() => {
        console.log('✅ Подключение к PostgreSQL успешно!');
    })
    .catch((err) => {
        console.error('❌ Ошибка подключения к PostgreSQL:', err.message);
        process.exit(1);
    });

// Делимся клиентом со всеми контроллерами проекта
app.set('prisma', prisma);

// Регистрируем API-роут для получения истории сообщений
app.use('/api/messages', messageRoutes);



// Настраиваем хранилище Multer
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

const upload = multer({
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowedExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.pdf', '.bmp', '.doc', '.docx', '.txt', '.mp3', '.mp4'];
        const ext = path.extname(file.originalname).toLowerCase();
        if (!allowedExtensions.includes(ext)) {
            return cb(new Error('Недопустимый тип файла. Разрешены только изображения, документы и медиа.'));
        }
        cb(null, true);
    }
});

// HTTP-маршрут для загрузки файлов
app.post('/api/upload', (req, res) => {
    upload.single('file')(req, res, function(err) {
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
            const fileUrl = `/uploads/${req.file.filename}`;
            return res.json({ fileUrl });
        } catch (err) {
            console.error('Ошибка загрузки файла на сервере:', err);
            return res.status(500).json({ error: 'Ошибка сервера при сохранении файла' });
        }
    });
});

// ==========================================
// МИДЛВЕЙР ДЛЯ ПРОВЕРКИ JWT
// ==========================================
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];

    console.log('📡 [JWT Проверка] Получен заголовок:', authHeader);

    if (!authHeader) {
        return res.status(401).json({ error: 'Доступ запрещен. Токен отсутствует.' });
    }

    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
        console.error('❌ [JWT Ошибка] Некорректный формат заголовка. Ожидалось "Bearer <token>"');
        return res.status(400).json({ error: 'Некорректный формат авторизации' });
    }

    const token = parts[1];

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
// 📊 НЕПРОЧИТАННЫЕ СООБЩЕНИЯ
// ==========================================
app.get('/api/unread', authenticateToken, async(req, res) => {
    try {
        const userId = req.userId;
        console.log(`📊 Запрос непрочитанных для пользователя ${userId}`);

        // ==========================================
        // 1. ПРИВАТНЫЕ ЧАТЫ - ИСПРАВЛЕННАЯ ВЕРСИЯ
        // ==========================================
        const privateMembers = await prisma.privateChatMember.findMany({
            where: {
                OR: [
                    { userId: userId },
                    { otherUserId: userId }
                ]
            }
        });
        console.log(`📊 Найдено приватных чатов: ${privateMembers.length}`);

        const privateUnreadCounts = {};

        for (const member of privateMembers) {
            const otherUserId = member.userId === userId ? member.otherUserId : member.userId;
            const lastReadTime = member.lastReadAt || new Date(0);
            console.log(`   Проверяю чат с пользователем ${otherUserId}, lastReadAt: ${lastReadTime}`);

            // ✅ СЧИТАЕМ ТОЛЬКО СООБЩЕНИЯ С СТАТУСОМ 'unread'
            const unreadCount = await prisma.message.count({
                where: {
                    senderId: otherUserId,
                    receiverId: userId,
                    channelId: null,
                    chatId: null,
                    status: 'unread', // ✅ ДОБАВЛЯЕМ СТАТУС
                    createdAt: {
                        gt: lastReadTime
                    }
                }
            });
            console.log(`      Непрочитанных: ${unreadCount}`);

            if (unreadCount > 0) {
                privateUnreadCounts[`user_${otherUserId}`] = unreadCount;
            }
        }
        // ==========================================
        // 2. КАНАЛЫ
        // ==========================================
        const channelMembers = await prisma.channelMember.findMany({
            where: { userId },
            include: {
                channel: {
                    include: {
                        messages: {
                            where: {
                                senderId: { not: userId }
                            }
                        }
                    }
                }
            }
        });

        const channelUnreadCounts = {};
        channelMembers.forEach(member => {
            const lastRead = member.lastReadAt || new Date(0);
            const unreadMessages = member.channel.messages.filter(
                msg => new Date(msg.createdAt) > new Date(lastRead)
            );
            const count = unreadMessages.length;
            if (count > 0) {
                channelUnreadCounts[`channel_${member.channelId}`] = count;
            }
        });

        // ==========================================
        // 3. ГРУППОВЫЕ ЧАТЫ - ИСПРАВЛЕННАЯ ВЕРСИЯ
        // ==========================================
        const chatMembers = await prisma.chatMember.findMany({
            where: { userId },
            include: {
                chat: {
                    include: {
                        messages: {
                            where: {
                                senderId: { not: userId },
                                status: 'unread' // ✅ ДОБАВЛЯЕМ СТАТУС
                            }
                        }
                    }
                }
            }
        });
        console.log(`📊 Найдено групповых чатов: ${chatMembers.length}`);

        const chatUnreadCounts = {};
        chatMembers.forEach(member => {
            const lastRead = member.lastReadAt || new Date(0);
            const unreadMessages = member.chat.messages.filter(
                msg => new Date(msg.createdAt) > new Date(lastRead)
            );
            const count = unreadMessages.length;
            console.log(`   Групповой чат ${member.chatId} (${member.chat.name}): ${count} непрочитанных`);
            if (count > 0) {
                chatUnreadCounts[`chat_${member.chatId}`] = count;
            }
        });

        // ==========================================
        // 4. ОБЪЕДИНЯЕМ
        // ==========================================
        const allUnreadCounts = {
            ...privateUnreadCounts,
            ...channelUnreadCounts,
            ...chatUnreadCounts
        };

        console.log(`📊 ИТОГОВЫЕ счетчики для пользователя ${userId}:`, allUnreadCounts);
        res.json(allUnreadCounts);
    } catch (error) {
        console.error('❌ Ошибка получения непрочитанных:', error);
        res.status(500).json({ error: 'Failed to get unread counts' });
    }
});

app.post('/api/read', authenticateToken, async(req, res) => {
    try {
        const userId = req.userId;
        const { type, id } = req.body;

        console.log(`📖 Отметка о прочтении: type=${type}, id=${id}, userId=${userId}`);

        if (!type || !id) {
            return res.status(400).json({ error: 'Не указан type или id' });
        }

        if (type === 'chat') {
            await prisma.chatMember.update({
                where: {
                    chatId_userId: {
                        chatId: parseInt(id),
                        userId
                    }
                },
                data: {
                    lastReadAt: new Date()
                }
            });
            console.log(`✅ Отметил прочтение в чате ${id}`);

        } else if (type === 'channel') {
            const channelId = parseInt(id);
            const member = await prisma.channelMember.findFirst({
                where: {
                    channelId: channelId,
                    userId: userId
                }
            });

            if (!member) {
                await prisma.channelMember.create({
                    data: {
                        channelId: channelId,
                        userId: userId,
                        role: 'member',
                        lastReadAt: new Date()
                    }
                });
            } else {
                await prisma.channelMember.update({
                    where: { id: member.id },
                    data: { lastReadAt: new Date() }
                });
            }
            console.log(`✅ Обновлен lastReadAt для канала ${channelId}`);

        } else if (type === 'private') {
            const otherUserId = parseInt(id);
            console.log(`🔍 Отмечаю прочтение в приватном чате с пользователем ${otherUserId}`);

            // ✅ ОБНОВЛЯЕМ lastReadAt
            const privateMember = await prisma.privateChatMember.findUnique({
                where: {
                    userId_otherUserId: {
                        userId: userId,
                        otherUserId: otherUserId
                    }
                }
            });

            if (!privateMember) {
                await prisma.privateChatMember.create({
                    data: {
                        userId: userId,
                        otherUserId: otherUserId,
                        lastReadAt: new Date()
                    }
                });
                console.log(`✅ Создана запись приватного чата с ${otherUserId}`);
            } else {
                await prisma.privateChatMember.update({
                    where: { id: privateMember.id },
                    data: { lastReadAt: new Date() }
                });
                console.log(`✅ Обновлен lastReadAt для приватного чата с ${otherUserId}`);
            }

            // ✅ ПОМЕЧАЕМ СООБЩЕНИЯ КАК ПРОЧИТАННЫЕ
            await prisma.message.updateMany({
                where: {
                    senderId: otherUserId,
                    receiverId: userId,
                    channelId: null,
                    chatId: null,
                    status: { not: 'read' }
                },
                data: {
                    status: 'read'
                }
            });
            console.log(`✅ Все сообщения от ${otherUserId} отмечены как прочитанные`);
        }

        res.json({ success: true });
    } catch (error) {
        console.error('❌ Ошибка в /api/read:', error);
        res.status(500).json({
            error: 'Failed to mark as read',
            details: error.message
        });
    }
});

// ==========================================
// 0.1. МАРШРУТ ДЛЯ ПОЛУЧЕНИЯ СПИСКА КОНТАКТОВ
// ==========================================
app.get('/api/users', authenticateToken, async(req, res) => {
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

        const formattedUsers = await Promise.all(users.map(async(u) => {
            const lastMessage = await prisma.message.findFirst({
                where: {
                    OR: [
                        { senderId: currentUserId, receiverId: u.id },
                        { senderId: u.id, receiverId: currentUserId }
                    ],
                    channelId: null,
                    chatId: null
                },
                orderBy: {
                    createdAt: 'desc'
                },
                include: {
                    sender: {
                        select: { id: true, username: true }
                    }
                }
            });

            return {
                id: `user_${u.id}`,
                dbId: u.id,
                name: u.username,
                avatar: u.avatar || "👤",
                unreadCount: 0,
                messages: [],
                lastMessage: lastMessage || null
            };
        }));

        res.json(formattedUsers);
    } catch (error) {
        console.error('Ошибка при получении списка пользователей:', error);
        res.status(500).json({ error: 'Не удалось загрузить список контактов' });
    }
});



// ==========================================
// СОЗДАНИЕ НОВОГО КАНАЛА
// ==========================================
app.post('/api/channels', authenticateToken, async(req, res) => {
    try {
        const { name, avatar } = req.body;
        const creatorId = req.userId;

        console.log(`📝 Создание канала: name=${name}, creatorId=${creatorId}`);

        if (!name) {
            return res.status(400).json({ error: 'Название канала обязательно' });
        }

        // Проверяем, существует ли пользователь
        const userExists = await prisma.user.findUnique({
            where: { id: creatorId }
        });

        if (!userExists) {
            console.error(`❌ Пользователь ${creatorId} не найден`);
            return res.status(400).json({ error: 'Пользователь не найден' });
        }

        const newChannel = await prisma.channel.create({
            data: {
                name: name.trim(),
                avatar: avatar || '📢',
                creatorId: creatorId,
                lastMessageId: null // Явно указываем null
            },
        });

        console.log(`✅ Канал создан: ${newChannel.id}`);

        await prisma.channelMember.create({
            data: {
                channelId: newChannel.id,
                userId: creatorId,
                role: 'admin'
            }
        });

        // Отправляем событие через сокеты
        const creatorSocketId = onlineUsers.get(creatorId);
        if (creatorSocketId) {
            io.to(creatorSocketId).emit('channel_created', newChannel);
            console.log(`📢 Канал ${newChannel.id} отправлен создателю ${creatorId}`);
        }

        return res.status(201).json(newChannel);
    } catch (error) {
        console.error('💥 ОШИБКА СОЗДАНИЯ КАНАЛА:', error);
        return res.status(500).json({
            error: 'Внутренняя ошибка сервера',
            details: error.message
        });
    }
});

// ==========================================
// 1. МАРШРУТ РЕГИСТРАЦИИ (С ВАЛИДАЦИЕЙ)
// ==========================================
app.post('/api/auth/register', async(req, res) => {
    try {
        const { username, email, password } = req.body;

        // === ВАЛИДАЦИЯ ===
        if (!username || !email || !password) {
            return res.status(400).json({
                error: 'Заполните все поля!',
                fields: ['username', 'email', 'password']
            });
        }

        // Проверка длины username (минимум 3 символа)
        const trimmedUsername = username.trim();
        if (trimmedUsername.length < 3) {
            return res.status(400).json({
                error: 'Имя пользователя должно содержать минимум 3 символа'
            });
        }

        // Проверка email
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({
                error: 'Введите корректный email адрес'
            });
        }

        // === СЛОЖНЫЙ ПАРОЛЬ ===
        const passwordErrors = [];
        if (password.length < 8) {
            passwordErrors.push('минимум 8 символов');
        }
        if (!/[A-Z]/.test(password)) {
            passwordErrors.push('хотя бы одну заглавную букву');
        }
        if (!/[a-z]/.test(password)) {
            passwordErrors.push('хотя бы одну строчную букву');
        }
        if (!/[0-9]/.test(password)) {
            passwordErrors.push('хотя бы одну цифру');
        }
        if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) {
            passwordErrors.push('хотя бы один специальный символ (!@#$%^&*)');
        }

        if (passwordErrors.length > 0) {
            return res.status(400).json({
                error: `Пароль должен содержать: ${passwordErrors.join(', ')}`
            });
        }

        // Проверка на занятость username
        const existingUser = await prisma.user.findFirst({
            where: { username: trimmedUsername }
        });

        if (existingUser) {
            return res.status(400).json({ error: 'Этот никнейм уже занят!' });
        }

        // Проверка на занятость email
        const existingEmail = await prisma.user.findFirst({
            where: { email: email.toLowerCase() }
        });

        if (existingEmail) {
            return res.status(400).json({ error: 'Этот email уже зарегистрирован!' });
        }

        // Хеширование пароля
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        // Создание пользователя
        const newUser = await prisma.user.create({
            data: {
                username: trimmedUsername,
                email: email.toLowerCase(),
                password: hashedPassword,
                avatar: '👤'
            }
        });

        // Генерация токена
        const token = jwt.sign({ userId: newUser.id, email: newUser.email },
            process.env.JWT_SECRET, { expiresIn: '30d' }
        );

        res.status(201).json({
            token,
            user: {
                id: newUser.id,
                username: newUser.username,
                email: newUser.email,
                avatar: newUser.avatar || '👤'
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
app.post('/api/auth/login', async(req, res) => {
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
// 3. БЛОК SOCKET.IO
// ==========================================
const onlineUsers = new Map();

io.use((socket, next) => {
    const token = (socket.handshake.auth && socket.handshake.auth.token) ||
        (socket.handshake.headers['authorization'] && socket.handshake.headers['authorization'].split(' ')[1]);

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

    onlineUsers.set(currentUserId, socket.id);
    io.emit('user_status_change', { userId: currentUserId, status: 'online' });

    socket.on('join_chat', (chatId) => {
        if (!chatId) return;
        socket.join(chatId);
        console.log(`🚪 Сокет ${socket.id} (Юзер ${currentUserId}) зафиксирован в комнате: ${chatId}`);
    });

    // === ОТПРАВКА СООБЩЕНИЙ ===
    socket.on('send_message', async(messageData) => {
        try {
            console.log('📨 Получены данные сообщения:', messageData);

            const { text, mediaUrl, mediaType, activeChatId, isForwarded } = messageData;
            const senderId = socket.userId;

            if (!activeChatId) {
                console.log('❌ Нет activeChatId');
                return;
            }

            let receiverId = null;
            let channelId = null;
            let chatId = null;

            // Определяем тип чата
            if (activeChatId.startsWith('user_')) {
                receiverId = parseInt(activeChatId.replace('user_', ''), 10);
                if (isNaN(receiverId)) {
                    console.log('❌ Невалидный receiverId');
                    return;
                }
                console.log(`📨 Приватный чат с пользователем ${receiverId}`);

            } else if (activeChatId.startsWith('channel_')) {
                channelId = parseInt(activeChatId.replace('channel_', ''), 10);
                if (isNaN(channelId)) return;
                console.log(`📨 Канал ${channelId}`);

                const isMember = await prisma.channelMember.findFirst({
                    where: { channelId: channelId, userId: senderId }
                });
                if (!isMember) {
                    console.log(`❌ Юзер ${senderId} не участник канала ${channelId}`);
                    return;
                }

            } else if (activeChatId.startsWith('chat_')) {
                chatId = parseInt(activeChatId.replace('chat_', ''), 10);
                if (isNaN(chatId)) return;
                console.log(`📨 Групповой чат ${chatId}`);

                const isMember = await prisma.chatMember.findFirst({
                    where: { chatId: chatId, userId: senderId }
                });
                if (!isMember) {
                    console.log(`❌ Юзер ${senderId} не участник чата ${chatId}`);
                    return;
                }
            } else {
                console.log(`❌ Неизвестный тип чата: ${activeChatId}`);
                return;
            }

            console.log(`📝 Создаю сообщение: text="${text}", chatId=${chatId}, channelId=${channelId}, receiverId=${receiverId}`);

            // ✅ СОХРАНЯЕМ В БАЗУ ДАННЫХ
            const savedMessage = await prisma.message.create({
                data: {
                    text: text || null,
                    mediaUrl: mediaUrl || null,
                    mediaType: mediaType || null,
                    senderId: senderId,
                    receiverId: receiverId,
                    channelId: channelId,
                    chatId: chatId,
                    isForwarded: isForwarded || false,
                    status: 'unread' // ✅ ДОБАВЛЯЕМ СТАТУС
                },
                include: {
                    sender: { select: { id: true, username: true } }
                }
            });

            console.log(`✅ Сообщение ${savedMessage.id} сохранено в БД`);

            // Формируем ответ
            const newMessage = {
                id: savedMessage.id,
                text: savedMessage.text,
                mediaUrl: savedMessage.mediaUrl,
                mediaType: savedMessage.mediaType,
                status: savedMessage.status,
                createdAt: savedMessage.createdAt,
                senderId: savedMessage.senderId,
                receiverId: savedMessage.receiverId,
                channelId: savedMessage.channelId,
                chatId: savedMessage.chatId,
                sender: savedMessage.sender,
                activeChatId: activeChatId,
                isForwarded: savedMessage.isForwarded || false
            };

            // ==========================================
            // 📨 РАССЫЛАЕМ СООБЩЕНИЕ
            // ==========================================
            if (chatId) {
                // Групповой чат
                io.to(`chat_${chatId}`).emit('receive_message', newMessage);
                console.log(`📤 Отправлено в групповой чат ${chatId}`);

                // Обновляем lastMessage для всех участников
                const members = await prisma.chatMember.findMany({
                    where: { chatId: chatId },
                    select: { userId: true }
                });

                for (const member of members) {
                    const socketId = onlineUsers.get(member.userId);
                    if (socketId && member.userId !== senderId) {
                        io.to(socketId).emit('chat_updated', {
                            chatId: chatId,
                            lastMessage: newMessage
                        });
                        // ✅ ОТПРАВЛЯЕМ СЧЕТЧИК
                        io.to(socketId).emit('unread_updated', {
                            type: 'chat',
                            id: chatId,
                            count: 1
                        });
                        console.log(`📊 Отправлен unread_updated для чата ${chatId} участнику ${member.userId}`);
                    }
                }
            } else if (channelId) {
                // Канал
                io.to(`channel_${channelId}`).emit('receive_message', newMessage);
                console.log(`📤 Отправлено в канал ${channelId}`);

                // ✅ ДОБАВЛЯЕМ ОБНОВЛЕНИЕ ДЛЯ ВСЕХ УЧАСТНИКОВ КАНАЛА
                const members = await prisma.channelMember.findMany({
                    where: { channelId: channelId },
                    select: { userId: true }
                });

                for (const member of members) {
                    const socketId = onlineUsers.get(member.userId);
                    if (socketId && member.userId !== senderId) {
                        // Отправляем обновление канала (lastMessage)
                        io.to(socketId).emit('channel_updated', {
                            channelId: channelId,
                            lastMessage: newMessage
                        });
                        // ✅ ОТПРАВЛЯЕМ СЧЕТЧИК НЕПРОЧИТАННЫХ
                        io.to(socketId).emit('unread_updated', {
                            type: 'channel',
                            id: channelId,
                            count: 1
                        });
                        console.log(`📊 Отправлен unread_updated для канала ${channelId} участнику ${member.userId}`);
                    }
                }

            } else if (receiverId) {
                // Приватный чат
                const targetSocketId = onlineUsers.get(receiverId);
                socket.emit('receive_message', newMessage);
                if (targetSocketId) {
                    io.to(targetSocketId).emit('receive_message', newMessage);
                    io.to(targetSocketId).emit('unread_updated', {
                        type: 'private',
                        id: senderId,
                        count: 1
                    });
                }
                console.log(`📤 Отправлено в приватный чат с ${receiverId}`);
            }

            console.log(`✅ Сообщение ${savedMessage.id} разослано`);

        } catch (error) {
            console.error('❌ Ошибка в send_message:', error);
            console.error('❌ Стек ошибки:', error.stack);
        }
    });



    // === УДАЛЕНИЕ СООБЩЕНИЙ ===
    socket.on('delete_message', async({ messageId, activeChatId }) => {
        try {
            console.log(`🗑️ Запрос на удаление сообщения ${messageId} от пользователя ${socket.userId}`);

            const message = await prisma.message.findUnique({
                where: { id: Number(messageId) }
            });

            if (!message) {
                console.log('❌ Сообщение не найдено');
                return;
            }

            if (message.senderId !== socket.userId) {
                if (message.channelId) {
                    const isAdmin = await prisma.channelMember.findFirst({
                        where: {
                            channelId: message.channelId,
                            userId: socket.userId,
                            role: 'admin'
                        }
                    });
                    if (!isAdmin) {
                        console.warn(`[🔒 SECURITY] Юзер ${socket.userId} пытался удалить чужое сообщение №${messageId}`);
                        return;
                    }
                } else {
                    console.warn(`[🔒 SECURITY] Юзер ${socket.userId} пытался удалить чужое сообщение №${messageId}`);
                    return;
                }
            }

            const updatedMessage = await prisma.message.update({
                where: { id: Number(messageId) },
                data: {
                    text: "Сообщение удалено",
                    mediaUrl: null,
                    mediaType: null
                }
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
                console.log(`🔍 Определен channelId: ${channelId}`);
                io.to(`channel_${channelId}`).emit('message_deleted', deletePayload);
            } else if (activeChatId && activeChatId.startsWith('chat_')) {
                const chatId = parseInt(activeChatId.replace('chat_', ''), 10);
                io.to(`chat_${chatId}`).emit('message_deleted', deletePayload);
            } else {
                io.to('chat_general').emit('message_deleted', deletePayload);
            }

            console.log(`🗑️ Сообщение №${messageId} успешно удалено`);
        } catch (err) {
            console.error('Ошибка удаления:', err);
        }
    });

    // === ПРОЧТЕНИЕ СООБЩЕНИЙ ===
    socket.on('read_messages', async(data) => {
        try {
            if (!data) return;
            const { activeChatId } = data;
            const myId = socket.userId;

            if (!activeChatId) return;

            console.log(`👁️ Юзер ${myId} прочитал историю чата: ${activeChatId}`);

            // ✅ ИСПОЛЬЗУЕМ ТУ ЖЕ ЛОГИКУ, ЧТО И В /api/read
            let type, id;

            if (activeChatId.startsWith('channel_')) {
                type = 'channel';
                id = parseInt(activeChatId.replace('channel_', ''), 10);
            } else if (activeChatId.startsWith('chat_')) {
                type = 'chat';
                id = parseInt(activeChatId.replace('chat_', ''), 10);
            } else if (activeChatId.startsWith('user_')) {
                type = 'private';
                id = parseInt(activeChatId.replace('user_', ''), 10);
            } else {
                // Общий чат — ничего не делаем
                console.log('📖 Общий чат, пропускаем');
                return;
            }

            // ✅ ВЫЗЫВАЕМ ТУ ЖЕ ЛОГИКУ, ЧТО И В HTTP-ЭНДПОИНТЕ
            if (type === 'chat') {
                await prisma.chatMember.update({
                    where: {
                        chatId_userId: {
                            chatId: id,
                            userId: myId
                        }
                    },
                    data: {
                        lastReadAt: new Date()
                    }
                });
                console.log(`✅ Отметил прочтение в чате ${id}`);

            } else if (type === 'channel') {
                const member = await prisma.channelMember.findFirst({
                    where: {
                        channelId: id,
                        userId: myId
                    }
                });

                if (!member) {
                    await prisma.channelMember.create({
                        data: {
                            channelId: id,
                            userId: myId,
                            role: 'member',
                            lastReadAt: new Date()
                        }
                    });
                    console.log(`✅ Создана запись участника в канале ${id}`);
                } else {
                    await prisma.channelMember.update({
                        where: { id: member.id },
                        data: { lastReadAt: new Date() }
                    });
                    console.log(`✅ Обновлен lastReadAt для канала ${id}`);
                }

            } else if (type === 'private') {
                const privateMember = await prisma.privateChatMember.findUnique({
                    where: {
                        userId_otherUserId: {
                            userId: myId,
                            otherUserId: id
                        }
                    }
                });

                if (!privateMember) {
                    await prisma.privateChatMember.create({
                        data: {
                            userId: myId,
                            otherUserId: id,
                            lastReadAt: new Date()
                        }
                    });
                    console.log(`✅ Создана запись приватного чата с ${id}`);
                } else {
                    await prisma.privateChatMember.update({
                        where: { id: privateMember.id },
                        data: { lastReadAt: new Date() }
                    });
                    console.log(`✅ Обновлен lastReadAt для приватного чата с ${id}`);
                }

                await prisma.message.updateMany({
                    where: {
                        senderId: id,
                        receiverId: myId,
                        channelId: null,
                        chatId: null,
                        status: { not: 'read' }
                    },
                    data: {
                        status: 'read'
                    }
                });
                console.log(`✅ Все сообщения от ${id} отмечены как прочитанные`);
            }

            const readPayload = { activeChatId, readerId: myId };

            // Рассылаем уведомления
            if (activeChatId.startsWith('channel_')) {
                const cleanId = parseInt(activeChatId.replace('channel_', ''), 10);
                io.to(`channel_${cleanId}`).emit('messages_read_update', readPayload);
            } else if (activeChatId.startsWith('user_')) {
                const cleanId = parseInt(activeChatId.replace('user_', ''), 10);
                socket.emit('messages_read_update', readPayload);
                const targetSocketId = onlineUsers.get(cleanId);
                if (targetSocketId) {
                    io.to(targetSocketId).emit('messages_read_update', readPayload);
                }
            } else {
                io.to('chat_general').emit('messages_read_update', readPayload);
            }

        } catch (err) {
            console.error('❌ Ошибка в read_messages:', err);
        }
    });


    // === СТАТУС ПЕЧАТАНИЯ ===
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

    // === УДАЛЕНИЕ КАНАЛА ===
    socket.on('delete_channel', async({ channelId }) => {
        try {
            const userId = socket.userId;

            const channel = await prisma.channel.findUnique({
                where: { id: channelId }
            });

            if (!channel) {
                socket.emit('error', { message: 'Канал не найден' });
                return;
            }

            if (channel.creatorId !== userId) {
                socket.emit('error', { message: 'Только создатель может удалить канал' });
                return;
            }

            await prisma.channel.delete({
                where: { id: channelId }
            });

            io.emit('channel_deleted', { channelId });
            console.log(`🗑️ Канал ${channelId} удален через сокет пользователем ${userId}`);

        } catch (error) {
            console.error('Ошибка удаления канала через сокет:', error);
            socket.emit('error', { message: 'Не удалось удалить канал' });
        }
    });

    // === ТРЕДЫ ===
    socket.on('create_thread', async({ messageId, text, activeChatId }) => {
        try {
            const userId = socket.userId;

            if (!text || !text.trim()) {
                socket.emit('error', { message: 'Текст комментария обязателен' });
                return;
            }

            const message = await prisma.message.findUnique({
                where: { id: messageId }
            });

            if (!message) {
                socket.emit('error', { message: 'Сообщение не найдено' });
                return;
            }

            const thread = await prisma.thread.create({
                data: {
                    messageId: messageId,
                    userId: userId,
                    text: text.trim()
                },
                include: {
                    user: {
                        select: { id: true, username: true, avatar: true }
                    }
                }
            });

            io.to(activeChatId || 'chat_general').emit('thread_created', {
                thread,
                messageId,
                activeChatId
            });

        } catch (error) {
            console.error('Ошибка создания треда через сокет:', error);
            socket.emit('error', { message: 'Не удалось создать комментарий' });
        }
    });

    // === РЕАКЦИИ ===
    socket.on('toggle_reaction', async({ messageId, type, activeChatId }) => {
        try {
            const userId = socket.userId;

            if (!type) {
                socket.emit('error', { message: 'Тип реакции обязателен' });
                return;
            }

            const existingReaction = await prisma.reaction.findUnique({
                where: {
                    messageId_userId: {
                        messageId: messageId,
                        userId: userId
                    }
                }
            });

            if (existingReaction) {
                await prisma.reaction.delete({
                    where: {
                        messageId_userId: {
                            messageId: messageId,
                            userId: userId
                        }
                    }
                });
            } else {
                await prisma.reaction.create({
                    data: {
                        messageId: messageId,
                        userId: userId,
                        type: type
                    }
                });
            }

            const allReactions = await prisma.reaction.findMany({
                where: { messageId: messageId },
                include: {
                    user: {
                        select: { id: true, username: true }
                    }
                }
            });

            io.to(activeChatId || 'chat_general').emit('reaction_updated', {
                messageId,
                reactions: allReactions
            });

        } catch (error) {
            console.error('Ошибка при работе с реакцией через сокет:', error);
            socket.emit('error', { message: 'Не удалось обработать реакцию' });
        }
    });

    // === ОТКЛЮЧЕНИЕ ===
    socket.on('disconnect', () => {
        const userId = socket.userId;
        console.log(`🔌 Пользователь ${userId} отключился`);

        if (userId && onlineUsers.get(userId) === socket.id) {
            onlineUsers.delete(userId);
            io.emit('user_status_change', { userId, status: 'offline' });
        }
    });

}); // КОНЕЦ io.on('connection')

// ==========================================
// 4. УЧАСТНИКИ КАНАЛОВ
// ==========================================
app.get('/api/channels/:channelId/members', authenticateToken, async(req, res) => {
    try {
        const channelId = parseInt(req.params.channelId);

        const members = await prisma.channelMember.findMany({
            where: { channelId: channelId },
            include: {
                user: {
                    select: { id: true, username: true, avatar: true }
                }
            }
        });

        res.json(members);
    } catch (error) {
        console.error('Ошибка получения участников канала:', error);
        res.status(500).json({ error: 'Не удалось получить участников' });
    }
});

app.get('/api/channels', authenticateToken, async(req, res) => {
    try {
        const userId = req.userId;
        console.log(`📡 Запрос каналов для пользователя ${userId}`);

        // ✅ Получаем только каналы, где пользователь является участником
        const channelMembers = await prisma.channelMember.findMany({
            where: { userId: userId },
            include: {
                channel: {
                    include: {
                        messages: {
                            orderBy: { createdAt: 'desc' },
                            take: 1,
                            include: {
                                sender: {
                                    select: { id: true, username: true }
                                }
                            }
                        }
                    }
                }
            }
        });

        const channelsWithLastMessage = channelMembers.map(member => {
            const channel = member.channel;
            const lastMessage = channel.messages[0] || null;
            const { messages, ...channelData } = channel;
            return {
                ...channelData,
                lastMessage: lastMessage
            };
        });

        console.log(`✅ Отправлено ${channelsWithLastMessage.length} каналов для пользователя ${userId}`);
        return res.json(channelsWithLastMessage);
    } catch (error) {
        console.error('❌ Ошибка при получении каналов:', error);
        return res.status(500).json({ error: 'Ошибка загрузки каналов' });
    }
});
app.post('/api/channels/:channelId/members', authenticateToken, async(req, res) => {
    try {
        const channelId = parseInt(req.params.channelId);
        const { userId } = req.body;
        const currentUserId = req.userId;

        const channel = await prisma.channel.findUnique({
            where: { id: channelId }
        });

        if (!channel) {
            return res.status(404).json({ error: 'Канал не найден' });
        }

        const isAdmin = await prisma.channelMember.findFirst({
            where: {
                channelId: channelId,
                userId: currentUserId,
                role: 'admin'
            }
        });

        if (!isAdmin) {
            return res.status(403).json({ error: 'Только админ может добавлять участников' });
        }

        const existingMember = await prisma.channelMember.findUnique({
            where: {
                channelId_userId: {
                    channelId: channelId,
                    userId: userId
                }
            }
        });

        if (existingMember) {
            return res.status(400).json({ error: 'Пользователь уже участник канала' });
        }

        const member = await prisma.channelMember.create({
            data: {
                channelId: channelId,
                userId: userId,
                role: 'member'
            },
            include: {
                user: {
                    select: { id: true, username: true, avatar: true }
                }
            }
        });

        res.status(201).json(member);

        // ✅ ОТПРАВЛЯЕМ СОБЫТИЕ НОВОМУ УЧАСТНИКУ
        const newMemberSocketId = onlineUsers.get(userId);
        if (newMemberSocketId) {
            io.to(newMemberSocketId).emit('channel_member_added', {
                channelId: channelId,
                member: member,
                channelName: channel.name
            });
            console.log(`📢 Событие channel_member_added отправлено пользователю ${userId}`);
        }

    } catch (error) {
        console.error('Ошибка добавления участника в канал:', error);
        res.status(500).json({ error: 'Не удалось добавить участника' });
    }
});
// ==========================================
// ПОЛУЧЕНИЕ ОДНОГО КАНАЛА
// ==========================================
app.get('/api/channels/:channelId', authenticateToken, async(req, res) => {
    try {
        const channelId = parseInt(req.params.channelId);
        const userId = req.userId;

        // Проверяем, что пользователь участник
        const member = await prisma.channelMember.findFirst({
            where: {
                channelId: channelId,
                userId: userId
            }
        });

        if (!member) {
            return res.status(403).json({ error: 'Вы не участник этого канала' });
        }

        const channel = await prisma.channel.findUnique({
            where: { id: channelId },
            include: {
                messages: {
                    orderBy: { createdAt: 'desc' },
                    take: 1,
                    include: {
                        sender: {
                            select: { id: true, username: true }
                        }
                    }
                }
            }
        });

        const lastMessage = channel.messages[0] || null;
        const { messages, ...channelData } = channel;
        res.json({...channelData, lastMessage });
    } catch (error) {
        console.error('Ошибка получения канала:', error);
        res.status(500).json({ error: 'Ошибка загрузки канала' });
    }
});


app.delete('/api/channels/:channelId/members/:userId', authenticateToken, async(req, res) => {
    try {
        const channelId = parseInt(req.params.channelId);
        const userId = parseInt(req.params.userId);
        const currentUserId = req.userId;

        const channel = await prisma.channel.findUnique({
            where: { id: channelId }
        });

        if (!channel) {
            return res.status(404).json({ error: 'Канал не найден' });
        }

        const isAdmin = await prisma.channelMember.findFirst({
            where: {
                channelId: channelId,
                userId: currentUserId,
                role: 'admin'
            }
        });

        if (!isAdmin) {
            return res.status(403).json({ error: 'Только админ может удалять участников' });
        }

        if (userId === channel.creatorId) {
            return res.status(400).json({ error: 'Нельзя удалить создателя канала' });
        }

        await prisma.channelMember.delete({
            where: {
                channelId_userId: {
                    channelId: channelId,
                    userId: userId
                }
            }
        });

        // 👇 ПОСЛЕ ЭТОЙ СТРОКИ (await prisma.channelMember.delete) ВСТАВЬ ЭТОТ КОД:

        // Отправляем событие удаленному пользователю
        const removedUserSocketId = onlineUsers.get(userId);
        if (removedUserSocketId) {
            // Отписываем от комнаты, чтобы не получал сообщения
            const socket = io.sockets.sockets.get(removedUserSocketId);
            if (socket) {
                socket.leave(`channel_${channelId}`);
                console.log(`🚪 Пользователь ${userId} отписан от комнаты channel_${channelId}`);
            }
            // Отправляем уведомление о кике
            io.to(removedUserSocketId).emit('kicked_from_channel', {
                channelId: channelId,
                channelName: channel.name
            });
            console.log(`👢 Пользователь ${userId} удален из канала ${channelId}, отправлено уведомление`);
        }

        res.json({ success: true, message: 'Участник удален из канала' });
    } catch (error) {
        console.error('Ошибка удаления участника из канала:', error);
        res.status(500).json({ error: 'Не удалось удалить участника' });
    }
});

// ==========================================
// 5. ГРУППОВЫЕ ЧАТЫ
// ==========================================

app.post('/api/chats', authenticateToken, async(req, res) => {
    try {
        const { name, avatar, memberIds } = req.body;
        const creatorId = req.userId;

        if (!name) {
            return res.status(400).json({ error: 'Название чата обязательно' });
        }

        const chat = await prisma.chat.create({
            data: {
                name: name.trim(),
                avatar: avatar || '💬',
                creatorId: creatorId
            }
        });

        await prisma.chatMember.create({
            data: {
                chatId: chat.id,
                userId: creatorId
            }
        });

        if (memberIds && Array.isArray(memberIds)) {
            for (const userId of memberIds) {
                if (userId !== creatorId) {
                    await prisma.chatMember.create({
                        data: {
                            chatId: chat.id,
                            userId: userId
                        }
                    });
                }
            }
        }

        const newChat = await prisma.chat.findUnique({
            where: { id: chat.id },
            include: {
                members: {
                    include: {
                        user: {
                            select: { id: true, username: true, avatar: true }
                        }
                    }
                }
            }
        });

        // ✅ ДОБАВЬ ЭТУ СТРОКУ
        io.emit('chat_created', newChat);
        console.log(`👥 Создан новый групповой чат: ${newChat.id}`);

        res.status(201).json({
            id: `chat_${newChat.id}`,
            dbId: newChat.id,
            name: newChat.name,
            avatar: newChat.avatar || '💬',
            creatorId: newChat.creatorId,
            members: newChat.members,
            type: 'group'
        });
    } catch (error) {
        console.error('Ошибка создания группового чата:', error);
        res.status(500).json({ error: 'Не удалось создать чат' });
    }
});

app.get('/api/chats', authenticateToken, async(req, res) => {
    try {
        const userId = req.userId;

        const chats = await prisma.chat.findMany({
            where: {
                members: {
                    some: { userId: userId }
                }
            },
            include: {
                members: {
                    include: {
                        user: {
                            select: { id: true, username: true, avatar: true }
                        }
                    }
                },
                messages: {
                    orderBy: { createdAt: 'desc' },
                    take: 1
                }
            },
            orderBy: { createdAt: 'desc' }
        });

        const formattedChats = chats.map(chat => ({
            id: `chat_${chat.id}`,
            dbId: chat.id,
            name: chat.name,
            avatar: chat.avatar || '💬',
            creatorId: chat.creatorId,
            members: chat.members,
            lastMessage: chat.messages[0] || null,
            unreadCount: 0,
            type: 'group'
        }));

        res.json(formattedChats);
    } catch (error) {
        console.error('Ошибка получения групповых чатов:', error);
        res.status(500).json({ error: 'Не удалось загрузить чаты' });
    }
});

app.get('/api/chats/:chatId/members', authenticateToken, async(req, res) => {
    try {
        const chatId = parseInt(req.params.chatId);

        const members = await prisma.chatMember.findMany({
            where: { chatId: chatId },
            include: {
                user: {
                    select: { id: true, username: true, avatar: true }
                }
            }
        });

        res.json(members);
    } catch (error) {
        console.error('Ошибка получения участников чата:', error);
        res.status(500).json({ error: 'Не удалось получить участников' });
    }
});

app.post('/api/chats/:chatId/members', authenticateToken, async(req, res) => {
    try {
        const chatId = parseInt(req.params.chatId);
        const { userId } = req.body;
        const currentUserId = req.userId;

        const chat = await prisma.chat.findUnique({
            where: { id: chatId }
        });

        if (!chat) {
            return res.status(404).json({ error: 'Чат не найден' });
        }

        const existingMember = await prisma.chatMember.findUnique({
            where: {
                chatId_userId: {
                    chatId: chatId,
                    userId: userId
                }
            }
        });

        if (existingMember) {
            return res.status(400).json({ error: 'Пользователь уже участник чата' });
        }

        const member = await prisma.chatMember.create({
            data: {
                chatId: chatId,
                userId: userId
            },
            include: {
                user: {
                    select: { id: true, username: true, avatar: true }
                }
            }
        });

        // Отправляем событие всем участникам чата
        io.emit('chat_member_added', {
            chatId: chatId,
            member: member,
            chatName: chat.name
        });
        console.log(`➕ Пользователь ${userId} добавлен в чат ${chatId}, отправлено уведомление`);

        res.status(201).json(member);
    } catch (error) {
        console.error('Ошибка добавления участника в чат:', error);
        res.status(500).json({ error: 'Не удалось добавить участника' });
    }
});

app.delete('/api/chats/:chatId/members/:userId', authenticateToken, async(req, res) => {
    try {
        const chatId = parseInt(req.params.chatId);
        const userId = parseInt(req.params.userId);
        const currentUserId = req.userId;

        const chat = await prisma.chat.findUnique({
            where: { id: chatId }
        });

        if (!chat) {
            return res.status(404).json({ error: 'Чат не найден' });
        }

        if (userId === chat.creatorId) {
            return res.status(400).json({ error: 'Нельзя удалить создателя чата' });
        }

        await prisma.chatMember.delete({
            where: {
                chatId_userId: {
                    chatId: chatId,
                    userId: userId
                }
            }
        });

        io.emit('chat_member_removed', {
            chatId: chatId,
            userId: userId,
            chatName: chat.name
        });
        console.log(`👢 Пользователь ${userId} удален из чата ${chatId}, отправлено уведомление`);

        res.json({ success: true, message: 'Участник удален из чата' });
    } catch (error) {
        console.error('Ошибка удаления участника из чата:', error);
        res.status(500).json({ error: 'Не удалось удалить участника' });
    }
});

// ==========================================
// УДАЛЕНИЕ ГРУППОВОГО ЧАТА
// ==========================================
app.delete('/api/chats/:chatId', authenticateToken, async(req, res) => {
    try {
        const chatId = parseInt(req.params.chatId);
        const userId = req.userId;

        const chat = await prisma.chat.findUnique({
            where: { id: chatId }
        });

        if (!chat) {
            return res.status(404).json({ error: 'Чат не найден' });
        }

        if (chat.creatorId !== userId) {
            return res.status(403).json({ error: 'Только создатель может удалить чат' });
        }

        await prisma.chat.delete({
            where: { id: chatId }
        });

        io.emit('chat_deleted', { chatId: chatId });
        console.log(`🗑️ Групповой чат ${chatId} удален пользователем ${userId}`);

        res.json({ success: true, message: 'Чат удален' });

    } catch (error) {
        console.error('Ошибка удаления группового чата:', error);
        res.status(500).json({ error: 'Не удалось удалить чат' });
    }
});

app.delete('/api/channels/:channelId', authenticateToken, async(req, res) => {
    try {
        const channelId = parseInt(req.params.channelId);
        const userId = req.userId;

        const channel = await prisma.channel.findUnique({
            where: { id: channelId }
        });

        if (!channel) {
            return res.status(404).json({ error: 'Канал не найден' });
        }

        if (channel.creatorId !== userId) {
            return res.status(403).json({ error: 'Только создатель может удалить канал' });
        }

        await prisma.channel.delete({
            where: { id: channelId }
        });

        io.emit('channel_deleted', { channelId });

        console.log(`🗑️ Канал ${channelId} удален пользователем ${userId}`);
        res.json({ success: true, message: 'Канал удален' });

    } catch (error) {
        console.error('Ошибка удаления канала:', error);
        res.status(500).json({ error: 'Не удалось удалить канал' });
    }
});

// ==========================================
// 7. ТРЕДЫ (КОММЕНТАРИИ К СООБЩЕНИЯМ)
// ==========================================

app.get('/api/messages/:messageId/threads', authenticateToken, async(req, res) => {
    try {
        const messageId = parseInt(req.params.messageId);

        const threads = await prisma.thread.findMany({
            where: { messageId: messageId },
            orderBy: { createdAt: 'asc' },
            include: {
                user: {
                    select: { id: true, username: true, avatar: true }
                }
            }
        });

        res.json(threads);
    } catch (error) {
        console.error('Ошибка получения тредов:', error);
        res.status(500).json({ error: 'Не удалось получить комментарии' });
    }
});

app.post('/api/messages/:messageId/threads', authenticateToken, async(req, res) => {
    try {
        const messageId = parseInt(req.params.messageId);
        const userId = req.userId;
        const { text } = req.body;

        if (!text || !text.trim()) {
            return res.status(400).json({ error: 'Текст комментария обязателен' });
        }

        const message = await prisma.message.findUnique({
            where: { id: messageId }
        });

        if (!message) {
            return res.status(404).json({ error: 'Сообщение не найдено' });
        }

        const thread = await prisma.thread.create({
            data: {
                messageId: messageId,
                userId: userId,
                text: text.trim()
            },
            include: {
                user: {
                    select: { id: true, username: true, avatar: true }
                }
            }
        });

        io.emit('thread_created', {
            thread,
            messageId,
            activeChatId: req.query.activeChatId || 'chat_general'
        });

        res.status(201).json(thread);
    } catch (error) {
        console.error('Ошибка создания треда:', error);
        res.status(500).json({ error: 'Не удалось создать комментарий' });
    }
});

app.delete('/api/threads/:threadId', authenticateToken, async(req, res) => {
    try {
        const threadId = parseInt(req.params.threadId);
        const userId = req.userId;

        const thread = await prisma.thread.findUnique({
            where: { id: threadId }
        });

        if (!thread) {
            return res.status(404).json({ error: 'Комментарий не найден' });
        }

        if (thread.userId !== userId) {
            return res.status(403).json({ error: 'Только автор может удалить комментарий' });
        }

        await prisma.thread.delete({
            where: { id: threadId }
        });

        res.json({ success: true, message: 'Комментарий удален' });
    } catch (error) {
        console.error('Ошибка удаления треда:', error);
        res.status(500).json({ error: 'Не удалось удалить комментарий' });
    }
});

// ==========================================
// 8. РЕАКЦИИ
// ==========================================

app.post('/api/messages/:messageId/reactions', authenticateToken, async(req, res) => {
    try {
        const messageId = parseInt(req.params.messageId);
        const userId = req.userId;
        const { type } = req.body;

        if (!type) {
            return res.status(400).json({ error: 'Тип реакции обязателен' });
        }

        const existingReaction = await prisma.reaction.findUnique({
            where: {
                messageId_userId: {
                    messageId: messageId,
                    userId: userId
                }
            }
        });

        let reaction;
        let action;

        if (existingReaction) {
            await prisma.reaction.delete({
                where: {
                    messageId_userId: {
                        messageId: messageId,
                        userId: userId
                    }
                }
            });
            action = 'removed';
            reaction = null;
        } else {
            reaction = await prisma.reaction.create({
                data: {
                    messageId: messageId,
                    userId: userId,
                    type: type
                },
                include: {
                    user: {
                        select: { id: true, username: true }
                    }
                }
            });
            action = 'added';
        }

        const allReactions = await prisma.reaction.findMany({
            where: { messageId: messageId },
            include: {
                user: {
                    select: { id: true, username: true }
                }
            }
        });

        io.emit('reaction_updated', {
            messageId,
            reactions: allReactions,
            action,
            reaction
        });

        res.json({
            success: true,
            action,
            reaction,
            reactions: allReactions
        });

    } catch (error) {
        console.error('Ошибка при работе с реакцией:', error);
        res.status(500).json({ error: 'Не удалось обработать реакцию' });
    }
});

app.get('/api/messages/:messageId/reactions', authenticateToken, async(req, res) => {
    try {
        const messageId = parseInt(req.params.messageId);

        const reactions = await prisma.reaction.findMany({
            where: { messageId: messageId },
            include: {
                user: {
                    select: { id: true, username: true }
                }
            }
        });

        res.json(reactions);
    } catch (error) {
        console.error('Ошибка получения реакций:', error);
        res.status(500).json({ error: 'Не удалось получить реакции' });
    }
});

// === ЗАПУСК СЕРВЕРА ===
const PORT = 5001;
server.listen(PORT, () => {
    console.log(`🚀 Сервер успешно запущен на http://localhost:${PORT}`);
});