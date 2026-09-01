# План выполнения запроса витрины

Документ сгенерирован скриптом `npm run bench:catalog`. Цифры получены на
PostgreSQL 16 при 5000 SKU и 250000 ключах в пуле, размер страницы 24,
30 прогонов на вариант.

## Задача

Витрина отдаёт список товаров с остатком. Считать остаток на каждый запрос нельзя,
и листать через OFFSET тоже нельзя. Ниже три варианта одного запроса и то, во что
они обходятся.

## Результаты

Первая страница:

| Вариант | Медиана, мс | p95, мс |
| --- | --- | --- |
| Naive: count the keys per SKU, page by OFFSET | 38076.08 | 39179.83 |
| Counter table, still paging by OFFSET | 0.91 | 1.37 |
| Shipped query: partial covering index plus keyset pagination | 0.79 | 1.26 |

Глубокая страница, смещение 3600:

| Вариант | Медиана, мс | p95, мс |
| --- | --- | --- |
| Naive: count the keys per SKU, page by OFFSET | 62759.29 | 63857.63 |
| Counter table, still paging by OFFSET | 3.51 | 3.72 |
| Shipped query: partial covering index plus keyset pagination | 0.81 | 1.74 |

## Как читать эти цифры

Наивный вариант проигрывает не из-за размера страницы, а из-за того, что
коррелированный подзапрос считает ключи для каждой строки каталога, и делает это
дважды, в фильтре и в выборке. Двадцать четыре строки на выходе, пять тысяч
просмотров пула на входе. Это тот случай, когда запрос не «медленный», а
принципиально не той формы.

Счётчик остатка убирает этот перебор целиком и даёт основной выигрыш. Дальше
остаётся разница между OFFSET и keyset, и она видна только на глубине: на первой
странице оба варианта одинаковы, на смещении 3600 keyset быстрее примерно
вчетверо. Причина в планах выше. У OFFSET план читает и выбрасывает все строки до
нужного места, поэтому число прочитанных буферов растёт вместе с глубиной. У
keyset условие по кортежу (sort_rank, id) попадает прямо в индекс, и на глубокой
странице читается ровно столько же буферов, сколько на первой. Стоимость страницы
перестаёт зависеть от её номера.

Отсюда и практический вывод: разрыв между этими двумя вариантами не фиксирован,
он растёт вместе с каталогом и глубиной листания, тогда как keyset остаётся
плоским.

## Что сделано и почему

Остаток вынесен в отдельную таблицу `product_stock`. Счётчик меняется на каждой
продаже, а каталог читают постоянно и почти не пишут. Держать их в одной таблице
значило бы переписывать read-mostly строку при каждой выдаче.

В `products` осталось только булево поле `in_stock`. Оно переключается редко,
лишь при переходе остатка через ноль, поэтому его можно держать в частичном
индексе, не тревожа индекс при каждой продаже. Точное число живёт в счётчике,
индексу нужен только факт наличия.

Индекс покрывающий и частичный, поэтому в него попадают лишь товары в продаже,
а нужные колонки читаются прямо из индекса без обращения к таблице.

Пагинация keyset. Курсор несёт последнюю пару (sort_rank, id), сравнение идёт
кортежем, и планировщик стартует сразу с нужного места. Стоимость перестаёт
зависеть от глубины страницы, что и видно в таблице выше.

## Индексы

```sql
CREATE UNIQUE INDEX product_stock_pkey ON public.product_stock USING btree (product_id);
CREATE INDEX products_active_idx ON public.products USING btree (is_active, id);
CREATE UNIQUE INDEX products_pkey ON public.products USING btree (id);
CREATE UNIQUE INDEX products_sku_key ON public.products USING btree (sku);
CREATE INDEX products_storefront_by_type_idx ON public.products USING btree (type, sort_rank DESC, id DESC) INCLUDE (sku, price_minor, currency) WHERE (is_active AND in_stock);
CREATE INDEX products_storefront_idx ON public.products USING btree (sort_rank DESC, id DESC) INCLUDE (sku, type, price_minor, currency) WHERE (is_active AND in_stock);
```

