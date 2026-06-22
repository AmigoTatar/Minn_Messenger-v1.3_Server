const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: "http://localhost:5173",
        methods: ["GET", "POST"]
    }
});

// Главный блок подключения сокетов
io.on('connection', (socket) => {
    console.log(`📡 Пользователь подключился: ${socket.id}`);

    // 📥 СЛУШАЕМ: отправку сообщения от пользователя
    socket.on('send_message', (data) => {
        console.log(`📩 Сервер получил сообщение от ${socket.id}:`, data);

        // 1. Пересылаем сообщение всем остальным вкладкам
        socket.broadcast.emit('receive_message', data);

        // 2. 🤖 БОТ НА СЕРВЕРЕ: отвечает через 3 секунды
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

            // Отправляем ответ бота ВСЕМ (io.emit шлет данные абсолютно во все окна)
            io.emit('receive_message', botReplyData);
        }, 3000);
    });

    // 🔌 СЛУШАЕМ: отключение пользователя (закрытие вкладки)
    socket.on('disconnect', () => {
        console.log(`🔌 Пользователь отключился: ${socket.id}`);
    });
}); // ← Закрыли io.on('connection')

// ЗАПУСК СЕРВЕРА (вынесен наружу, как и должно быть)
const PORT = 5001;
server.listen(PORT, () => {
    console.log(`🚀 Сервер успешно запущен на http://localhost:${PORT}`);
});