import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI } from '@google/generative-ai';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });

const MAX_ANALISIS = 15; // Reducido: cuota gratuita más ajustada desde dic 2025
const PAUSA_MS = 6000;    // Pausa mayor entre llamadas (límite ~10-15 RPM en free tier)

async function obtenerPendientes() {
  const { data, error } = await supabase
    .schema('arena')
    .from('subvenciones')
    .select('id, titulo, descripcion, entidad_responsable, territorio')
    .limit(1000);

  if (error) throw error;

  // Filtrar las que YA tienen análisis (evitar reanalizar)
  const { data: yaAnalizadas } = await supabase
    .schema('arena')
    .from('subvenciones_ia')
    .select('subvencion_id');

  const idsAnalizados = new Set((yaAnalizadas || []).map(a => a.subvencion_id));
  
  return (data || [])
    .filter(s => !idsAnalizados.has(s.id))
    .slice(0, MAX_ANALISIS);
}

async function analizarConGemini(subvencion) {
  const prompt = `
Eres un experto en subvenciones españolas. Analiza esta convocatoria y responde SOLO con JSON válido (sin markdown, sin \`\`\`json):

TÍTULO: ${subvencion.titulo}
ENTIDAD: ${subvencion.entidad_responsable}
TERRITORIO: ${subvencion.territorio}
DESCRIPCIÓN: ${subvencion.descripcion || 'No disponible'}

Responde con este formato exacto:
{
  "resumen_ejecutivo": "resumen de 2-3 frases explicando de qué trata esta subvención y quién podría beneficiarse, en lenguaje claro",
  "encaja_sectores": ["sector1", "sector2"],
  "puntuacion_ia": 50
}

Para puntuacion_ia usa un número del 0 al 100 según lo interesante/relevante que parece la ayuda basándote solo en el título y entidad (100 = muy relevante y clara, 50 = neutro/poca info, 0 = irrelevante).
Si no hay suficiente información, sé honesto en el resumen sobre esa limitación.
`;

  try {
    const result = await model.generateContent(prompt);
    const texto = result.response.text();
    const jsonMatch = texto.match(/\{[\s\S]*\}/);
    
    if (!jsonMatch) {
      console.warn(`⚠️ Sin JSON válido para: ${subvencion.titulo.substring(0, 50)}`);
      return null;
    }

    const analisis = JSON.parse(jsonMatch[0]);
    
    return {
      subvencion_id: subvencion.id,
      resumen_ejecutivo: analisis.resumen_ejecutivo || 'No se pudo generar resumen',
      encaja_sectores: analisis.encaja_sectores || [],
      puntuacion_ia: Math.min(100, Math.max(0, parseInt(analisis.puntuacion_ia) || 50)),
      analizado_en: new Date().toISOString(),
      modelo_ia: 'gemini-2.5-flash-lite',
      version_ia: 1
    };
  } catch (error) {
    console.error(`❌ Error Gemini para "${subvencion.titulo.substring(0, 50)}":`, error.message);
    return null;
  }
}

async function main() {
  console.log('🤖 Iniciando análisis IA real con Gemini...');

  const pendientes = await obtenerPendientes();
  
  if (pendientes.length === 0) {
    console.log('✅ No hay subvenciones pendientes de analizar.');
    process.exit(0);
  }

  console.log(`📋 Analizando ${pendientes.length} subvenciones...`);

  let exitosas = 0;

  for (let i = 0; i < pendientes.length; i++) {
    const sub = pendientes[i];
    console.log(`[${i + 1}/${pendientes.length}] ${sub.titulo.substring(0, 60)}...`);

    const analisis = await analizarConGemini(sub);

    if (analisis) {
      const { error } = await supabase
        .schema('arena')
        .from('subvenciones_ia')
        .upsert(analisis, { onConflict: 'subvencion_id' });

      if (error) {
        console.error('❌ Error guardando:', error.message);
      } else {
        exitosas++;
        console.log(`   ✅ Puntuación: ${analisis.puntuacion_ia}`);
      }
    }

    if (i < pendientes.length - 1) {
      await new Promise(r => setTimeout(r, PAUSA_MS));
    }
  }

  console.log('═'.repeat(50));
  console.log(`📊 Analizadas con éxito: ${exitosas}/${pendientes.length}`);
  console.log('═'.repeat(50));
  process.exit(0);
}

main().catch(error => {
  console.error('❌ Error fatal:', error);
  process.exit(1);
});
