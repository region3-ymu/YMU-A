# Extra Hours → módulo de YMU-A (reemplazo del spreadsheet)

## Context

Hoy las horas extra de YMU viven en `YMU TEACHER HOURS 2025-26.xlsx`: 6 tabs
(Miami Gardens, Central, Afterschool, South Dade, ACADEMICS, Shows), ~26
columnas de periodo de pago biseminal, y celdas de **texto libre** donde los
Regional Managers escriben cosas como `$320 4 days MBSH after school`,
`2 hrs 2/3 afterschool sub for richard`, `52.50 YMPA PFC visit support`,
`NO Edison Park -1 hr`. Nada de eso es procesable por script, así que las horas
de calendario se pagan automáticamente vía Paylocity pero las horas extra siguen
siendo captura manual.

El intern construyó `payroll-portal` (HTML/JS + Supabase) partiendo de la premisa
de que **los profesores** capturan sus horas y el RM aprueba. El usuario confirmó
que esa premisa no es la que quiere: **solo los RM capturan**. Eso invalida el
diseño del prototipo (signup de profesores, código de manager en el JS, flujo
aprobar/rechazar) y elimina de paso casi todos sus bugs.

Decisiones tomadas con el usuario:
- **Solo los RM capturan.** Los profesores no tienen cuenta en este flujo.
- **Vive dentro de YMU-A**, no como app aparte.
- **Scope por región**: cada RM ve solo la suya; OM/CPO ven todo.
- **Dos salidas**: export CSV por periodo + vista de solo-lectura para el jefe.
- El formato exacto de Paylocity queda pendiente de preguntarle al jefe.

Resultado esperado: una fila por entrada en lugar de una celda de texto libre,
con escuela de un picker, fecha real del trabajo, y horas vs. monto fijo como
campos separados — de modo que un periodo de pago se pueda exportar sin que
nadie relea notas a mano.

## Por qué dentro de YMU-A y no en payroll-portal

YMU-A ya tiene lo que el prototipo tendría que reconstruir: logins reales, los
5 roles (`src/lib/auth/roles.ts`), regiones, tabla `schools` con geocoding,
`school_years`, RLS con helpers `current_app_role()` / `current_app_region()`
(`supabase/migrations/0002_profiles_rls.sql:107`), reportes que ya agregan
`hours_worked` por profesor y periodo, export CSV, y suite de tests de RLS.

Lo decisivo: si algún día el jefe quiere **un solo archivo por periodo** con
horas de calendario + horas extra + pagos fijos, eso solo es posible si ambos
flujos viven en la misma base. Una segunda base de datos cierra esa puerta
permanentemente.

`payroll-portal` no se toca más que para archivarlo (ver «Disposición del
prototipo»). **Ya no hace falta crear proyecto de Supabase** — YMU-A tiene uno.

## Hallazgos del spreadsheet que el esquema debe absorber

Evidencia de por qué el modelo de datos se ve como se ve:

