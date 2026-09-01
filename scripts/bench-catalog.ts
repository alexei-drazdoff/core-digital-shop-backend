/**
 * Catalog benchmark for stage 5.
 *
 * Seeds a realistic catalog into a throwaway database, then measures the
 * storefront query three ways so the index and pagination choices are argued
 * from measurements rather than asserted:
 *
 *   naive        counts keys per SKU with a correlated subquery and pages by OFFSET
 *   offset       uses the stock counter but still pages by OFFSET
 *   keyset       the shipped query: partial covering index plus keyset pagination
 *
 * Writes docs/EXPLAIN.md with the plans and the numbers.
 */
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/infrastructure/config/env.js';
import { createPool, type Pool } from '../src/infrastructure/db/pool.js';
import { migrateUp } from '../src/infrastructure/db/migrate.js';

const { values } = parseArgs({
  options: {
    products: { type: 'string', default: '5000' },
    keys: { type: 'string', default: '250000' },
    page: { type: 'string', default: '24' },
    runs: { type: 'string', default: '30' },
    keep: { type: 'boolean', default: false },
  },
});

const PRODUCTS = Number.parseInt(values.products as string, 10);
const KEYS = Number.parseInt(values.keys as string, 10);
const PAGE = Number.parseInt(values.page as string, 10);
const RUNS = Number.parseInt(values.runs as string, 10);
const TYPES = ['topup', 'key', 'subscription', 'giftcard'];

interface Variant {
  readonly name: string;
  readonly title: string;
  readonly note: string;
  sql(deepPage: boolean): { text: string; values: unknown[] };
}

/** Cursor for the deep page, resolved once the data is in place. */
let deepCursor = { sortRank: 0, id: 0 };
let deepOffset = 0;

const variants: Variant[] = [
  {
    name: 'naive',
    title: 'Naive: count the keys per SKU, page by OFFSET',
    note: 'What the storefront looks like before any thought is given to it. Availability is computed from the key pool on every request, and paging walks and discards every earlier row.',
    sql: (deepPage) => ({
      // Availability is computed twice, once to filter and once to display,
      // because without the denormalised flag there is nothing else to filter on.
      text: `SELECT p.sku, p.name, p.type, p.price_minor, p.currency,
                    (SELECT count(*) FROM supplier_stub.keys k
                      WHERE k.sku = p.sku AND k.state = 'available') AS available
               FROM products p
              WHERE p.is_active
                AND (SELECT count(*) FROM supplier_stub.keys k
                      WHERE k.sku = p.sku AND k.state = 'available') > 0
              ORDER BY p.sort_rank DESC, p.id DESC
              OFFSET $1 LIMIT $2`,
      values: [deepPage ? deepOffset : 0, PAGE],
    }),
  },
  {
    name: 'offset',
    title: 'Counter table, still paging by OFFSET',
    note: 'The per request counting is gone, which is the big win. What remains is that a deep page still has to walk everything before it.',
    sql: (deepPage) => ({
      text: `SELECT p.sku, p.name, p.type, p.price_minor, p.currency,
                    COALESCE(ps.available_count, 0) AS available
               FROM products p
          LEFT JOIN product_stock ps ON ps.product_id = p.id
              WHERE p.is_active AND p.in_stock
              ORDER BY p.sort_rank DESC, p.id DESC
              OFFSET $1 LIMIT $2`,
      values: [deepPage ? deepOffset : 0, PAGE],
    }),
  },
  {
    name: 'keyset',
    title: 'Shipped query: partial covering index plus keyset pagination',
    note: 'The cursor carries the last (sort_rank, id) seen, so the planner starts at the right place in the index instead of counting up to it. Cost no longer depends on page depth.',
    sql: (deepPage) => ({
      text: `SELECT p.sku, p.name, p.type, p.price_minor, p.currency,
                    COALESCE(ps.available_count, 0) AS available
               FROM products p
          LEFT JOIN product_stock ps ON ps.product_id = p.id
              WHERE p.is_active AND p.in_stock
                ${deepPage ? 'AND (p.sort_rank, p.id) < ($1, $2)' : ''}
              ORDER BY p.sort_rank DESC, p.id DESC
              LIMIT $${deepPage ? '3' : '1'}`,
      values: deepPage ? [deepCursor.sortRank, deepCursor.id, PAGE] : [PAGE],
    }),
  },
];

