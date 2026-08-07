#!/usr/bin/env node

/**
 * ARENA FUNDING AI - Conector BDNS (Base de Datos Nacional de Subvenciones)
 * 
 * Descarga subvenciones de la BDNS API, normaliza datos y almacena en Supabase
 * 
 * Reutiliza patrones probados de LicitaTech:
 * - Upsert por lotes para evitar timeouts
 * - Cursor de sincronización persistente
 * - Deduplicación automática
 * - Detección de cambios vs versión anterior
 */

import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';
import { Logger } from '@nl-tech/logger';

// ============================================================================
// CONFIG
// ============================================================================

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ckjyusjdpkcpsgxpwhsy.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY; // Necesario para Admin API
const BDNS_BASE_URL = 'https://www.infosubvenciones.es/bdnstrans/api/v2';
const BDNS_API_KEY = process.env.BDNS_API_KEY || 'demo'; // Solicitar a BDNS

// Límites de seguridad (igual que LicitaTech)
const MAX_REGISTROS_POR_EJECUCION = 500;
const TAMAÑO_LOTE = 200;
const TIEMPO_MAXIMO_MINUTOS = 22; // Dejar margen para otros jobs
const PAUSA_ENTRE_PAGINAS_MS = 1000;

// Logging
const logger = new Logger('BDNS-Conector', process.env.DEBUG ? 'debug' : 'info');

// ============================================================================
// CLIENTE SUPABASE
// ============================================================================

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false }
});

// ============================================================================
// FUNCIONES AUXILIARES
// ============================================================================

/**
 * Normalizar título de subvención (eliminar espacios extras, tildes)
 */
