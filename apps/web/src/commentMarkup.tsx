import { Fragment, type ReactNode } from "react";

/**
 * Показ текста комментария с разметкой шаблонов: `**слово**` → <strong>.
 *
 * Пары звёздочек режутся на части и рендерятся текстовыми узлами — HTML в
 * шаблон попасть не может, теги пользователя отобразятся буквально, как и в
 * поле ввода. Отправляется разметка на сервере (lib/comment-markup.ts),
 * здесь только предпросмотр.
 */
export function renderCommentMarkup(text: string): ReactNode {
  return text.split(/\*\*([\s\S]+?)\*\*/g).map((part, index) => (
    index % 2 === 1
      ? <strong key={index}>{part}</strong>
      : <Fragment key={index}>{part}</Fragment>
  ));
}
