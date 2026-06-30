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
// Добавьте после маршрута /api/channels
app.get('/api/unread', authenticateToken, async (req, res) => {
  try {
    const userId = req.userId;
    
    // Получаем непрочитанные сообщения для пользователя
    const unreadMessages = await prisma.message.findMany({
      where: {
        OR: [
          // Приватные чаты
          { receiverId: userId, status: 'unread' },
          // Общий чат
          { 
            receiverId: null, 
            channelId: null,
            NOT: { senderId: userId }
          },
          // Каналы (нужно будет добавить логику)
        ]
      },
      select: {
        id: true,
        senderId: true,
        channelId: true,
        receiverId: true
      }
    });
    
    // Группируем по чатам
    const unreadCounts = {};
    unreadMessages.forEach(msg => {
      let chatId = 'chat_general';
      if (msg.channelId) {
        chatId = `channel_${msg.channelId}`;
      } else if (msg.receiverId && msg.senderId !== userId) {
        chatId = `user_${msg.senderId}`;
      } else if (msg.receiverId && msg.senderId === userId) {
        chatId = `user_${msg.receiverId}`;
      }
      unreadCounts[chatId] = (unreadCounts[chatId] || 0) + 1;
    });
    
    res.json(unreadCounts);
  } catch (error) {
    console.error('Ошибка получения непрочитанных:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
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

        // Создаем канал
        const newChannel = await prisma.channel.create({
            data: {
                name: name.trim(),
                avatar: avatar || '📢',
                creatorId: creatorId
            },
        });

        // ✅ ДОБАВЛЯЕМ СОЗДАТЕЛЯ В УЧАСТНИКИ КАНАЛА
        await prisma.channelMember.create({
            data: {
                channelId: newChannel.id,
                userId: creatorId,
                role: 'admin' // создатель - админ
            }
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

socket.on('send_message', async (messageData) => {
  try {
    const { text, mediaUrl, mediaType, activeChatId } = messageData;
    const senderId = socket.userId;
    
    let receiverId = null;
    let channelId = null;
    let chatId = null;
    let targetRoom = 'chat_general';

    if (!activeChatId) return;

    // Определяем тип чата
    if (activeChatId.startsWith('user_')) {
      // Приватный чат
      receiverId = parseInt(activeChatId.replace('user_', ''), 10);
      if (isNaN(receiverId)) return;
      const ids = [senderId, receiverId].sort((a, b) => a - b);
      targetRoom = `room_${ids[0]}_${ids[1]}`;
    }
    else if (activeChatId.startsWith('channel_')) {
      // Публичный канал
      channelId = parseInt(activeChatId.replace('channel_', ''), 10);
      if (isNaN(channelId)) return;
      targetRoom = `channel_${channelId}`;

      const isMember = await prisma.channelMember.findFirst({
        where: { channelId: channelId, userId: senderId }
      });
      if (!isMember) {
        console.log(`❌ Юзер ${senderId} не участник канала ${channelId}`);
        return;
      }
    }
    else if (activeChatId.startsWith('chat_')) {
      // ✅ ГРУППОВОЙ ЧАТ
      chatId = parseInt(activeChatId.replace('chat_', ''), 10);
      if (isNaN(chatId)) return;
      targetRoom = `chat_${chatId}`;

      // Проверяем, что пользователь - участник чата
      const isMember = await prisma.chatMember.findFirst({
        where: { chatId: chatId, userId: senderId }
      });
      if (!isMember) {
        console.log(`❌ Юзер ${senderId} не участник чата ${chatId}`);
        return;
      }
    }

    // Сохраняем сообщение
    const savedMessage = await prisma.message.create({
      data: {
        text: text || null,
        mediaUrl: mediaUrl || null,
        mediaType: mediaType || null,
        senderId: senderId,
        receiverId: receiverId,
        channelId: channelId,
        chatId: chatId  // ← для групповых чатов
      },
      include: {
        sender: { select: { id: true, username: true } }
      }
    });

    const newMessage = { ...savedMessage, activeChatId };
    console.log(`✅ Сообщение сохранено:`, newMessage);

    // Отправляем в комнату
    if (chatId) {
      // Групповой чат
      io.to(`chat_${chatId}`).emit('receive_message', newMessage);
    } else if (channelId) {
      // Канал
      io.to(`channel_${channelId}`).emit('receive_message', newMessage);
    } else if (receiverId) {
      // Приватный чат
      const targetSocketId = onlineUsers.get(receiverId);
      socket.emit('receive_message', newMessage);
      if (targetSocketId) {
        io.to(targetSocketId).emit('receive_message', newMessage);
      }
    } else {
      // Общий чат
      io.to('chat_general').emit('receive_message', newMessage);
    }
  } catch (error) {
    console.error('❌ Ошибка сохранения сообщения:', error);
  }
});


socket.on('delete_message', async ({ messageId, activeChatId }) => {
  try {
    console.log(`🗑️ Запрос на удаление сообщения ${messageId} от пользователя ${socket.userId}`);
    
    const message = await prisma.message.findUnique({
      where: { id: Number(messageId) }
    });

    if (!message) {
      console.log('❌ Сообщение не найдено');
      return;
    }

    // Проверяем права
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

    // ✅ ПОЛНОСТЬЮ ОЧИЩАЕМ СООБЩЕНИЕ
    const updatedMessage = await prisma.message.update({
      where: { id: Number(messageId) },
      data: { 
        text: "Сообщение удалено",
        mediaUrl: null,  // ← ОЧИЩАЕМ
        mediaType: null  // ← ОЧИЩАЕМ
      }
    });

    const deletePayload = {
      messageId: updatedMessage.id,
      activeChatId,
      isDeleted: true
    };

    // Рассылаем во все комнаты
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

// === 2.1. ОБРАБОТКА ПРОЧТЕНИЯ СООБЩЕНИЙ ===
socket.on('read_messages', async (data) => {
  try {
    if (!data) return;
    const { activeChatId } = data;
    const myId = socket.userId;

    if (!activeChatId) return;

    console.log(`👁️ Юзер ${myId} прочитал историю чата: ${activeChatId}`);

    // ✅ ПРОСТО ОТПРАВЛЯЕМ СОБЫТИЕ, НЕ ОБНОВЛЯЕМ БД (так как поля status нет)
    const readPayload = { activeChatId, readerId: myId };

    // Отправляем уведомление о прочтении во все комнаты
    if (activeChatId.startsWith('channel_')) {
      const cleanId = parseInt(activeChatId.replace('channel_', ''), 10);
      io.to(`channel_${cleanId}`).emit('messages_read_update', readPayload);
      console.log(`✅ Отправлено уведомление о прочтении в канал ${cleanId}`);
    } else if (activeChatId.startsWith('user_')) {
      const cleanId = parseInt(activeChatId.replace('user_', ''), 10);
      socket.emit('messages_read_update', readPayload);
      const targetSocketId = onlineUsers.get(cleanId);
      if (targetSocketId) {
        io.to(targetSocketId).emit('messages_read_update', readPayload);
      }
      console.log(`✅ Отправлено уведомление о прочтении в приватный чат с ${cleanId}`);
    } else {
      io.to('chat_general').emit('messages_read_update', readPayload);
      console.log(`✅ Отправлено уведомление о прочтении в Общий чат`);
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
    // === УДАЛЕНИЕ КАНАЛА ЧЕРЕЗ СОКЕТ ===
socket.on('delete_channel', async ({ channelId }) => {
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

    // Рассылаем всем
    io.emit('channel_deleted', { channelId });
    console.log(`🗑️ Канал ${channelId} удален через сокет пользователем ${userId}`);

  } catch (error) {
    console.error('Ошибка удаления канала через сокет:', error);
    socket.emit('error', { message: 'Не удалось удалить канал' });
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

// === 7. ТРЕДЫ (ЧЕРЕЗ СОКЕТ) ===
socket.on('create_thread', async ({ messageId, text, activeChatId }) => {
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

    // Отправляем всем в комнате чата
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

// === 8. РЕАКЦИИ (ЧЕРЕЗ СОКЕТ) ===
socket.on('toggle_reaction', async ({ messageId, type, activeChatId }) => {
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

    // Получаем все реакции для сообщения
    const allReactions = await prisma.reaction.findMany({
      where: { messageId: messageId },
      include: {
        user: {
          select: { id: true, username: true }
        }
      }
    });

    // Отправляем обновление в комнату
    io.to(activeChatId || 'chat_general').emit('reaction_updated', {
      messageId,
      reactions: allReactions
    });

  } catch (error) {
    console.error('Ошибка при работе с реакцией через сокет:', error);
    socket.emit('error', { message: 'Не удалось обработать реакцию' });
  }
});



}); // <--- Вот здесь закрывается io.on('connection')


// ==========================================
// 4. УЧАСТНИКИ КАНАЛОВ
// ==========================================

// Получить список участников канала
app.get('/api/channels/:channelId/members', authenticateToken, async (req, res) => {
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

// Добавить участника в канал (только админ)
app.post('/api/channels/:channelId/members', authenticateToken, async (req, res) => {
  try {
    const channelId = parseInt(req.params.channelId);
    const { userId } = req.body;
    const currentUserId = req.userId;

    // Проверяем, что канал существует
    const channel = await prisma.channel.findUnique({
      where: { id: channelId }
    });

    if (!channel) {
      return res.status(404).json({ error: 'Канал не найден' });
    }

    // Проверяем права (только админ)
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

    // Проверяем, что пользователь не уже участник
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

    // Добавляем участника
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
  } catch (error) {
    console.error('Ошибка добавления участника в канал:', error);
    res.status(500).json({ error: 'Не удалось добавить участника' });
  }
});

// Удалить участника из канала (только админ)
app.delete('/api/channels/:channelId/members/:userId', authenticateToken, async (req, res) => {
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

    // Проверяем права (только админ)
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

    // Нельзя удалить создателя канала
    if (userId === channel.creatorId) {
      return res.status(400).json({ error: 'Нельзя удалить создателя канала' });
    }

    // Удаляем участника
    await prisma.channelMember.delete({
      where: {
        channelId_userId: {
          channelId: channelId,
          userId: userId
        }
      }
    });

    res.json({ success: true, message: 'Участник удален из канала' });
  } catch (error) {
    console.error('Ошибка удаления участника из канала:', error);
    res.status(500).json({ error: 'Не удалось удалить участника' });
  }
});
// Удалить участника из канала (только админ)
app.delete('/api/channels/:channelId/members/:userId', authenticateToken, async (req, res) => {
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

    // ✅ ПРОВЕРКА ЧЕРЕЗ TABLICE ChannelMember
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

    // Нельзя удалить создателя канала
    if (userId === channel.creatorId) {
      return res.status(400).json({ error: 'Нельзя удалить создателя канала' });
    }

    // Удаляем участника
    await prisma.channelMember.delete({
      where: {
        channelId_userId: {
          channelId: channelId,
          userId: userId
        }
      }
    });

    res.json({ success: true, message: 'Участник удален из канала' });
  } catch (error) {
    console.error('Ошибка удаления участника из канала:', error);
    res.status(500).json({ error: 'Не удалось удалить участника' });
  }
});
// ==========================================
// 5. ГРУППОВЫЕ ЧАТЫ
// ==========================================

// Создать групповой чат
app.post('/api/chats', authenticateToken, async (req, res) => {
  try {
    const { name, avatar, memberIds } = req.body;
    const creatorId = req.userId;

    if (!name) {
      return res.status(400).json({ error: 'Название чата обязательно' });
    }

    // Создаем чат
    const chat = await prisma.chat.create({
      data: {
        name: name.trim(),
        avatar: avatar || '💬',
        creatorId: creatorId
      }
    });

    // ✅ Добавляем создателя как участника
    await prisma.chatMember.create({
      data: {
        chatId: chat.id,
        userId: creatorId
      }
    });

    // ✅ Добавляем остальных участников
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

    // Возвращаем созданный чат с участниками
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

// ==========================================
// 5.1. ПОЛУЧИТЬ ВСЕ ГРУППОВЫЕ ЧАТЫ ПОЛЬЗОВАТЕЛЯ
// ==========================================

app.get('/api/chats', authenticateToken, async (req, res) => {
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

    // Форматируем для фронтенда
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

// ==========================================
// 5.2. ПОЛУЧИТЬ УЧАСТНИКОВ ГРУППОВОГО ЧАТА
// ==========================================

app.get('/api/chats/:chatId/members', authenticateToken, async (req, res) => {
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
// ==========================================
// 5.3. ДОБАВИТЬ УЧАСТНИКА В ГРУППОВОЙ ЧАТ
// ==========================================

app.post('/api/chats/:chatId/members', authenticateToken, async (req, res) => {
  try {
    const chatId = parseInt(req.params.chatId);
    const { userId } = req.body;
    const currentUserId = req.userId;

    // Проверяем, что чат существует
    const chat = await prisma.chat.findUnique({
      where: { id: chatId }
    });

    if (!chat) {
      return res.status(404).json({ error: 'Чат не найден' });
    }

    // Проверяем, что пользователь уже не участник
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

    // Добавляем участника
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

    res.status(201).json(member);
  } catch (error) {
    console.error('Ошибка добавления участника в чат:', error);
    res.status(500).json({ error: 'Не удалось добавить участника' });
  }
});
// ==========================================
// 5.4. УДАЛИТЬ УЧАСТНИКА ИЗ ГРУППОВОГО ЧАТА
// ==========================================

app.delete('/api/chats/:chatId/members/:userId', authenticateToken, async (req, res) => {
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

    // Нельзя удалить создателя чата
    if (userId === chat.creatorId) {
      return res.status(400).json({ error: 'Нельзя удалить создателя чата' });
    }

    // Удаляем участника
    await prisma.chatMember.delete({
      where: {
        chatId_userId: {
          chatId: chatId,
          userId: userId
        }
      }
    });

    res.json({ success: true, message: 'Участник удален из чата' });
  } catch (error) {
    console.error('Ошибка удаления участника из чата:', error);
    res.status(500).json({ error: 'Не удалось удалить участника' });
  }
});

// ==========================================
// УДАЛЕНИЕ КАНАЛА
// ==========================================

app.delete('/api/channels/:channelId', authenticateToken, async (req, res) => {
  try {
    const channelId = parseInt(req.params.channelId);
    const userId = req.userId;

    // Проверяем, что канал существует
    const channel = await prisma.channel.findUnique({
      where: { id: channelId }
    });

    if (!channel) {
      return res.status(404).json({ error: 'Канал не найден' });
    }

    // Проверяем, что пользователь - создатель канала
    if (channel.creatorId !== userId) {
      return res.status(403).json({ error: 'Только создатель может удалить канал' });
    }

    // Удаляем канал (все связанные записи удалятся благодаря onDelete: Cascade)
    await prisma.channel.delete({
      where: { id: channelId }
    });

    // Отправляем событие через сокеты
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

// Получить треды для сообщения
app.get('/api/messages/:messageId/threads', authenticateToken, async (req, res) => {
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

// Создать тред (ответ на сообщение)
app.post('/api/messages/:messageId/threads', authenticateToken, async (req, res) => {
  try {
    const messageId = parseInt(req.params.messageId);
    const userId = req.userId;
    const { text } = req.body;

    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'Текст комментария обязателен' });
    }

    // Проверяем, что сообщение существует
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

    // Отправляем через сокеты
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

// Удалить тред (только автор)
app.delete('/api/threads/:threadId', authenticateToken, async (req, res) => {
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

// Добавить или убрать реакцию (toggle)
app.post('/api/messages/:messageId/reactions', authenticateToken, async (req, res) => {
  try {
    const messageId = parseInt(req.params.messageId);
    const userId = req.userId;
    const { type } = req.body; // "like" | "heart" | "laugh" | "wow" | "sad" | "angry"

    if (!type) {
      return res.status(400).json({ error: 'Тип реакции обязателен' });
    }

    // Проверяем, есть ли уже такая реакция от этого пользователя
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
      // Если реакция уже есть — удаляем (toggle off)
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
      // Создаем новую реакцию
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

    // Получаем все реакции для этого сообщения
    const allReactions = await prisma.reaction.findMany({
      where: { messageId: messageId },
      include: {
        user: {
          select: { id: true, username: true }
        }
      }
    });

    // Отправляем через сокеты
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

// Получить все реакции для сообщения
app.get('/api/messages/:messageId/reactions', authenticateToken, async (req, res) => {
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