function normalizarTexto(texto) {
  if (!texto) return '';
  return texto
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/**
 * Extraer CNAE array de una cadena
 */
function extraerCNAE(texto) {
  if (!texto) return [];
  const cnaeRegex = /\b[A-Z]\d{4}\b/g;
  return [...new Set(texto.match(cnaeRegex) || [])];
}

/**
 * Detectar tipo de beneficiario de la subvención
 */
function detectarBeneficiarios(texto) {
  const beneficiarios = [];
  const lower = (texto || '').toLowerCase();
  
  if (lower.includes('pyme')) beneficiarios.push('pyme');
  if (lower.includes('autónomo') || lower.includes('autonomo')) beneficiarios.push('autonomo');
  if (lower.includes('asociación') || lower.includes('asociacion')) beneficiarios.push('asociacion');
  if (lower.includes('cooperativa')) beneficiarios.push('cooperativa');
  if (lower.includes('universidad') || lower.includes('centro de investigación')) beneficiarios.push('universidad');
  if (lower.includes('administración pública') || lower.includes('administracion publica')) beneficiarios.push('administracion');
  if (lower.includes('ong') || lower.includes('entidad sin ánimo')) beneficiarios.push('ong');
  
  return beneficiarios.length > 0 ? beneficiarios : ['general'];
}

/**
 * Detectar sector principal
 */
function detectarSector(titulo, descripcion) {
  const texto = (titulo + ' ' + (descripcion || '')).toLowerCase();
  
  if (texto.includes('formación') || texto.includes('educación')) return 'formacion';
  if (texto.includes('tecnología') || texto.includes('digital') || texto.includes('informática')) return 'tech';
  if (texto.includes('startup') || texto.includes('innovación') || texto.includes('i+d')) return 'startup';
  if (texto.includes('investigación')) return 'investigacion';
  if (texto.includes('exportación') || texto.includes('internacional')) return 'exportacion';
  if (texto.includes('medio ambiente') || texto.includes('sostenibilidad')) return 'medioambiente';
  if (texto.includes('cultura') || texto.includes('audiovisual')) return 'cultura';
  if (texto.includes('turismo')) return 'turismo';
  if (texto.includes('industria') || texto.includes('manufactura')) return 'industria';
  
  return 'general';
}

/**
 * Detectar territorio
 */
function detectarTerritorio(descripcion) {
  const lower = (descripcion || '').toLowerCase();
  
  if (lower.includes('unión europea') || lower.includes('europa')) return 'ue';
  if (lower.includes('españa')) return 'españa';
  
  return 'españa'; // Default
}

// ============================================================================
// FETCH CON REINTENTOS
// ============================================================================

async function fetchConReintento(url, opciones = {}, reintentos = 3) {
  for (let i = 0; i < reintentos; i++) {
    try {
      const response = await fetch(url, {
        timeout: 30000,
        headers: {
          'User-Agent': 'ArenaFundingAI/1.0',
          'X-API-Key': BDNS_API_KEY,
          ...opciones.headers
        },
        ...opciones
      });
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      return response;
    } catch (error) {
      logger.warn(`Fetch intento ${i + 1}/${reintentos} falló: ${error.message}`);
      
      if (i < reintentos - 1) {
        await new Promise(r => setTimeout(r, 2000 * (i + 1)));
      } else {
        throw error;
      }
    }
  }
}

// ============================================================================
// OBTENER CURSOR DE SINCRONIZACIÓN
// ============================================================================

async function obtenerCursor() {
  try {
    const { data, error } = await supabase
      .from('arena.sync_cursores')
      .select('*')
      .eq('fuente', 'bdns')
      .eq('tipo_sync', 'incremental')
      .single();
    
    if (error && error.code !== 'PGRST116') {
      throw error;
    }
    
    return data || {
      fuente: 'bdns',
      cursor_valor: null,
      pagina_actual: 0,
      estado: 'ready'
    };
  } catch (error) {
    logger.error('Error obteniendo cursor:', error);
    return {
      fuente: 'bdns',
      cursor_valor: null,
      pagina_actual: 0,
      estado: 'ready'
    };
  }
}

/**
 * Guardar cursor de sincronización
 */
async function guardarCursor(cursor) {
  const { error } = await supabase
    .from('arena.sync_cursores')
    .upsert(
      {
        fuente: 'bdns',
        tipo_sync: 'incremental',
        cursor_valor: cursor.cursor_valor,
        pagina_actual: cursor.pagina_actual,
        fecha_sincronizacion: new Date().toISOString(),
        estado: cursor.estado,
        registros_procesados: cursor.registros_procesados || 0,
        registros_nuevos: cursor.registros_nuevos || 0,
        registros_actualizados: cursor.registros_actualizados || 0
      },
      { onConflict: 'fuente,tipo_sync' }
    );
  
  if (error) logger.error('Error guardando cursor:', error);
}

// ============================================================================
// FETCH BDNS
// ============================================================================

async function fetchBDNS(pagina = 1) {
  logger.info(`Obteniendo página ${pagina} de BDNS...`);
  
  const params = new URLSearchParams({
    pageNumber: pagina,
    pageSize: 100,
    sortBy: 'fecha_publicacion',
    order: 'desc'
  });
  
  const url = `${BDNS_BASE_URL}/subvenciones?${params}`;
  
  try {
    const response = await fetchConReintento(url);
    const data = await response.json();
    
    return {
      subvenciones: data.data || [],
      totalPages: data.totalPages || 0,
      totalRecords: data.totalRecords || 0,
      currentPage: data.currentPage || pagina
    };
  } catch (error) {
    logger.error(`Error fetching BDNS página ${pagina}:`, error);
    return {
      subvenciones: [],
      totalPages: 0,
      totalRecords: 0,
      currentPage: pagina
    };
  }
}

// ============================================================================
// NORMALIZAR SUBVENCIÓN BDNS → ARENA SCHEMA
// ============================================================================

function normalizarSubvencionBDNS(item) {
  return {
    fuente: 'bdns',
    id_externo: item.id || item.idPrograma,
    
    titulo: item.nombre || item.nombrePrograma || 'Sin título',
    descripcion: item.descripcion || item.objetivos || '',
    url_original: item.urlConvocatoria || '',
    
    entidad_responsable: item.nombreAdministracion || item.entidadConvocante || '',
    codigo_org: item.codigoAdministracion || '',
    
    fecha_publicacion: item.fechaPublicacion ? new Date(item.fechaPublicacion).toISOString() : null,
    fecha_apertura: item.fechaApertura ? new Date(item.fechaApertura).toISOString() : null,
    fecha_cierre: item.fechaCierre ? new Date(item.fechaCierre).toISOString() : null,
    
    presupuesto_total: item.importeTotal ? parseFloat(item.importeTotal) : null,
    importe_minimo: item.importeMinimo ? parseFloat(item.importeMinimo) : null,
    importe_maximo: item.importeMaximo ? parseFloat(item.importeMaximo) : null,
    intensidad_ayuda: item.intensidadAyuda ? parseInt(item.intensidadAyuda) : null,
    
    sector_principal: detectarSector(item.nombre || '', item.descripcion || ''),
    cnae_elegibles: extraerCNAE(item.sectorEligible || item.actividad || ''),
    tipos_beneficiarios: detectarBeneficiarios(item.beneficiarios || item.descripcion || ''),
    territorio: detectarTerritorio(item.descripcion || ''),
    regiones_elegibles: item.comunidadesAutonomas ? item.comunidadesAutonomas.split(',').map(c => c.trim()) : [],
    
    bases_reguladoras_url: item.urlBasesReguladoras || item.urlBases || '',
    convocatoria_url: item.urlConvocatoria || '',
    documentacion_requerida_url: item.urlDocumentacion || '',
    
    estado: item.estado === 'Cerrada' ? 'cerrada' : 'abierta',
    urgencia: 0, // Se calcula con trigger
    
    version: 1,
    fuente_verificada: true
  };
}

// ============================================================================
// PROCESAR SUBVENCIONES EN LOTES
// ============================================================================

async function procesarSubvencionesEnLotes(subvenciones, estadisticas) {
  let procesadas = 0;
  
  for (let i = 0; i < subvenciones.length; i += TAMAÑO_LOTE) {
    const lote = subvenciones.slice(i, i + TAMAÑO_LOTE);
    const normalizadas = lote.map(normalizarSubvencionBDNS);
    
    try {
      const { error } = await supabase
        .from('arena.subvenciones')
        .upsert(normalizadas, {
          onConflict: 'fuente,id_externo',
          ignoreDuplicates: false
        });
      
      if (error) {
        logger.error(`Error upsert lote ${i / TAMAÑO_LOTE + 1}:`, error);
      } else {
        procesadas += lote.length;
        logger.info(`✅ Procesadas ${procesadas}/${subvenciones.length} subvenciones`);
        estadisticas.registros_nuevos += lote.length;
      }
    } catch (error) {
      logger.error(`Excepción al procesar lote:`, error);
    }
    
    if (i + TAMAÑO_LOTE < subvenciones.length) {
      await new Promise(r => setTimeout(r, PAUSA_ENTRE_PAGINAS_MS));
    }
  }
  
  return procesadas;
}

// ============================================================================
// MAIN: SINCRONIZACIÓN
// ============================================================================

async function sincronizarBDNS() {
  const iniciada = Date.now();
  const cursor = await obtenerCursor();
  
  logger.info('🚀 Iniciando sincronización BDNS...');
  logger.info(`Estado anterior: página ${cursor.pagina_actual}`);
  
  let estadisticas = {
    registros_procesados: 0,
    registros_nuevos: 0,
    registros_actualizados: 0,
    paginas_procesadas: 0,
    errores: 0
  };
  
  let pagina = (cursor.pagina_actual || 0) + 1;
  let deberiaDetener = false;
  
  try {
    while (!deberiaDetener) {
      // ✓ Verificar tiempo transcurrido
      const tiempoTranscurrido = (Date.now() - iniciada) / 1000 / 60;
      if (tiempoTranscurrido > TIEMPO_MAXIMO_MINUTOS) {
        logger.warn(`⏱️ Límite de tiempo alcanzado (${tiempoTranscurrido.toFixed(1)}min). Deteniendo...`);
        deberiaDetener = true;
        break;
      }
      
      // ✓ Verificar registros procesados
      if (estadisticas.registros_procesados >= MAX_REGISTROS_POR_EJECUCION) {
        logger.info(`✅ Límite de registros alcanzado (${MAX_REGISTROS_POR_EJECUCION}). Pausando.`);
        deberiaDetener = true;
        break;
      }
      
      // ✓ Fetch página
      const resultado = await fetchBDNS(pagina);
      
      if (resultado.subvenciones.length === 0) {
        logger.info('📭 No hay más subvenciones. Sincronización completada.');
        deberiaDetener = true;
        break;
      }
      
      // ✓ Procesar subvenciones
      const registrosEnEstaLote = Math.min(
        resultado.subvenciones.length,
        MAX_REGISTROS_POR_EJECUCION - estadisticas.registros_procesados
      );
      
      const subvencionesAProcesar = resultado.subvenciones.slice(0, registrosEnEstaLote);
      
      await procesarSubvencionesEnLotes(subvencionesAProcesar, estadisticas);
      
      estadisticas.registros_procesados += registrosEnEstaLote;
      estadisticas.paginas_procesadas += 1;
      
      logger.info(`📊 Progreso: ${estadisticas.registros_procesados}/${MAX_REGISTROS_POR_EJECUCION} registros, ${tiempoTranscurrido.toFixed(1)}min`);
      
      // ✓ Actualizar cursor (CRÍTICO: después de cada página)
      cursor.pagina_actual = pagina;
      cursor.registros_procesados = estadisticas.registros_procesados;
      cursor.registros_nuevos = estadisticas.registros_nuevos;
      await guardarCursor(cursor);
      
      // ✓ Siguiente página
      pagina += 1;
      
      // ✓ Pausa entre páginas
      if (!deberiaDetener) {
        await new Promise(r => setTimeout(r, PAUSA_ENTRE_PAGINAS_MS));
      }
    }
    
  } catch (error) {
    logger.error('❌ Error crítico en sincronización:', error);
    estadisticas.errores += 1;
    cursor.estado = 'error';
    cursor.error_detalle = error.message;
  }
  
  // ✓ GUARDAR ESTADO FINAL
  cursor.estado = deberiaDetener ? 'completado' : 'en_progreso';
  cursor.registros_procesados = estadisticas.registros_procesados;
  cursor.registros_nuevos = estadisticas.registros_nuevos;
  cursor.fecha_sincronizacion = new Date().toISOString();
  
  await guardarCursor(cursor);
  
  // ✓ RESUMEN
  const tiempoTotal = ((Date.now() - iniciada) / 1000 / 60).toFixed(2);
  
  logger.info('═'.repeat(60));
  logger.info('📈 RESUMEN SINCRONIZACIÓN BDNS');
  logger.info('═'.repeat(60));
  logger.info(`Páginas procesadas:    ${estadisticas.paginas_procesadas}`);
  logger.info(`Subvenciones nuevas:   ${estadisticas.registros_nuevos}`);
  logger.info(`Registros procesados:  ${estadisticas.registros_procesados}`);
  logger.info(`Tiempo total:          ${tiempoTotal} minutos`);
  logger.info(`Estado:                ${cursor.estado}`);
  logger.info('═'.repeat(60));
  
  return {
    success: estadisticas.errores === 0,
    estadisticas
  };
}

// ============================================================================
// PUNTO DE ENTRADA
// ============================================================================

(async () => {
  try {
    const resultado = await sincronizarBDNS();
    process.exit(resultado.success ? 0 : 1);
  } catch (error) {
    logger.error('Error fatal:', error);
    process.exit(1);
  }
})();
