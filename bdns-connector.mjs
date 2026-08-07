#!/usr/bin/env node

import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ckjyusjdpkcpsgxpwhsy.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const BDNS_BASE_URL = 'https://www.infosubvenciones.es/bdnstrans/api/v2';
const BDNS_API_KEY = process.env.BDNS_API_KEY || 'demo';

const MAX_REGISTROS_POR_EJECUCION = 500;
const TAMAÑO_LOTE = 200;
const TIEMPO_MAXIMO_MINUTOS = 22;
const PAUSA_ENTRE_PAGINAS_MS = 1000;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false }
});

function normalizarTexto(texto) {
  if (!texto) return '';
  return texto
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function extraerCNAE(texto) {
  if (!texto) return [];
  const cnaeRegex = /\b[A-Z]\d{4}\b/g;
  return [...new Set(texto.match(cnaeRegex) || [])];
}

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
  if
