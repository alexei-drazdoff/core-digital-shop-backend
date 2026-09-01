# Ядро магазина цифровых товаров

Бэкенд площадки цифровых товаров: каталог, заказы, приём оплаты по вебхуку,
автоматическая выдача ключей через поставщиков, сверка и восстановление.

Решение построено вокруг трёх вещей, которые задание называет главными:
однократная выдача, корректная обработка таймаута и восстановление после сбоя.

Стек: Node.js 22, TypeScript, Fastify, PostgreSQL 16, без ORM и без внешнего
брокера очередей.

## Быстрый старт

### Через docker compose

```bash
cp .env.example .env
docker compose up --build
```

Поднимутся Postgres, API на порту 3000, воркер и две заглушки поставщиков на
портах 4001 и 4002. Миграции и сидирование выполняются автоматически.

### Без docker

Нужен установленный PostgreSQL 16. Скрипт `scripts/pg-dev.sh` поднимает локальный
кластер в каталоге проекта, отдельно от системного.

```bash
npm ci
scripts/pg-dev.sh start
export DATABASE_URL=postgres://postgres@127.0.0.1:55432/digital_shop
npm run migrate
npm run seed
npm run dev
```

`npm run dev` запускает все четыре процесса в одном терминале.

## Проверка

```bash
npm run typecheck
npm run lint
npm test
```

Тестам нужен доступный Postgres и переменная `DATABASE_URL` либо
`TEST_DATABASE_URL`. Каждый тестовый файл создаёт себе отдельную базу, поэтому
файлы гоняются параллельно и не мешают друг другу.

Отдельно:

```bash
npm run test:unit         # чистая логика, база не нужна
npm run test:adversarial  # шесть критериев приёмки плюс хаос-прогон
```

## Как воспроизвести проверку гонок

Создаём заказ, затем стреляем по нему пятьюдесятью одновременными вебхуками.

```bash
ORDER=$(curl -s -X POST http://127.0.0.1:3000/orders \
  -H 'content-type: application/json' -d '{"sku":"KEY-GTA5"}' | jq -r .order_id)

# 50 параллельных вебхуков с РАЗНЫМИ event_id (критерий 1)
npm run simulate -- race --order "$ORDER" --amount 1990 --concurrency 50

curl -s "http://127.0.0.1:3000/orders/$ORDER" | jq
```

Ожидаемо: один вебхук отвечает `applied`, остальные сорок девять `ignored`,
заказ в статусе `delivered`, код ровно один.

```bash
# 50 повторов ОДНОГО event_id (критерий 2)
npm run simulate -- replay --order "$ORDER" --amount 1990 --concurrency 50
```

Ожидаемо: один `applied`, сорок девять `duplicate`, состояние заказа не меняется.

Проверить в базе, что выдача ровно одна:

```sql
SELECT count(*) FROM deliveries WHERE order_id = '<ORDER>';   -- 1
SELECT count(*) FROM payment_events WHERE order_id = '<ORDER>'; -- 50 или 1
```

### Вебхук раньше заказа (критерий 3)

```bash
npm run simulate -- early --amount 890
# скрипт печатает order_id, который он использовал
curl -s -X POST http://127.0.0.1:3000/orders -H 'content-type: application/json' \
  -d '{"sku":"GIFT-ROBLOX-800","order_id":"<напечатанный order_id>"}'
```

Вебхук по несуществующему заказу получает `200` и паркуется. При создании заказа
с тем же id он применяется, и заказ доходит до `delivered`.

## Как воспроизвести отказ и фолбэк поставщика

Заглушки принимают настройку хаоса на лету.

### Ловушка таймаута (критерий 4)

Поставщик A выдаёт код и не отдаёт ответ. Это ровно тот случай, ради которого всё
и строилось: таймаут не равен отказу.

```bash
curl -s -X POST http://127.0.0.1:4001/admin/chaos -H 'content-type: application/json' \
  -d '{"forced_outcome":"timeout","hang_ms":3000,"issue_before_hang":true}'

ORDER=$(curl -s -X POST http://127.0.0.1:3000/orders \
  -H 'content-type: application/json' -d '{"sku":"KEY-EFT"}' | jq -r .order_id)
npm run simulate -- pay --order "$ORDER" --amount 3490

sleep 8
curl -s "http://127.0.0.1:3000/orders/$ORDER" | jq
curl -s "http://127.0.0.1:4001/admin/issuances?order_id=$ORDER" | jq
```

Ожидаемо: первая попытка в журнале помечена как `timeout`, вторая идёт с тем же
`request_id` и получает тот же самый код, у поставщика ровно одна выдача, у нас
ровно одна строка в `deliveries`.

### Фолбэк на резервного поставщика (критерий 5)

```bash
curl -s -X POST http://127.0.0.1:4001/admin/chaos -H 'content-type: application/json' \
  -d '{"forced_outcome":"error"}'
ORDER=$(curl -s -X POST http://127.0.0.1:3000/orders \
  -H 'content-type: application/json' -d '{"sku":"KEY-CS2-PRIME"}' | jq -r .order_id)
npm run simulate -- pay --order "$ORDER" --amount 1290
sleep 4
curl -s "http://127.0.0.1:3000/orders/$ORDER" | jq '.delivery.supplier'   # supplier_b
```

