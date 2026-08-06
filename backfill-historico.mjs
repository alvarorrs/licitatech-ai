// ============================================================
// LicitaTech AI — Backfill histórico
//
// Descarga y procesa el histórico oficial de PLACSP (por mes o por año),
// reutilizando el mismo parseo/scoring que la ingesta diaria.
//
// FUENTE VERIFICADA (Hacienda, no una web de terceros):
// "Se pueden descargar comprimidos los ficheros por año con las
//  actualizaciones producidas desde el 1 de enero de 2012 hasta el año
//  anterior en curso; o por meses del año en curso."
//  Patrón mensual: .../sindicacion_643/licitacionesPerfilesContratanteCompleto3_AAAAMM.zip
//
// AVISO HONESTO: el patrón MENSUAL está confirmado literalmente en la
// documentación oficial. El patrón ANUAL (para años completos, ej. 2023)
// se infiere del mismo texto pero no lo he visto escrito con el nombre
// exacto del fichero — el script lo intenta con el patrón más probable
// (_AAAA.zip) y si falla, lo dice claramente en el log para poder ajustar.
//
// Cada ZIP contiene varios .atom encadenados cronológicamente (el más
// antiguo enlaza al más reciente del paquete anterior). Este script:
//   1. Descarga el ZIP del periodo indicado
//   2. Lo descomprime con `unzip` (ya viene instalado en el runner)
//   3. Recorre TODOS los .atom encontrados, siguiendo el enlace rel="next"
//      cuando existe; si no lo encuentra, procesa todos los .atom por
//      orden de nombre (red de seguridad ante variaciones del formato)
//   4. Reutiliza el mismo parseo y scoring que sync-licitaciones-v4.mjs
//
// SE LANZA A MANO, período a período (workflow_dispatch con año/mes),
// para poder ir avanzando con calma sin arriesgar timeouts ni sorpresas.
// ============================================================

import { createClient } from '@supabase/supabase-js';
import { XMLParser } from 'fast-xml-parser';
import { execSync } from 'node:child_process';
import { readdirSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { calcularScore } from './rule-scoring.mjs';

const ANIO = process.env.BACKFILL_ANIO;   // ej. '2024'
const MES = process.env.BACKFILL_MES;     // ej. '03' (opcional — si falta, se usa el ZIP anual)
const CANAL_ID = 'placsp_perfiles_contratante';
const LOTE_UPSERT = 500;
const PRESUPUESTO_MS = 22 * 60 * 1000;
const INICIO = Date.now();
const tiempoAgotado = () => (Date.now() - INICIO) > PRESUPUESTO_MS;

if (!ANIO) { console.error('❌ Falta BACKFILL_ANIO'); process.exit(1); }

const BASE_URL = 'https://contrataciondelsectorpublico.gob.es/sindicacion/sindicacion_643';
const zipUrl = MES
  ? `${BASE_URL}/licitacionesPerfilesContratanteCompleto3_${ANIO}${MES}.zip`
  : `${BASE_URL}/licitacionesPerfilesContratanteCompleto3_${ANIO}.zip`;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true });

function extraerCPV(cf) {
  const codes = [];
  const classif = cf?.ProcurementProject?.RequiredCommodityClassification;
  const arr = Array.isArray(classif) ? classif : [classif].filter(Boolean);
  for (const c of arr) {
    const code = c?.ItemClassificationCode?.['#text'] ?? c?.ItemClassificationCode;
    if (code) codes.push(String(code));
  }
  return codes.length ? codes : ['92000000'];
}

function extraerImporte(cf) {
  const b = cf?.ProcurementProject?.BudgetAmount;
  const v = b?.EstimatedOverallContractAmount?.['#text'] ?? b?.EstimatedOverallContractAmount
    ?? b?.TotalAmount?.['#text'] ?? b?.TotalAmount;
  return v ? Number(v) : null;
}

