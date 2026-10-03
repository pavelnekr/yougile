/**
 * Создание или обновление учётной записи портала.
 *
 * Запуск:
 *   node --experimental-strip-types apps/api/scripts/create-user.ts <login> <password> [displayName] [role]
 *
 * Либо с интерактивным вводом, если запустить без аргументов.
 * Роль: ADMIN (полный доступ) или OPERATOR. VIEWER пока не используется.
 */
import { PrismaClient, PortalRole } from "@prisma/client";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { hashPassword } from "../src/modules/auth/service.js";

const prisma = new PrismaClient();

function parseRole(value: string | undefined): PortalRole {
  const normalized = (value ?? "ADMIN").trim().toUpperCase();
  if (normalized === "ADMIN") return PortalRole.ADMIN;
  if (normalized === "OPERATOR") return PortalRole.OPERATOR;
  if (normalized === "VIEWER") return PortalRole.VIEWER;
  throw new Error(`Неизвестная роль: ${value}. Допустимо: ADMIN, OPERATOR, VIEWER.`);
}

async function ask(question: string, fallback?: string) {
  const rl = createInterface({ input, output });
  try {
    const suffix = fallback ? ` [${fallback}]` : "";
    const answer = (await rl.question(`${question}${suffix}: `)).trim();
    return answer || fallback || "";
  } finally {
    rl.close();
  }
}

async function readPassword(question: string) {
  const rl = createInterface({ input, output });
  try {
    // echo:false не поддерживается readline/promises, поэтому вводим открыто,
    // но значение не печатаем в вывод скрипта.
    const answer = await rl.question(`${question}: `);
    return answer.trim();
  } finally {
    rl.close();
  }
}

async function main() {
  const [loginArgument, passwordArgument, nameArgument, roleArgument] = process.argv.slice(2);

  const login = loginArgument ?? (await ask("Логин"));
  if (!login) throw new Error("Логин не может быть пустым.");

  const password = passwordArgument ?? (await readPassword("Пароль (минимум 8 символов)"));
  if (password.length < 8) {
    throw new Error("Пароль должен быть не короче 8 символов.");
  }

  const displayName = nameArgument ?? (await ask("Отображаемое имя", login));
  const role = parseRole(roleArgument ?? (await ask("Роль (ADMIN/OPERATOR)", "ADMIN")));

  const passwordHash = await hashPassword(password);
  const existing = await prisma.portalUser.findUnique({ where: { login } });

  const user = existing
    ? await prisma.portalUser.update({
        where: { login },
        data: { passwordHash, displayName, role, active: true }
      })
    : await prisma.portalUser.create({
        data: { login, passwordHash, displayName, role }
      });

  // Старые сессии сбрасываем: пароль изменился — продолжать нельзя.
  await prisma.portalSession.deleteMany({ where: { userId: user.id } });

  console.log(
    `${existing ? "Обновлён" : "Создан"} пользователь ${user.login} ` +
    `(${user.displayName}), роль ${user.role}. Старые сессии завершены.`
  );
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