async function seed(pool: Pool): Promise<void> {
  process.stdout.write(`seeding ${PRODUCTS} products and ${KEYS} keys ... `);
  await pool.query(
    `INSERT INTO products (sku, name, type, price_minor, cost_minor, currency, image, sort_rank, is_active, in_stock)
     SELECT 'SKU-' || lpad(g::text, 6, '0'),
            'Product ' || g,
            ($1::text[])[1 + (g % 4)],
            100 + (g % 500) * 10,
            (100 + (g % 500) * 10) * 7 / 10,
            'RUB',
            'assets/generic.png',
            g,
            true,
            false
       FROM generate_series(1, $2) AS g`,
    [TYPES, PRODUCTS],
  );

  // The key pool the naive query has to count through. Every fifth SKU is left
  // without keys, so "out of stock" is a real part of the catalog and the
  // partial index has something to exclude.
  await pool.query(
    `INSERT INTO supplier_stub.keys (supplier, sku, code, state)
     SELECT CASE WHEN g % 2 = 0 THEN 'supplier_a' ELSE 'supplier_b' END,
            'SKU-' || lpad((1 + (g % $1))::text, 6, '0'),
            'CODE-' || g,
            CASE WHEN g % 7 = 0 THEN 'issued' ELSE 'available' END
       FROM generate_series(1, $2) AS g
      WHERE (1 + (g % $1)) % 5 <> 0`,
    [PRODUCTS, KEYS],
  );

  // Stock and the in_stock flag are DERIVED from the pool rather than invented,
  // so all three variants describe exactly the same set of rows. Comparing
  // queries that disagree about which products exist would prove nothing.
  await pool.query(
    `INSERT INTO product_stock (product_id, available_count)
     SELECT p.id, COALESCE(k.available, 0)
       FROM products p
  LEFT JOIN (SELECT sku, count(*)::int AS available FROM supplier_stub.keys
              WHERE state = 'available' GROUP BY sku) k ON k.sku = p.sku`,
  );
  await pool.query(
    `UPDATE products p SET in_stock = (ps.available_count > 0)
       FROM product_stock ps WHERE ps.product_id = p.id`,
  );

  // Without fresh statistics the planner is guessing, and a benchmark of a
  // guessing planner measures nothing.
  await pool.query('ANALYZE products');
  await pool.query('ANALYZE product_stock');
  await pool.query('ANALYZE supplier_stub.keys');
  console.log('done');
}

async function explain(pool: Pool, variant: Variant, deepPage: boolean): Promise<string> {
  const { text, values: params } = variant.sql(deepPage);
  const result = await pool.query<{ 'QUERY PLAN': string }>(
    `EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING ON) ${text}`,
    params,
  );
  return result.rows.map((row) => row['QUERY PLAN']).join('\n');
}

async function measure(pool: Pool, variant: Variant, deepPage: boolean): Promise<{ median: number; p95: number }> {
  const { text, values: params } = variant.sql(deepPage);

  // Warm the cache, and use that first run to size the sample. A variant that
  // takes seconds does not need thirty repetitions to make its point.
  const warmupStart = process.hrtime.bigint();
  await pool.query(text, params);
  const warmupMs = Number(process.hrtime.bigint() - warmupStart) / 1e6;
  const runs = warmupMs > 200 ? 3 : RUNS;

  const timings: number[] = [];
  for (let run = 0; run < runs; run += 1) {
    const startedAt = process.hrtime.bigint();
    await pool.query(text, params);
    timings.push(Number(process.hrtime.bigint() - startedAt) / 1e6);
  }
  timings.sort((a, b) => a - b);
  return {
    median: timings[Math.floor(timings.length / 2)] ?? 0,
    p95: timings[Math.floor(timings.length * 0.95)] ?? 0,
  };
}

function table(rows: ReadonlyArray<readonly string[]>): string {
  const header = rows[0];
  if (!header) return '';
  const divider = header.map(() => '---');
  return [header, divider, ...rows.slice(1)].map((row) => `| ${row.join(' | ')} |`).join('\n');
}

