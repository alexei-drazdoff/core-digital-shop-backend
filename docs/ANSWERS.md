# Ответы на вопросы по второму этапу

Все команды ниже прогонялись на живом стенде; вывод в примерах настоящий, а не
придуманный. Перед началом:

```bash
docker compose up -d postgres
export DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/digital_shop
npm ci && npm run migrate && npm run seed

# api + воркер + обе заглушки поставщиков в одном терминале
STUCK_ORDER_AFTER_MS=1000 RECOVERY_SCAN_INTERVAL_MS=2000 npm run dev
```

`STUCK_ORDER_AFTER_MS` и `RECOVERY_SCAN_INTERVAL_MS` уменьшены только для того,
чтобы не ждать: свёртка восстановления по умолчанию считает заказ застрявшим
через 30 секунд, и в демонстрации это лишняя минута ожидания.

Дальше везде `ADMIN='authorization: Bearer dev-admin-token'`.

Если поднимать стенд руками не хочется, ровно те же сценарии проверяются одной
командой — `npm test`. Ниже у каждого сценария указан соответствующий тест.

---

## 1. Как воспроизвести частичный сбой заказа и поведение при недобросовестном поставщике

### 1.1. Частичный сбой: часть товаров выдана, за остальное возвращены деньги

`SUB-SPOTIFY-1M` намеренно засеян с нулевым остатком у обоих поставщиков, так что
непроходимая позиция получается на чистой установке, без правки данных.

```bash
curl -s -X POST localhost:3000/orders -H 'content-type: application/json' -d '{
  "items": [{"sku":"KEY-CS2-PRIME"}, {"sku":"STEAM-TOPUP-500"}, {"sku":"SUB-SPOTIFY-1M"}]
}'
# -> {"order_id":"ord_01M234...","amount":2089,"items":[...3 позиции...]}

npm run simulate -- pay --order ord_01M234... --amount 2089
# -> 200 {"received":true,"outcome":"applied"}

sleep 20   # выдача + бюджет попыток + возврат за невыданное
curl -s localhost:3000/orders/ord_01M234...
```

Фактический результат:

```
status: partially_delivered
  1 KEY-CS2-PRIME    delivered  code=LI39-4330-ISMB
  2 STEAM-TOPUP-500  delivered  code=LFXC-TNCS-BPCD
  3 SUB-SPOTIFY-1M   refunded   refund=299
money: {paid: 2089, delivered: 1790, refunded: 299, unresolved: 0}
```

Что здесь важно:

- `partially_delivered` — отдельный конечный статус. Назвать это `delivered`
  значило бы соврать про третью позицию, а `failed` — про первые две;
- выданные коды остались у покупателя, за невыданный вернулись деньги;
- `1790 + 299 = 2089`. Инвариант виден прямо в ответе, без админского доступа;
- возврат происходит не сразу: позиция получает бюджет из
  `ITEM_MAX_DELIVERY_ROUNDS` полных проходов по всем поставщикам (по умолчанию
  3). Пока бюджет не исчерпан, свёртка восстановления пробует снова — покупателю
  нужен товар, а не деньги. Бюджет конечен, потому что «за что не смогли, деньги
  возвращаются» верно только если попытки заканчиваются.

Тест: `tests/adversarial/09-partial-order-failure.test.ts`.

### 1.2. Аварийная остановка посреди выдачи

Заказ обязан дойти до конечного состояния после перезапуска, не купив второй код.
Воспроизводится убийством воркера в момент выдачи; в тесте то же состояние
создаётся честнее — задачи помечаются `running` и брошенными, ровно как их
оставляет умерший воркер:

```sql
UPDATE jobs SET state='running', locked_at = now() - interval '1 hour', locked_by='dead'
 WHERE state='pending' AND kind='deliver_order_item';
```

```bash
curl -s -X POST -H "$ADMIN" localhost:3000/admin/recover
```

Свёртка освобождает и брошенные задачи, и позиции, застрявшие в `delivering`
(второе обязательно: захват выдачи намеренно отказывается брать позицию, которую
якобы уже кто-то обрабатывает, и без освобождения такая позиция не забирается
никем и никогда).

Тест: `tests/adversarial/10-crash-mid-delivery.test.ts`.

### 1.3. Недобросовестный поставщик: дубль чужого кода

