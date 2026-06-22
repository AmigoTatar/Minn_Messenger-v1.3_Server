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

const app = express();

app.use(cors());
app.use(express.json());

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

// ==========================================
// 1. МАРШРУТ РЕГИСТРАЦИИ (РЕГИСТРАЦИЯ)
// ==========================================
app.post('/api/auth/register', async(req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({ error: 'Заполните все поля!' });
        }

        const existingUser = await prisma.user.findUnique({
            where: { username }
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
                avatar: '',
                status: 'online'
            }
        });

        const token = jwt.sign({ userId: newUser.id }, process.env.JWT_SECRET, { expiresIn: '30d' });

        res.status(201).json({
            token,
            user: {
                id: newUser.id,
                username: newUser.username,
                avatar: newUser.avatar,
                status: newUser.status
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

        const user = await prisma.user.findUnique({
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
                username: user.username,
                avatar: user.avatar,
                status: user.status
            }
        });

    } catch (error) {
        console.error('Ошибка входа:', error);
        res.status(500).json({ error: 'Ошибка сервера при входе' });
    }
});

// ==========================================
// ТВОЙ БЛОК SOCKET.IO С БОТОМ
// ==========================================
io.on('connection', (socket) => {
    console.log(`📡 Пользователь подключился: ${socket.id}`);

    socket.on('send_message', (data) => {
        console.log(`📩 Сервер получил сообщение от ${socket.id}:`, data);

        socket.broadcast.emit('receive_message', data);

        setTimeout(() => {
            const replyTime = new Date();
            const replyTimeStr = replyTime.getHours().toString().padStart(2, '0') + ':' + replyTime.getMinutes().toString().padStart(2, '0');

            const botReplyData = {
                chatId: data.chatId,
                text: "Интересно! Расскажи подробнее 🤔 (Ответ Сервера)",
                time: replyTimeStr,
                sender: 'friend'
            };

            console.log(`🤖 Бот на сервере сгенерировал ответ и отправляет его в сеть...`);
            io.emit('receive_message', botReplyData);
        }, 3000);
    });

    socket.on('disconnect', () => {
        console.log(`🔌 Пользователь отключился: ${socket.id}`);
    });
});

// ЗАПУСК СЕРВЕРА
const PORT = 5001;
server.listen(PORT, () => {
    console.log(`🚀 Сервер успешно запущен на http://localhost:${PORT}`);
});