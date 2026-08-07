Skip to content
alvarorrs
licitatech-ai
Repository navigation
Code
Issues
Pull requests
Actions
Projects
Wiki
Security and quality
Insights
Settings
Files
Go to file
t
T
.github
README.md
SUPABASE_SQL_COMPLETO.sql
analizar-bdns-ia.mjs
analizar-ia.mjs
backfill-historico.mjs
bdns-connector.mjs
env.example
index.html
package.json
rule-scoring (1).mjs
rule-scoring.mjs
schema (1).sql
schema.sql
send-daily-email.mjs
sync-licitaciones.mjs
sync-licitaciones.yml
licitatech-ai
/
analizar-ia.mjs
in
main

Edit

Preview
Indent mode

Spaces
Indent size

2
Line wrap mode

No wrap
Editing analizar-ia.mjs file contents
  1
  2
  3
  4
  5
  6
  7
  8
  9
 10
 11
 12
 13
 14
 15
 16
 17
 18
 19
 20
 21
 22
 23
 24
 25
 26
 27
 28
 29
 30
 31
 32
 33
 34
 35
 36
import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI } from '@google/generative-ai';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

const MAX_ANALISIS = 20;
const PAUSA_MS = 4000;

async function obtenerPendientes() {
  const { data, error } = await supabase
    .schema('arena')
    .from('subvenciones')
    .select('id, titulo, descripcion, entidad_responsable, territorio')
    .limit(1000);

  if (error) throw error;

  const { data: yaAnalizadas } = await supabase
    .schema('arena')
    .from('subvenciones_ia')
    .select('subvencion_id');

  const idsAnalizados = new Set((yaAnalizadas || []).map(a => a.subvencion_id));
  
  return (data || [])
    .filter(s => !idsAnalizados.has(s.id))
    .slice(0, MAX_ANALISIS);
}

Use Control + Shift + m to toggle the tab key moving focus. Alternatively, use esc then tab to move to the next interactive element on the page.
