// Чистый экспорт объекта без внешних импортов, чтобы удовлетворить npx prisma
require('dotenv').config();
module.exports = {
    schema: "prisma/schema.prisma",
    datasource: {
        url: process.env.DATABASE_URL || "", // Используем стандартный встроенный объект Node.js
    },
};