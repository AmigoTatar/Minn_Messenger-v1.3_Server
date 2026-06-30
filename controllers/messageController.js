const getMessages = async (req, res) => {
    try {
        const prisma = req.app.get('prisma');

        if (!prisma) {
            console.error("Критическая ошибка: Инстанс Prisma не найден в app.set");
            return res.status(500).json({ error: "Ошибка конфигурации сервера базы данных" });
        }

        // 1. Извлекаем параметры из query-строки запроса
        const { activeChatId, cursorMessageId } = req.query;
        const currentUserId = req.userId; 

        if (!activeChatId) {
            return res.status(400).json({ error: "Параметр activeChatId обязателен" });
        }

        const limit = 30;
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
        } 
        // ✅ Г. ГРУППОВЫЕ ЧАТЫ
        else if (activeChatId.startsWith('chat_')) {
            const chatDbId = parseInt(activeChatId.replace('chat_', ''), 10);
            if (isNaN(chatDbId)) return res.status(400).json({ error: "Невалидный ID группового чата" });
            
            whereClause = {
                chatId: chatDbId
            };
        }
        else {
            return res.status(400).json({ error: "Неизвестный формат чата" });
        }

        // 3. НАСТРОЙКА КУРСОРНОЙ ПАГИНАЦИИ PRISMA
// В messageController.js, в queryOptions
let queryOptions = {
  where: whereClause,
  orderBy: { createdAt: 'desc' },
  take: limit,
  include: {
    sender: {
      select: { id: true, username: true }
    },
    threads: {
      include: {
        user: {
          select: { id: true, username: true, avatar: true }
        }
      },
      orderBy: { createdAt: 'asc' }
    },
    reactions: {  // ← ДОБАВЛЯЕМ РЕАКЦИИ
      include: {
        user: {
          select: { id: true, username: true }
        }
      }
    }
  }
};

        if (cursorMessageId) {
            const cursorId = Number(cursorMessageId);
            if (!isNaN(cursorId)) {
                queryOptions.cursor = { id: cursorId };
                queryOptions.skip = 1;
            }
        }

        // 4. ЗАПРОС К POSTGRESQL
        const messages = await prisma.message.findMany(queryOptions);

        // Переворачиваем массив обратно (от старых к свежим)
        const orderedMessages = messages.reverse();

        return res.json({
            messages: orderedMessages,
            hasMore: messages.length === limit
        });

    } catch (error) {
        console.error('Ошибка при получении сообщений с пагинацией:', error);
        return res.status(500).json({ error: 'Ошибка сервера при загрузке истории чата' });
    }
};

module.exports = {
    getMessages
};