#!/usr/bin/env node

/**
 * ARENA FUNDING AI - Análisis IA con Gemini Flash
 * 
 * Lee subvenciones nuevas de BDNS y genera:
 * - Resumen ejecutivo en lenguaje claro
 * - Criterios de evaluación
 * - Requisitos de solvencia
 * - Gastos subvencionables
 * - Puntuación IA (0-100)
 * - Embeddings para búsqueda semántica
 * 
 * Reutiliza patrón de LicitaTech: máx 25 análisis/ejecución, 5s pausa entre llamadas
 */

import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import fetch from 'node-fetch';
import { Logger } from '@nl-tech/logger';

// ============================================================================
// CONFIG
// ============================================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const MAX_ANALISIS_POR_EJECUCION = 25;
const PAUSA_ENTRE_LLAMADAS_MS = 5000; // 5s = ~12 RPM (límite gratuito Gemini)
const TAMAÑO_BATCH_INSERCIONES = 5;

const logger = new Logger('IA-Analyzer', 'info');

// ============================================================================
// CLIENTES
// ============================================================================

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false }
});

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

// ============================================================================
// DESCARGAR DOCUMENTO PDF
// ============================================================================

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
    logger.warn(`No se pudo descargar PDF (${url}): ${error.message}`);
    return null;
  }
}

// ============================================================================
// OBTENER SUBVENCIONES NO ANALIZADAS
// ============================================================================

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
      .is('embedding', null)  // Solo las no analizadas
      .eq('estado', 'abierta')  // Solo abiertas
      .order('creado_en', { ascending: true })
      .limit(MAX_ANALISIS_POR_EJECUCION);
    
    if (error) throw error;
    return data || [];
  } catch (error) {
    logger.error('Error obteniendo subvenciones:', error);
    return [];
  }
}

// ============================================================================
// ANÁLISIS CON GEMINI
// ============================================================================

async function analizarConGemini(subvencion) {
  logger.info(`📊 Analizando: ${subvencion.titulo.substring(0, 60)}...`);
  
  // Descargar PDF de bases si existe
  let pdfBase64 = null;
  let fuente_pdf = 'bases';
  
  if (subvencion.bases_reguladoras_url) {
    pdfBase64 = await descargarPDF(subvencion.bases_reguladoras_url);
  }
  
  if (!pdfBase64 && subvencion.convocatoria_url) {
    pdfBase64 = await descargarPDF(subvencion.convocatoria_url);
    fuente_pdf = 'convocatoria';
  }
  
  // Construir mensaje
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
    
    // Limpiar JSON (puede tener ```json ... ``` alrededor)
    const jsonMatch = texto.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn(`No se encontró JSON válido en respuesta para ${subvencion.id}`);
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
      encaja_sectores: analisis.encaja_sectores || [subvencion.sector_principal],
      analizado_en: new Date().toISOString(),
      modelo_ia: 'gemini-2.0-flash',
      version_ia: 1
    };
  } catch (error) {
    logger.error(`Error en análisis Gemini para ${subvencion.id}:`, error);
    return null;
  }
}

// ============================================================================
// GUARDAR ANÁLISIS EN SUPABASE
// ============================================================================

async function guardarAnalisis(analisisList) {
  if (analisisList.length === 0) return 0;
  
  try {
    // Guardar en tabla subvenciones_ia
    const { error: errorIA } = await supabase
      .from('arena.subvenciones_ia')
      .upsert(analisisList, {
        onConflict: 'subvencion_id'
      });
    
    if (errorIA) {
      logger.error('Error guardando análisis IA:', errorIA);
      return 0;
    }
    
    // Actualizar embeddings en tabla subvenciones
    // (Nota: en producción, usaría pgvector para embeddings, aquí es placeholder)
    const { error: errorUpdate } = await supabase
      .rpc('marcar_analizadas', {
        subvencion_ids: analisisList.map(a => a.subvencion_id)
      });
    
    if (errorUpdate && errorUpdate.code !== 'PGRST102') {
      logger.warn('RPC marcar_analizadas no existe (primera vez)');
    }
    
    return analisisList.length;
  } catch (error) {
    logger.error('Error guardando análisis:', error);
    return 0;
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function analizarSubvenciones() {
  const iniciada = Date.now();
  
  logger.info('🤖 Iniciando análisis IA de subvenciones BDNS...');
  
  // 1. Obtener subvenciones sin analizar
  const subvenciones = await obtenerSubvencionesAAnalizar();
  
  if (subvenciones.length === 0) {
    logger.info('✅ No hay subvenciones pendientes de análisis');
    return { success: true, analizadas: 0 };
  }
  
  logger.info(`📋 Encontradas ${subvenciones.length} subvenciones para analizar`);
  
  // 2. Procesar en lotes
  let analizadas = 0;
  const analisisCompletos = [];
  
  for (let i = 0; i < subvenciones.length; i++) {
    const subvencion = subvenciones[i];
    
    // Esperar entre llamadas (API rate limiting)
    if (i > 0) {
      await new Promise(r => setTimeout(r, PAUSA_ENTRE_LLAMADAS_MS));
    }
    
    // Analizar
    const analisis = await analizarConGemini(subvencion);
    
    if (analisis) {
      analisisCompletos.push(analisis);
      analizadas += 1;
    }
    
    logger.info(`Progreso: ${i + 1}/${subvenciones.length}`);
    
    // Guardar en batch
    if (analisisCompletos.length % TAMAÑO_BATCH_INSERCIONES === 0 || i === subvenciones.length - 1) {
      const guardadas = await guardarAnalisis(analisisCompletos);
      logger.info(`✅ Guardadas ${guardadas} análisis en BD`);
      analisisCompletos.length = 0;
    }
  }
  
  // 3. Resumen
  const tiempoTotal = ((Date.now() - iniciada) / 1000 / 60).toFixed(2);
  
  logger.info('═'.repeat(60));
  logger.info('📊 RESUMEN ANÁLISIS IA');
  logger.info('═'.repeat(60));
  logger.info(`Subvenciones analizadas: ${analizadas}`);
  logger.info(`Tiempo total:            ${tiempoTotal} minutos`);
  logger.info('═'.repeat(60));
  
  return { success: true, analizadas };
}

// ============================================================================
// PUNTO DE ENTRADA
// ============================================================================

(async () => {
  try {
    const resultado = await analizarSubvenciones();
    process.exit(resultado.success ? 0 : 1);
  } catch (error) {
    logger.error('Error fatal:', error);
    process.exit(1);
  }
})();