function normalizarEntry(entry) {
  const cf = entry?.ContractFolderStatus ?? {};
  const idExpediente = cf?.ContractFolderID ?? entry?.id;
  const party = cf?.LocatedContractingParty?.Party;
  return {
    id_expediente: `${CANAL_ID}:${idExpediente ?? entry?.id ?? crypto.randomUUID()}`,
    titulo: entry?.title ?? cf?.ProcurementProject?.Name ?? 'Licitación sin título',
    objeto: cf?.ProcurementProject?.Name ?? entry?.title ?? '',
    descripcion: cf?.ProcurementProject?.Description ?? '',
    organismo: party?.PartyName?.Name ?? party?.PartyLegalEntity?.RegistrationName ?? 'Sin nombre',
    organo_contratacion: party?.PartyName?.Name ?? '',
    comunidad_autonoma: cf?.ProcurementProject?.RealizedLocation?.CountrySubentity ?? 'No especificada',
    provincia: null,
    municipio: null,
    fecha_publicacion: entry?.updated ? entry.updated.slice(0, 10) : null,
    fecha_limite: cf?.TenderingProcess?.TenderSubmissionDeadlinePeriod?.EndDate ?? null,
    estado: cf?.ContractFolderStatusCode?.['#text'] ?? cf?.ContractFolderStatusCode ?? null,
    tipo_contrato: cf?.ProcurementProject?.TypeCode?.['#text'] ?? cf?.ProcurementProject?.TypeCode ?? null,
    procedimiento: cf?.TenderingProcess?.ProcedureCode?.['#text'] ?? null,
    tipo_tramitacion: cf?.TenderingProcess?.UrgencyCode?.['#text'] ?? null,
    valor_estimado: extraerImporte(cf),
    presupuesto: extraerImporte(cf),
    cpv: extraerCPV(cf),
    enlace_oficial: entry?.link?.['@_href'] ?? (Array.isArray(entry?.link) ? entry.link[0]?.['@_href'] : null),
    documentos_urls: [],
    financiacion_europea: Boolean(cf?.ProcurementProject?.FundingProgramCode),
    lotes: cf?.ProcurementProjectLot ?? null,
    adjudicatarios: cf?.TenderResult ?? null,
    raw_codice: entry,
  };
}

async function cargarBibliotecas() {
  const [{ data: cpv }, { data: keywords }] = await Promise.all([
    supabase.from('cpv_biblioteca').select('*'),
    supabase.from('keywords_biblioteca').select('*'),
  ]);
  return { cpv: cpv ?? [], keywords: keywords ?? [] };
}

async function procesarLote(licitaciones, cpvBiblioteca, keywordsBiblioteca) {
  if (!licitaciones.length) return { nuevas: 0, actualizadas: 0 };
  const ids = licitaciones.map(l => l.id_expediente);

  const { data: existentes, error: errSelect } = await supabase
    .from('licitaciones').select('id_expediente, estado, historico').in('id_expediente', ids);
  if (errSelect) throw errSelect;
  const mapaExistentes = new Map((existentes || []).map(e => [e.id_expediente, e]));

  const filas = licitaciones.map(lic => {
    const score = calcularScore(lic, cpvBiblioteca, keywordsBiblioteca);
    const previo = mapaExistentes.get(lic.id_expediente);
    const historico = previo?.historico ?? [];
    if (previo && previo.estado !== lic.estado) historico.push({ estado: previo.estado, fecha: new Date().toISOString() });
    return { ...lic, ...score, historico, updated_at: new Date().toISOString() };
  });

  for (let i = 0; i < filas.length; i += LOTE_UPSERT) {
    const chunk = filas.slice(i, i + LOTE_UPSERT);
    const { error } = await supabase.from('licitaciones').upsert(chunk, { onConflict: 'id_expediente' });
    if (error) throw error;
  }

  const nuevas = licitaciones.filter(l => !mapaExistentes.has(l.id_expediente)).length;
  return { nuevas, actualizadas: licitaciones.length - nuevas };
}

/** Sigue la cadena rel="next" dentro del directorio descomprimido. */
function siguienteArchivoLocal(root, hrefNext) {
  if (!hrefNext) return null;
  const nombre = hrefNext.split('/').pop();
  const encontrado = readdirSync(root).find(f => f === nombre);
  return encontrado ? join(root, encontrado) : null;
}

