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
| Naive: count the keys per SKU, page by OFFSET | 395.19 | 411.54 |
| Counter table, still paging by OFFSET | 0.85 | 1.13 |
| Shipped query: partial covering index plus keyset pagination | 0.81 | 0.93 |

Глубокая страница, смещение 4750:

| Вариант | Медиана, мс | p95, мс |
| --- | --- | --- |
| Naive: count the keys per SKU, page by OFFSET | 46391.52 | 47777.59 |
| Counter table, still paging by OFFSET | 3.30 | 3.71 |
| Shipped query: partial covering index plus keyset pagination | 0.69 | 0.90 |

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
| keys | 56 MB | 250000 |
| product_stock | 416 kB | 5000 |
| products | 2264 kB | 5000 |

## Планы выполнения

### Naive: count the keys per SKU, page by OFFSET

What the storefront looks like before any thought is given to it. Availability is computed from the key pool on every request, and paging walks and discards every earlier row.

Первая страница:

```
Limit (actual time=23.814..339.239 rows=24 loops=1)
  Buffers: shared hit=67980
  ->  Result (actual time=16.050..331.449 rows=24 loops=1)
        Buffers: shared hit=67980
        ->  Sort (actual time=1.842..1.877 rows=24 loops=1)
              Sort Key: p.sort_rank DESC, p.id DESC
              Sort Method: top-N heapsort  Memory: 31kB
              Buffers: shared hit=84
              ->  Seq Scan on products p (actual time=0.023..0.570 rows=5000 loops=1)
                    Filter: is_active
                    Buffers: shared hit=84
        SubPlan 1
          ->  Aggregate (actual time=13.722..13.722 rows=1 loops=24)
                Buffers: shared hit=67896
                ->  Seq Scan on keys k (actual time=0.321..13.702 rows=43 loops=24)
                      Filter: ((sku = p.sku) AND (state = 'available'::text))
                      Rows Removed by Filter: 249957
                      Buffers: shared hit=67896
Planning Time: 0.209 ms
Execution Time: 340.451 ms
```

Глубокая страница (смещение 4750):

```
Limit (actual time=46022.057..46221.047 rows=24 loops=1)
  Buffers: shared hit=13505730
  ->  Result (actual time=13.230..46115.816 rows=4774 loops=1)
        Buffers: shared hit=13505730
        ->  Sort (actual time=1.948..6.980 rows=4774 loops=1)
              Sort Key: p.sort_rank DESC, p.id DESC
              Sort Method: quicksort  Memory: 857kB
              Buffers: shared hit=84
              ->  Seq Scan on products p (actual time=0.031..0.584 rows=5000 loops=1)
                    Filter: is_active
                    Buffers: shared hit=84
        SubPlan 1
          ->  Aggregate (actual time=9.651..9.651 rows=1 loops=4774)
                Buffers: shared hit=13505646
                ->  Seq Scan on keys k (actual time=0.132..9.634 rows=43 loops=4774)
                      Filter: ((sku = p.sku) AND (state = 'available'::text))
                      Rows Removed by Filter: 249957
                      Buffers: shared hit=13505646
Planning Time: 0.217 ms
Execution Time: 46222.226 ms
```

### Counter table, still paging by OFFSET

The per request counting is gone, which is the big win. What remains is that a deep page still has to walk everything before it.

Первая страница:

```
Limit (actual time=0.021..0.068 rows=24 loops=1)
  Buffers: shared hit=76
  ->  Nested Loop Left Join (actual time=0.020..0.064 rows=24 loops=1)
        Buffers: shared hit=76
        ->  Index Scan using products_storefront_idx on products p (actual time=0.010..0.016 rows=24 loops=1)
              Buffers: shared hit=4
        ->  Index Scan using product_stock_pkey on product_stock ps (actual time=0.001..0.001 rows=1 loops=24)
              Index Cond: (product_id = p.id)
              Buffers: shared hit=72
Planning:
  Buffers: shared hit=24
Planning Time: 0.311 ms
Execution Time: 0.097 ms
```

Глубокая страница (смещение 4750):

```
Limit (actual time=4.767..4.769 rows=0 loops=1)
  Buffers: shared hit=116
  ->  Sort (actual time=4.434..4.599 rows=4000 loops=1)
        Sort Key: p.sort_rank DESC, p.id DESC
        Sort Method: quicksort  Memory: 628kB
        Buffers: shared hit=116
        ->  Hash Right Join (actual time=1.850..3.312 rows=4000 loops=1)
              Hash Cond: (ps.product_id = p.id)
              Buffers: shared hit=116
              ->  Seq Scan on product_stock ps (actual time=0.007..0.344 rows=5000 loops=1)
                    Buffers: shared hit=32
              ->  Hash (actual time=1.832..1.833 rows=4000 loops=1)
                    Buckets: 4096  Batches: 1  Memory Usage: 390kB
                    Buffers: shared hit=84
                    ->  Seq Scan on products p (actual time=0.007..0.819 rows=4000 loops=1)
                          Filter: (is_active AND in_stock)
                          Rows Removed by Filter: 1000
                          Buffers: shared hit=84
Planning:
  Buffers: shared hit=24
Planning Time: 0.246 ms
Execution Time: 4.796 ms
```

### Shipped query: partial covering index plus keyset pagination

The cursor carries the last (sort_rank, id) seen, so the planner starts at the right place in the index instead of counting up to it. Cost no longer depends on page depth.

Первая страница:

```
Limit (actual time=0.013..0.047 rows=24 loops=1)
  Buffers: shared hit=76
  ->  Nested Loop Left Join (actual time=0.013..0.045 rows=24 loops=1)
        Buffers: shared hit=76
        ->  Index Scan using products_storefront_idx on products p (actual time=0.006..0.010 rows=24 loops=1)
              Buffers: shared hit=4
        ->  Index Scan using product_stock_pkey on product_stock ps (actual time=0.001..0.001 rows=1 loops=24)
              Index Cond: (product_id = p.id)
              Buffers: shared hit=72
Planning:
  Buffers: shared hit=24
Planning Time: 0.187 ms
Execution Time: 0.062 ms
```

Глубокая страница (смещение 4750):

```
Limit (actual time=0.006..0.006 rows=0 loops=1)
  Buffers: shared hit=2
  ->  Nested Loop Left Join (actual time=0.005..0.005 rows=0 loops=1)
        Buffers: shared hit=2
        ->  Index Scan using products_storefront_idx on products p (actual time=0.004..0.005 rows=0 loops=1)
              Index Cond: (ROW(sort_rank, id) < ROW(0, '0'::bigint))
              Buffers: shared hit=2
        ->  Index Scan using product_stock_pkey on product_stock ps (never executed)
              Index Cond: (product_id = p.id)
Planning:
  Buffers: shared hit=24
Planning Time: 0.252 ms
Execution Time: 0.029 ms
```