| Hallazgo | Consecuencia de diseño |
|---|---|
| ~50% de las celdas son **montos fijos**, no horas (`$250 sound engineer`, `$80 sub`) | `pay_type` con columnas distintas para horas y monto |
| Celdas con **varias entradas** separadas por corridas de espacios | una fila por entrada, no una celda por periodo |
| `NO Edison Park -1 hr`, `NO YMPA 4/2 -1hr` → **deducciones** | `pay_type = 'adjustment'` con monto negativo permitido |
| Los headers de periodo **no coinciden entre tabs**: Central tiene `12/13-12/19` y una columna extra `7/11-7/24`; los demás `12/13-12/26` | `pay_periods` como **tabla sembrada**, no cálculo biseminal desde un ancla — calcularlo discreparía en silencio con lo que ve el jefe |
| ACADEMICS trae **dos juegos de periodos traslapados** (`August 5 - August 16`… y `July 26 - August 8`…), 39 columnas | la migración de datos históricos necesita revisión humana, no import automático |
| `Juan Jaimes` aparece **dos veces** en Central (filas 10 y 47) con entradas distintas | **sin** unique constraint en el nombre; la identidad es la fila, y la UI desambigua con teléfono/instrumento |
| `Lilia Fernandez` (fila 3) y `Lilia Hernandez` (fila 77) — posiblemente la misma persona mal escrita | roster con picker en lugar de teclear el nombre |
| Escuelas como texto libre: `MBSH`, `WLR`, `YMPA`, `NMS`, `FFK8`, `CGSH` | `school_id` contra la tabla `schools` que ya existe |
| Vendors/LLC en el roster: `Sound Decisions Entertainment LLC`, `Marte Melody LLC`, `Danny (Shows)` | los payees **no** pueden ser `profiles` (que exige `auth.users`) → tabla `payees` |
| Notas de estado: `Payment pending until paperwork completed`, `None` | `status` explícito + `notes`, no texto en el monto |
| Columnas `L1 / L2` (South Dade: `L1 / L2 / Vendor`), `sling` solo en Miami Gardens y Shows | `worker_type` en `payees`; `sling` se ignora |
| Header roto: A1 de Miami Gardens dice `d`; ACADEMICS no tiene header `NAME` | confirma que el import histórico es un trabajo aparte con revisión |

## Implementación

### 1. Migración `supabase/migrations/0062_extra_hours.sql`

Seguir las convenciones ya establecidas en el repo: `revoke all ... from anon,
authenticated` + `grant` explícito, `touch_updated_at()` trigger, RLS con
`current_app_role()` / `current_app_region()`, y mutaciones sensibles vía RPC
`security definer` (precedente: `promote_user`, `clock_in`,
`assign_event_school`).

**`pay_periods`** — sembrada con los periodos reales del spreadsheet
(26 filas, `2025-07-26` → `2026-07-24`).
`id, school_year_id (fk nullable), start_date, end_date, label, locked_at`.
`unique (start_date)`, `check (end_date > start_date)`.
`locked_at` congela el periodo una vez entregado a nómina.

**`payees`** — el roster. Existe porque `profiles.id references auth.users(id)`
(`0002_profiles_rls.sql:11`) y la mitad de la gente del spreadsheet nunca va a
entrar a YMU-A.
`id, profile_id (fk profiles, nullable, unique), full_name, phone, email,
instruments text[], region, worker_type ('l1'|'l2'|'vendor'), active,
created_by, created_at, updated_at`.
`profile_id` liga al profesor cuando **sí** es usuario de la app — eso es lo que
después permite juntar sus horas de calendario con sus horas extra.

**`extra_hours_entries`** — una fila por línea de pago.
`id, payee_id, pay_period_id, date_worked date not null, school_id (nullable),
program ('afterschool'|'academics'|'shows'|null), region, category, description,
pay_type ('hourly'|'flat'|'adjustment'), hours numeric(6,2), rate numeric(8,2),
amount numeric(9,2), status ('draft'|'submitted'|'approved'|'paid'),
created_by, approved_by, approved_at, paid_at, notes`.

El CHECK que carga todo el peso — es lo que hace representables
`$320 4 days MBSH` y `2 hrs sub` sin texto libre:

```
check (
  (pay_type = 'hourly'     and hours is not null and hours > 0 and amount is null)
  or (pay_type = 'flat'    and amount is not null and amount >= 0 and hours is null)
  or (pay_type = 'adjustment' and amount is not null)   -- negativo permitido
)
```

`date_worked` es la fecha **del trabajo**, no de la captura — es el campo del que
cuelga toda la lógica de periodo, y es justo el que le falta al prototipo.
`region` va desnormalizada para que la política de RLS no tenga que hacer join.

**RLS** (misma forma que `schools_select` en `0005_schools.sql`):
- `regional_manager`: select/insert/update/delete de su región, y solo mientras
  `status in ('draft','submitted')` y el periodo no esté `locked_at`.