Заглушка поставщика A начинает отдавать код, уже выданный другому заказу. Она
делает это в обход собственной бухгалтерии — просто произносит неверное
предложение, ничего не потратив, — потому что именно так это и выглядит снаружи
у настоящего поставщика.

```bash
curl -s -X POST localhost:4001/admin/chaos -H 'content-type: application/json' \
     -d '{"forced_outcome":"duplicate_code"}'

# заказ на тот же SKU, что уже покупали
curl -s -X POST localhost:3000/orders -H 'content-type: application/json' -d '{"sku":"KEY-CS2-PRIME"}'
npm run simulate -- pay --order ord_... --amount 1290
sleep 8
curl -s localhost:3000/orders/ord_...
```

Фактический результат:

```
status: delivered | served by: supplier_b | code=YPLV-QK2Z-IUS5
supplier_requests: [(supplier_a, epoch 1, failed_definitive),
                    (supplier_a, epoch 2, failed_definitive),
                    (supplier_b, epoch 1, succeeded)]
```

- дублирующий код отбракован, покупатель получил другой, рабочий код;
- дубль по-прежнему числится за ПЕРВЫМ заказом — это и есть «один код не уйдёт
  двум покупателям», обеспеченное первичным ключом в `issued_codes`;
- у A выросла эпоха запроса: 1 → 2. Повтор того же `request_id` вечно возвращал
  бы ту же ложь, так что отбракованный ответ — единственный случай, который
  открывает новый запрос. На таймаут эпоха НЕ растёт, иначе ловушка таймаута из
  первого этапа начала бы покупать вторые коды;
- после двух попыток система ушла на честного поставщика B.

Не забыть выключить: `curl -s -X POST localhost:4001/admin/chaos -d '{"forced_outcome":null}' -H 'content-type: application/json'`.

### 1.4. Недобросовестный поставщик: чужой товар

```bash
curl -s -X POST localhost:4001/admin/chaos -H 'content-type: application/json' \
     -d '{"forced_outcome":"foreign_code"}'
curl -s -X POST localhost:3000/orders -H 'content-type: application/json' -d '{"sku":"KEY-EFT"}'
npm run simulate -- pay --order ord_... --amount 3490
sleep 8
curl -s -H "$ADMIN" localhost:3000/admin/quarantined-codes
```

Фактический результат:

```
status: delivered | served by: supplier_b
quarantined: 1
  supplier_a  sku_mismatch  FEL3-GUXN-TCCH
```

Код был для другого товара. Он помещён в карантин — не выдан никому и никогда,
включая того, кто этот товар действительно купит. Проводки при этом НЕ делается:
`shrinkage` означает потреблённый склад без продажи, а код, на который у нас
никогда не было прав, нашим складом не был; списывать его значило бы раздувать
недостачу тем, чего не происходило.

### 1.5. Недобросовестный поставщик: ошибка при фактически выданном коде

Это не ловушка таймаута. Таймаут говорит «ответа нет», и вызывающий уже умеет
считать такое неопределённостью. Явная 503 говорит «точно не вышло» — и именно
такой ответ провоцирует немедленный уход на резерв, когда ключ уже потрачен.

```bash
curl -s -X POST localhost:4001/admin/chaos -H 'content-type: application/json' \
     -d '{"forced_outcome":"error_after_issue"}'
curl -s -X POST localhost:3000/orders -H 'content-type: application/json' -d '{"sku":"GIFT-PSN-1000"}'
npm run simulate -- pay --order ord_... --amount 1000
sleep 8
curl -s -X POST localhost:4001/admin/chaos -H 'content-type: application/json' -d '{"forced_outcome":null}'
curl -s -X POST -H "$ADMIN" localhost:3000/admin/reconcile-suppliers
```

Поставщик A потратил РОВНО ОДИН ключ, сколько бы раз его ни спросили: все повторы
идут с тем же `request_id`, а контракт связывает один код с одним `request_id`.
Дальше ключ обязательно учтён — либо он у покупателя, либо записан как сирота и
списан в `shrinkage`. Потерянным он не остаётся.

Тесты 1.3–1.5: `tests/adversarial/11-dishonest-supplier.test.ts`.

### 1.6. Расхождения разбираются сами

Требование — «без ручного вмешательства». Путь выдачи ставит сверку сам, когда
сдаётся на неотвеченном вызове; отдельная свёртка нужна для случаев, когда эта
постановка не пережила (воркер умер, задача умерла). Она находит такие
утверждения сама, никто не называет ей номер запроса:

