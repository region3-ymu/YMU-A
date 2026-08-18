# PLAN — Afterschool Manager (afterschool@ymu.org)

## Context

YMU quiere una cuenta que vea **todos los afterschools de todas las regiones**, y
que esos afterschools **salgan** del inbox de los Regional Managers (YMU
2026-08-18, confirmado punto por punto).

El problema no es el rol, es la clasificación. Hoy no existe el concepto
"afterschool" en la base. Lo más cercano es el programa **After School**, que no
sirve para rutear porque es también el *catch-all*: `sort_order = 900` y fallback
explícito en `resolveProgram()`, así que se le cuelgan 754 eventos de basura
(`Walkthrough - …`, `Equipment`, `Evaluations`, `TEST - Name of Class`, títulos
que son nombres de profesor, 6 sin título). Rutear por `program_id` le mandaría
todo eso a ella.

## La regla de clasificación

Dos niveles. Validada contra los 18.883 eventos del calendario: reproduce las
cuatro decisiones de YMU sin un solo caso mal clasificado.

**Nivel fuerte — el título lo dice, a cualquier hora:**

```
after school | afterschool | aftreschool | tutoring | rock ensemble | fusion
```

`after ?school` cubre las dos grafías que YMU pidió aceptar: el año 2025-26 se
titulaba `After School` (dos palabras) y el 2026-27 `Afterschool` (una).
`aftreschool` es un typo real con 36 eventos vivos en Little River — se acepta
explícitamente porque el calendario es de los colegios y no se va a arreglar.

**Nivel débil — ambiguo, sólo cuenta si corre de tarde (≥ 13:30):**

```
marching band
```

Esto es lo que separa los dos marching bands: Carol City a las 15:00 **es**
afterschool, Homestead Middle a las 07:40–10:44 (90 eventos este año) **no**.
YMU: *"Si el marching band es de mañana no es afterschool entonces"*.

**Nunca afterschool:** `asd` / `special` (clases regulares, van al RM de su
región), y todo lo que hoy sólo cae en After School por fallback.

### Por qué el corte de hora no puede aplicarse a todo

Hay títulos que dicen `Afterschool` y arrancan a las 12:00–12:30 (Redland
Middle, South Dade). Si el corte se aplicara a todos, se perderían. El título es
autoridad; la hora sólo desempata lo ambiguo.

### Casos que la regla resuelve sola, sin lista de excepciones

- `Jazz Ensamble` (Citrus Grove, 90 eventos), `Jazz` (Miami Beach, 90),
  `Jazz Band Rhythm Section` (Northwestern, 90) → 10:10–12:45, horario regular.
  No matchean nivel fuerte y no son marching band: quedan fuera solas.
- `Modern Band/Marching Band` (Booker T., 12:30) → débil + mañana: fuera.

## Alcance actual (desde jue 13 ago 2026)

Ojo: el calendario tiene **2024-08-15 → 2027-06-03**. 8.496 eventos son de años
anteriores y 10.358 del año escolar actual.

| Región | Colegio | Título | Horario | Eventos |
|---|---|---|---|---|
| central | Little River K-8 | `Afterschool` | 15:00–18:00 | 569 |
| central | Little River K-8 | `Tutoring` | 13:50–16:00 | 177 |
| central | Little River K-8 | `Aftreschool` | 15:00–17:30 | 36 |
| east | Young Men's Preparatory Academy | `Afterschool` | 15:00–17:30 | 110 |
| east | Young Men's Preparatory Academy | `Afterschool␠` | 15:00–17:30 | 110 |
| east | Young Men's Preparatory Academy | `Tutoring` | 14:00–15:00 | 110 |
| north | Miami Carol City Senior High | `After School Marching Band (T/Th)` | 15:00–17:30 | 76 |
| north | Norland Middle School | `Afterschool Program` | 16:00–18:00 | 73 |

**4 colegios, 1.261 eventos.**

Los dos `Afterschool` de YMPA (con y sin espacio final, mismos slots Tue/Wed/Thu
15:00) **no son duplicados** — son dos secciones con profesores distintos (YMU
2026-08-18). No deduplicar.

Los ensembles Rock/Fusion (Miami Beach, Fienberg, Nautilus, Coral Gables) y los
`Extra After School` (Redland, Earlington) tienen 0 eventos este año: todavía no
los han metido al calendario. Por eso la regla es por patrón y no una lista de
colegios — cuando los agreguen, entran solos.

## Diseño

### 1. La clasificación se almacena, no se calcula en cada policy

`calendar_events.is_afterschool boolean not null default false`, poblado por
trigger en insert/update de `summary` / `start_at`, más un backfill.

Se almacena y no se computa por tres razones: 11 policies de RLS la van a
consultar y un regex por fila en cada evaluación es caro; las tablas
dependientes (attendance, feedback, tickets, flags) necesitan heredarla vía
`event_id` y no repetir el regex; y un override manual necesita algo que
escribir cuando la regla se equivoque en un caso.