- `operations_manager` / `cpo`: todo, más aprobar y marcar pagado.
- `teacher`: sin acceso (coincide con «los profesores no meten sus horas»). Si
  después quieren la vista de consulta, se abre con una política sobre
  `payees.profile_id = auth.uid()` — sin cambiar el esquema.

**RPCs `security definer`**: `submit_pay_period(p_period_id, p_region)`,
`approve_extra_hours_entry(p_entry_id)`, `lock_pay_period(p_period_id)`.
El guard de rol va dentro de la función, como en `find_substitutes` (0060).

**Vista `extra_hours_period_totals`** — una fila por (payee, periodo) con
`total_hours`, `total_flat`, `total_adjustments`, `entry_count`, roll-up de
status. Hereda el RLS de la tabla base.

### 2. Lógica pura + UI

- `src/lib/extra-hours/aggregate.ts` — totales por payee/periodo, puro y sin
  dependencias, siguiendo exactamente el patrón de `src/lib/reports/aggregate.ts`
  (que es puro «so it's directly unit-testable without touching the DB»).
- `src/lib/extra-hours/queries.ts` — lecturas server-side; reusar
  `getSchoolYears()` de `src/lib/reports/queries.ts:74` y `createClient()` de
  `src/lib/supabase/server`.
- `src/app/(app)/extra-hours/page.tsx` — selector de periodo (default: el que
  contiene hoy), la región sale del perfil; tabla de entradas del periodo.
  Primera línea `const caller = await requireRole(...MANAGER_ROLES);` igual que
  `src/app/(app)/flags/page.tsx:41`.
- `src/app/(app)/extra-hours/entry-form.tsx` — payee picker, `date_worked`
  (default dentro del periodo elegido), school picker desde `schools`
  (region-scoped — esto mata los typos de `MBSH`/`WLR`), categoría, toggle
  Horas / Monto fijo / Ajuste con el campo correspondiente, descripción.
- `src/app/(app)/extra-hours/actions.ts` — server actions, patrón de
  `src/app/(app)/flags/actions.ts`.
- `src/app/(app)/extra-hours/roster/page.tsx` — alta/edición de payees, para
  registrar un sub o un vendor sin darle cuenta de app.
- Nav: agregar `{ href: "/extra-hours", label: "Extra Hours", note: "Pay-period
  entries", icon: "payments" }` a la rama de managers de `navForRole()`
  (`src/lib/auth/roles.ts:180`) **después de Schedules** — solo los primeros
  cuatro items entran a la barra inferior y los managers ya pidieron
  Home·Dashboard·Flags·Tickets·Schedules; y
  `"/extra-hours": MANAGER_ROLES` en `ROUTE_ROLES` (`roles.ts:300`).

### 3. Las dos salidas

- `src/lib/export/extra-hours-csv.ts`, reusando `csvField()` de
  `src/lib/export/csv.ts`. Dos formas: **detalle** (una fila por entrada) y
  **nómina** (una fila por payee con horas, monto fijo, ajustes, total).
  Formato marcado explícitamente como provisional hasta la respuesta del jefe.
- Vista de solo-lectura del periodo para OM/CPO (`page.tsx` sin los controles de
  edición) — el jefe abre una URL en lugar del spreadsheet.

### 4. Tests

`npm test` y `npm run test:rls` en `package.json` son **listas explícitas de
archivos, no globs** — hay que agregar los nuevos a mano o no corren.

- `tests/extra-hours-aggregate.test.ts` — totales con mezcla de hourly + flat +
  adjustment; entradas en el límite del periodo.
- `tests/extra-hours-rls.test.ts` — un RM no lee otra región; un teacher no lee
  nada; un RM no edita un periodo con `locked_at`; OM/CPO ven todo.

## Fuera de alcance de esta ronda

- **Import del histórico 2025-26.** Es un trabajo aparte:
  `scripts/import-extra-hours.ts` siguiendo el precedente de
  `scripts/import-schools.ts` + `school-import-review.csv` — parsea los 6 tabs y
  emite `extra-hours-import-review.csv` con columna de confianza para revisión
  humana antes de cargar. Alrededor de la mitad de las celdas son parseables sin
  ambigüedad; el resto no (`None`, `Payment pending until paperwork completed`,
  `Incluide all payments form two payment periods`). **Nada se auto-importa.**
- **Integración con Paylocity.** Bloqueada hasta las respuestas del jefe.

## Disposición del prototipo

`payroll-portal` no se desarrolla más. Se archiva:
`git init` + `.gitignore` + un commit local con un `ARCHIVED.md` que diga por qué
se detuvo (premisa de captura equivocada) y qué sobrevivió como idea. Se le
entregan al usuario los comandos para crear y empujar
`region3-ymu/payroll-portal` **privado** si quiere conservarlo fuera de la
laptop — el push lo hace él (`gh` no está instalado y git no tiene credential
helper configurado). El trabajo real va en un branch de `region3-ymu/YMU-A`.

Nota de seguridad para el archivo: el `MANAGER_ACCESS_CODE = "coolwebapp12"`
vivía en `js/auth.js:1` y la política de RLS de `profiles` nunca validaba el
`role`, así que cualquier profesor podía volverse manager y ver la nómina de
todas las regiones. No se despliega tal cual.

## Preguntas para el jefe (el usuario las hace)

1. ¿Cómo entran hoy las horas a Paylocity: API, import de CSV/batch, o captura
   manual?
2. Si es import: ¿qué columnas exactas y qué earning codes (regular / OT / flat /
   reimbursement)? Un archivo de ejemplo vale más que la descripción.
3. Los montos fijos ($320, $80): ¿entran como earning de monto, o como horas ×
   tarifa? ¿Y los reimbursements tipo `93.50 Contractor ID reimbursement`?
4. Los vendors/LLC (`Sound Decisions Entertainment LLC`, `Marte Melody LLC`):
   ¿van por Paylocity o por AP/1099? Eso decide si viven en este módulo.
5. ¿Los periodos de pago son exactamente los del spreadsheet? Central tiene
   `12/13-12/19` mientras los otros tabs tienen `12/13-12/26` — uno de los dos
   está mal, y de eso depende la siembra de `pay_periods`.
6. ¿Quién autoriza formalmente antes de pagar: él, o basta el RM?
7. El script de Google Calendar → Paylocity: ¿lo mantiene él? ¿Podría en su
   lugar leer un endpoint de YMU-A, para que las horas de calendario y las
   extra salgan en un solo archivo?

Las respuestas 1–3 y 5 pueden cambiar el formato del export y la siembra de
`pay_periods`. El resto del módulo no depende de ellas, así que se construye
sin esperar.

## Verificación

1. `npx supabase db push` para aplicar `0062_extra_hours.sql` (o
   `npx supabase db reset` en local con Docker).
2. `npm test` y `npm run test:rls` — con los dos archivos nuevos ya agregados a
   los scripts de `package.json`.
3. `npm run dev`, entrar como `regional_manager` de Central: capturar una entrada
   por horas, una de monto fijo y un ajuste negativo en el mismo periodo;
   verificar que el total del periodo cuadra y que el picker de escuelas solo
   ofrece escuelas de Central.
4. Entrar como RM de otra región: la entrada de Central **no** debe aparecer
   (esto es lo que `tests/extra-hours-rls.test.ts` fija, pero conviene verlo).
5. Entrar como `operations_manager`: ver ambas regiones, aprobar el periodo,
   bloquearlo, y confirmar que el RM ya no puede editar.
6. Descargar los dos CSV y compararlos contra la columna del periodo
   correspondiente del spreadsheet para el mismo puñado de personas.