async function main() {
  console.log(`📦 Backfill histórico — periodo: ${ANIO}${MES ? '-' + MES : ' (año completo)'}`);
  console.log(`   URL: ${zipUrl}`);

  const res = await fetch(zipUrl, { headers: { 'User-Agent': 'LicitaTechAI/1.0' } });
  if (!res.ok) {
    console.error(`❌ No se pudo descargar el ZIP (${res.status}). `);
    if (!MES) console.error('   El patrón anual es una inferencia — prueba con un mes concreto (BACKFILL_MES) para confirmar el nombre exacto del fichero.');
    process.exit(1);
  }

  const dirTmp = mkdtempSync(join(tmpdir(), 'placsp-backfill-'));
  const zipPath = join(dirTmp, 'datos.zip');
  const buffer = Buffer.from(await res.arrayBuffer());
  await import('node:fs/promises').then(fs => fs.writeFile(zipPath, buffer));
  console.log(`   ZIP descargado (${(buffer.length / 1e6).toFixed(1)} MB), descomprimiendo...`);

  execSync(`unzip -o "${zipPath}" -d "${dirTmp}"`, { stdio: 'inherit' });
  const archivosAtom = readdirSync(dirTmp).filter(f => f.endsWith('.atom')).sort();
  console.log(`   ${archivosAtom.length} ficheros .atom encontrados`);

  if (!archivosAtom.length) { console.error('❌ El ZIP no contiene ficheros .atom'); process.exit(1); }

  const { cpv: cpvBiblioteca, keywords: keywordsBiblioteca } = await cargarBibliotecas();

  // Construye la cadena empezando por el fichero "base" (el que no lleva
  // sufijo _2, _3... si existe; si no, el primero por orden alfabético).
  let archivoActual = archivosAtom.find(f => !/_\d+\.atom$/.test(f)) || archivosAtom[0];
  const visitados = new Set();
  let nuevas = 0, actualizadas = 0, errores = 0, ficheros = 0;

  while (archivoActual && !visitados.has(archivoActual)) {
    if (tiempoAgotado()) { console.log('⏱️ Presupuesto de tiempo agotado en este periodo — relanza el mismo mes para continuar (los ya guardados no se duplican).'); break; }
    visitados.add(archivoActual);

    const ruta = join(dirTmp, archivoActual);
    let feed;
    try {
      feed = xmlParser.parse(readFileSync(ruta, 'utf-8'));
    } catch (e) {
      console.error(`   ❌ Error parseando ${archivoActual}:`, e.message);
      errores++;
      break;
    }

    const root = feed?.feed ?? feed;
    const entries = Array.isArray(root?.entry) ? root.entry : [root?.entry].filter(Boolean);
    const licitaciones = entries.filter(e => !e?.['deleted-entry']).map(normalizarEntry);

    try {
      const r = await procesarLote(licitaciones, cpvBiblioteca, keywordsBiblioteca);
      nuevas += r.nuevas; actualizadas += r.actualizadas;
    } catch (e) {
      console.error(`   ❌ Error guardando lote de ${archivoActual}:`, e.message);
      errores++;
    }

    ficheros++;
    if (ficheros % 5 === 0) console.log(`   ✓ ${ficheros}/${archivosAtom.length} ficheros · ${nuevas + actualizadas} procesadas`);

    // Sigue el enlace rel="next" si existe; si no, cae al siguiente por orden alfabético
    const links = Array.isArray(root?.link) ? root.link : [root?.link].filter(Boolean);
    const hrefNext = links.find(l => l?.['@_rel'] === 'next')?.['@_href'];
    const siguientePorLink = siguienteArchivoLocal(dirTmp, hrefNext);
    archivoActual = siguientePorLink || archivosAtom.find(f => !visitados.has(f)) || null;
  }

  rmSync(dirTmp, { recursive: true, force: true });

  console.log(`\n✅ BACKFILL ${ANIO}${MES ? '-' + MES : ''} completado:`);
  console.log(`   Ficheros procesados: ${ficheros}/${archivosAtom.length} | Nuevas: ${nuevas} | Actualizadas: ${actualizadas} | Errores: ${errores}`);
}

main().catch(e => { console.error('💥 Error fatal:', e); process.exit(1); });