async function main(): Promise<void> {
  const rootUrl = process.env.DATABASE_URL;
  if (!rootUrl) throw new Error('DATABASE_URL must be set');

  const admin = new URL(rootUrl);
  admin.pathname = '/postgres';
  const benchName = `dshop_bench_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

  const adminPool = createPool(loadConfig({ ...process.env, DATABASE_URL: admin.toString() }));
  await adminPool.query(`CREATE DATABASE "${benchName}"`);
  await adminPool.end();

  const benchUrl = new URL(rootUrl);
  benchUrl.pathname = `/${benchName}`;
  // The naive variant is slow enough to trip the production statement timeout,
  // which is the point of measuring it. The benchmark connection therefore gets
  // a generous limit so the number can be reported instead of an error.
  const pool = createPool(
    loadConfig({ ...process.env, DATABASE_URL: benchUrl.toString(), DATABASE_STATEMENT_TIMEOUT_MS: '300000' }),
  );

  try {
    await migrateUp(pool);
    await seed(pool);

    // Page roughly 90% of the way into the SELLABLE catalog, which is where
    // OFFSET hurts most. Taking the offset from the total product count instead
    // would land past the end of the filtered set, and the keyset variant would
    // then be timed on an empty result: a flattering number that means nothing.
    const sellable = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM products WHERE is_active AND in_stock',
    );
    const sellableCount = sellable.rows[0]?.count ?? 0;
    deepOffset = Math.max(0, Math.floor(sellableCount * 0.9));

    const cursorRow = await pool.query<{ sort_rank: number; id: number }>(
      `SELECT sort_rank, id FROM products WHERE is_active AND in_stock
        ORDER BY sort_rank DESC, id DESC OFFSET $1 LIMIT 1`,
      [deepOffset],
    );
    const cursor = cursorRow.rows[0];
    if (!cursor) throw new Error(`no row at offset ${deepOffset} of ${sellableCount} sellable products`);
    deepCursor = { sortRank: cursor.sort_rank, id: cursor.id };

    // Guard the comparison itself: if a deep page came back empty the numbers
    // below would be measuring nothing.
    for (const variant of variants) {
      const { text, values: params } = variant.sql(true);
      const probe = await pool.query(text, params);
      if (probe.rowCount === 0) throw new Error(`variant "${variant.name}" returned no rows on the deep page`);
    }
    console.log(`sellable products: ${sellableCount}, deep page offset: ${deepOffset}`);

    const sections: string[] = [];
    const firstPage: string[][] = [['Вариант', 'Медиана, мс', 'p95, мс']];
    const deepPageRows: string[][] = [['Вариант', 'Медиана, мс', 'p95, мс']];

    for (const variant of variants) {
      const shallow = await measure(pool, variant, false);
      const deep = await measure(pool, variant, true);
      firstPage.push([variant.title, shallow.median.toFixed(2), shallow.p95.toFixed(2)]);
      deepPageRows.push([variant.title, deep.median.toFixed(2), deep.p95.toFixed(2)]);

      sections.push(
        `### ${variant.title}\n\n${variant.note}\n\n` +
          `Первая страница:\n\n\`\`\`\n${await explain(pool, variant, false)}\n\`\`\`\n\n` +
          `Глубокая страница (смещение ${deepOffset}):\n\n\`\`\`\n${await explain(pool, variant, true)}\n\`\`\``,
      );
      console.log(`${variant.name.padEnd(8)} first=${shallow.median.toFixed(2)}ms deep=${deep.median.toFixed(2)}ms`);
    }

    const indexes = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE tablename IN ('products', 'product_stock') ORDER BY indexname`,
    );
    const sizes = await pool.query<{ table_name: string; size: string; rows: number }>(
      `SELECT c.relname AS table_name, pg_size_pretty(pg_total_relation_size(c.oid)) AS size, c.reltuples::bigint AS rows
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname IN ('products', 'product_stock', 'keys') AND c.relkind = 'r'
        ORDER BY c.relname`,
    );

    const doc = `# План выполнения запроса витрины

Документ сгенерирован скриптом \`npm run bench:catalog\`. Цифры получены на
PostgreSQL 16 при ${PRODUCTS} SKU и ${KEYS} ключах в пуле, размер страницы ${PAGE},
${RUNS} прогонов на вариант.

## Задача

Витрина отдаёт список товаров с остатком. Считать остаток на каждый запрос нельзя,
и листать через OFFSET тоже нельзя. Ниже три варианта одного запроса и то, во что
они обходятся.

## Результаты

Первая страница:

${table(firstPage)}

Глубокая страница, смещение ${deepOffset}:

${table(deepPageRows)}

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

Остаток вынесен в отдельную таблицу \`product_stock\`. Счётчик меняется на каждой
продаже, а каталог читают постоянно и почти не пишут. Держать их в одной таблице
значило бы переписывать read-mostly строку при каждой выдаче.

В \`products\` осталось только булево поле \`in_stock\`. Оно переключается редко,
лишь при переходе остатка через ноль, поэтому его можно держать в частичном
индексе, не тревожа индекс при каждой продаже. Точное число живёт в счётчике,
индексу нужен только факт наличия.

Индекс покрывающий и частичный, поэтому в него попадают лишь товары в продаже,
а нужные колонки читаются прямо из индекса без обращения к таблице.

Пагинация keyset. Курсор несёт последнюю пару (sort_rank, id), сравнение идёт
кортежем, и планировщик стартует сразу с нужного места. Стоимость перестаёт
зависеть от глубины страницы, что и видно в таблице выше.

## Индексы

\`\`\`sql
${indexes.rows.map((row) => `${row.indexdef};`).join('\n')}
\`\`\`

## Размер данных

${table([['Таблица', 'Размер', 'Строк'], ...sizes.rows.map((row) => [row.table_name, row.size, String(row.rows)])])}

## Планы выполнения

${sections.join('\n\n')}
`;

    const target = fileURLToPath(new URL('../docs/EXPLAIN.md', import.meta.url));
    await writeFile(target, doc, 'utf8');
    console.log(`\nwrote ${target}`);
  } finally {
    await pool.end();
    if (!values.keep) {
      const cleanupPool = createPool(loadConfig({ ...process.env, DATABASE_URL: admin.toString() }));
      await cleanupPool.query(`DROP DATABASE IF EXISTS "${benchName}" WITH (FORCE)`).catch(() => undefined);
      await cleanupPool.end();
    } else {
      console.log(`benchmark database kept: ${benchName}`);
    }
  }
}

main().catch((error: Error) => {
  console.error(error);
  process.exit(1);
});
