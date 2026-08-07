#!/usr/bin/env node

import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import fetch from 'node-fetch';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const MAX_ANALISIS_POR_EJECUCION = 25;
const PAUSA_ENTRE_LLAMADAS_MS = 5000;
const TAMAÑO_BATCH_INSERCIONES = 5;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false }
});

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

async function descargarPDF(url) {
  if (!url) return null;
  
  try {
    const response = await fetch(url, {
      timeout: 30000,
      headers: {
        'User-Agent': 'ArenaFundingAI/1.0'
      }
    });
    
    if (!response.ok) return null;
    
    const buffer = await response.buffer();
    return Buffer.from(buffer).toString('base64');
  } catch (error) {
    console.warn(`No se pudo descargar PDF (${url}): ${error.message}`);
    return null;
  }
}

async function obtenerSubvencionesAAnalizar() {
  try {
    const { data, error } = await supabase
      .from('arena.subvenciones')
      .select(`
        id,
        titulo,
        descripcion,
        entidad_responsable,
        presupuesto_total,
        sector_principal,
        bases_reguladoras_url,
        convocatoria_url,
        fecha_cierre
      `)
      .is('embedding', null)
      .eq('estado', 'abierta')
      .order('creado_en', { ascending: true })
      .limit(MAX_ANALISIS_POR_EJECUCION);
    
    if (error) throw error;
    return data || [];
  } catch (error) {
    console.error('Error obteniendo subvenciones:', error);
    return [];
  }
}

async function analizarConGemini(subvencion) {
  console.log(`📊 Analizando: ${subvencion.titulo.substring(0, 60)}...`);
  
  let pdfBase64 = null;
  let fuente_pdf = 'bases';
  
  if (subvencion.bases_reguladoras_url) {
    pdfBase64 = await descargarPDF(subvencion.bases_reguladoras_url);
  }
  
  if (!pdfBase64 && subvencion.convocatoria_url) {
    pdfBase64 = await descargarPDF(subvencion.convocatoria_url);
    fuente_pdf = 'convocatoria';
  }
  
  const partes = [];
  
  if (pdfBase64) {
    partes.push({
      inlineData: {
        mimeType: 'application/pdf',
        data: pdfBase64
      }
    });
  }
  
  const prompt = `
Eres un experto en subvenciones españolas con 15 años de experiencia.
Analiza esta convocatoria de subvención y proporciona en JSON estructurado:

TÍTULO: ${subvencion.titulo}
DESCRIPCIÓN: ${subvencion.descripcion}
PRESUPUESTO: €${subvencion.presupuesto_total || 'No especificado'}
ENTIDAD: ${subvencion.entidad_responsable}
SECTOR: ${subvencion.sector_principal}

Responde SOLO con JSON válido, sin preambles:

{
  "resumen_ejecutivo": "200-300 palabras en lenguaje claro y directo",
  "criterios_evaluacion": ["criterio 1", "criterio 2", "criterio 3"],
  "criterios_puntuacion": "Ej: '40% precio + 30% memoria + 30% impacto'",
  "requisitos_solvencia": "Qué documentación financiera/legal necesitan",
  "gastos_subvencionables": ["gasto 1", "gasto 2", "gasto 3"],
  "gastos_excluidos": ["excluido 1", "excluido 2"],
  "incompatibilidades": ["No compatible con otra ayuda X", "No compatible con Y"],
  "riesgos_principales": [
    "Riesgo 1: descripción",
    "Riesgo 2: descripción"
  ],
  "oportunidades": [
    "Oportunidad 1: descripción",
    "Oportunidad 2: descripción"
  ],
  "puntuacion_ia": 75,
  "encaja_sectores": ["formacion", "tech", "startup"]
}

Si el PDF está vacío o corrupto, usa la descripción textual. Si falta información, no inventes datos.
Siempre responde SOLO con JSON.
  `;
  
  partes.push({ text: prompt });
  
  try {
    const response = await model.generateContent({
      contents: [{ role: 'user', parts: partes }],
      generationConfig: {
        temperature: 1,
        topP: 0.95,
        topK: 40,
        maxOutputTokens: 1500
      }
    });
    
    const texto = response.response.text();
    
    const jsonMatch = texto.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn(`No se encontró JSON válido en respuesta para ${subvencion.id}`);
      return null;
    }
    
    const analisis = JSON.parse(jsonMatch[0]);
    
    return {
      subvencion_id: subvencion.id,
      resumen_ejecutivo: analisis.resumen_ejecutivo,
      resumen_criterios: analisis.criterios_puntuacion,
      criterios_evaluacion: analisis.criterios_evaluacion || [],
      requisitos_solvencia: analisis.requisitos_solvencia,
      requisitos_solvencia_lista: (analisis.requisitos_solvencia || '').split('\n').filter(r => r.trim()),
      gastos_subvencionables: analisis.gastos_subvencionables || [],
      gastos_excluidos: analisis.gastos_excluidos || [],
      incompatibilidades: analisis.incompatibilidades || [],
      riesgos_principales: analisis.riesgos_principales || [],
      oportunidades: analisis.oportunidades || [],
      puntuacion_ia: Math.min(100, Math.max(0, analisis.puntuacion_ia || 50)),
      encaja_sectores: analisis.encaja_sectores || [],
      analizado_en: new Date().toISOString(),
      modelo_ia: 'gemini-2.0-flash',
      version_ia: 1
    };
  } catch (error) {
    console.error(`Error en análisis Gemini para ${subvencion.id}:`, error);
    return null;
  }
}

