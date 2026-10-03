"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sessionDurations = exports.sessionCookieName = void 0;
exports.hashPassword = hashPassword;
exports.verifyPassword = verifyPassword;
exports.createSession = createSession;
exports.resolveSession = resolveSession;
exports.destroySession = destroySession;
exports.setSessionCookie = setSessionCookie;
exports.clearSessionCookie = clearSessionCookie;
exports.requireSession = requireSession;
// Хеширование паролей и управление сессиями на встроенном node:crypto.
// Зависимости не добавляются намеренно: node_modules в контейнере перекрыт volume,
// поэтому новая библиотека потребовала бы пересборки образа.
var node_crypto_1 = require("node:crypto");
var node_util_1 = require("node:util");
var scryptAsync = (0, node_util_1.promisify)(node_crypto_1.scrypt);
var keyLength = 64;
var saltBytes = 16;
// scrypt дорогой: память ~16 МБ на попытку. Лимит нужен, чтобы злоумышленник
// не мог отправлять подбор пароля параллельно и исчерпать память процесса.
var concurrentHashes = new Set();
exports.sessionCookieName = "portal_session";
exports.sessionDurations = {
    short: 12 * 60 * 60 * 1000,
    long: 30 * 24 * 60 * 60 * 1000
};
function hashPassword(password) {
    var salt = (0, node_crypto_1.randomBytes)(saltBytes);
    var promise = scryptAsync(password.normalize("NFKC"), salt, keyLength);
    concurrentHashes.add(promise);
    return promise
        .then(function (derived) { return "scrypt$".concat(salt.toString("base64"), "$").concat(derived.toString("base64")); })
        .finally(function () {
        concurrentHashes.delete(promise);
    });
}
function verifyPassword(password, storedHash) {
    return __awaiter(this, void 0, void 0, function () {
        var _a, algorithm, saltPart, hashPart, salt, expected, derived;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    _a = storedHash.split("$"), algorithm = _a[0], saltPart = _a[1], hashPart = _a[2];
                    if (algorithm !== "scrypt" || !saltPart || !hashPart)
                        return [2 /*return*/, false];
                    salt = Buffer.from(saltPart, "base64");
                    expected = Buffer.from(hashPart, "base64");
                    if (expected.length !== keyLength)
                        return [2 /*return*/, false];
                    return [4 /*yield*/, scryptAsync(password.normalize("NFKC"), salt, keyLength)];
                case 1:
                    derived = _b.sent();
                    // Длины равны по проверке выше, поэтому timingSafeEqual не бросит исключение.
                    return [2 /*return*/, (0, node_crypto_1.timingSafeEqual)(derived, expected)];
            }
        });
    });
}
function hashToken(token) {
    return (0, node_crypto_1.createHash)("sha256").update(token).digest("hex");
}
function createSession(prisma, userId, duration, userAgent) {
    return __awaiter(this, void 0, void 0, function () {
        var token, expiresAt;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    token = (0, node_crypto_1.randomBytes)(32).toString("base64url");
                    expiresAt = new Date(Date.now() + exports.sessionDurations[duration]);
                    return [4 /*yield*/, prisma.portalSession.create({
                            data: {
                                tokenHash: hashToken(token),
                                userId: userId,
                                expiresAt: expiresAt,
                                userAgent: (_a = userAgent === null || userAgent === void 0 ? void 0 : userAgent.slice(0, 255)) !== null && _a !== void 0 ? _a : null
                            }
                        })];
                case 1:
                    _b.sent();
                    return [2 /*return*/, { token: token, expiresAt: expiresAt }];
            }
        });
    });
}
/**
 * Читает сессию из cookie, проверяет срок и активность пользователя.
 * Возвращает null, если сессии нет или она недействительна.
 */
function resolveSession(prisma, request) {
    return __awaiter(this, void 0, void 0, function () {
        var token, session;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    token = request.cookies[exports.sessionCookieName];
                    if (!token || typeof token !== "string" || token.length < 20)
                        return [2 /*return*/, null];
                    return [4 /*yield*/, prisma.portalSession.findUnique({
                            where: { tokenHash: hashToken(token) },
                            include: { user: true }
                        })];
                case 1:
                    session = _a.sent();
                    if (!session)
                        return [2 /*return*/, null];
                    if (!(session.expiresAt.getTime() <= Date.now())) return [3 /*break*/, 3];
                    return [4 /*yield*/, prisma.portalSession.delete({ where: { id: session.id } }).catch(function () { return undefined; })];
                case 2:
                    _a.sent();
                    return [2 /*return*/, null];
                case 3:
                    if (!!session.user.active) return [3 /*break*/, 5];
                    return [4 /*yield*/, prisma.portalSession.delete({ where: { id: session.id } }).catch(function () { return undefined; })];
                case 4:
                    _a.sent();
                    return [2 /*return*/, null];
                case 5:
                    if (!(Date.now() - session.lastSeenAt.getTime() > 60000)) return [3 /*break*/, 7];
                    return [4 /*yield*/, prisma.portalSession
                            .update({ where: { id: session.id }, data: { lastSeenAt: new Date() } })
                            .catch(function () { return undefined; })];
                case 6:
                    _a.sent();
                    _a.label = 7;
                case 7: return [2 /*return*/, session];
            }
        });
    });
}
function destroySession(prisma, request) {
    return __awaiter(this, void 0, void 0, function () {
        var token;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    token = request.cookies[exports.sessionCookieName];
                    if (!(token && typeof token === "string")) return [3 /*break*/, 2];
                    return [4 /*yield*/, prisma.portalSession
                            .deleteMany({ where: { tokenHash: hashToken(token) } })
                            .catch(function () { return undefined; })];
                case 1:
                    _a.sent();
                    _a.label = 2;
                case 2: return [2 /*return*/];
            }
        });
    });
}
function setSessionCookie(reply, token, expiresAt, secure) {
    reply.setCookie(exports.sessionCookieName, token, {
        path: "/",
        httpOnly: true,
        sameSite: "lax",
        secure: secure,
        expires: expiresAt
    });
}
function clearSessionCookie(reply, secure) {
    reply.clearCookie(exports.sessionCookieName, {
        path: "/",
        httpOnly: true,
        sameSite: "lax",
        secure: secure
    });
}
/**
 * Проверка активной сессии. Используется как preHandler для защищённых маршрутов.
 */
function requireSession(prisma) {
    var _this = this;
    return function (request, reply) { return __awaiter(_this, void 0, void 0, function () {
        var session;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, resolveSession(prisma, request)];
                case 1:
                    session = _a.sent();
                    if (!session) {
                        return [2 /*return*/, reply.code(401).send({ error: "Требуется вход в портал." })];
                    }
                    request.sessionUser = session.user;
                    return [2 /*return*/];
            }
        });
    }); };
}
