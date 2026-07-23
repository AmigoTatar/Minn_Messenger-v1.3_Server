const isProduction = process.env.NODE_ENV === 'production';
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
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const { validateRegister, validateMessage, validateSearch } = require('./middleware/validation');

// Импорт роутов сообщений
const messageRoutes = require('./routes/messageRoutes');

const app = express();

// НАСТРОЙКА ЗАГРУЗКИ ФАЙЛОВ (MULTER)
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}
app.use('/uploads', express.static(uploadDir));


// ==========================================
// 🔒 БЕЗОПАСНОСТЬ
// ==========================================

// Helmet с настройками для WebSocket
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" }
}));

// CORS — разрешаем WebSocket
app.use(cors({
    origin: ["http://localhost:5173", "http://localhost:5001"],
    credentials: true
}));

// Ограничение размера запросов
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use('/uploads', express.static('uploads'));

// Настройка multer для загрузки файлов
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir), 
  filename: (req, file, cb) => {
    const uniqueName = Date.now() + '-' + file.originalname;
    cb(null, uniqueName);
  }
});
const upload = multer({ storage });
/// ==========================================
// ⏱️ RATE LIMITING (защита от спама)
// ==========================================

// Общий лимит для всех запросов (базовая защита)
const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 минут
    max: 1000, // 1000 запросов
    message: { error: 'Слишком много запросов, попробуйте позже' },
    standardHeaders: true,
    legacyHeaders: false
});

// Лимит для чтения (скролл, прочтение)
const readLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 минута
    max: 100, // 60 прочтений в минуту
    message: { error: 'Слишком много запросов на прочтение' },
    standardHeaders: true,
    legacyHeaders: false
});

// Лимит для реакций (клики по смайлам)
const reactionLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 минута
    max: 30, // 30 реакций в минуту
    message: { error: 'Слишком много реакций, подождите' },
    standardHeaders: true,
    legacyHeaders: false
});

// Лимит для отправки сообщений
const sendLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 минута
    max: 20, // 20 сообщений в минуту
    message: { error: 'Слишком много сообщений, попробуйте позже' },
    standardHeaders: true,
    legacyHeaders: false
});

// Лимит для регистрации и входа (защита от брутфорса)
const authLimiter = rateLimit({
    windowMs: 5 * 60 * 1000, // 5 минут
    max: 20, // 20 попыток (достаточно, чтобы не заблокировать пользователя)
    message: { error: 'Слишком много попыток входа. Попробуйте через 5 минут.' },
    standardHeaders: true,
    legacyHeaders: false
});



// Регистрация – без лимита (чтобы не мешать новым пользователям)
app.use('/api/auth/register', (req, res, next) => next());

// Вход – с лимитом
app.use('/api/auth/login', authLimiter);

// Лимит для поиска
const searchLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 минута
    max: 20, // 20 поисковых запросов в минуту
    message: { error: 'Слишком много поисковых запросов, подождите' },
    standardHeaders: true,
    legacyHeaders: false
});

// ПРИМЕНЯЕМ ЛИМИТЫ
app.use('/api/', globalLimiter); // Для всех запросов

