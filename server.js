const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');
require('dotenv').config();

// Подключаем роуты сообщений (импорт перенесли сюда)
const messageRoutes = require('./routes/messageRoutes');

const app = express();
// НАСТРОЙКА ЗАГРУЗКИ ФАЙЛОВ (MULTER)
// ==========================================
const path = require('path');
const fs = require('fs');
const multer = require('multer');

// 1. Создаем папку для загрузок, если её нет
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}
// Настройки CORS и JSON-парсера
app.use(cors());
app.use(express.json());

// Раздаем файлы из папки public/uploads по адресу http://localhost:5001/uploads
app.use('/uploads', express.static(uploadDir));
// Регистрируем API-роут для получения истории сообщений (теперь строго ПОСЛЕ инициализации app)


const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: "http://localhost:5173",
        methods: ["GET", "POST"]
    }
});

// Настраиваем пул соединений через современный чистый JS-драйвер для Prisma 7
// 🔒 Жестко ограничиваем max: 2, чтобы не взрывать лимиты облачной БД
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 2,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000
});
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });


// Сначала делимся клиентом со всеми контроллерами проекта!
app.set('prisma', prisma);

// ТЕПЕРЬ регистрируем API-роут для получения истории сообщений (чтобы контроллер видел Prisma)
app.use('/api/messages', messageRoutes);


// 2. Раздаем файлы из папки public/uploads по адресу http://localhost:5001/uploads
app.use('/uploads', express.static(uploadDir));

// 3. Настраиваем хранилище Multer (сохраняем оригинальное расширение)
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        cb(null, file.fieldname + '-' + uniqueSuffix + ext);
    }
});

const upload = multer({ storage: storage });

// 4. HTTP-маршрут для загрузки файлов
app.post('/api/upload', upload.single('file'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'Файл не загружен' });
        }
        // Возвращаем фронтенду прямую ссылку на файл (измени порт 5000 на свой, если у тебя другой)
        const fileUrl = `http://localhost:5001/uploads/${req.file.filename}`;
        return res.json({ fileUrl });
    } catch (err) {
        console.error('Ошибка загрузки файла на сервере:', err);
        return res.status(500).json({ error: 'Ошибка сервера при сохранении файла' });
    }
});

