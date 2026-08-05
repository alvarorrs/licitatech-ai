// ============================================================
// LicitaTech AI — Sync PLACSP → Supabase (v4, optimizado)
//
// Cambios frente a v3 (que agotaba los 30 min de GitHub Actions):
//  1. Consultas por LOTES: 1 SELECT por página en vez de 1 por licitación
//  2. UPSERT por LOTES de 500 en vez de uno a uno
//  3. Cursor guardado DESPUÉS DE CADA PÁGINA — si el job se corta,
//     la siguiente ejecución continúa donde se quedó (antes se perdía todo)
//  4. Presupuesto de tiempo: para limpiamente antes del límite del runner
// ============================================================

import { createClient } from '@supabase/supabase-js';
import { XMLParser } from 'fast-xml-parser';
import { calcularScore } from './rule-scoring.mjs';

const CANALES = [
  {
    id: 'placsp_perfiles_contratante',
    nombre: 'Licitaciones (perfiles del contratante)',
    url: 'https://contrataciondelsectorpublico.gob.es/sindicacion/sindicacion_643/licitacionesPerfilesContratanteCompleto3.atom',
  },
  {
    id: 'placsp_contratos_menores',
    nombre: 'Contratos menores',
    url: 'https://contrataciondelsectorpublico.gob.es/sindicacion/sindicacion_1143/contratosMenoresPerfilesContratantes.atom',
  },
];

const MAX_PAGINAS_POR_CANAL = 200;          // ya no es el cuello de botella
const LOTE_UPSERT = 500;                    // filas por escritura
const PRESUPUESTO_MS = 22 * 60 * 1000;      // 22 min: deja margen antes del timeout
const INICIO = Date.now();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true });

const tiempoAgotado = () => (Date.now() - INICIO) > PRESUPUESTO_MS;