// Специфичные лимиты для конкретных эндпоинтов
app.use('/api/read', readLimiter);
app.use('/api/messages/:messageId/reactions', reactionLimiter);
app.use('/api/messages/search', searchLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/auth/login', authLimiter);

// Лимит для отправки сообщений (через сокет — отдельно)
// Для сокетов лимиты настраиваются внутри send_message



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
            // ✅ ПРОВЕРЯЕМ, СУЩЕСТВУЕТ ЛИ ЧАТ
            const chatExists = await prisma.chat.findUnique({
                where: { id: parseInt(id) }
            });

            if (!chatExists) {
                console.log(`⚠️ Чат ${id} не существует, пропускаю`);
                return res.status(404).json({ error: 'Чат не найден' });
            }

            // ✅ СНАЧАЛА ПРОВЕРЯЕМ, СУЩЕСТВУЕТ ЛИ ЗАПИСЬ
            const existingMember = await prisma.chatMember.findUnique({
                where: {
                    chatId_userId: {
                        chatId: parseInt(id),
                        userId
                    }
                }
            });

            if (!existingMember) {
                // Если записи нет — создаем её
                await prisma.chatMember.create({
                    data: {
                        chatId: parseInt(id),
                        userId: userId,
                        lastReadAt: new Date()
                    }
                });
                console.log(`✅ Создана запись участника в чате ${id} для пользователя ${userId}`);
            } else {
                // Если запись есть — обновляем
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
            }
        } else if (type === 'channel') {
            const channelId = parseInt(id);

            // ✅ СНАЧАЛА ПРОВЕРЯЕМ, СУЩЕСТВУЕТ ЛИ КАНАЛ
            const channelExists = await prisma.channel.findUnique({
                where: { id: channelId }
            });

            if (!channelExists) {
                console.log(`⚠️ Канал ${channelId} не существует, пропускаю`);
                return res.status(404).json({ error: 'Канал не найден' });
            }

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
app.post('/api/auth/register', validateRegister, async(req, res) => {
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
            // ✅ ВАЛИДАЦИЯ
            if (!text && !mediaUrl) {
                console.log('❌ Сообщение пустое');
                return;
            }
            if (text && text.length > 10000) {
                console.log('❌ Сообщение слишком длинное');
                return;
            }
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

                const member = await prisma.channelMember.findFirst({
                    where: {
                        channelId: channelId,
                        userId: senderId
                    }
                });

                if (!member) {
                    console.log(`❌ Юзер ${senderId} не участник канала ${channelId}`);
                    socket.emit('error', { message: 'Вы не участник этого канала' });
                    return;
                }

                // ✅ ПРОВЕРКА ПРАВ: ТОЛЬКО АДМИН МОЖЕТ ПИСАТЬ
                if (member.role !== 'admin') {
                    console.log(`❌ Юзер ${senderId} не админ канала ${channelId}`);
                    socket.emit('error', { message: 'Только администраторы могут отправлять сообщения в этот канал' });
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
                    status: 'unread'
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

            // Проверка прав
            if (message.senderId !== socket.userId) {
                // ... проверка прав ...
            }

            // ✅ 1. УДАЛЯЕМ ВСЕ РЕАКЦИИ
            await prisma.reaction.deleteMany({
                where: { messageId: Number(messageId) }
            });
            console.log(`🗑️ Удалены реакции для сообщения ${messageId}`);

            // ✅ 2. УДАЛЯЕМ ВСЕ КОММЕНТАРИИ (ТРЕДЫ)
            await prisma.thread.deleteMany({
                where: { messageId: Number(messageId) }
            });
            console.log(`🗑️ Удалены комментарии для сообщения ${messageId}`);

            // ✅ 3. ОБНОВЛЯЕМ СООБЩЕНИЕ
            const updatedMessage = await prisma.message.update({
                where: { id: Number(messageId) },
                data: {
                    text: "Сообщение удалено",
                    mediaUrl: null,
                    mediaType: null,
                    isDeleted: true, // ✅ ТЕПЕРЬ ЭТО РАБОТАЕТ!
                    isForwarded: false
                }
            });

            const deletePayload = {
                messageId: updatedMessage.id,
                activeChatId,
                isDeleted: true
            };

            // ✅ 4. РАССЫЛАЕМ ВСЕМ В КОМНАТЕ
            if (activeChatId && activeChatId.startsWith('channel_')) {
                const channelId = parseInt(activeChatId.replace('channel_', ''), 10);
                io.to(`channel_${channelId}`).emit('message_deleted', deletePayload);
            } else if (activeChatId && activeChatId.startsWith('chat_')) {
                const chatId = parseInt(activeChatId.replace('chat_', ''), 10);
                io.to(`chat_${chatId}`).emit('message_deleted', deletePayload);
            } else if (activeChatId && activeChatId.startsWith('user_')) {
                const receiverId = parseInt(activeChatId.replace('user_', ''), 10);
                socket.emit('message_deleted', deletePayload);
                const targetSocketId = onlineUsers.get(receiverId);
                if (targetSocketId) {
                    io.to(targetSocketId).emit('message_deleted', deletePayload);
                }
            } else {
                io.to('chat_general').emit('message_deleted', deletePayload);
            }

            console.log(`🗑️ Сообщение №${messageId} полностью удалено`);
        } catch (err) {
            console.error('❌ Ошибка удаления:', err);
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

            // ✅ ДОБАВЛЯЕМ ЗАЩИТУ ОТ ПУСТЫХ ЗНАЧЕНИЙ
            if (activeChatId === 'chat_general' || activeChatId === 'null' || activeChatId === 'undefined' || !activeChatId) {
                console.log('📖 Общий чат или пустой ID, пропускаем');
                return;
            }

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
                console.log(`⚠️ Неизвестный тип чата: ${activeChatId}, пропускаем`);
                return;
            }

            // ✅ ПРОВЕРЯЕМ, ЧТО ID - ЧИСЛО
            if (isNaN(id)) {
                console.log(`⚠️ Невалидный ID: ${id}, пропускаем`);
                return;
            }

            // ✅ ВЫЗЫВАЕМ ТУ ЖЕ ЛОГИКУ, ЧТО И В HTTP-ЭНДПОИНТЕ
            if (type === 'chat') {
                // ✅ СНАЧАЛА ПРОВЕРЯЕМ, СУЩЕСТВУЕТ ЛИ ЗАПИСЬ
                const existingMember = await prisma.chatMember.findUnique({
                    where: {
                        chatId_userId: {
                            chatId: id,
                            userId: myId
                        }
                    }
                });
                 io.to(`chat_${id}`).emit('messages_read_update', {
    activeChatId: `chat_${id}`,
    readerId: myId
  });
} else if (type === 'channel') {
  // ... обновление lastReadAt
  io.to(`channel_${id}`).emit('messages_read_update', {
    activeChatId: `channel_${id}`,
    readerId: myId
  });


                if (!existingMember) {
                    // Если записи нет — создаем её
                    await prisma.chatMember.create({
                        data: {
                            chatId: id,
                            userId: myId,
                            lastReadAt: new Date()
                        }
                    });
                    console.log(`✅ Создана запись участника в чате ${id} для пользователя ${myId}`);
                } else {
                    // Если запись есть — обновляем
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
                }

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
        console.log('📝 [SERVER] typing от', socket.userId, 'в чат', data.activeChatId);
        if (!data || !data.activeChatId) {
            console.log('❌ [SERVER] Нет activeChatId');
            return;
        }
        const { activeChatId } = data;
        const senderId = socket.userId;

        console.log(`📝 Печатает пользователь ${senderId} в чате ${activeChatId}`);

        if (activeChatId === 'chat_general') {
            socket.to('chat_general').emit('typing', {
                senderId,
                isGeneral: true,
                activeChatId: activeChatId
            });
        } else if (activeChatId.startsWith('channel_')) {
            socket.to(activeChatId).emit('typing', {
                senderId,
                isGeneral: false,
                activeChatId: activeChatId
            });
            console.log(`📤 Событие typing отправлено в комнату ${activeChatId}`);
        } else if (activeChatId.startsWith('user_')) {
            const targetUserId = parseInt(activeChatId.replace('user_', ''), 10);
            if (!isNaN(targetUserId)) {
                const targetSocketId = onlineUsers.get(targetUserId);
                if (targetSocketId) {
                    console.log(`📤 [SERVER] Отправляю typing пользователю ${targetUserId}, socketId: ${targetSocketId}, activeChatId: ${activeChatId}`);

                    // ✅ ПРОВЕРЯЕМ, ЧТО ОТПРАВЛЯЕМ ПРАВИЛЬНЫЙ activeChatId
                    const chatIdForTarget = `user_${senderId}`; // ← ВАЖНО!
                    console.log(`📤 [SERVER] Для получателя activeChatId должен быть: ${chatIdForTarget}`);

                    io.to(targetSocketId).emit('typing', {
                        senderId,
                        isGeneral: false,
                        activeChatId: chatIdForTarget // ← ОТПРАВЛЯЕМ ПРАВИЛЬНЫЙ ID
                    });
                } else {
                    console.log(`⚠️ [SERVER] Пользователь ${targetUserId} не в сети`);
                }
            }
        } else if (activeChatId.startsWith('chat_')) {
            socket.to(activeChatId).emit('typing', {
                senderId,
                isGeneral: false,
                activeChatId: activeChatId
            });
            console.log(`📤 Событие typing отправлено в групповой чат ${activeChatId}`);
        }
    });

    socket.on('stop_typing', (data) => {
        if (!data || !data.activeChatId) return;
        const { activeChatId } = data;
        const senderId = socket.userId;

        console.log(`📝 [SERVER] Пользователь ${senderId} перестал печатать в чате ${activeChatId}`);

        if (activeChatId === 'chat_general') {
            socket.to('chat_general').emit('stop_typing', { activeChatId });
        } else if (activeChatId.startsWith('channel_')) {
            socket.to(activeChatId).emit('stop_typing', { activeChatId });
        } else if (activeChatId.startsWith('user_')) {
            const targetUserId = parseInt(activeChatId.replace('user_', ''), 10);
            if (!isNaN(targetUserId)) {
                const targetSocketId = onlineUsers.get(targetUserId);
                if (targetSocketId) {
                    // ✅ ДЛЯ ПОЛУЧАТЕЛЯ ID ДОЛЖЕН БЫТЬ user_${senderId}
                    const chatIdForTarget = `user_${senderId}`;
                    io.to(targetSocketId).emit('stop_typing', {
                        activeChatId: chatIdForTarget
                    });
                }
            }
        } else if (activeChatId.startsWith('chat_')) {
            socket.to(activeChatId).emit('stop_typing', { activeChatId });
        }
    });

    // === ОБРАБОТЧИК УДАЛЕНИЯ УЧАСТНИКА ===
    socket.on('remove_member', async(data) => {
        console.log(`📤 [SERVER] Получен запрос на удаление участника:`, data);

        const { chatId, userId, chatType } = data;

        try {
            let cleanId;
            let roomName;

            if (chatId.startsWith('chat_')) {
                cleanId = parseInt(chatId.replace('chat_', ''));
                roomName = `chat_${cleanId}`;
                console.log(`🔍 Групповой чат: cleanId=${cleanId}, roomName=${roomName}`);
            } else if (chatId.startsWith('channel_')) {
                cleanId = parseInt(chatId.replace('channel_', ''));
                roomName = `channel_${cleanId}`;
                console.log(`🔍 Канал: cleanId=${cleanId}, roomName=${roomName}`);
            } else {
                cleanId = parseInt(chatId);
                roomName = `chat_${cleanId}`;
            }

            // ✅ УДАЛЯЕМ ИЗ БАЗЫ ДАННЫХ
            if (chatType === 'group') {
                // Проверяем, существует ли участник
                const member = await prisma.chatMember.findUnique({
                    where: {
                        chatId_userId: {
                            chatId: cleanId,
                            userId: userId
                        }
                    }
                });

                if (!member) {
                    console.log(`⚠️ Участник ${userId} не найден в чате ${cleanId}`);
                    return;
                }

                // Удаляем из БД
                await prisma.chatMember.delete({
                    where: {
                        chatId_userId: {
                            chatId: cleanId,
                            userId: userId
                        }
                    }
                });
                console.log(`🗑️ Участник ${userId} удален из чата ${cleanId} в БД`);

                // Отправляем событие всем в комнате
                console.log(`📤 [SERVER] Отправляю chat_member_removed в комнату ${roomName} для userId ${userId}`);

                // Отправляем событие лично удалённому пользователю
const removedUserSocketId = onlineUsers.get(userId);
if (removedUserSocketId) {
    io.to(removedUserSocketId).emit('chat_member_removed', {
        chatId: cleanId,
        userId: userId,
        chatName: 'Групповой чат'
    });
    console.log(`👢 Личное уведомление отправлено пользователю ${userId}`);
}
                io.to(roomName).emit('chat_member_removed', {
                    chatId: cleanId,
                    userId: userId,
                    chatName: 'Групповой чат'
                });
                console.log(`✅ [SERVER] Отправлено chat_member_removed в комнату ${roomName}`);

            } else if (chatType === 'channel') {
                // Проверяем, существует ли участник
                const member = await prisma.channelMember.findUnique({
                    where: {
                        channelId_userId: {
                            channelId: cleanId,
                            userId: userId
                        }
                    }
                });

                if (!member) {
                    console.log(`⚠️ Участник ${userId} не найден в канале ${cleanId}`);
                    return;
                }

                // Удаляем из БД
                await prisma.channelMember.delete({
                    where: {
                        channelId_userId: {
                            channelId: cleanId,
                            userId: userId
                        }
                    }
                });
                console.log(`🗑️ Участник ${userId} удален из канала ${cleanId} в БД`);

                // Отправляем событие всем в комнате
                console.log(`📤 [SERVER] Отправляю channel_member_removed в комнату ${roomName} для userId ${userId}`);
                io.to(roomName).emit('channel_member_removed', {
                    channelId: cleanId,
                    userId: userId,
                    channelName: 'Канал'
                });
                console.log(`✅ [SERVER] Отправлено channel_member_removed в комнату ${roomName}`);
            }

        } catch (error) {
            console.error('❌ Ошибка в remove_member:', error);
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


 socket.on('add_member', async(data) => {
    console.log(`📤 [SERVER] Получен запрос на добавление участника:`, data);

    const { chatId, userId, chatType } = data;

    try {
        let cleanId;
        let roomName;

        if (chatId.startsWith('chat_')) {
            cleanId = parseInt(chatId.replace('chat_', ''));
            roomName = `chat_${cleanId}`;
        } else if (chatId.startsWith('channel_')) {
            cleanId = parseInt(chatId.replace('channel_', ''));
            roomName = `channel_${cleanId}`;
        } else {
            cleanId = parseInt(chatId);
            roomName = `chat_${cleanId}`;
        }

        // ✅ ДЛЯ ГРУППОВЫХ ЧАТОВ
        if (chatType === 'group') {
            const newMember = await prisma.chatMember.findUnique({
                where: {
                    chatId_userId: {
                        chatId: cleanId,
                        userId: userId
                    }
                },
                include: {
                    user: {
                        select: { id: true, username: true, avatar: true }
                    }
                }
            });

            if (newMember) {
                console.log(`📤 [SERVER] Отправляю chat_member_added в комнату ${roomName}`);
                io.to(roomName).emit('chat_member_added', {
                    chatId: cleanId,
                    member: newMember
                });
            }
        }

        // ✅ ДЛЯ КАНАЛОВ (ДОБАВЛЯЕМ!)
        if (chatType === 'channel') {
            const newMember = await prisma.channelMember.findUnique({
                where: {
                    channelId_userId: {
                        channelId: cleanId,
                        userId: userId
                    }
                },
                include: {
                    user: {
                        select: { id: true, username: true, avatar: true }
                    }
                }
            });

            if (newMember) {
                console.log(`📤 [SERVER] Отправляю channel_member_added в комнату ${roomName}`);
                io.to(roomName).emit('channel_member_added', {
                    channelId: cleanId,
                    member: newMember
                });
            }
        }

    } catch (error) {
        console.error('❌ [SERVER] Ошибка в add_member:', error);
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

        // ✅ Получаем полные данные канала для нового участника
        const fullChannel = await prisma.channel.findUnique({
            where: { id: channelId },
            include: {
                messages: {
                    orderBy: { createdAt: 'desc' },
                    take: 1,
                    include: { sender: { select: { id: true, username: true } } }
                }
            }
        });
        const lastMessage = fullChannel.messages[0] || null;
        const allMembers = await prisma.channelMember.findMany({
            where: { channelId },
            include: { user: { select: { id: true, username: true, avatar: true } } }
        });
        const channelData = {
            ...fullChannel,
            lastMessage,
            members: allMembers
        };

        // ✅ Отправляем событие новому участнику
        const newMemberSocketId = onlineUsers.get(userId);
        if (newMemberSocketId) {
            io.to(newMemberSocketId).emit('channel_created', channelData);
            console.log(`📢 Канал ${channelId} отправлен новому участнику ${userId}`);
        }

        // ✅ Отправляем событие остальным (для обновления списка участников)
        io.to(`channel_${channelId}`).emit('channel_member_added', {
            channelId: channelId,
            member: member,
            channelName: channel.name
        });

        res.status(201).json(member);
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

    console.log(`📤 Отправляю chat_created для чата ${chat.id} всем клиентам`);
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

        // ✅ ПРОВЕРЯЕМ, ЧТО chatId - ЧИСЛО
        if (isNaN(chatId)) {
            return res.status(400).json({ error: 'Неверный ID чата' });
        }

        const members = await prisma.chatMember.findMany({
            where: {
                chatId: chatId // ← УБЕДИТЕСЬ, ЧТО ПОЛЕ НАЗЫВАЕТСЯ chatId
            },
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

        console.log(`🗑️ [SERVER] Удаление пользователя ${userId} из чата ${chatId}`);

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

        // ✅ Отправляем событие удалённому пользователю (через socket)
        const removedUserSocketId = onlineUsers.get(userId);
        if (removedUserSocketId) {
            io.to(removedUserSocketId).emit('chat_member_removed', {
                chatId: chatId,
                userId: userId,
                chatName: chat.name
            });
            console.log(`👢 Личное уведомление отправлено пользователю ${userId}`);
        }

        // ✅ Отправляем событие остальным участникам (в комнату)
        io.to(`chat_${chatId}`).emit('chat_member_removed', {
            chatId: chatId,
            userId: userId,
            chatName: chat.name
        });
        console.log(`📤 Отправлено chat_member_removed в комнату chat_${chatId}`);

        res.json({ success: true, message: 'Участник удален из чата' });
    } catch (error) {
        console.error('Ошибка удаления участника из чата:', error);
        res.status(500).json({ error: 'Не удалось удалить участника' });
    }
});

app.delete('/api/chats/:chatId', authenticateToken, async(req, res) => {
    try {
        const chatId = parseInt(req.params.chatId);
        const userId = req.userId;

        console.log(`🗑️ [SERVER] Удаление группового чата ${chatId} пользователем ${userId}`);

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

        // ✅ ОТПРАВЛЯЕМ СОБЫТИЕ ВСЕМ
        console.log(`📤 [SERVER] Отправляю chat_deleted для чата ${chatId}`);
        io.emit('chat_deleted', { chatId });

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

        console.log(`🗑️ [SERVER] Удаление канала ${channelId} пользователем ${userId}`);

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

        // ✅ ОТПРАВЛЯЕМ СОБЫТИЕ ВСЕМ
        console.log(`📤 [SERVER] Отправляю channel_deleted для канала ${channelId}`);
        io.emit('channel_deleted', { channelId });

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

// ==========================================
// ИЗМЕНЕНИЕ ПРОФИЛЯ ПОЛЬЗОВАТЕЛЯ
// ==========================================
app.put('/api/users/profile', authenticateToken, async(req, res) => {
    try {
        const userId = req.userId;
        const { username } = req.body;

        if (!username || username.trim().length < 3) {
            return res.status(400).json({
                error: 'Имя должно содержать минимум 3 символа'
            });
        }

        // Проверяем, не занято ли имя другим пользователем
        const existingUser = await prisma.user.findFirst({
            where: {
                username: username.trim(),
                NOT: { id: userId }
            }
        });

        if (existingUser) {
            return res.status(400).json({
                error: 'Это имя уже занято'
            });
        }

        // Обновляем пользователя
        const updatedUser = await prisma.user.update({
            where: { id: userId },
            data: {
                username: username.trim()
            },
            select: {
                id: true,
                username: true,
                avatar: true
            }
        });

        // ✅ ОТПРАВЛЯЕМ СОБЫТИЕ ВСЕМ ОНЛАЙН-ПОЛЬЗОВАТЕЛЯМ
        io.emit('user_updated', {
            userId: userId,
            username: updatedUser.username,
            avatar: updatedUser.avatar
        });

        res.json({
            success: true,
            user: updatedUser
        });

    } catch (error) {
        console.error('❌ Ошибка обновления профиля:', error);
        res.status(500).json({
            error: 'Не удалось обновить профиль'
        });
    }
});

// ==========================================
// ЗАГРУЗКА АВАТАРКИ
// ==========================================
app.put('/api/users/avatar', authenticateToken, upload.single('avatar'), async(req, res) => {
    try {
        const userId = req.userId;

        if (!req.file) {
            return res.status(400).json({ error: 'Файл не загружен' });
        }

        // Формируем URL для аватарки
        const avatarUrl = `/uploads/${req.file.filename}`;

        // Обновляем пользователя
        const updatedUser = await prisma.user.update({
            where: { id: userId },
            data: {
                avatar: avatarUrl
            },
            select: {
                id: true,
                username: true,
                avatar: true
            }
        });

        // ✅ ОТПРАВЛЯЕМ СОБЫТИЕ ВСЕМ ОНЛАЙН-ПОЛЬЗОВАТЕЛЯМ
        io.emit('user_updated', {
            userId: userId,
            username: updatedUser.username,
            avatar: updatedUser.avatar
        });

        res.json({
            success: true,
            user: updatedUser
        });

    } catch (error) {
        console.error('❌ Ошибка загрузки аватарки:', error);
        res.status(500).json({
            error: 'Не удалось загрузить аватарку'
        });
    }
});

// ==========================================
// 📌 ЗАКРЕПЛЕНИЕ/ОТКРЕПЛЕНИЕ СООБЩЕНИЯ
// ==========================================
app.post('/api/messages/:messageId/pin', authenticateToken, async(req, res) => {
    try {
        const messageId = parseInt(req.params.messageId);
        const userId = req.userId;

        console.log('📌 Закрепление: messageId=', messageId, 'userId=', userId);

        const message = await prisma.message.findUnique({
            where: { id: messageId },
            include: {
                chat: true,
                channel: true,
                sender: {
                    select: { id: true, username: true, avatar: true }
                }
            }
        });

        if (!message) {
            return res.status(404).json({ error: 'Сообщение не найдено' });
        }

        let canPin = false;

// Приватные чаты: автор всегда может закрепить
if (message.senderId === userId) {
    canPin = true;
    console.log('✅ Автор сообщения');
}

// Каналы: создатель или админ
if (!canPin && message.channelId) {
    const channel = await prisma.channel.findUnique({
        where: { id: message.channelId }
    });
    if (channel && channel.creatorId === userId) {
        canPin = true;
        console.log('✅ Создатель канала');
    }
    if (!canPin) {
        const isAdmin = await prisma.channelMember.findFirst({
            where: {
                channelId: message.channelId,
                userId: userId,
                role: 'admin'
            }
        });
        if (isAdmin) {
            canPin = true;
            console.log('✅ Админ канала');
        }
    }
}

// Группы: создатель
if (!canPin && message.chatId) {
    const chat = await prisma.chat.findUnique({
        where: { id: message.chatId }
    });
    if (chat && chat.creatorId === userId) {
        canPin = true;
        console.log('✅ Создатель группы');
    }
}

console.log('📌 Итоговое canPin:', canPin);
if (!canPin) {
    return res.status(403).json({ error: 'Нет прав на закрепление' });
}

        // 3. Для групповых чатов: создатель
        if (message.chatId) {
            const chat = await prisma.chat.findUnique({
                where: { id: message.chatId }
            });
            if (chat && chat.creatorId === userId) {
                canPin = true;
            }
        }

        if (!canPin) {
            return res.status(403).json({
                error: 'Только автор, админ или создатель чата/канала может закреплять сообщения'
            });
        }

        console.log('✅ Права есть, обновляю сообщение');
        const updatedMessage = await prisma.message.update({
            where: { id: messageId },
            data: {
                isPinned: !message.isPinned
            },
            include: {
                sender: {
                    select: { id: true, username: true, avatar: true }
                }
            }
        });

        // Отправляем событие в зависимости от типа чата
        if (message.channelId) {
            io.to(`channel_${message.channelId}`).emit('message_pinned', {
                messageId: messageId,
                isPinned: updatedMessage.isPinned,
                message: updatedMessage
            });
        } else if (message.chatId) {
            io.to(`chat_${message.chatId}`).emit('message_pinned', {
                messageId: messageId,
                isPinned: updatedMessage.isPinned,
                message: updatedMessage
            });
        } else {
            // Приватный чат
            io.to(`user_${message.senderId}`).emit('message_pinned', {
                messageId: messageId,
                isPinned: updatedMessage.isPinned,
                message: updatedMessage
            });
            io.to(`user_${message.receiverId}`).emit('message_pinned', {
                messageId: messageId,
                isPinned: updatedMessage.isPinned,
                message: updatedMessage
            });
        }

        res.json({
            success: true,
            isPinned: updatedMessage.isPinned,
            message: updatedMessage
        });
    } catch (error) {
        console.error('❌ Ошибка закрепления сообщения:', error);
        res.status(500).json({ error: 'Не удалось закрепить сообщение' });
    }
});



// ✅ ПОЛУЧЕНИЕ ЗАКРЕПЛЕННЫХ СООБЩЕНИЙ
app.get('/api/messages/pinned', authenticateToken, async(req, res) => {
    try {
        const { channelId, chatId } = req.query;
        const userId = req.userId;

        let where = {};

        if (channelId) {
            where = {
                channelId: parseInt(channelId),
                isPinned: true,
                isDeleted: false
            };
        } else if (chatId) {
            where = {
                chatId: parseInt(chatId),
                isPinned: true,
                isDeleted: false
            };
        } else {
            return res.status(400).json({ error: 'Не указан channelId или chatId' });
        }

        const pinnedMessages = await prisma.message.findMany({
            where,
            include: {
                sender: {
                    select: {
                        id: true,
                        username: true,
                        avatar: true
                    }
                }
            },
            orderBy: {
                createdAt: 'desc'
            },
            take: 50
        });

        res.json(pinnedMessages);

    } catch (error) {
        console.error('❌ Ошибка получения закрепленных:', error);
        res.status(500).json({ error: 'Ошибка получения закрепленных сообщений' });
    }
});


// ==========================================
// 🔕 ВКЛЮЧИТЬ/ВЫКЛЮЧИТЬ "НЕ БЕСПОКОИТЬ"
// ==========================================
app.post('/api/mute', authenticateToken, async(req, res) => {
    try {
        const userId = req.userId;
        const { type, id } = req.body;

        if (!type || !id) {
            return res.status(400).json({ error: 'Не указан type или id' });
        }

        console.log(`🔕 Запрос на mute: type=${type}, id=${id}, userId=${userId}`);

        let result;

        if (type === 'private') {
            const otherUserId = parseInt(id);
            const member = await prisma.privateChatMember.findUnique({
                where: {
                    userId_otherUserId: {
                        userId: userId,
                        otherUserId: otherUserId
                    }
                }
            });

            if (!member) {
                return res.status(404).json({ error: 'Чат не найден' });
            }

            result = await prisma.privateChatMember.update({
                where: { id: member.id },
                data: { muted: !member.muted }
            });

        } else if (type === 'channel') {
            const channelId = parseInt(id);
            const member = await prisma.channelMember.findUnique({
                where: {
                    channelId_userId: {
                        channelId: channelId,
                        userId: userId
                    }
                }
            });

            if (!member) {
                return res.status(404).json({ error: 'Вы не участник канала' });
            }

            result = await prisma.channelMember.update({
                where: { id: member.id },
                data: { muted: !member.muted }
            });

        } else if (type === 'chat') {
            const chatId = parseInt(id);
            const member = await prisma.chatMember.findUnique({
                where: {
                    chatId_userId: {
                        chatId: chatId,
                        userId: userId
                    }
                }
            });

            if (!member) {
                return res.status(404).json({ error: 'Вы не участник чата' });
            }

            result = await prisma.chatMember.update({
                where: { id: member.id },
                data: { muted: !member.muted }
            });

        } else {
            return res.status(400).json({ error: 'Неизвестный тип чата' });
        }

        res.json({
            success: true,
            muted: result.muted,
            type,
            id
        });

    } catch (error) {
        console.error('❌ Ошибка изменения режима "Не беспокоить":', error);
        res.status(500).json({ error: 'Не удалось изменить режим' });
    }
});

// ==========================================
// 🔕 ПОЛУЧИТЬ СТАТУС "НЕ БЕСПОКОИТЬ"
// ==========================================
app.get('/api/mute-status', authenticateToken, async(req, res) => {
    try {
        const userId = req.userId;
        const { type, id } = req.query;

        if (!type || !id) {
            return res.status(400).json({ error: 'Не указан type или id' });
        }

        let muted = false;

        if (type === 'private') {
            const otherUserId = parseInt(id);
            const member = await prisma.privateChatMember.findUnique({
                where: {
                    userId_otherUserId: {
                        userId: userId,
                        otherUserId: otherUserId
                    }
                }
            });
            if (member) {
                muted = member.muted || false;
            }

        } else if (type === 'channel') {
            const channelId = parseInt(id);
            const member = await prisma.channelMember.findUnique({
                where: {
                    channelId_userId: {
                        channelId: channelId,
                        userId: userId
                    }
                }
            });
            if (member) {
                muted = member.muted || false;
            }

        } else if (type === 'chat') {
            const chatId = parseInt(id);
            const member = await prisma.chatMember.findUnique({
                where: {
                    chatId_userId: {
                        chatId: chatId, // ← ПЕРВЫМ chatId
                        userId: userId // ← ВТОРЫМ userId
                    }
                }
            });
            if (member) {
                muted = member.muted || false;
            }
        }

        res.json({ muted });

    } catch (error) {
        console.error('❌ Ошибка получения статуса "Не беспокоить":', error);
        res.status(500).json({ error: 'Не удалось получить статус' });
    }
});

// ==========================================
// ✏️ РЕДАКТИРОВАНИЕ СООБЩЕНИЯ
// ==========================================
app.put('/api/messages/:id', authenticateToken, async(req, res) => {
    try {
        const messageId = parseInt(req.params.id);
        const userId = req.userId;
        const { text } = req.body;

        if (!text || !text.trim()) {
            return res.status(400).json({ error: 'Текст сообщения обязателен' });
        }

        const message = await prisma.message.findUnique({
            where: { id: messageId }
        });

        if (!message) {
            return res.status(404).json({ error: 'Сообщение не найдено' });
        }

        // Проверяем, что пользователь — автор
        if (message.senderId !== userId) {
            return res.status(403).json({ error: 'Вы не можете редактировать это сообщение' });
        }

        // Обновляем сообщение
        const updatedMessage = await prisma.message.update({
            where: { id: messageId },
            data: {
                text: text.trim(),
                edited: true
            },
            include: {
                sender: {
                    select: { id: true, username: true, avatar: true }
                }
            }
        });

        // Определяем комнату для сокета
        let chatRoom = null;
        if (message.channelId) {
            chatRoom = `channel_${message.channelId}`;
        } else if (message.chatId) {
            chatRoom = `chat_${message.chatId}`;
        } else if (message.receiverId) {
            chatRoom = `user_${message.receiverId}`;
        }

        if (chatRoom) {
            io.to(chatRoom).emit('message_edited', {
                messageId: updatedMessage.id,
                text: updatedMessage.text,
                edited: updatedMessage.edited
            });
        }

        res.json({
            success: true,
            message: updatedMessage
        });

    } catch (error) {
        console.error('❌ Ошибка редактирования:', error);
        res.status(500).json({ error: 'Не удалось отредактировать сообщение' });
    }
});

// ==========================================
// 🔍 ПОИСК СООБЩЕНИЙ
// ==========================================

app.get('/api/messages/search', authenticateToken, validateSearch, async(req, res) => {
    try {
        const userId = req.userId;
        const { query, chatType } = req.query;

        if (!query || query.length < 2) {
            return res.status(400).json({ error: 'Поисковый запрос должен содержать минимум 2 символа' });
        }

        console.log(`🔍 Поиск: userId=${userId}, query="${query}"`);

        const userChats = await prisma.chatMember.findMany({
            where: { userId: userId },
            select: { chatId: true }
        });

        const userChannels = await prisma.channelMember.findMany({
            where: { userId: userId },
            select: { channelId: true }
        });

        const userPrivateChats = await prisma.privateChatMember.findMany({
            where: { userId: userId },
            select: { otherUserId: true }
        });

        const chatIds = userChats.map(function(c) { return c.chatId; });
        const channelIds = userChannels.map(function(c) { return c.channelId; });
        const privateUserIds = userPrivateChats.map(function(c) { return c.otherUserId; });

        var whereClause = {
            OR: [{ text: { contains: query } }]
        };

        if (chatType === 'private') {
            whereClause.AND = [
                { receiverId: { in: privateUserIds } },
                { channelId: null },
                { chatId: null }
            ];
        } else if (chatType === 'group') {
            whereClause.AND = [
                { chatId: { in: chatIds } },
                { channelId: null }
            ];
        } else if (chatType === 'channel') {
            whereClause.AND = [
                { channelId: { in: channelIds } }
            ];
        } else {
            whereClause.AND = [{
                OR: [
                    { receiverId: { in: privateUserIds } },
                    { chatId: { in: chatIds } },
                    { channelId: { in: channelIds } }
                ]
            }];
        }

        const messages = await prisma.message.findMany({
            where: whereClause,
            include: {
                sender: {
                    select: { id: true, username: true, avatar: true }
                },
                chat: {
                    select: { id: true, name: true, avatar: true }
                },
                channel: {
                    select: { id: true, name: true, avatar: true }
                }
            },
            orderBy: { createdAt: 'desc' },
            take: 50
        });

        var formattedMessages = messages.map(function(msg) {
            var chatName = '';
            var chatType = '';
            var chatId = '';

            if (msg.chat) {
                chatName = msg.chat.name;
                chatType = 'group';
                chatId = 'chat_' + msg.chat.id;
            } else if (msg.channel) {
                chatName = msg.channel.name;
                chatType = 'channel';
                chatId = 'channel_' + msg.channel.id;
            } else if (msg.receiverId) {
                var isOwn = msg.senderId === userId;
                chatName = isOwn ? 'Вы' : 'Собеседник';
                chatType = 'private';
                chatId = 'user_' + (isOwn ? msg.receiverId : msg.senderId);
            }

            return {
                id: msg.id,
                text: msg.text,
                mediaUrl: msg.mediaUrl,
                mediaType: msg.mediaType,
                createdAt: msg.createdAt,
                chatName: chatName,
                chatType: chatType,
                chatId: chatId,
                sender: msg.sender,
                isPinned: msg.isPinned || false,
                edited: msg.edited || false
            };
        });

        res.json({
            results: formattedMessages,
            total: formattedMessages.length,
            query: query
        });

    } catch (error) {
        console.error('❌ Ошибка поиска:', error);
        res.status(500).json({ error: 'Не удалось выполнить поиск' });
    }
});

// 📝 ИЗМЕНЕНИЕ ГРУППОВОГО ЧАТА (с загрузкой аватара)
app.put('/api/chats/:chatId', authenticateToken, upload.single('avatar'), async (req, res) => {
  try {
    const chatId = parseInt(req.params.chatId);
    const userId = req.userId;
    const { name } = req.body;

    const chat = await prisma.chat.findUnique({
      where: { id: chatId }
    });

    if (!chat) {
      return res.status(404).json({ error: 'Чат не найден' });
    }

    if (chat.creatorId !== userId) {
      return res.status(403).json({ error: 'Только создатель может изменять чат' });
    }

    // Если загружен новый файл, удаляем старый аватар
    let avatar = chat.avatar;
    if (req.file) {
      // Удаляем старый файл, если он существует
      if (avatar && avatar.startsWith('/uploads/')) {
  const oldPath = path.join(uploadDir, path.basename(avatar));
  if (fs.existsSync(oldPath)) {
    fs.unlinkSync(oldPath);
  }
}
      avatar = '/uploads/' + req.file.filename;
    }

    const updatedChat = await prisma.chat.update({
      where: { id: chatId },
      data: {
        name: name !== undefined ? name.trim() : chat.name,
        avatar: avatar,
      },
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

    // Отправляем событие всем участникам
    io.to(`chat_${chatId}`).emit('chat_updated', updatedChat);

    res.json(updatedChat);
  } catch (error) {
    console.error('Ошибка обновления чата:', error);
    res.status(500).json({ error: 'Не удалось обновить чат' });
  }
});

// 📝 ИЗМЕНЕНИЕ КАНАЛА (с загрузкой аватара)
app.put('/api/channels/:channelId', authenticateToken, upload.single('avatar'), async (req, res) => {
  console.log('PUT /api/channels/:channelId', req.params, req.body, req.file);
  try {
    const channelId = parseInt(req.params.channelId);
    const userId = req.userId;
    const { name } = req.body;

    const channel = await prisma.channel.findUnique({
      where: { id: channelId }
    });

    if (!channel) {
      return res.status(404).json({ error: 'Канал не найден' });
    }

    // Проверяем права (создатель или админ)
    const isAdmin = await prisma.channelMember.findFirst({
      where: {
        channelId: channelId,
        userId: userId,
        role: 'admin'
      }
    });

    if (channel.creatorId !== userId && !isAdmin) {
      return res.status(403).json({ error: 'Только создатель или админ может изменять канал' });
    }

    // Если загружен новый файл, удаляем старый аватар
    let avatar = channel.avatar;
    if (req.file) {
      if (avatar && avatar.startsWith('/uploads/')) {
  const oldPath = path.join(uploadDir, path.basename(avatar));
  if (fs.existsSync(oldPath)) {
    fs.unlinkSync(oldPath);
  }
}
      avatar = '/uploads/' + req.file.filename;
    }

    const updatedChannel = await prisma.channel.update({
      where: { id: channelId },
      data: {
        name: name !== undefined ? name.trim() : channel.name,
        avatar: avatar,
      },
      include: {
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          include: { sender: { select: { id: true, username: true } } }
        }
      }
    });

    const lastMessage = updatedChannel.messages[0] || null;
    const { messages, ...channelData } = updatedChannel;
    const result = { ...channelData, lastMessage };

    // Отправляем событие всем участникам
    io.to(`channel_${channelId}`).emit('channel_updated', result);

    res.json(result);
  } catch (error) {
    console.error('Ошибка обновления канала:', error);
    res.status(500).json({ error: 'Не удалось обновить канал' });
  }
});




// === ЗАПУСК СЕРВЕРА ===
const PORT = 5001;
server.listen(PORT, () => {
    console.log(`🚀 Сервер успешно запущен на http://localhost:${PORT}`);
});