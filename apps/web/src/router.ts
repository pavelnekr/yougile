import { useCallback, useEffect, useState } from "react";

/**
 * Разделы портала и их адреса.
 *
 * Слаги латинскими буквами: кириллица в URL кодируется процентами и выглядит
 * неаккуратно в закладках, письмах и логах. Слаг — часть контракта: переименование
 * ломает сохранённые ссылки, поэтому менять его нужно вместе с редиректом со старого.
 *
 * Обзор — это корень `/`, а не `/overview`: он открывается по умолчанию и должен
 * выглядеть как главная страница портала.
 */
export type Section =
  | "Обзор"
  | "Площадки"
  | "Назначить инженера"
  | "Снять инженеров"
  | "Написать комментарий"
  | "Проверить работы"
  | "Аудит"
  | "История"
  | "Настройки"
  | "Учётные записи"
  | "Логирование";

export const sectionSlugs: Record<Section, string> = {
  "Обзор": "",
  "Площадки": "sites",
  "Назначить инженера": "assign",
  "Снять инженеров": "remove",
  "Написать комментарий": "comment",
  "Проверить работы": "work-check",
  "Аудит": "audit",
  "История": "history",
  "Настройки": "settings",
  "Учётные записи": "admin/users",
  "Логирование": "admin/logs"
};

const slugToSection = new Map<string, Section>(
  Object.entries(sectionSlugs).map(([section, slug]) => [slug, section as Section])
);

export function pathFromSection(section: Section): string {
  const slug = sectionSlugs[section];
  return slug ? `/${slug}` : "/";
}

/** Раздел по pathname или null, если такого адреса нет. */
export function sectionFromPath(pathname: string): Section | null {
  const slug = pathname.replace(/^\/+/, "").replace(/\/+$/, "");
  return slugToSection.get(slug) ?? null;
}

export type Navigate = (section: Section, options?: { replace?: boolean }) => void;

/**
 * Раздел портала живёт в URL, а не в состоянии компонента.
 *
 * Почему так: ссылку на раздел можно отправить коллеге, сохранить в закладки и
 * открыть после перезагрузки страницы или в новой вкладке. Кнопки меню вызывают
 * navigate(), а не меняют состояние, поэтому «назад» в браузере работает.
 *
 * Неизвестный адрес не считается ошибкой: возвращается `null`, и раздел
 * нормализуется вызывающим кодом (см. `syncSectionUrl`).
 */
export function useSectionUrl(): [Section, Navigate] {
  const [section, setSection] = useState<Section>(
    () => sectionFromPath(window.location.pathname) ?? "Обзор"
  );

  useEffect(() => {
    const onPopState = () => {
      setSection(sectionFromPath(window.location.pathname) ?? "Обзор");
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = useCallback<Navigate>((next, options) => {
    const path = pathFromSection(next);
    if (window.location.pathname !== path) {
      const method = options?.replace ? "replaceState" : "pushState";
      window.history[method](null, "", path);
    }
    setSection(next);
  }, []);

  return [section, navigate];
}

/**
 * Приводит адресную строку в соответствие с разделом, который реально открыт.
 *
 * Нужен для трёх случаев: неизвестный путь, раздел без прав (например, админ-раздел
 * после смены роли) и лишний слеш. `replaceState`, а не `pushState`: это не новая
 * страница в истории, а исправление адреса, поэтому «назад» не должен в неё попадать.
 */
export function syncSectionUrl(section: Section): void {
  const path = pathFromSection(section);
  if (window.location.pathname !== path) {
    window.history.replaceState(null, "", path);
  }
}