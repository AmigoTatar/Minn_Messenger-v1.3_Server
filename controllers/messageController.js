const getMessages = async(req, res) => {
    try {
        // Безопасно достаем инстанс Prisma, который мы положили в server.js
        const prisma = req.app.get('prisma');

        if (!prisma) {
            console.error("Критическая ошибка: Инстанс Prisma не найден в app.set");
            return res.status(500).json({ error: "Ошибка конфигурации сервера базы данных" });
        }

        const messages = await prisma.message.findMany({
            orderBy: {
                createdAt: 'asc' // Старые сверху, новые снизу
            },
            include: {
                sender: {
                    select: {
                        id: true,
                        username: true
                    }
                }
            }
        });

        res.json(messages);
    } catch (error) {
        console.error('Ошибка при получении сообщений:', error);
        res.status(500).json({ error: 'Ошибка сервера при загрузке чата' });
    }
};

module.exports = {
    getMessages
};