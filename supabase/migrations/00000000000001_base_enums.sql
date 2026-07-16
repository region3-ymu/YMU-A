-- Phase 0: shared extensions and enums used across later migrations.
create extension if not exists "uuid-ossp";

-- Roles per PRD §1. CPO is seeded manually; Operations Manager promotes.
create type public.app_role as enum (
  'teacher',
  'regional_manager',
  'operations_manager',
  'cpo'
);

-- Fixed YMU regions (PRD: Central, East, West, North, South).
create type public.region as enum (
  'central',
  'east',
  'west',
  'north',
  'south'
);
