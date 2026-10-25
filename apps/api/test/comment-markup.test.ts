import assert from "node:assert/strict";
import test from "node:test";
import { renderCommentForYougile } from "../src/lib/comment-markup.js";

test("обычный комментарий передаётся без HTML", () => {
  assert.deepEqual(renderCommentForYougile("План работ готов"), { text: "План работ готов" });
});

test("жирная разметка сохраняет чистый текст и экранирует HTML", () => {
  assert.deepEqual(renderCommentForYougile("**Важно**: <проверить> & подтвердить"), {
    text: "Важно: <проверить> & подтвердить",
    textHtml: "<p><b>Важно</b>: &lt;проверить&gt; &amp; подтвердить</p>"
  });
});

test("незакрытая разметка остаётся без изменений", () => {
  assert.deepEqual(renderCommentForYougile("Текст **без конца"), { text: "Текст **без конца" });
});
