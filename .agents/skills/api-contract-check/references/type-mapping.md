# Type mapping — spark-api backend ↔ spark-web frontend

The authoritative contract is the **class-validator DTO** (requests) and the
**actually-serialized entity + interceptors** (responses) — not the TS type
annotations, which lie under `strictNullChecks: false`.

## Leaf-field type mapping

| Backend (DTO decorator / entity column) | Serialized as | Frontend TS type | Frontend zod |
|---|---|---|---|
| `@IsString()` / `varchar`, `text` | JSON string | `string` | `z.string()` |
| `@IsInt()` / `int`, `smallint` | JSON number | `number` | `z.number()` |
| `numeric`, `decimal`, `bigint` | **JSON string** (TypeORM default) | `string` (not `number`) | `z.string()` |
| `@IsBoolean()` / `boolean` | JSON boolean | `boolean` | `z.boolean()` |
| `@IsDate()` / `timestamp`, `date` | **ISO 8601 string** | `string` (not `Date`) | `z.string().datetime()` |
| `@IsEnum(E)` / `enum` | JSON string | union literal `'a' \| 'b'` | `z.enum([...])` |
| `@IsUUID()` / `uuid` | JSON string | `string` | `z.string().uuid()` |
| `json`, `jsonb` | JSON object/array | matching interface | matching object schema |
| nullable column (`{ nullable: true }`) | `null` when unset | `T \| null` | `z.T().nullable()` |

## Optional vs nullable — keep them distinct

- **Optional** (`@IsOptional()`, key may be absent): FE `field?: T`, `z.T().optional()`.
- **Nullable** (present but `null`): FE `field: T | null`, `z.T().nullable()`.
- A nullable *column* on an always-present field is `T | null`, **not** `T?`.
  Reporting one as the other is a real finding (silent `null` at runtime).

## Casing

TypeORM entities are commonly snake_case columns; the FE mirror may be camelCase.
Confirm whether a naming strategy or a serializer transforms casing on the way
out. If the wire is snake_case and the FE type is camelCase (or vice versa),
every field is a mismatch — flag the transform, not each field.

## Response envelope & pagination (read `main.ts` + the controller's interceptors)

- **`ResponseInterceptor`** (`libs/interceptors/`, spark-api) wraps the payload as
  **`{ data: T }`** — **no top-level `meta`**. It is applied **per-controller** via
  `@UseInterceptors(ResponseInterceptor)`, **not globally** (~55 of ~62
  controllers). For an enveloped route the FE type must be `{ data: T }`, not `T`;
  for a route whose controller *lacks* the decorator the payload is **bare** (`T`).
  Resolve this per route — a per-field diff that ignores the envelope reports false
  "aligned."
- **No `ClassSerializerInterceptor`** and no `@Exclude()` / `@Expose()` exist in
  spark-api — entities serialize **as-is**. Every entity column is on the wire
  unless the service omits it in code, so the FE type should include those fields;
  a sensitive column that leaks to the wire is a finding, not an omission.
- **Collections — nestjs-paginate:** a paginated list is
  `{ data: T[], meta: { itemsPerPage, totalItems, currentPage, totalPages, sortBy, filter }, links: { current } }`,
  itself nested inside the `{ data }` envelope ⇒ the wire is
  `{ data: { data: T[], meta, links } }` (the FE reads `res.data.data.data`).
  Request-side filtering/paging uses **query params** `filter.<field>`, operators
  like `$in:a,b`, `limit`, and `sortBy` — not `page` / `pageSize` fields.
- **Error shape:** spark-api's custom `exceptionFactory` + `HttpExceptionsFilter`
  produce `{ statusCode, error, message }` (validation errors comma-joined into
  `message`); the FE `ApiError` is `{ error, message }`.

## Route matching

- Compose `app.setGlobalPrefix('...')` and any `@Version` / URI versioning with
  the `@Controller('...')` + `@Get('...')` paths before comparing to the FE
  `Endpoint` string. A prefix mismatch reads as "endpoint not found" — check the
  prefix before concluding the route is missing. (spark-api currently sets
  **neither** a global prefix nor URI versioning — but verify, since that can
  change silently.)

## Request-side coercion

- `@Query()` / `@Param()` values arrive as **strings**. They become the DTO's
  declared type (`number`, `boolean`) only when `ValidationPipe({ transform: true })`
  is active (check `main.ts` / the pipe registration). Without transform, a
  `page: number` param is really a `string` on arrival — the FE sending a number
  vs string, and the BE expecting one, is a genuine mismatch.
- `@Body()` is JSON-parsed, so body field types follow the leaf table above.
