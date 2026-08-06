// ============================================================
// LicitaTech AI — Análisis IA con Gemini Flash (gratis)
//
// Analiza licitaciones PUBLICADAS y sin analizar todavía:
//  - Resumen ejecutivo en 2-3 frases
//  - Señales de requisitos de solvencia (facturación, experiencia...)
//  - Si encaja con los servicios de NL Tech
//
// Por ahora trabaja sobre objeto + descripción + CPV (no el PDF del
// pliego completo — eso es la siguiente entrega, pendiente de verificar
// la ruta exacta del documento en el XML CODICE).
//
// Tier gratuito de Gemini Flash (ago 2026): ~15 RPM, ~1.500 RPD.
// Este script se autolimita muy por debajo de eso para no arriesgar
// nunca un 429, y procesa como mucho LIMITE_POR_EJECUCION licitaciones
// por ejecución del cron.
// ============================================================

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODELO = 'gemini-flash-latest';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODELO}:generateContent?key=${GEMINI_API_KEY}`;

const LIMITE_POR_EJECUCION = 40;   // muy por debajo del RPD gratuito
const PAUSA_ENTRE_LLAMADAS_MS = 4500; // ~13 RPM, por debajo del límite de 15 RPM

const PERFIL_NLTECH = `NL Tech es una empresa de Cantabria (España) especializada en:
- Eventos y torneos de gaming/esports (ej. AstiGaming, LIGUCA)
- Formación tecnológica STEAM para jóvenes (robótica, programación, campus tecnológicos)
- Alquiler y suministro de equipamiento informático/gaming (PCs, consolas, pantallas, VR)
- Gestión de espacios y stands en ferias tecnológicas
Facturación anual actual: 30.000-50.000€. Empresa pequeña, sin gran capacidad financiera para
avales o garantías elevadas.`;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const ESQUEMA_RESPUESTA = {
  type: 'object',
  properties: {
    resumen: { type: 'string', description: 'Resumen ejecutivo en 2-3 frases, en español, de qué pide el contrato' },
    requisitos_solvencia: { type: 'string', description: 'Requisitos de solvencia económica/técnica detectados en el texto (facturación mínima, experiencia, clasificación empresarial). Si no hay información suficiente en el texto para saberlo, decirlo explícitamente.' },
    riesgos: { type: 'string', description: 'Riesgos o motivos de duda para presentarse (plazo muy corto, requisitos que probablemente NO se cumplan, ambigüedad). Vacío si no hay ninguno claro.' },
    encaja_nltech: { type: 'boolean', description: 'true si el objeto del contrato encaja razonablemente con los servicios de NL Tech descritos' },
  },
  required: ['resumen', 'requisitos_solvencia', 'riesgos', 'encaja_nltech'],
};

async function analizarConGemini(lic) {
  const prompt = `Eres un asistente que ayuda a una empresa española a evaluar licitaciones públicas.

PERFIL DE LA EMPRESA:
${PERFIL_NLTECH}

LICITACIÓN A ANALIZAR:
Título: ${lic.titulo || ''}
Objeto: ${lic.objeto || ''}
Descripción: ${lic.descripcion || ''}
Organismo: ${lic.organismo || ''}
CPV: ${(lic.cpv || []).join(', ')}
Presupuesto: ${lic.presupuesto || lic.valor_estimado || 'no especificado'} €

IMPORTANTE: Solo tienes el objeto/descripción del contrato, NO el pliego completo.
Si el texto no da información suficiente sobre solvencia, dilo explícitamente en vez
de inventar requisitos. No inventes datos que no estén en el texto.`;

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: ESQUEMA_RESPUESTA,
      temperature: 0.2,
    },
  };

  const res = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const texto = await res.text();
    throw new Error(`Gemini ${res.status}: ${texto.slice(0, 300)}`);
  }

  const data = await res.json();
  const textoRespuesta = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!textoRespuesta) throw new Error('Respuesta de Gemini sin contenido');

  return JSON.parse(textoRespuesta);
}

async function main() {
  if (!GEMINI_API_KEY) throw new Error('Falta GEMINI_API_KEY');

  console.log('🧠 Buscando licitaciones publicadas sin analizar...');
  const { data: pendientes, error } = await supabase
    .from('licitaciones')
    .select('id_expediente,titulo,objeto,descripcion,organismo,cpv,presupuesto,valor_estimado')
    .ilike('estado', 'pub%')
    .is('ia_analizado_en', null)
    .gte('score', 30) // no gastar cuota en las que ni siquiera pasaron el filtro de reglas
    .order('score', { ascending: false })
    .limit(LIMITE_POR_EJECUCION);

  if (error) throw error;

  if (!pendientes || !pendientes.length) {
    console.log('✅ No hay pendientes de analizar.');
    return;
  }

  console.log(`   ${pendientes.length} licitaciones a analizar (máx ${LIMITE_POR_EJECUCION}/ejecución)`);

  let ok = 0, errores = 0;

  for (const lic of pendientes) {
    try {
      const analisis = await analizarConGemini(lic);
      const { error: errUpdate } = await supabase
        .from('licitaciones')
        .update({
          ia_resumen: analisis.resumen,
          ia_solvencia: analisis.requisitos_solvencia,
          ia_riesgos: analisis.riesgos,
          ia_encaja: analisis.encaja_nltech,
          ia_analizado_en: new Date().toISOString(),
        })
        .eq('id_expediente', lic.id_expediente);
      if (errUpdate) throw errUpdate;
      ok++;
      console.log(`   ✓ ${lic.titulo?.slice(0, 60) || lic.id_expediente}`);
    } catch (e) {
      errores++;
      console.error(`   ✗ Error en "${lic.titulo?.slice(0, 40)}":`, e.message);
    }
    await sleep(PAUSA_ENTRE_LLAMADAS_MS);
  }

  console.log(`\n✅ Análisis completado: ${ok} correctas, ${errores} errores`);
}

main().catch(e => { console.error('💥 Error fatal:', e); process.exit(1); });