async function guardarAnalisis(analisisList) {
  if (analisisList.length === 0) return 0;
  
  try {
    const { error: errorIA } = await supabase
      .from('arena.subvenciones_ia')
      .upsert(analisisList, {
        onConflict: 'subvencion_id'
      });
    
    if (errorIA) {
      console.error('Error guardando análisis IA:', errorIA);
      return 0;
    }
    
    return analisisList.length;
  } catch (error) {
    console.error('Error guardando análisis:', error);
    return 0;
  }
}

async function analizarSubvenciones() {
  const iniciada = Date.now();
  
  console.log('🤖 Iniciando análisis IA de subvenciones BDNS...');
  
  const subvenciones = await obtenerSubvencionesAAnalizar();
  
  if (subvenciones.length === 0) {
    console.log('✅ No hay subvenciones pendientes de análisis');
    return { success: true, analizadas: 0 };
  }
  
  console.log(`📋 Encontradas ${subvenciones.length} subvenciones para analizar`);
  
  let analizadas = 0;
  const analisisCompletos = [];
  
  for (let i = 0; i < subvenciones.length; i++) {
    const subvencion = subvenciones[i];
    
    if (i > 0) {
      await new Promise(r => setTimeout(r, PAUSA_ENTRE_LLAMADAS_MS));
    }
    
    const analisis = await analizarConGemini(subvencion);
    
    if (analisis) {
      analisisCompletos.push(analisis);
      analizadas += 1;
    }
    
    console.log(`Progreso: ${i + 1}/${subvenciones.length}`);
    
    if (analisisCompletos.length % TAMAÑO_BATCH_INSERCIONES === 0 || i === subvenciones.length - 1) {
      const guardadas = await guardarAnalisis(analisisCompletos);
      console.log(`✅ Guardadas ${guardadas} análisis en BD`);
      analisisCompletos.length = 0;
    }
  }
  
  const tiempoTotal = ((Date.now() - iniciada) / 1000 / 60).toFixed(2);
  
  console.log('═'.repeat(60));
  console.log('📊 RESUMEN ANÁLISIS IA');
  console.log('═'.repeat(60));
  console.log(`Subvenciones analizadas: ${analizadas}`);
  console.log(`Tiempo total:            ${tiempoTotal} minutos`);
  console.log('═'.repeat(60));
  
  return { success: true, analizadas };
}

(async () => {
  try {
    const resultado = await analizarSubvenciones();
    process.exit(resultado.success ? 0 : 1);
  } catch (error) {
    console.error('Error fatal:', error);
    process.exit(1);
  }
})();
