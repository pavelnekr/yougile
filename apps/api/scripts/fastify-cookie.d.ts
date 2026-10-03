// Подключает типы @fastify/cookie.
//
// Плагин объявляет request.cookies, reply.setCookie и reply.clearCookie
// через augmentations модуля fastify. Они действуют только если модуль
// @fastify/cookie попал в программу компиляции. Основная сборка
// (tsconfig.json) импортирует его в src/server.ts, а сборка скриптов
// (tsconfig.scripts.json) — нет, и tsc ругается на отсутствующие свойства.
import "@fastify/cookie";