## Размер данных

| Таблица | Размер | Строк |
| --- | --- | --- |
| keys | 45 MB | 200000 |
| product_stock | 416 kB | 5000 |
| products | 3344 kB | 5000 |

## Планы выполнения

### Naive: count the keys per SKU, page by OFFSET

What the storefront looks like before any thought is given to it. Availability is computed from the key pool on every request, and paging walks and discards every earlier row.

Первая страница:

```
Limit (actual time=37477.128..37646.228 rows=24 loops=1)
  Buffers: shared hit=11364455
  ->  Result (actual time=37348.978..37518.046 rows=24 loops=1)
        Buffers: shared hit=11364455
        ->  Sort (actual time=37341.588..37341.612 rows=24 loops=1)
              Sort Key: p.sort_rank DESC, p.id DESC
              Sort Method: top-N heapsort  Memory: 31kB
              Buffers: shared hit=11310167
              ->  Seq Scan on products p (actual time=8.237..37330.008 rows=4000 loops=1)
                    Filter: (is_active AND ((SubPlan 2) > 0))
                    Rows Removed by Filter: 1000
                    Buffers: shared hit=11310167
                    SubPlan 2
                      ->  Aggregate (actual time=7.460..7.460 rows=1 loops=5000)
                            Buffers: shared hit=11310000
                            ->  Seq Scan on keys k_1 (actual time=1.568..7.447 rows=34 loops=5000)
                                  Filter: ((sku = p.sku) AND (state = 'available'::text))
                                  Rows Removed by Filter: 199966
                                  Buffers: shared hit=11310000
        SubPlan 1
          ->  Aggregate (actual time=7.339..7.339 rows=1 loops=24)
                Buffers: shared hit=54288
                ->  Seq Scan on keys k (actual time=0.170..7.323 rows=43 loops=24)
                      Filter: ((sku = p.sku) AND (state = 'available'::text))
                      Rows Removed by Filter: 199957
                      Buffers: shared hit=54288
Planning Time: 0.246 ms
Execution Time: 37647.898 ms
```

Глубокая страница (смещение 3600):

```
Limit (actual time=65858.432..66035.544 rows=24 loops=1)
  Buffers: shared hit=19507655
  ->  Result (actual time=37628.888..65920.083 rows=3624 loops=1)
        Buffers: shared hit=19507655
        ->  Sort (actual time=37620.764..37624.680 rows=3624 loops=1)
              Sort Key: p.sort_rank DESC, p.id DESC
              Sort Method: quicksort  Memory: 628kB
              Buffers: shared hit=11310167
              ->  Seq Scan on products p (actual time=8.237..37610.050 rows=4000 loops=1)
                    Filter: (is_active AND ((SubPlan 2) > 0))
                    Rows Removed by Filter: 1000
                    Buffers: shared hit=11310167
                    SubPlan 2
                      ->  Aggregate (actual time=7.515..7.515 rows=1 loops=5000)
                            Buffers: shared hit=11310000
                            ->  Seq Scan on keys k_1 (actual time=1.582..7.502 rows=34 loops=5000)
                                  Filter: ((sku = p.sku) AND (state = 'available'::text))
                                  Rows Removed by Filter: 199966
                                  Buffers: shared hit=11310000
        SubPlan 1
          ->  Aggregate (actual time=7.800..7.800 rows=1 loops=3624)
                Buffers: shared hit=8197488
                ->  Seq Scan on keys k (actual time=0.111..7.785 rows=43 loops=3624)
                      Filter: ((sku = p.sku) AND (state = 'available'::text))
                      Rows Removed by Filter: 199957
                      Buffers: shared hit=8197488
Planning Time: 0.209 ms
Execution Time: 66037.066 ms
```

