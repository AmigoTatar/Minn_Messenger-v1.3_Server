// middleware/validation.js

// Валидация регистрации
function validateRegister(req, res, next) {
    const { username, email, password } = req.body;

    const errors = [];

    if (!username || username.length < 3) {
        errors.push('Имя пользователя должно содержать минимум 3 символа');
    }

    if (!email || !email.includes('@') || !email.includes('.')) {
        errors.push('Введите корректный email');
    }

    if (!password || password.length < 8) {
        errors.push('Пароль должен содержать минимум 8 символов');
    }

    if (errors.length > 0) {
        return res.status(400).json({ errors: errors });
    }

    next();
}

// Валидация сообщения
function validateMessage(req, res, next) {
    const { text, mediaUrl } = req.body;

    if (!text && !mediaUrl) {
        return res.status(400).json({ error: 'Сообщение должно содержать текст или медиа' });
    }

    if (text && text.length > 10000) {
        return res.status(400).json({ error: 'Сообщение слишком длинное (максимум 10000 символов)' });
    }

    next();
}

// Валидация поиска
function validateSearch(req, res, next) {
    const { query } = req.query;

    if (!query || query.length < 2) {
        return res.status(400).json({ error: 'Поисковый запрос должен содержать минимум 2 символа' });
    }

    if (query.length > 100) {
        return res.status(400).json({ error: 'Поисковый запрос слишком длинный' });
    }

    next();
}

module.exports = {
    validateRegister,
    validateMessage,
    validateSearch
};