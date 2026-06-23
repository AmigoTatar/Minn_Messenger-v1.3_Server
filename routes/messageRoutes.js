const express = require('express');
const router = express.Router();
const { getMessages } = require('../controllers/messageController');
// Если у вас есть мидлварь для проверки JWT, её стоит подключить сюда, например: const protect = require('../middleware/authMiddleware');

router.get('/', getMessages);

module.exports = router;