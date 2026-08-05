-- ============================================================
-- LicitaTech AI — Schema Supabase (v2, 100% gratis / sin IA)
-- Copiar y pegar TODO esto en SQL Editor de Supabase
-- ============================================================

create extension if not exists "uuid-ossp";

-- ---------- CPV biblioteca (catálogo de códigos priorizados) ----------
create table if not exists cpv_biblioteca (
  codigo text primary key,
  categoria text not null,
  descripcion text,
  prioridad smallint not null default 1,
  peso integer not null default 20
);

-- ---------- Keywords para scoring por reglas ----------
create table if not exists keywords_biblioteca (
  id uuid primary key default uuid_generate_v4(),
  palabra text not null,
  categoria text,
  peso integer not null default 10
);

-- ---------- Organismos (tabla independiente) ----------
create table if not exists organismos (
  id uuid primary key default uuid_generate_v4(),
  nombre text unique not null,
  tipo text,
  provincia text,
  comunidad_autonoma text,
  num_licitaciones integer default 0,
  presupuesto_total numeric default 0,
  ultima_publicacion timestamptz
);

-- ---------- Licitaciones ----------
create table if not exists licitaciones (
  id uuid primary key default uuid_generate_v4(),
  id_expediente text unique not null,
  titulo text,
  objeto text,
  descripcion text,
  organismo text,
  organo_contratacion text,
  comunidad_autonoma text,
  provincia text,
  municipio text,
  fecha_publicacion date,
  fecha_limite date,
  estado text,
  tipo_contrato text,
  procedimiento text,
  tipo_tramitacion text,
  valor_estimado numeric,
  presupuesto numeric,
  cpv text[],
  enlace_oficial text,
  documentos_urls text[],
  texto_pliegos text,
  financiacion_europea boolean default false,
  lotes jsonb,
  adjudicatarios jsonb,
  historico jsonb default '[]'::jsonb,
  raw_codice jsonb,
  score integer default 0,
  categorias text[],
  interesa boolean default false,
  prioridad text,
  presentada boolean default false,
  ganada boolean,
  comentarios text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_licitaciones_cpv on licitaciones using gin (cpv);
create index if not exists idx_licitaciones_score on licitaciones (score desc);
create index if not exists idx_licitaciones_estado on licitaciones (estado);
create index if not exists idx_licitaciones_fecha_publicacion on licitaciones (fecha_publicacion desc);
create index if not exists idx_licitaciones_pendientes on licitaciones (id) where score is null;

-- ---------- Control de sincronización ----------
create table if not exists sync_state (
  id text primary key,
  cursor_url text,
  ultima_ejecucion timestamptz,
  nuevas integer default 0,
  duplicadas integer default 0,
  errores integer default 0
);

-- ---------- RLS (Row Level Security) ----------
alter table licitaciones enable row level security;
alter table cpv_biblioteca enable row level security;
alter table keywords_biblioteca enable row level security;
alter table organismos enable row level security;
alter table sync_state enable row level security;

create policy "lectura publica licitaciones" on licitaciones for select using (true);
create policy "lectura publica cpv" on cpv_biblioteca for select using (true);
create policy "lectura publica keywords" on keywords_biblioteca for select using (true);
create policy "lectura publica organismos" on organismos for select using (true);

-- ---------- Seed CPV inicial ----------
insert into cpv_biblioteca (codigo, categoria, descripcion, prioridad, peso) values
  ('92000000','Ocio y Cultura','Servicios de esparcimiento, culturales y deportivos',3,40),
  ('79952100','Eventos','Organización de eventos culturales',3,35),
  ('79950000','Eventos','Organización de exposiciones, ferias y congresos',3,35),
  ('79951000','Eventos','Organización de seminarios',2,20),
  ('92300000','Entretenimiento','Servicios de entretenimiento',3,35),
  ('92600000','Deportes','Servicios deportivos',2,25),
  ('80500000','Formación','Servicios de formación (división)',3,35),
  ('80533100','Formación','Cursos de formación informática',2,25),
  ('72000000','Tecnología','Servicios TI: consultoría, desarrollo de software (división)',2,30),
  ('72200000','Tecnología','Programación y consultoría de software',2,30),
  ('48000000','Tecnología','Paquetes de software y sistemas de información (división)',2,25),
  ('32000000','Audiovisual','Equipos de radio, televisión, comunicación y telecomunicación (división)',2,25),
  ('30200000','Informática','Equipos y material informático',2,25),
  ('92500000','Cultura','Servicios de bibliotecas, archivos y museos',1,15),
  ('35613000','Drones','Vehículos aéreos no tripulados',2,25),
  ('37000000','Juegos y Deporte','Instrumentos musicales, artículos deportivos, juegos, juguetes (división)',2,30),
  ('37500000','Gaming','Juegos y juguetes; atracciones de feria (grupo 375)',3,40),
  ('79341000','Marketing','Servicios de publicidad',1,15),
  ('79342000','Marketing','Servicios de marketing',1,15)
on conflict (codigo) do nothing;

-- ---------- Seed keywords inicial ----------
insert into keywords_biblioteca (palabra, categoria, peso) values
  ('gaming','Gaming',18),('esports','Esports',18),('e-sports','Esports',18),
  ('videojuego','Gaming',18),('videojuegos','Gaming',18),
  ('streaming','Streaming',12),('twitch','Streaming',10),
  ('realidad virtual','VR',12),('realidad aumentada','AR',12),
  ('sim racing','Sim Racing',15),('simulador de conducción','Sim Racing',12),
  ('robótica','Robótica',12),('robótica educativa','Robótica',12),
  ('impresión 3d','Maker',10),('impresora 3d','Maker',10),
  ('steam','STEAM',10),('makerspace','Maker',10),('fabricación digital','Maker',8),
  ('ciberseguridad','Ciberseguridad',12),('inteligencia artificial','IA',12),
  ('hackathon','Formación',12),('lan party','Gaming',15),
  ('campamento tecnológico','Juventud',10),('campus tecnológico','Juventud',10),
  ('dron','Drones',8),('drones','Drones',8),
  ('formación digital','Formación',8),('transformación digital','Formación',6),
  ('consolas','Gaming',12),('playstation','Gaming',12),('xbox','Gaming',12),
  ('nintendo','Gaming',12),('pc gaming','Gaming',15),
  ('torneo de videojuegos','Esports',18),('competición de videojuegos','Esports',18),
  ('liga de videojuegos','Esports',15),('feria gaming','Gaming',18),
  ('convención gaming','Gaming',18),('zona gaming','Gaming',15),
  ('arena esports','Esports',15),('ocio digital','Ocio digital',10),
  ('ocio electrónico','Ocio digital',10),('pantallas led','Eventos',8),
  ('cultura digital','Formación',6),('programación para jóvenes','Formación',10),
  ('coding','Formación',8),('nuevas tecnologías','Tecnología',6)
on conflict do nothing;