```bash
curl -s -X POST -H "$ADMIN" localhost:3000/admin/reconcile-suppliers
# -> {"unresolved":1,"scheduled":1}
```

На воркере эта свёртка запускается по таймеру, эндпоинт нужен только чтобы не
ждать.

---

## 2. Как проверить, что деньги сходятся

Четыре независимых способа. Они специально считают одно и то же из разных
таблиц: отчёт, доверяющий тому же коду, который мог ошибиться, — не отчёт.

### 2.1. По одному заказу, без админского доступа

```bash
curl -s localhost:3000/orders/ord_... | python -m json.tool
```

Поле `money`:

```json
{"paid": 2089, "delivered": 1790, "refunded": 299, "unresolved": 0}
```

`paid = delivered + refunded + unresolved` в любой момент. У завершённого заказа
`unresolved` равен нулю, и утверждение сворачивается ровно в формулировку
задания: **оплачено = выдано + возвращено**.

### 2.2. По всем заказам сразу — из товаров

```bash
curl -s -H "$ADMIN" localhost:3000/admin/money
```

```
balanced: true | orders: 5
totals: {paid: 12349, delivered: 12050, refunded: 299, unresolved: 0}
mismatched: []
```

Считается из `order_items`, `deliveries` и `refunds` — то есть из товаров, а не
из журнала. Отвечает `200`, когда всё сходится, и `409` со списком заказов,
когда нет, поэтому эндпоинт можно поставить под мониторинг без разбора тела.

### 2.3. По журналу двойной записи

```bash
curl -s -H "$ADMIN" localhost:3000/admin/ledger/balance
```

```
balanced: true
  psp_cash          12050     # деньги, оставшиеся у провайдера
  revenue          -12349     # признанная выручка (кредитовый счёт)
  refund              299     # контр-выручка: что вернули
  cogs               2156     # себестоимость выданного
  supplier_payable  -2156     # долг поставщикам
```

Две проверки:

- `balanced: true` означает, что нет ни одной группы проводок с ненулевой суммой.
  Это инвариант двойной записи, проверяемый запросом, а не обещанием;
- `psp_cash = -(revenue) - refund`, то есть `12050 = 12349 - 299`. Чистая выручка
  `-(revenue + refund)` равна стоимости выданных позиций.

Стороны покупателя (`psp_cash`, `revenue`, `refund`) и поставщика (`cogs`,
`supplier_payable`, `shrinkage`) намеренно разделены. Смешать их — значит
получить инвариант, который выглядит строгим и ничего не доказывает, потому что
недостачу с одной стороны молча покрывает другая.

### 2.4. Отчёт за период

```bash
curl -s -H "$ADMIN" "localhost:3000/admin/reports/period?from=2026-09-09T00:00:00Z&to=2026-09-10T00:00:00Z"
```

```
balanced: true
captured: 12349  refunded: 299  net_revenue: 12050  cash_movement: 12050
orders_paid: 5   items_delivered: 6  items_refunded: 1
```

`balanced` здесь — настоящая проверка, а не пересказ: движение денег берётся из
`psp_cash`, а `captured` и `refunded` — из `revenue` и `refund`. Их совпадение
означает, что три независимые суммы по счетам рассказывают одну историю.

Журнал append-only и не датируется задним числом (это обеспечено триггером, см.
раздел 4 ниже), поэтому повторный отчёт по закрытому периоду навсегда вернёт те
же цифры. Границы полуоткрытые `[from, to)`, чтобы соседние периоды стыковались
без двойного счёта.

### 2.5. Сводная сверка

```bash
curl -s -o /dev/null -w '%{http_code}\n' -H "$ADMIN" localhost:3000/admin/reconciliation
# 200 = здоров, 409 = есть расхождения
```

Пустой список — здоровый ответ по каждому пункту. Разделы:

| Раздел | Что означает непустой список |
|---|---|
| `paid_not_delivered` | позиция оплачена, но нет ни выдачи, ни возврата |
| `delivered_not_paid` | товар ушёл, а платежа в журнале нет |
| `double_settled_items` | **позиция и выдана, и возвращена** |
| `unsettled_orders` | все позиции разрешены, а статус заказа не догнал |
| `unresolved_supplier_requests` | судьба вызова к поставщику неизвестна |
| `orphan_issuances` | ключ потрачен без продажи, списан в `shrinkage` |
| `quarantined_codes` | поставщик предложил код, который отбраковали |
| `dead_jobs` | задача исчерпала попытки |
| `ledger_imbalances` | группа проводок не сходится в ноль |

