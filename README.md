# Обратная связь КАДР

[Открытая тема для вопросов, предложений и сообщений об ошибках](https://github.com/ultrozing-ops/kadr-feedback/issues/1).

Укажите версию приложения и шаги, после которых возникает проблема. Сообщения и вложения в этой теме доступны всем.

## Подключение КАДРа

Рабочий адрес — `https://kadr-feedback.pages.dev/`. Поместите `feedback-source.json` в папку `Программа`; пример находится в `feedback-source.example.json`. Для отправки из КАДРа нужен код приглашения. Коды выдаёт владелец проекта.

`worker.mjs` можно развернуть через Cloudflare Pages Direct Upload: положите его в ZIP под именем `_worker.js` и загрузите в Production. Переменные Production: `GITHUB_REPO`, `GITHUB_ISSUE`, `GITHUB_AUTHOR_ID`. Секреты: `GITHUB_TOKEN`, `KADR_AUTHOR_CODE`, `KADR_MEMBER_CODES`. Для токена используются права записи в Issues и Contents только этого репозитория. Коды коллег хранятся в секрете как список через пробел. После изменения переменных требуется новое развёртывание.