// ==========================================
// 0.1. МАРШРУТ ДЛЯ ПОЛУЧЕНИЯ СПИСКА ПОЛЬЗОВАТЕЛЕЙ (КОНТАКТОВ)
// ==========================================
app.get('/api/users', async(req, res) => {
    try {
        // Извлекаем ID текущего пользователя из заголовков, чтобы исключить его из списка
        const currentUserId = req.headers['x-current-user-id'];

        const users = await prisma.user.findMany({
            where: {
                NOT: {
                    id: currentUserId ? parseInt(currentUserId) : undefined
                }
            },
            select: {
                id: true,
                username: true,
                avatar: true
            }
        });

        // Форматируем массив под структуру чатов для фронтенда
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
}); // 🔒 Роут пользователей теперь герметично закрыт здесь!

// ==========================================
// 0.2. МАРШРУТ ДЛЯ ПОЛУЧЕНИЯ СПИСКА ПУБЛИЧНЫХ КАНАЛОВ
// ==========================================
app.get('/api/channels', async(req, res) => {
    try {
        const dbInstance = typeof prisma !== 'undefined' ? prisma : (typeof db !== 'undefined' ? db : null);

        // Запрашиваем список каналов из БД
        const channelsList = await dbInstance.channel.findMany({
            orderBy: { id: 'asc' }
        });

        return res.json(channelsList);
    } catch (error) {
        console.error('Ошибка при получении каналов из БД:', error);
        // Отдаем 500 статус, фронтенд поймает его и сделает автоматический перезапрос через секунду
        return res.status(500).json({ error: 'База данных временно перегружена' });
    }
});
// 🔒 Роут каналов герметично закрыт здесь!


// ==========================================
// СОЗДАНИЕ НОВОГО КАНАЛА (ЗАЩИЩЕННАЯ ВЕРСИЯ)
// ==========================================
app.post('/api/channels', async(req, res) => {
    try {
        const { name, avatar, creatorId } = req.body;

        if (!name || !creatorId) {
            return res.status(400).json({ error: 'Название канала и ID создателя обязательны' });
        }

        // Определяем, как у тебя называется Prisma в файле. 
        // Если выше по коду у тебя const db = new PrismaClient(), то используем db, иначе prisma
        const dbInstance = typeof prisma !== 'undefined' ? prisma : (typeof db !== 'undefined' ? db : null);

        if (!dbInstance) {
            console.error('❌ Ошибка: Экземпляр Prisma Client не найден в server.js!');
            return res.status(500).json({ error: 'Конфигурация базы данных нарушена' });
        }

        // Создаем запись в БД
        const newChannel = await dbInstance.channel.create({
            data: {
                name: name,
                avatar: avatar || '📢',
                creatorId: creatorId
            },
        });

        // Безопасный вызов сокетов: оборачиваем в отдельный try, чтобы сбой сокетов не валил запрос
        try {
            if (req.io) {
                req.io.emit('channel_created', newChannel);
            } else if (global.io) {
                global.io.emit('channel_created', newChannel);
            } else if (typeof io !== 'undefined') {
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
app.post('/api/auth/register', async(req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({ error: 'Заполните все поля!' });
        }

        const existingUser = await prisma.user.findFirst({
            where: { username: username } // или просто { username }, если имя переменной совпадает
        });

        if (existingUser) {
            return res.status(400).json({ error: 'Этот никнейм уже занят!' });
        }

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        const newUser = await prisma.user.create({
            data: {
                username,
                password: hashedPassword,
                email: `${username.toLowerCase()}@messenger.local` // Заглушка для обязательного поля email
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
app.post('/api/auth/login', async(req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({ error: 'Заполните все поля!' });
        }

        const user = await prisma.user.findFirst({
            where: { username }
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

/// ==========================================
// 3. БЛОК SOCKET.IO С БОТОМ И ПРИВАТНЫМИ КОМНАТАМИ
// ==========================================
io.on('connection', (socket) => {
    console.log(`📡 Пользователь подключился: ${socket.id}`);


    // ИСПРАВЛЕННОЕ СОБЫТИЕ: Подключение пользователя к комнате без выселения из остальных
    socket.on('join_chat', (chatId) => {
        if (!chatId) return;

        // Просто подключаем сокет в комнату (общую или личный ящик)
        socket.join(chatId);
        console.log(`🚪 Сокет ${socket.id} успешно зафиксирован в комнате: ${chatId}`);
    });


    // === 1. ОБРАБОТКА ОТПРАВКИ СООБЩЕНИЯ ===
    socket.on('send_message', async(messageData) => {
        try {
            const { text, mediaUrl, mediaType, senderId, activeChatId } = messageData;
            let receiverId = null;
            let channelId = null; // Новая переменная для БД
            let targetRoom = 'chat_general';

            // 1. ЛОГИКА ЛИЧНЫХ ЧАТОВ
            if (activeChatId && activeChatId.startsWith('user_')) {
                receiverId = parseInt(activeChatId.replace('user_', ''));
                const ids = [parseInt(senderId), receiverId].sort((a, b) => a - b);
                targetRoom = `room_${ids[0]}_${ids[1]}`;
            }
            // 2. 🔥 НОВАЯ ЛОГИКА ПУБЛИЧНЫХ КАНАЛОВ
            else if (activeChatId && activeChatId.startsWith('channel_')) {
                channelId = parseInt(activeChatId.replace('channel_', ''));
                targetRoom = `channel_${channelId}`;

                // СТРОГАЯ ЗАЩИТА: Проверяем, является ли отправитель создателем канала
                const channel = await prisma.channel.findUnique({
                    where: { id: channelId }
                });

                if (!channel || channel.creatorId !== parseInt(senderId)) {
                    console.warn(`[🔒 SECURITY] Юзер ${senderId} пытался спамить в канал ${channelId} без прав!`);
                    return; // Глухая блокировка сокета
                }
            }

            // Сохраняем в базу данных (с учетом новых полей)
            const savedMessage = await prisma.message.create({
                data: {
                    text: text || null,
                    mediaUrl: mediaUrl || null,
                    mediaType: mediaType || null,
                    senderId: parseInt(senderId),
                    receiverId: receiverId,
                    channelId: channelId // Запишется Int или null
                },
                include: {
                    sender: { select: { id: true, username: true } }
                }
            });

            const newMessage = {...savedMessage, status: 'unread', activeChatId };

            // Отправка в сокет-комнаты
            if (channelId) {
                // Вещаем на всю комнату канала (ее слушают все подписчики, вошедшие в канал через join_chat)
                io.to(targetRoom).emit('receive_message', newMessage);
            } else if (receiverId) {
                // Твоя логика для лички
                io.to(`user_${senderId}`).to(`user_${receiverId}`).emit('receive_message', newMessage);
            } else {
                // Твоя логика для общего чата
                io.to('chat_general').emit('receive_message', newMessage);
            }


            // Вещаем во все персональные ящики
            if (receiverId) {
                io.to(`user_${senderId}`).to(`user_${receiverId}`).emit('receive_message', newMessage);
            } else {
                io.to('chat_general').emit('receive_message', newMessage);
            }

            // === АВТООТВЕТ БОТА ===
            if (activeChatId === 'user_1') {
                // Отправляем статус печатания обратно текущему пользователю
                io.to(`user_${senderId}`).emit('typing');

                setTimeout(async() => {
                    try {
                        io.to(`user_${senderId}`).emit('stop_typing');

                        const savedBotMessage = await prisma.message.create({
                            data: {
                                text: `Автоответ: Я получил твое личное сообщение "${text || 'Медиафайл'}"! 🤔`,
                                senderId: 1,
                                receiverId: parseInt(senderId)
                            },
                            include: {
                                sender: { select: { id: true, username: true } }
                            }
                        });

                        const botMessage = {...savedBotMessage, status: 'unread', activeChatId: `user_1` };
                        io.to(`user_${senderId}`).emit('receive_message', botMessage);
                    } catch (botErr) {
                        console.error('Ошибка бота:', botErr);
                        io.to(`user_${senderId}`).emit('stop_typing');
                    }
                }, 2000);
            }

        } catch (error) {
            console.error('Ошибка сохранения сообщения:', error);
        }
    });

    // === 2. ОБРАБОТКА УДАЛЕНИЯ СООБЩЕНИЯ ===
    socket.on('delete_message', async({ messageId, activeChatId }) => {
        try {
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
                const receiverId = parseInt(activeChatId.replace('user_', ''));

                // РАЗДЕЛЯЕМ НА ДВА СТРОГИХ ВЫЗОВА:
                io.to(`user_${updatedMessage.senderId}`).emit('message_deleted', deletePayload);
                io.to(`user_${receiverId}`).emit('message_deleted', deletePayload);
            } else {
                io.to('chat_general').emit('message_deleted', deletePayload);
            }
            console.log(`🗑️ Сообщение №${messageId} удалено в базе и сокетах`);
        } catch (err) {
            console.error('Ошибка удаления:', err);
        }
    });

    // === 2.1. ОБРАБОТКА ПРОЧТЕНИЯ СООБЩЕНИЙ ===
    socket.on('read_messages', async(data) => {
        try {
            if (!data) return;
            const { activeChatId, currentUserId } = data;
            if (!activeChatId || !currentUserId) return;

            const myId = parseInt(currentUserId);
            let cleanId = null;

            if (activeChatId.startsWith('user_')) {
                cleanId = parseInt(activeChatId.replace('user_', ''));
            }

            console.log(`👁️ Юзер ${myId} прочитал историю чата: ${activeChatId}`);

            // Переменные создаются СТРОГО внутри функции, теперь ошибок не будет
            const readPayload = { activeChatId, readerId: myId };

            // Оповещаем сокет-комнаты, чтобы фронтенд погасил плашку
            if (activeChatId.startsWith('user_')) {
                io.to(`user_${myId}`).to(`user_${cleanId}`).emit('messages_read_update', readPayload);
            } else if (activeChatId.startsWith('channel_')) {
                cleanId = parseInt(activeChatId.replace('channel_', ''));
                io.to(`channel_${cleanId}`).emit('messages_read_update', readPayload);
            } else {
                io.to('chat_general').emit('messages_read_update', readPayload);
            }

        } catch (err) {
            console.error('Ошибка в обработчике read_messages:', err);
        }
    }); // Конец обработчика read_messages


    // === 3. ТРАНСЛЯЦИЯ СТАТУСА ПЕЧАТАНИЯ ===
    socket.on('typing', (data) => {
        if (!data) return;
        const { activeChatId, senderId } = data;
        socket.to(activeChatId).emit('typing', { senderId, isGeneral: activeChatId === 'chat_general' });
    });

    socket.on('stop_typing', (data) => {
        if (!data) return;
        const { activeChatId } = data;
        socket.to(activeChatId).emit('stop_typing');
    });



    // <-- Конец обработчика события send_message/message

    // Обработка отключения пользователя
    socket.on('disconnect', () => {
        console.log(`🔌 Пользователь отключился: ${socket.id}`);
    });
}); // <-- Конец io.on('connection')


// === ЗАПУСК СЕРВЕРА ===
const PORT = 5001;
server.listen(PORT, () => {
    console.log(`🚀 Сервер успешно запущен на http://localhost:${PORT}`);
});