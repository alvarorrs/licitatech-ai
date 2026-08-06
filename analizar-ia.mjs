// ============================================================
// LicitaTech AI — Análisis IA con Gemini Flash (v2: lee el pliego PDF)
//
// Estructura verificada directamente contra datos reales de vuestra base
// (no adivinada):
//   ContractFolderStatus.LegalDocumentReference      -> PCAP (solvencia, cláusulas)
//   ContractFolderStatus.TechnicalDocumentReference  -> PPT  (qué se pide técnicamente)
//   ambos en .Attachment.ExternalReference.URI
//
// Gemini acepta el PDF directamente (sin OCR ni extracción de texto previa).
// Si no hay pliego disponible, cae al análisis solo con objeto/descripción
// (igual que la v1), para que nunca falle por completo.
// ============================================================

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODELO = 'gemini-flash-latest';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODELO}:generateContent?key=${GEMINI_API_KEY}`;

const LIMITE_POR_EJECUCION = 25;      // baja frente a la v1: descargar+mandar PDFs es más pesado
const PAUSA_ENTRE_LLAMADAS_MS = 5000; // ~12 RPM, margen amplio sobre el límite gratuito de 15
const TAMANO_MAX_PDF_BYTES = 15 * 1024 * 1024; // 15MB de margen bajo el límite de Gemini

const PERFIL_NLTECH = `NL Tech es una empresa de Cantabria (España) especializada en:
- Eventos y torneos de gaming/esports (ej. AstiGaming, LIGUCA)
- Formación tecnológica STEAM para jóvenes (robótica, programación, campus tecnológicos)
- Alquiler y suministro de equipamiento informático/gaming (PCs, consolas, pantallas, VR)
- Gestión de espacios y stands en ferias tecnológicas
Facturación anual actual: 30.000-50.000€. Empresa pequeña, sin gran capacidad financiera para
avales o garantías elevadas.`;

const ESQUEMA_RESPUESTA = {
  type: 'object',
  properties: {
    resumen: { type: 'string', description: 'Resumen ejecutivo en 2-4 frases de qué pide el contrato' },
    requisitos_solvencia: { type: 'string', description: 'Requisitos de solvencia económica/técnica EXACTOS si el pliego los detalla (facturación mínima, años de experiencia, clasificación empresarial, garantías). Si no hay pliego disponible y solo se infiere del importe, decirlo explícitamente.' },
    criterios_valoracion: { type: 'string', description: 'Cómo se puntúa la oferta (ej. 60% precio / 40% memoria técnica). Vacío si no consta.' },
    riesgos: { type: 'string', description: 'Motivos de duda para presentarse: requisitos que probablemente NO se cumplan, plazos ajustados, cláusulas desfavorables. Vacío si no hay ninguno claro.' },
    encaja_nltech: { type: 'boolean', description: 'true si el objeto del contrato encaja razonablemente con los servicios de NL Tech' },
    cumple_solvencia_probable: { type: 'string', enum: ['si', 'no', 'no_se_puede_determinar'], description: 'Estimación de si NL Tech cumpliría los requisitos de solvencia, dada su facturación de 30-50k€' },
  },
  required: ['resumen', 'requisitos_solvencia', 'riesgos', 'encaja_nltech', 'cumple_solvencia_probable'],
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** Extrae las URLs de PCAP y PPT del XML CODICE ya parseado (raw_codice). */
function extraerDocumentosPliego(rawCodice) {
  const cf = rawCodice?.ContractFolderStatus;
  if (!cf) return {};
  const pcap = cf?.LegalDocumentReference?.Attachment?.ExternalReference?.URI;
  const ppt = cf?.TechnicalDocumentReference?.Attachment?.ExternalReference?.URI;
  return { pcapUrl: pcap || null, pptUrl: ppt || null };
}

async function descargarPdfBase64(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'LicitaTechAI/1.0 (contacto: nltech.es)' } });
  if (!res.ok) throw new Error(`Descarga falló: ${res.status}`);
  const buffer = await res.arrayBuffer();
  if (buffer.byteLength > TAMANO_MAX_PDF_BYTES) throw new Error(`PDF demasiado grande (${(buffer.byteLength / 1e6).toFixed(1)}MB)`);
  return Buffer.from(buffer).toString('base64');
}

async function analizarConGemini(lic, pdfsBase64) {
  const prompt = `Eres un asistente que ayuda a una empresa española a evaluar licitaciones públicas.