Los patrones viven en una tabla, no en el código, siguiendo lo que ya hace
`programs.match_patterns`:

```sql
create table public.afterschool_patterns (
  pattern text primary key,
  -- 'strong' = el título es autoridad; 'weak' = sólo si corre de tarde
  tier text not null check (tier in ('strong','weak')),
  active boolean not null default true
);
```

Más `afterschool_afternoon_cutoff` = `13:30` como constante en la función, con
comentario de por qué (el `Tutoring` 13:50 de Little River es el caso más
temprano que tiene que entrar).

### 2. El rol: nuevo valor de enum, no un regional_manager sin región

`alter type public.app_role add value 'afterschool_manager';`

Un `regional_manager` con `region = null` obligaría a cada uno de los 48 usos de
`current_app_region()` a distinguir "sin región todavía" de "a propósito sin
región", y `profiles.region` ya es nullable por otras razones. Un valor de enum
propio hace que `displayRole`, el nav y `MANAGER_ROLES` se comporten solos, y
mirrorea el diseño que ya usa `academic_manager` para un alcance no-regional.

Nota operativa: `alter type ... add value` **no corre dentro de una transacción**
en Postgres, así que va en su propia migración, sola.

### 3. Las 11 policies

Todas tienen la misma forma. Ejemplo con `calendar_events_select`:

```sql
-- antes
(current_app_role() = 'regional_manager' and (school_id is null or exists (...region...)))

-- después
(current_app_role() = 'regional_manager'
   and not is_afterschool                      -- <- sale del inbox del RM
   and (school_id is null or exists (...region...)))
or (current_app_role() = 'afterschool_manager'
   and is_afterschool)                         -- <- cualquier región
```

Las dependientes llegan por `event_id`, que ya existe en casi todas:

| Tabla | Cómo llega a la clasificación |
|---|---|
| `calendar_events` | directo |
| `attendance_sessions` | `event_id` |
| `clock_in_attempts` | `event_id` |
| `feedback_submissions` | `event_id` |
| `flags` | `event_id` |
| `tickets` | `event_id` |
| `notification_queue` | `event_id` |
| `gps_checks` | `session_id` → `attendance_sessions.event_id` |
| `ticket_messages` | `ticket_id` → `tickets.event_id` |
| `schools` | no aplica — ella lee todos, como ops/cpo |

Un helper `is_afterschool_event(uuid)` SECURITY DEFINER STABLE para las que
llegan indirecto, y lectura directa de la columna donde se puede.

### 4. Las funciones SECURITY DEFINER

`find_substitutes`, los report functions, `sheet_export_*` y ticket insights
leen entre regiones por su cuenta y **no** pasan por RLS. Cada una necesita su
propio guard: para `afterschool_manager`, filtrar a `is_afterschool`; para
`regional_manager`, excluirlo. Hay que revisarlas una por una.

## Decisión pendiente

**¿Retroactivo?** Hay ~1.500 eventos de afterschool de 2025-26 con su attendance,
feedback y tickets colgando. Si la regla se aplica en RLS sin filtro de fecha,
los RMs pierden también su historia — y sus reportes del año pasado cambian.

- **Opción A (recomendada):** aplicar a todo. Una sola regla, sin fecha mágica en
  el RLS, y "afterschool no es tuyo" es cierto siempre. Los reportes históricos
  del RM cambian.
- **Opción B:** sólo desde el año escolar actual. Preserva la historia del RM,
  pero mete `current_school_year_start()` en 11 policies y crea una segunda regla
  que hay que explicar para siempre.

## Pasos, en orden

1. Migración A: `alter type app_role add value 'afterschool_manager'` (sola, sin
   transacción).
2. Migración B: tabla `afterschool_patterns` + seed, columna
   `calendar_events.is_afterschool`, función de clasificación, trigger, backfill,
   índice parcial.
3. Migración C: las 11 policies + los helpers.
4. Migración D: guards de las funciones SECURITY DEFINER.
5. TS: `APP_ROLES`, `displayRole`, `MANAGER_ROLES` / `FEEDBACK_READER_ROLES` /
   nav, y el label de región en la UI (hoy asume que un manager tiene región).
6. Tests: `tests/afterschool-classification.test.ts` (puro, sobre los títulos
   reales de este documento) y `tests/afterschool-rls.test.ts` (el RM no ve, ella
   sí, en las 11 tablas).
7. **La cuenta la crea YMU**, no este repo: `afterschool@ymu.org` se registra por
   el flujo normal de signup y después se le pone
   `role = 'afterschool_manager'`, `region = null`. Crear usuarios de auth con
   password no es algo que se haga desde acá.

## Riesgo

Los pasos 3 y 4 reescriben el control de acceso de 11 tablas en producción, y la
suite de RLS no corre en este entorno (rate limit de auth en el proyecto remoto).
Se aplican con el visto bueno de YMU y verificando después con las dos cuentas
reales, o en un branch de Supabase si se quiere ensayar primero.