async function fetchAtom(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'LicitaTechAI/1.0 (contacto: nltech.es)' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} (${url})`);
  return xmlParser.parse(await res.text());
}

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

function normalizarEntry(entry, canalId) {
  const cf = entry?.ContractFolderStatus ?? {};
  const idExpediente = cf?.ContractFolderID ?? entry?.id;
  const party = cf?.LocatedContractingParty?.Party;
  return {
    id_expediente: `${canalId}:${idExpediente ?? entry?.id ?? crypto.randomUUID()}`,
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
    estado: cf?.ContractFolderStatusCode?.['#text'] ?? cf?.ContractFolderStatusCode ?? 'PUB',
    tipo_contrato: cf?.ProcurementProject?.TypeCode?.['#text'] ?? cf?.ProcurementProject?.TypeCode ?? null,
    procedimiento: cf?.TenderingProcess?.ProcedureCode?.['#text'] ?? (canalId.includes('menor') ? 'Contrato menor' : null),
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

async function obtenerCursor(canalId, urlDefault) {
  const { data } = await supabase.from('sync_state').select('*').eq('id', canalId).maybeSingle();
  return data?.cursor_url || urlDefault;
}

async function guardarCursor(canalId, cursorUrl, nuevas, actualizadas, errores) {
  await supabase.from('sync_state').upsert({
    id: canalId,
    cursor_url: cursorUrl,
    ultima_ejecucion: new Date().toISOString(),
    nuevas, duplicadas: actualizadas, errores,
  });
}

/**
 * Procesa una página completa con solo 1 SELECT + N/500 UPSERTs,
 * en vez de 2 consultas por licitación (que es lo que reventaba el tiempo).
 */
async function procesarLote(licitaciones, cpvBiblioteca, keywordsBiblioteca) {
  if (!licitaciones.length) return { nuevas: 0, actualizadas: 0 };

  const ids = licitaciones.map(l => l.id_expediente);

  // 1 sola consulta para saber cuáles ya existen y con qué estado
  const { data: existentes, error: errSelect } = await supabase
    .from('licitaciones')
    .select('id_expediente, estado, historico')
    .in('id_expediente', ids);

  if (errSelect) throw errSelect;

  const mapaExistentes = new Map((existentes || []).map(e => [e.id_expediente, e]));

  const filas = licitaciones.map(lic => {
    const score = calcularScore(lic, cpvBiblioteca, keywordsBiblioteca);
    const previo = mapaExistentes.get(lic.id_expediente);
    const historico = previo?.historico ?? [];
    if (previo && previo.estado !== lic.estado) {
      historico.push({ estado: previo.estado, fecha: new Date().toISOString() });
    }
    return { ...lic, ...score, historico, updated_at: new Date().toISOString() };
  });

  // Escritura por lotes
  for (let i = 0; i < filas.length; i += LOTE_UPSERT) {
    const chunk = filas.slice(i, i + LOTE_UPSERT);
    const { error } = await supabase.from('licitaciones').upsert(chunk, { onConflict: 'id_expediente' });
    if (error) throw error;
  }

  const nuevas = licitaciones.filter(l => !mapaExistentes.has(l.id_expediente)).length;
  return { nuevas, actualizadas: licitaciones.length - nuevas };
}

async function sincronizarCanal(canal, cpvBiblioteca, keywordsBiblioteca) {
  console.log(`\n📡 Canal: ${canal.nombre}`);
  let url = await obtenerCursor(canal.id, canal.url);
  let nuevas = 0, actualizadas = 0, errores = 0, paginas = 0;

  while (url && paginas < MAX_PAGINAS_POR_CANAL) {
    if (tiempoAgotado()) {
      console.log(`   ⏱️ Presupuesto de tiempo agotado — se guarda el cursor y continúa en la próxima ejecución`);
      break;
    }

    let feed;
    try {
      feed = await fetchAtom(url);
    } catch (e) {
      console.error(`   ❌ Error descargando:`, e.message);
      errores++;
      break;
    }

    const root = feed?.feed ?? feed;
    const entries = Array.isArray(root?.entry) ? root.entry : [root?.entry].filter(Boolean);
    const licitaciones = entries
      .filter(e => !e?.['deleted-entry'])
      .map(e => normalizarEntry(e, canal.id));

    try {
      const r = await procesarLote(licitaciones, cpvBiblioteca, keywordsBiblioteca);
      nuevas += r.nuevas;
      actualizadas += r.actualizadas;
    } catch (e) {
      console.error('   ❌ Error guardando lote:', e.message);
      errores++;
    }

    const links = Array.isArray(root?.link) ? root.link : [root?.link].filter(Boolean);
    const next = links.find(l => l?.['@_rel'] === 'next')?.['@_href'];
    url = next || null;
    paginas++;

    // CLAVE: guardar el cursor tras cada página. Si el runner corta el job,
    // no se pierde el progreso ni se vuelve a empezar desde el principio.
    await guardarCursor(canal.id, url ?? canal.url, nuevas, actualizadas, errores);

    if (paginas % 10 === 0) {
      const min = ((Date.now() - INICIO) / 60000).toFixed(1);
      console.log(`   ✓ ${paginas} páginas · ${nuevas + actualizadas} procesadas · ${min} min`);
    }
  }

  console.log(`   ✅ ${canal.nombre}: ${nuevas} nuevas, ${actualizadas} actualizadas, ${errores} errores (${paginas} páginas)`);
  return { nuevas, actualizadas, errores };
}

async function main() {
  console.log('🔄 LicitaTech AI v4 — Sincronización por lotes');
  const { cpv: cpvBiblioteca, keywords: keywordsBiblioteca } = await cargarBibliotecas();
  if (!cpvBiblioteca.length) console.warn('⚠️ cpv_biblioteca vacía');
  if (!keywordsBiblioteca.length) console.warn('⚠️ keywords_biblioteca vacía');

  let tN = 0, tA = 0, tE = 0;
  for (const canal of CANALES) {
    if (tiempoAgotado()) { console.log(`⏭️ Sin tiempo para el canal "${canal.nombre}" — irá en la próxima ejecución`); continue; }
    try {
      const r = await sincronizarCanal(canal, cpvBiblioteca, keywordsBiblioteca);
      tN += r.nuevas; tA += r.actualizadas; tE += r.errores;
    } catch (e) {
      console.error(`💥 Canal "${canal.nombre}" falló:`, e.message);
      tE++;
    }
  }

  const min = ((Date.now() - INICIO) / 60000).toFixed(1);
  console.log(`\n✅ COMPLETADO en ${min} min — Nuevas: ${tN} | Actualizadas: ${tA} | Errores: ${tE}`);
}

main().catch(e => { console.error('💥 Error fatal:', e); process.exit(1); });
