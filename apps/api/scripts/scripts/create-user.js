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
/**
 * Создание или обновление учётной записи портала.
 *
 * Запуск:
 *   node --experimental-strip-types apps/api/scripts/create-user.ts <login> <password> [displayName] [role]
 *
 * Либо с интерактивным вводом, если запустить без аргументов.
 * Роль: ADMIN (полный доступ) или OPERATOR. VIEWER пока не используется.
 */
var client_1 = require("@prisma/client");
var promises_1 = require("node:readline/promises");
var node_process_1 = require("node:process");
var service_js_1 = require("../src/modules/auth/service.js");
var prisma = new client_1.PrismaClient();
function parseRole(value) {
    var normalized = (value !== null && value !== void 0 ? value : "ADMIN").trim().toUpperCase();
    if (normalized === "ADMIN")
        return client_1.PortalRole.ADMIN;
    if (normalized === "OPERATOR")
        return client_1.PortalRole.OPERATOR;
    if (normalized === "VIEWER")
        return client_1.PortalRole.VIEWER;
    throw new Error("\u041D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u0430\u044F \u0440\u043E\u043B\u044C: ".concat(value, ". \u0414\u043E\u043F\u0443\u0441\u0442\u0438\u043C\u043E: ADMIN, OPERATOR, VIEWER."));
}
function ask(question, fallback) {
    return __awaiter(this, void 0, void 0, function () {
        var rl, suffix, answer;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    rl = (0, promises_1.createInterface)({ input: node_process_1.stdin, output: node_process_1.stdout });
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, , 3, 4]);
                    suffix = fallback ? " [".concat(fallback, "]") : "";
                    return [4 /*yield*/, rl.question("".concat(question).concat(suffix, ": "))];
                case 2:
                    answer = (_a.sent()).trim();
                    return [2 /*return*/, answer || fallback || ""];
                case 3:
                    rl.close();
                    return [7 /*endfinally*/];
                case 4: return [2 /*return*/];
            }
        });
    });
}
function readPassword(question) {
    return __awaiter(this, void 0, void 0, function () {
        var rl, answer;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    rl = (0, promises_1.createInterface)({ input: node_process_1.stdin, output: node_process_1.stdout });
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, , 3, 4]);
                    return [4 /*yield*/, rl.question("".concat(question, ": "))];
                case 2:
                    answer = _a.sent();
                    return [2 /*return*/, answer.trim()];
                case 3:
                    rl.close();
                    return [7 /*endfinally*/];
                case 4: return [2 /*return*/];
            }
        });
    });
}
function main() {
    return __awaiter(this, void 0, void 0, function () {
        var _a, loginArgument, passwordArgument, nameArgument, roleArgument, login, _b, password, _c, displayName, _d, role, _e, _f, passwordHash, existing, user, _g;
        return __generator(this, function (_h) {
            switch (_h.label) {
                case 0:
                    _a = process.argv.slice(2), loginArgument = _a[0], passwordArgument = _a[1], nameArgument = _a[2], roleArgument = _a[3];
                    if (!(loginArgument !== null && loginArgument !== void 0)) return [3 /*break*/, 1];
                    _b = loginArgument;
                    return [3 /*break*/, 3];
                case 1: return [4 /*yield*/, ask("Логин")];
                case 2:
                    _b = (_h.sent());
                    _h.label = 3;
                case 3:
                    login = _b;
                    if (!login)
                        throw new Error("Логин не может быть пустым.");
                    if (!(passwordArgument !== null && passwordArgument !== void 0)) return [3 /*break*/, 4];
                    _c = passwordArgument;
                    return [3 /*break*/, 6];
                case 4: return [4 /*yield*/, readPassword("Пароль (минимум 8 символов)")];
                case 5:
                    _c = (_h.sent());
                    _h.label = 6;
                case 6:
                    password = _c;
                    if (password.length < 8) {
                        throw new Error("Пароль должен быть не короче 8 символов.");
                    }
                    if (!(nameArgument !== null && nameArgument !== void 0)) return [3 /*break*/, 7];
                    _d = nameArgument;
                    return [3 /*break*/, 9];
                case 7: return [4 /*yield*/, ask("Отображаемое имя", login)];
                case 8:
                    _d = (_h.sent());
                    _h.label = 9;
                case 9:
                    displayName = _d;
                    _e = parseRole;
                    if (!(roleArgument !== null && roleArgument !== void 0)) return [3 /*break*/, 10];
                    _f = roleArgument;
                    return [3 /*break*/, 12];
                case 10: return [4 /*yield*/, ask("Роль (ADMIN/OPERATOR)", "ADMIN")];
                case 11:
                    _f = (_h.sent());
                    _h.label = 12;
                case 12:
                    role = _e.apply(void 0, [_f]);
                    return [4 /*yield*/, (0, service_js_1.hashPassword)(password)];
                case 13:
                    passwordHash = _h.sent();
                    return [4 /*yield*/, prisma.portalUser.findUnique({ where: { login: login } })];
                case 14:
                    existing = _h.sent();
                    if (!existing) return [3 /*break*/, 16];
                    return [4 /*yield*/, prisma.portalUser.update({
                            where: { login: login },
                            data: { passwordHash: passwordHash, displayName: displayName, role: role, active: true }
                        })];
                case 15:
                    _g = _h.sent();
                    return [3 /*break*/, 18];
                case 16: return [4 /*yield*/, prisma.portalUser.create({
                        data: { login: login, passwordHash: passwordHash, displayName: displayName, role: role }
                    })];
                case 17:
                    _g = _h.sent();
                    _h.label = 18;
                case 18:
                    user = _g;
                    // Старые сессии сбрасываем: пароль изменился — продолжать нельзя.
                    return [4 /*yield*/, prisma.portalSession.deleteMany({ where: { userId: user.id } })];
                case 19:
                    // Старые сессии сбрасываем: пароль изменился — продолжать нельзя.
                    _h.sent();
                    console.log("".concat(existing ? "Обновлён" : "Создан", " \u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u0435\u043B\u044C ").concat(user.login, " ") +
                        "(".concat(user.displayName, "), \u0440\u043E\u043B\u044C ").concat(user.role, ". \u0421\u0442\u0430\u0440\u044B\u0435 \u0441\u0435\u0441\u0441\u0438\u0438 \u0437\u0430\u0432\u0435\u0440\u0448\u0435\u043D\u044B."));
                    return [2 /*return*/];
            }
        });
    });
}
main()
    .catch(function (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
})
    .finally(function () {
    void prisma.$disconnect();
});