Вернуть поставщика в норму: `-d '{"forced_outcome":null}'`.

### Пустой остаток и восстановление (критерий 6)

SKU `SUB-SPOTIFY-1M` намеренно засеян без ключей у обоих поставщиков, поэтому
сценарий воспроизводится сразу после `npm run seed`.

```bash
ORDER=$(curl -s -X POST http://127.0.0.1:3000/orders \
  -H 'content-type: application/json' -d '{"sku":"SUB-SPOTIFY-1M"}' | jq -r .order_id)
npm run simulate -- pay --order "$ORDER" --amount 299
sleep 3
curl -s "http://127.0.0.1:3000/orders/$ORDER" | jq -r .status   # out_of_stock

curl -s -X POST http://127.0.0.1:3000/admin/inventory/replenish \
  -H 'authorization: Bearer dev-admin-token' -H 'content-type: application/json' \
  -d '{"sku":"SUB-SPOTIFY-1M","count":5}'
sleep 5
curl -s "http://127.0.0.1:3000/orders/$ORDER" | jq -r .status   # delivered
```

## API

Публичные методы.

| Метод | Путь | Что делает |
|---|---|---|
| GET | `/health`, `/ready` | проверки живости и готовности |
| GET | `/metrics` | метрики в формате Prometheus |
| GET | `/catalog/products` | витрина, фильтр `type`, keyset-пагинация через `cursor` |
| GET | `/catalog/products/:sku` | карточка товара |
| POST | `/orders` | создание заказа, поддерживает заголовок `Idempotency-Key` |
| GET | `/orders/:id` | заказ, выданный код и журнал обращений к поставщикам |
| POST | `/webhooks/payment` | вебхук оплаты по контракту из задания |

Воркер слушает отдельно, по умолчанию на порту 3001, и отдаёт там `/health` и
`/metrics`. Реестр метрик у каждого процесса свой, а счётчики выдач, повторов и
осиротевших кодов инкрементируются именно в воркере, поэтому без собственного
слушателя их было бы некуда собирать.

Административные методы, авторизация `Authorization: Bearer $ADMIN_TOKEN`.

| Метод | Путь | Что делает |
|---|---|---|
| GET | `/admin/reconciliation` | отчёт сверки, `200` если расхождений нет, `409` если есть |
| GET | `/admin/ledger/balance` | остатки по счетам и проверка баланса |
| POST | `/admin/orders/:id/redeliver` | повторная постановка заказа на выдачу |
| POST | `/admin/recover` | ручной запуск подчистки зависших заказов |
| POST | `/admin/inventory/replenish` | пополнение пула у поставщика |
| POST | `/admin/sync-stock` | синхронизация остатков витрины |

### Создание заказа

```http
POST /orders
Idempotency-Key: 6f1c0a7e-...

{ "sku": "KEY-GTA5", "customer_ref": "user-42", "order_id": "ord_..." }
```

Поле `order_id` необязательное. Оно есть затем, чтобы платёжной стороне можно было
сообщить идентификатор до того, как строка заказа появится у нас, и именно это
делает сценарий с ранним вебхуком воспроизводимым.

При повторе с тем же `Idempotency-Key` возвращается исходный заказ и код `200`
вместо `201`, поэтому клиент отличает повтор от нового создания.

## Заглушки

Обе заглушки реализуют контракт `POST /issue` и хранят выдачи по `request_id`,
поэтому повтор с тем же идентификатором возвращает тот же код.

Сверх контракта у них есть служебные методы, они помечены как расширение:
`GET /stock` для синхронизации остатков, `GET /admin/issuances?order_id=` для
проверок, `POST /admin/replenish` для пополнения и `POST /admin/chaos` для
настройки отказов.

Параметры хаоса: `error_rate`, `timeout_rate`, `latency_ms`, `hang_ms`,
`issue_before_hang`, `hang_before_lookup` и `forced_outcome` для детерминированных
сценариев. `issue_before_hang` означает, что код будет выдан, а ответ не дойдёт,
то есть ровно ту самую ловушку. `hang_before_lookup` дополнительно моделирует
поставщика, который стал совсем недоступен уже после выдачи.

## Каталог под нагрузкой

```bash
npm run bench:catalog
```

Скрипт создаёт временную базу, засевает пять тысяч SKU и четверть миллиона ключей,
замеряет три варианта запроса витрины и пишет планы выполнения в
[docs/EXPLAIN.md](docs/EXPLAIN.md).

## Документация

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) описывает слои, схему данных и
механику однократной выдачи.

[docs/DECISIONS.md](docs/DECISIONS.md) содержит записку о ключевых решениях.

[docs/SCALING.md](docs/SCALING.md) отвечает на вопрос про масштабирование.

[docs/EXPLAIN.md](docs/EXPLAIN.md) разбирает план запроса витрины.

## Затраченное время

TODO: заполнить перед отправкой. Задание просит указать, сколько времени ушло по факту.

## Конфигурация

Все параметры читаются из окружения и проверяются схемой при старте, процесс с
некорректной конфигурацией падает сразу. Полный список с значениями по умолчанию
лежит в `.env.example`.
