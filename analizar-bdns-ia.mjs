import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI } from '@google/generative-ai';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const geminiModel = genAI.getGenerativeModel({ model: 'gemini-flash-latest' });

const MAX_ANALISIS = 100;
const PAUSA_MS = 500;

function construirPrompt(subvencion) {
  return `
Eres un experto en subvenciones españolas. Analiza esta convocatoria y responde SOLO con JSON válido (sin markdown, sin \`\`\`json):

TÍTULO: ${subvencion.titulo}
ENTIDAD: ${subvencion.entidad_responsable}
TERRITORIO: ${subvencion.territorio}
DESCRIPCIÓN: ${subvencion.descripcion || 'No disponible'}

Responde con este formato exacto:
{
  "resumen_ejecutivo": "resumen de 2-3 frases explicando de qué trata esta subvención y quién podría beneficiarse, en lenguaje claro",
  "encaja_sectores": ["sector1", "sector2"],
  "puntuacion_ia": 50,
  "fecha_cierre_detectada": "2026-12-31 o null si no se menciona ninguna fecha o plazo concreto en el texto",
  "restriccion_geografica": "nombre de la CCAA/provincia/municipio concreto si el título o descripción limitan explícitamente a un territorio, o null si no hay ninguna restricción geográfica mencionada o si aplica a toda España",
  "restriccion_sector": "descripción breve del sector/CNAE/actividad concreta si el título o descripción limitan explícitamente a un tipo de empresa o actividad (ej: 'solo agricultura', 'solo comercio textil'), o null si no hay restricción sectorial clara o aplica a cualquier sector"
}

Para puntuacion_ia usa un número del 0 al 100 según lo interesante/relevante que parece la ayuda basándote solo en el título y entidad (100 = muy relevante y clara, 50 = neutro/poca info, 0 = irrelevante).
Para fecha_cierre_detectada: solo rellena si el título o descripción mencionan EXPLÍCITAMENTE una fecha límite o plazo concreto (formato YYYY-MM-DD). Si no aparece ninguna fecha o plazo, pon null. No inventes ni calcules fechas relativas tipo "15 días desde publicación" si no puedes resolver la fecha exacta.
Para restriccion_geografica y restriccion_sector: sé estricto, solo pon algo si está explícito en el texto, nunca lo infieras ni lo supongas.
Si no hay suficiente información, sé honesto en el resumen sobre esa limitación.
`;
}

function parsearJSON(texto) {
  const jsonMatch = texto.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    return JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }
}

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

async function intentarDeepSeek(prompt) {
  const response = await fetch(DEEPSEEK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
    },
    body: JSON.stringify({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: prompt }],
      temperature: 1,
      max_tokens: 1200,
      response_format: { type: 'json_object' }
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`DeepSeek HTTP ${response.status}: ${errText.substring(0, 150)}`);
  }

  const data = await response.json();
  const texto = data.choices?.[0]?.message?.content || '';
  const json = parsearJSON(texto);
  if (!json) throw new Error(`DeepSeek: respuesta sin JSON válido (finish_reason: ${data.choices?.[0]?.finish_reason})`);
  return json;
}

async function intentarGemini(prompt) {
  const result = await geminiModel.generateContent(prompt);
  const texto = result.response.text();
  const json = parsearJSON(texto);
  if (!json) throw new Error('Gemini: respuesta sin JSON válido');
  return json;
}

async function analizarSubvencion(subvencion) {
  const prompt = construirPrompt(subvencion);
  let analisis = null;
  let proveedorUsado = null;

  try {
    analisis = await intentarDeepSeek(prompt);
    proveedorUsado = 'deepseek-v4-flash';
  } catch (errorDeepSeek) {
    console.warn(`   ⚠️ DeepSeek falló (${errorDeepSeek.message}), probando Gemini...`);

    try {
      analisis = await intentarGemini(prompt);
      proveedorUsado = 'gemini-flash-latest';
    } catch (errorGemini) {
      console.error(`   ❌ Gemini también falló: ${errorGemini.message}`);
      return null;
    }
  }

  let fechaCierreDetectada = null;
  if (analisis.fecha_cierre_detectada && analisis.fecha_cierre_detectada !== 'null') {
    const fechaParseada = new Date(analisis.fecha_cierre_detectada);
    if (!isNaN(fechaParseada.getTime()) && fechaParseada > new Date()) {
      fechaCierreDetectada = fechaParseada.toISOString();
    }
  }

  return {
    subvencion_id: subvencion.id,
    resumen_ejecutivo: analisis.resumen_ejecutivo || 'No se pudo generar resumen',
    encaja_sectores: analisis.encaja_sectores || [],
    puntuacion_ia: Math.min(100, Math.max(0, parseInt(analisis.puntuacion_ia) || 50)),
    analizado_en: new Date().toISOString(),
    modelo_ia: proveedorUsado,
    version_ia: 1,
    fecha_cierre_detectada: fechaCierreDetectada,
    restriccion_geografica: (analisis.restriccion_geografica && analisis.restriccion_geografica !== 'null') ? analisis.restriccion_geografica : null,
    restriccion_sector: (analisis.restriccion_sector && analisis.restriccion_sector !== 'null') ? analisis.restriccion_sector : null
  };
}

async function main() {
  console.log('🤖 Iniciando análisis IA (DeepSeek principal, Gemini respaldo)...');

  const pendientes = await obtenerPendientes();

  if (pendientes.length === 0) {
    console.log('✅ No hay subvenciones pendientes de analizar.');
    process.exit(0);
  }

  console.log(`📋 Analizando ${pendientes.length} subvenciones...`);

  let exitosas = 0;
  let usadasDeepSeek = 0;
  let usadasGemini = 0;

  for (let i = 0; i < pendientes.length; i++) {
    const sub = pendientes[i];
    console.log(`[${i + 1}/${pendientes.length}] ${sub.titulo.substring(0, 60)}...`);

    const analisis = await analizarSubvencion(sub);

    if (analisis) {
      const fechaDetectada = analisis.fecha_cierre_detectada;
      delete analisis.fecha_cierre_detectada;

      const { error } = await supabase
        .schema('arena')
        .from('subvenciones_ia')
        .upsert(analisis, { onConflict: 'subvencion_id' });

      if (error) {
        console.error('   ❌ Error guardando:', error.message);
      } else {
        exitosas++;
        if (analisis.modelo_ia === 'deepseek-v4-flash') usadasDeepSeek++;
        else usadasGemini++;
        console.log(`   ✅ Puntuación: ${analisis.puntuacion_ia} (${analisis.modelo_ia})`);

        if (fechaDetectada) {
          const { error: errorFecha } = await supabase
            .schema('arena')
            .from('subvenciones')
            .update({ fecha_cierre: fechaDetectada, fecha_cierre_confirmada: true })
            .eq('id', sub.id);

          if (!errorFecha) {
            console.log(`   📅 Fecha de cierre real detectada: ${fechaDetectada.substring(0, 10)}`);
          }
        }
      }
    }

    if (i < pendientes.length - 1) {
      await new Promise(r => setTimeout(r, PAUSA_MS));
    }
  }

  console.log('═'.repeat(50));
  console.log(`📊 Analizadas con éxito: ${exitosas}/${pendientes.length}`);
  console.log(`   · DeepSeek: ${usadasDeepSeek}`);
  console.log(`   · Gemini (respaldo): ${usadasGemini}`);
  console.log('═'.repeat(50));
  process.exit(0);
}

main().catch(error => {
  console.error('❌ Error fatal:', error);
  process.exit(1);
});
