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
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
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
            let targetRoom = 'chat_general';

            if (activeChatId && activeChatId.startsWith('user_')) {
                receiverId = parseInt(activeChatId.replace('user_', ''));
                const ids = [parseInt(senderId), receiverId].sort((a, b) => a - b);
                // ИСПРАВЛЕНО: Правильное формирование строки комнаты (например, room_2_3)
                targetRoom = `room_${ids[0]}_${ids[1]}`;
            }

            const savedMessage = await prisma.message.create({
                data: {
                    text: text || null,
                    mediaUrl: mediaUrl || null,
                    mediaType: mediaType || null,
                    senderId: parseInt(senderId),
                    receiverId: receiverId
                },
                include: {
                    sender: { select: { id: true, username: true } }
                }
            });

            const newMessage = {...savedMessage, status: 'unread', activeChatId };

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
    socket.on('read_messages', async({ activeChatId, currentUserId }) => {
        try {
            if (!activeChatId || !currentUserId) return;

            // Если это личный чат (например, "user_5"), значит мы читаем сообщения от юзера 5
            if (activeChatId.startsWith('user_')) {
                const senderId = parseInt(activeChatId.replace('user_', ''));

                // Обновляем статус всех непрочитанных сообщений в этой переписке
                await prisma.message.updateMany({
                    where: {
                        senderId: senderId,
                        receiverId: parseInt(currentUserId),
                        // status: 'unread' // если поле status есть в строковом формате
                    },
                    data: {
                        // Если у тебя поле status в Prisma — это обычная строка:
                        // (Убедись, что твоя Prisma поддерживает обновление этого текстового поля)
                    }
                });

                // Отправляем сокет-событие второму участнику, чтобы у него галочки стали синими
                io.to(`user_${senderId}`).to(`user_${currentUserId}`).emit('messages_marked_as_read', {
                    activeChatId: `user_${currentUserId}`, // для собеседника активным чатом являемся мы
                    senderId
                });
            }
        } catch (err) {
            console.error('Ошибка при обновлении статуса прочтения:', err);
        }
    });


    // === 3. ТРАНСЛЯЦИЯ СТАТУСА ПЕЧАТАНИЯ ===
    socket.on('typing', ({ activeChatId, senderId }) => {
        if (!activeChatId) return;

        if (activeChatId === 'chat_general') {
            // В общем чате передаем senderId, чтобы все знали, кто пишет
            socket.to('chat_general').emit('typing', { senderId, isGeneral: true });
        } else if (activeChatId.startsWith('user_')) {
            // В личке отправляем пакет напрямую в ящик получателя
            io.to(activeChatId).emit('typing', { senderId, isGeneral: false });
        }
    });

    socket.on('stop_typing', ({ activeChatId, senderId }) => {
        if (!activeChatId) return;

        if (activeChatId === 'chat_general') {
            socket.to('chat_general').emit('stop_typing', { senderId, isGeneral: true });
        } else if (activeChatId.startsWith('user_')) {
            io.to(activeChatId).emit('stop_typing', { senderId, isGeneral: false });
        }
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