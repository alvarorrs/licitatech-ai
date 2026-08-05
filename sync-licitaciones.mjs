// ============================================================
// LicitaTech AI — Sync PLACSP → Supabase (v2 mejorado)
// SIN filtro previo destructivo — captura TODO
// ============================================================

import { createClient } from '@supabase/supabase-js';
import { XMLParser } from 'fast-xml-parser';
import { calcularScore } from './rule-scoring.mjs';

const FEED_URL = 'https://contrataciondelsectorpublico.gob.es/sindicacion/sindicacion_643/licitacionesPerfilesContratanteCompleto3.atom';
const SYNC_ID = 'placsp_perfiles_contratante';
const MAX_PAGINAS = 50; // aumentado: capturar más páginas

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
});

async function fetchAtom(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'LicitaTechAI/1.0 (contacto: nltech.es)' },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return xmlParser.parse(await res.text());
}

function extraerCPV(contractFolder) {
  const codes = [];
  const classif = contractFolder?.ProcurementProject?.RequiredCommodityClassification;
  const arr = Array.isArray(classif) ? classif : [classif].filter(Boolean);
  for (const c of arr) {
    const code = c?.ItemClassificationCode?.['#text'] ?? c?.ItemClassificationCode;
    if (code) codes.push(String(code));
  }
  return codes.length > 0 ? codes : ['92000000']; // fallback a ocio/cultura si no hay CPV
}

function extraerImporte(contractFolder) {
  const budget = contractFolder?.ProcurementProject?.BudgetAmount;
  const val = budget?.EstimatedOverallContractAmount?.['#text'] ?? budget?.EstimatedOverallContractAmount
    ?? budget?.TotalAmount?.['#text'] ?? budget?.TotalAmount;
  return val ? Number(val) : null;
}

function normalizarEntry(entry) {
  const cf = entry?.ContractFolderStatus ?? {};
  const idExpediente = cf?.ContractFolderID ?? entry?.id;
  const party = cf?.LocatedContractingParty?.Party;
  const organismo = party?.PartyName?.Name ?? party?.PartyLegalEntity?.RegistrationName ?? 'Sin nombre';
  const location = cf?.ProcurementProject?.RealizedLocation?.CountrySubentity ?? null;

  return {
    id_expediente: String(idExpediente ?? entry?.id ?? crypto.randomUUID()),
    titulo: entry?.title ?? cf?.ProcurementProject?.Name ?? 'Licitación sin título',
    objeto: cf?.ProcurementProject?.Name ?? entry?.title ?? '',
    descripcion: cf?.ProcurementProject?.Description ?? '',
    organismo,
    organo_contratacion: party?.PartyName?.Name ?? '',
    comunidad_autonoma: location ?? 'No especificada',
    provincia: null,
    municipio: null,
    fecha_publicacion: entry?.updated ? entry.updated.slice(0, 10) : null,
    fecha_limite: cf?.TenderingProcess?.TenderSubmissionDeadlinePeriod?.EndDate ?? null,
    estado: cf?.ContractFolderStatusCode?.['#text'] ?? cf?.ContractFolderStatusCode ?? 'PUB',
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

async function obtenerCursor() {
  const { data } = await supabase.from('sync_state').select('*').eq('id', SYNC_ID).maybeSingle();
  return data?.cursor_url || FEED_URL;
}

async function guardarCursor(cursorUrl, nuevas, actualizadas, errores) {
  await supabase.from('sync_state').upsert({
    id: SYNC_ID,
    cursor_url: cursorUrl,
    ultima_ejecucion: new Date().toISOString(),
    nuevas,
    duplicadas: actualizadas,
    errores,
  });
}

async function upsertLicitacion(lic, score) {
  const { data: existente } = await supabase
    .from('licitaciones')
    .select('id, estado, historico')
    .eq('id_expediente', lic.id_expediente)
    .maybeSingle();

  const historico = existente?.historico ?? [];
  if (existente && existente.estado !== lic.estado) {
    historico.push({ estado: existente.estado, fecha: new Date().toISOString() });
  }

  const { error } = await supabase.from('licitaciones').upsert({
    ...lic,
    ...score,
    historico,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'id_expediente' });

  if (error) throw error;
  return { esNueva: !existente };
}

async function main() {
  console.log('🔄 LicitaTech AI — Sincronización iniciada (SIN filtro destructivo)');
  const { cpv: cpvBiblioteca, keywords: keywordsBiblioteca } = await cargarBibliotecas();

  if (!cpvBiblioteca.length) {
    console.warn('⚠️ cpv_biblioteca vacía — ejecuta schema.sql primero');
  }

  let url = await obtenerCursor();
  let nuevas = 0, actualizadas = 0, errores = 0, paginas = 0;

  while (url && paginas < MAX_PAGINAS) {
    console.log(`📄 Página ${paginas + 1}: descargando...`);
    let feed;
    try {
      feed = await fetchAtom(url);
    } catch (e) {
      console.error('❌ Error descargando feed:', e.message);
      errores++;
      break;
    }

    const root = feed?.feed ?? feed;
    const entries = Array.isArray(root?.entry) ? root.entry : [root?.entry].filter(Boolean);

    console.log(`   → ${entries.length} entradas encontradas`);

    for (const entry of entries) {
      try {
        if (entry?.['deleted-entry']) continue;

        const lic = normalizarEntry(entry);
        
        // ✅ CAMBIO CRÍTICO: Calcular score SIEMPRE, guardar TODO
        const score = calcularScore(lic, cpvBiblioteca, keywordsBiblioteca);
        const { esNueva } = await upsertLicitacion(lic, score);
        
        if (esNueva) nuevas++;
        else actualizadas++;
      } catch (e) {
        console.error('❌ Error procesando entrada:', e.message);
        errores++;
      }
    }

    const links = Array.isArray(root?.link) ? root.link : [root?.link].filter(Boolean);
    const next = links.find(l => l?.['@_rel'] === 'next')?.['@_href'];
    url = next || null;
    paginas++;

    if (paginas % 5 === 0) console.log(`   ✓ ${paginas} páginas procesadas, ${nuevas + actualizadas} licitaciones guardadas`);
  }

  await guardarCursor(url ?? FEED_URL, nuevas, actualizadas, errores);

  console.log('\n✅ SINCRONIZACIÓN COMPLETADA:');
  console.log(`   Nuevas: ${nuevas}`);
  console.log(`   Actualizadas: ${actualizadas}`);
  console.log(`   Errores: ${errores}`);
  console.log(`   Total: ${nuevas + actualizadas}`);
  console.log(`   Páginas procesadas: ${paginas}`);
}

main().catch(e => {
  console.error('💥 Error fatal:', e);
  process.exit(1);
});
