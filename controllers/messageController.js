const getMessages = async (req, res) => {
    try {
        const prisma = req.app.get('prisma');

        if (!prisma) {
            console.error("Критическая ошибка: Инстанс Prisma не найден в app.set");
            return res.status(500).json({ error: "Ошибка конфигурации сервера базы данных" });
        }

        // 1. Извлекаем параметры из query-строки запроса
        // activeChatId указывает, какую комнату грузим
        // cursorMessageId указывает ID сообщения, от которого скроллим ВВЕРХ
        const { activeChatId, cursorMessageId } = req.query;
        
        // ID текущего авторизованного пользователя (его туда записал наш JWT мидлвейр!)
        const currentUserId = req.userId; 

        if (!activeChatId) {
            return res.status(400).json({ error: "Параметр activeChatId обязателен" });
        }

        const limit = 30; // Жестко фиксируем порцию загрузки по 30 штук
        let whereClause = {};

        // 2. СТРОГОЕ ВЕТВЛЕНИЕ ФИЛЬТРАЦИИ НА УРОВНЕ БАЗЫ ДАННЫХ
        
        // А. ОБЩИЙ ЧАТ
        if (activeChatId === 'chat_general') {
            whereClause = {
                receiverId: null,
                channelId: null
            };
        } 
        // Б. ПУБЛИЧНЫЕ КАНАЛЫ
        else if (activeChatId.startsWith('channel_')) {
            const channelDbId = parseInt(activeChatId.replace('channel_', ''), 10);
            if (isNaN(channelDbId)) return res.status(400).json({ error: "Невалидный ID канала" });
            
            whereClause = {
                channelId: channelDbId
            };
        } 
        // В. ЛИЧНЫЕ ДИАЛОГИ (ТЕТ-А-ТЕТ)
        else if (activeChatId.startsWith('user_')) {
            const targetUserId = parseInt(activeChatId.replace('user_', ''), 10);
            if (isNaN(targetUserId)) return res.status(400).json({ error: "Невалидный ID собеседника" });

            whereClause = {
                channelId: null,
                OR: [
                    { senderId: currentUserId, receiverId: targetUserId },
                    { senderId: targetUserId, receiverId: currentUserId }
                ]
            };
        } else {
            return res.status(400).json({ error: "Неизвестный формат чата" });
        }

        // 3. НАСТРОЙКА КУРСОРНОЙ ПАГИНАЦИИ PRISMA
        let queryOptions = {
            where: whereClause,
            // Сортируем от СВЕЖИХ к СТАРЫМ (desc), чтобы забирать последние 30 штук из истории чата
            orderBy: { createdAt: 'desc' },
            take: limit,
            include: {
                sender: {
                    select: { id: true, username: true }
                }
            }
        };

        // Если фронтенд передал ID курсора (запрос истории при скролле вверх)
        if (cursorMessageId) {
            const cursorId = Number(cursorMessageId);
            if (!isNaN(cursorId)) {
                queryOptions.cursor = { id: cursorId };
                queryOptions.skip = 1; // Пропускаем само сообщение-курсор, чтобы оно не дублировалось
            }
        }

        // 4. ЗАПРОС К POSTGRESQL
        const messages = await prisma.message.findMany(queryOptions);

        // Переворачиваем массив обратно (от старых к свежим), чтобы фронтенд отрендерил их сверху вниз
        const orderedMessages = messages.reverse();

        // Отдаем порцию сообщений и флаг, есть ли еще история для подгрузки
        return res.json({
            messages: orderedMessages,
            hasMore: messages.length === limit // Если вернулось ровно 30 — значит, в базе есть еще сообщения
        });

    } catch (error) {
        console.error('Ошибка при получении сообщений с пагинацией:', error);
        return res.status(500).json({ error: 'Ошибка сервера при загрузке истории чата' });
    }
};

module.exports = {
    getMessages
};