`double_settled_items` стоит отдельного слова: это единственный сбой, который
ломает «оплачено = выдано + возвращено», оставляя ВСЕ счета сбалансированными —
и выдача, и возврат по отдельности являются корректной двойной записью. Ни одна
сумма по счёту его не поймает, поэтому он спрашивается напрямую и валит здоровье.

`orphan_issuances` и `quarantined_codes` намеренно не влияют на здоровье: это
зафиксированные и уравновешенные факты, а плохое поведение поставщика — не
болезнь этой системы, она его как раз обнаружила и обработала.

### 2.6. Одной командой

```bash
npm test
```

`tests/adversarial/09` и `10` проверяют сходимость на частичном сбое и после
аварии, `12` — после всплеска, `14` — что она держится в любой прошлый момент, а
не только в конце.

---

## 3. Фактически затраченное время

> **Заполнить перед отправкой.**

---

## 4. Дополнительно: восстановление картины на любой момент

```bash
# полная история одного заказа
curl -s -H "$ADMIN" localhost:3000/admin/orders/ord_.../history

# состояние на конкретный момент
curl -s -H "$ADMIN" "localhost:3000/admin/orders/ord_.../at?ts=2026-09-09T12:59:03Z"
```

Фактический вывод по заказу из раздела 1.1:

```
12:59:02.416  order_created
12:59:05.444  payment_captured
12:59:05.877  item_delivered   itm_...HZ2
12:59:05.890  item_delivered   itm_...4MZ
12:59:05.982  order_settled
12:59:09.716  item_refunded    itm_...D44
12:59:09.716  order_settled

на 12:59:02  -> status: created,              money: paid 0
на сейчас    -> status: partially_delivered,  money: paid 2089, delivered 1790, refunded 299
```

История только дополняется, и это свойство базы, а не обещание:

```bash
docker exec -it digital-shop-postgres-1 psql -U postgres -d digital_shop \
  -c "UPDATE order_events SET type='tampered'"
# ERROR: table order_events is append-only: UPDATE is not permitted
# HINT:  Record a new, correcting fact instead of altering a recorded one.

docker exec -it digital-shop-postgres-1 psql -U postgres -d digital_shop \
  -c "UPDATE ledger_entries SET amount_minor = 1"
# ERROR: table ledger_entries is append-only: UPDATE is not permitted
```

Триггер стоит и на журнале денег: все утверждения раздела 2 опираются на то, что
эти строки никогда не правили руками.

Свёртка идёт по `recorded_at` — когда мы УЗНАЛИ факт, — а не по `occurred_at`.
Вебхук, пришедший в 12:05 о платеже в 11:55, не был нам известен в 12:00, и
восстановление по `occurred_at` выдавало бы историю, задним числом знающую
будущее.

Тест: `tests/adversarial/14-history-as-of.test.ts`.

---

## 5. Дополнительно: всплеск заказов и лимит поставщика

```bash
# лимит: 4 запроса в запасе, 60 в минуту
docker exec -it digital-shop-postgres-1 psql -U postgres -d digital_shop -c \
  "UPDATE supplier_rate_limits SET capacity=4, refill_per_minute=60, tokens=4, updated_at=now()"

# 24 заказа подряд, затем
curl -s -H "$ADMIN" localhost:3000/admin/queue/progress
```

```
pending: 0   dead: 0
items: 6 delivered, 1 refunded, 0 waiting
capacity: [{supplier_a: 600/600}, {supplier_b: 600/600}]
```

Главное здесь — `dead: 0`. Ожидание не стоит ничего: задача, отложенная из-за
нехватки квоты, возвращается в очередь через `defer`, который откатывает
списанную попытку. Иначе достаточно большой всплеск тихо вымер бы в хвосте
очереди, и система отрапортовала бы об идеально соблюдённом лимите, теряя заказы.

Токен тратится на каждый HTTP-запрос, а не на выдачу целиком: лимит поставщика
считает полученные запросы, и повтор для него — такой же запрос. Троттлинг при
этом никогда не тратит раунд выдачи, иначе занятость поставщика через три раунда
обернулась бы возвратом денег покупателю, чей товар всё это время был в наличии.

Тесты: `tests/adversarial/12-rate-limit-burst.test.ts`,
`tests/adversarial/13-token-bucket.test.ts`.