PERFIL DE LA EMPRESA:
${PERFIL_NLTECH}

LICITACIÓN:
Título: ${lic.titulo || ''}
Objeto: ${lic.objeto || ''}
Organismo: ${lic.organismo || ''}
Presupuesto: ${lic.presupuesto || lic.valor_estimado || 'no especificado'} €

${pdfsBase64.length
  ? 'Se adjunta el pliego oficial (PCAP y/o PPT) en PDF. Basa tu análisis de solvencia y criterios de valoración en el CONTENIDO REAL de esos documentos, citando cifras exactas cuando existan.'
  : 'NO se ha podido obtener el PDF del pliego para esta licitación. Basa el análisis solo en el objeto/descripción y dilo explícitamente en "requisitos_solvencia" — no inventes cifras que no tengas.'}

No inventes datos que no estén en el texto o los documentos.`;

  const parts = [{ text: prompt }];
  pdfsBase64.forEach(b64 => parts.push({ inline_data: { mime_type: 'application/pdf', data: b64 } }));

  const body = {
    contents: [{ parts }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: ESQUEMA_RESPUESTA, temperature: 0.2 },
  };

  const res = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const texto = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!texto) throw new Error('Respuesta de Gemini sin contenido');
  return JSON.parse(texto);
}

async function main() {
  if (!GEMINI_API_KEY) throw new Error('Falta GEMINI_API_KEY');

  console.log('🧠 Buscando licitaciones publicadas sin analizar...');
  const { data: pendientes, error } = await supabase
    .from('licitaciones')
    .select('id_expediente,titulo,objeto,descripcion,organismo,cpv,presupuesto,valor_estimado,raw_codice')
    .ilike('estado', 'pub%')
    .is('ia_analizado_en', null)
    .gte('score', 30)
    .order('score', { ascending: false })
    .limit(LIMITE_POR_EJECUCION);

  if (error) throw error;
  if (!pendientes?.length) { console.log('✅ No hay pendientes.'); return; }
  console.log(`   ${pendientes.length} licitaciones a analizar`);

  let ok = 0, conPdf = 0, errores = 0;

  for (const lic of pendientes) {
    try {
      const { pcapUrl, pptUrl } = extraerDocumentosPliego(lic.raw_codice);
      const pdfsBase64 = [];
      const urlsUsadas = [];

      for (const url of [pcapUrl, pptUrl].filter(Boolean)) {
        try {
          pdfsBase64.push(await descargarPdfBase64(url));
          urlsUsadas.push(url);
        } catch (e) {
          console.warn(`   ⚠️ No se pudo descargar un documento: ${e.message}`);
        }
      }
      if (pdfsBase64.length) conPdf++;

      const analisis = await analizarConGemini(lic, pdfsBase64);

      const { error: errUpdate } = await supabase
        .from('licitaciones')
        .update({
          ia_resumen: analisis.resumen,
          ia_solvencia: analisis.requisitos_solvencia +
            (analisis.criterios_valoracion ? `\n\nCriterios de valoración: ${analisis.criterios_valoracion}` : '') +
            `\n\n¿Cumpliríamos solvencia?: ${analisis.cumple_solvencia_probable}`,
          ia_riesgos: analisis.riesgos,
          ia_encaja: analisis.encaja_nltech,
          documentos_urls: urlsUsadas,
          ia_analizado_en: new Date().toISOString(),
        })
        .eq('id_expediente', lic.id_expediente);
      if (errUpdate) throw errUpdate;

      ok++;
      console.log(`   ✓ [${pdfsBase64.length ? 'con PDF' : 'sin PDF'}] ${lic.titulo?.slice(0, 55) || lic.id_expediente}`);
    } catch (e) {
      errores++;
      console.error(`   ✗ Error en "${lic.titulo?.slice(0, 40)}":`, e.message);
    }
    await sleep(PAUSA_ENTRE_LLAMADAS_MS);
  }

  console.log(`\n✅ Completado: ${ok} correctas (${conPdf} con pliego real leído), ${errores} errores`);
}

main().catch(e => { console.error('💥 Error fatal:', e); process.exit(1); });
