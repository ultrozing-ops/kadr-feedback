# Обратная связь КАДР

[Открытая тема для вопросов, предложений и сообщений об ошибках](https://github.com/ultrozing-ops/kadr-feedback/issues/1).

Укажите версию приложения и шаги, после которых возникает проблема. Сообщения и вложения в этой теме доступны всем.

## Подключение КАДРа

`worker.mjs` и `wrangler.toml` предназначены для Cloudflare Workers. КАДР использует адрес опубликованного Worker из `feedback-source.json`. Пример находится в `feedback-source.example.json`.

Для Worker требуются секреты `GITHUB_TOKEN`, `KADR_AUTHOR_CODE` и `KADR_MEMBER_CODES`. Для токена достаточно прав записи в Issues и Contents этого репозитория. Коды коллег хранятся в секрете как список через пробел.
