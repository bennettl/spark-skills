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

## Response envelope & pagination (read `main.ts` / global interceptors)

- **`TransformInterceptor`** wrapping every response as `{ data: T, meta?: {...} }`
  — the FE type must be `{ data: T }`, not `T`. A per-field diff that ignores the
  envelope reports false "aligned."
- **`ClassSerializerInterceptor`** honoring `@Exclude()` / `@Expose()` — an entity
  field that exists in the DB but is `@Exclude`d is **not** on the wire; the FE
  type must not include it.
- **Collections:** `T` vs `T[]` vs `{ data: T[], total, page, pageSize }`. Match
  the exact pagination wrapper the endpoint returns.
- **Error shape:** the global exception filter defines the error body; FE error
  handling types should match it.

## Route matching

- Compose `app.setGlobalPrefix('...')` and any `@Version` / URI versioning with
  the `@Controller('...')` + `@Get('...')` paths before comparing to the FE
  `Endpoint` string. A prefix mismatch reads as "endpoint not found" — check the
  prefix before concluding the route is missing.

## Request-side coercion

- `@Query()` / `@Param()` values arrive as **strings**. They become the DTO's
  declared type (`number`, `boolean`) only when `ValidationPipe({ transform: true })`
  is active (check `main.ts` / the pipe registration). Without transform, a
  `page: number` param is really a `string` on arrival — the FE sending a number
  vs string, and the BE expecting one, is a genuine mismatch.
- `@Body()` is JSON-parsed, so body field types follow the leaf table above.