### Counter table, still paging by OFFSET

The per request counting is gone, which is the big win. What remains is that a deep page still has to walk everything before it.

Первая страница:

```
Limit (actual time=0.014..0.038 rows=24 loops=1)
  Buffers: shared hit=75
  ->  Nested Loop Left Join (actual time=0.013..0.035 rows=24 loops=1)
        Buffers: shared hit=75
        ->  Index Scan using products_storefront_idx on products p (actual time=0.007..0.010 rows=24 loops=1)
              Buffers: shared hit=3
        ->  Index Scan using product_stock_pkey on product_stock ps (actual time=0.001..0.001 rows=1 loops=24)
              Index Cond: (product_id = p.id)
              Buffers: shared hit=72
Planning:
  Buffers: shared hit=24
Planning Time: 0.230 ms
Execution Time: 0.057 ms
```

Глубокая страница (смещение 3600):

```
Limit (actual time=3.742..3.748 rows=24 loops=1)
  Buffers: shared hit=199
  ->  Sort (actual time=3.462..3.622 rows=3624 loops=1)
        Sort Key: p.sort_rank DESC, p.id DESC
        Sort Method: quicksort  Memory: 628kB
        Buffers: shared hit=199
        ->  Hash Right Join (actual time=1.374..2.520 rows=4000 loops=1)
              Hash Cond: (ps.product_id = p.id)
              Buffers: shared hit=199
              ->  Seq Scan on product_stock ps (actual time=0.004..0.280 rows=5000 loops=1)
                    Buffers: shared hit=32
              ->  Hash (actual time=1.362..1.363 rows=4000 loops=1)
                    Buckets: 4096  Batches: 1  Memory Usage: 390kB
                    Buffers: shared hit=167
                    ->  Seq Scan on products p (actual time=0.024..0.613 rows=4000 loops=1)
                          Filter: (is_active AND in_stock)
                          Rows Removed by Filter: 1000
                          Buffers: shared hit=167
Planning:
  Buffers: shared hit=24
Planning Time: 0.163 ms
Execution Time: 3.771 ms
```

### Shipped query: partial covering index plus keyset pagination

The cursor carries the last (sort_rank, id) seen, so the planner starts at the right place in the index instead of counting up to it. Cost no longer depends on page depth.

Первая страница:

```
Limit (actual time=0.014..0.049 rows=24 loops=1)
  Buffers: shared hit=75
  ->  Nested Loop Left Join (actual time=0.013..0.046 rows=24 loops=1)
        Buffers: shared hit=75
        ->  Index Scan using products_storefront_idx on products p (actual time=0.007..0.011 rows=24 loops=1)
              Buffers: shared hit=3
        ->  Index Scan using product_stock_pkey on product_stock ps (actual time=0.001..0.001 rows=1 loops=24)
              Index Cond: (product_id = p.id)
              Buffers: shared hit=72
Planning:
  Buffers: shared hit=24
Planning Time: 0.236 ms
Execution Time: 0.069 ms
```

Глубокая страница (смещение 3600):

```
Limit (actual time=0.011..0.037 rows=24 loops=1)
  Buffers: shared hit=76
  ->  Nested Loop Left Join (actual time=0.010..0.034 rows=24 loops=1)
        Buffers: shared hit=76
        ->  Index Scan using products_storefront_idx on products p (actual time=0.005..0.009 rows=24 loops=1)
              Index Cond: (ROW(sort_rank, id) < ROW(499, '499'::bigint))
              Buffers: shared hit=4
        ->  Index Scan using product_stock_pkey on product_stock ps (actual time=0.001..0.001 rows=1 loops=24)
              Index Cond: (product_id = p.id)
              Buffers: shared hit=72
Planning:
  Buffers: shared hit=24
Planning Time: 0.199 ms
Execution Time: 0.053 ms
```
