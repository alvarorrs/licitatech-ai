// ============================================================
// LicitaTech AI — Sync de licitaciones PLACSP → Supabase
// Ejecutado por GitHub Actions cada 12h. 100% gratis, sin IA.
//
// Fuente oficial: feed ATOM/CODICE de licitaciones en perfiles
// del contratante (excluye contratos menores).
// https://www.hacienda.gob.es/.../LicitacionesContratante.aspx
// ============================================================

import { createClient } from '@supabase/supabase-js';
import { XMLParser } from 'fast-xml-parser';
import { calcularScore, pasaFiltroPrevio } from './rule-scoring.mjs';

const FEED_URL = 'https://contrataciondelsectorpublico.gob.es/sindicacion/sindicacion_643/licitacionesPerfilesContratanteCompleto3.atom';
const SYNC_ID = 'placsp_perfiles_contratante';
const MAX_PAGINAS_POR_EJECUCION = 20; // límite de seguridad por ejecución (500 entradas/página)

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true, // simplifica namespaces CODICE/UBL para no pelear con prefijos
});

async function fetchAtom(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'LicitaTechAI/1.0 (contacto: nltech.es)' },
  });
  if (!res.ok) throw new Error(`Error al descargar feed: ${res.status} ${res.statusText} (${url})`);
  const xml = await res.text();
  return xmlParser.parse(xml);
}

/**
 * Extrae el/los CPV de una entrada CODICE. La estructura real puede variar
 * ligeramente; se buscan varias rutas conocidas y se cae a raw si no se encuentra.
 */
function extraerCPV(contractFolder) {
  const codes = [];
  const classif = contractFolder?.ProcurementProject?.RequiredCommodityClassification;
  const arr = Array.isArray(classif) ? classif : [classif].filter(Boolean);
  for (const c of arr) {
    const code = c?.ItemClassificationCode?.['#text'] ?? c?.ItemClassificationCode;
    if (code) codes.push(String(code));
  }
  return codes;
}

function extraerImporte(contractFolder) {
  const budget = contractFolder?.ProcurementProject?.BudgetAmount;
  const val = budget?.EstimatedOverallContractAmount?.['#text'] ?? budget?.EstimatedOverallContractAmount
    ?? budget?.TotalAmount?.['#text'] ?? budget?.TotalAmount;
  return val ? Number(val) : null;
}

/**
 * Normaliza una <entry> del atom a nuestro esquema de `licitaciones`.
 * Guarda SIEMPRE el objeto original completo en raw_codice — así no se
 * pierde nada aunque un campo no esté bien mapeado.
 */
function normalizarEntry(entry) {
  const cf = entry?.ContractFolderStatus ?? {};
  const idExpediente = cf?.ContractFolderID ?? entry?.id;
  const party = cf?.LocatedContractingParty?.Party;
  const organismo = party?.PartyName?.Name ?? party?.PartyLegalEntity?.RegistrationName ?? null;
  const location = cf?.ProcurementProject?.RealizedLocation?.CountrySubentity ?? null;

  return {
    id_expediente: String(idExpediente ?? entry?.id ?? crypto.randomUUID()),
    titulo: entry?.title ?? cf?.ProcurementProject?.Name ?? null,
    objeto: cf?.ProcurementProject?.Name ?? null,
    descripcion: cf?.ProcurementProject?.Description ?? null,
    organismo,
    organo_contratacion: party?.PartyName?.Name ?? null,
    comunidad_autonoma: location ?? null,
    provincia: null, // se puede refinar con un mapeo CountrySubentityCode -> provincia
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

async function obtenerCursor() {
  const { data } = await supabase.from('sync_state').select('*').eq('id', SYNC_ID).maybeSingle();
  return data?.cursor_url || FEED_URL;
}

async function guardarCursor({ cursorUrl, nuevas, duplicadas, errores }) {
  await supabase.from('sync_state').upsert({
    id: SYNC_ID,
    cursor_url: cursorUrl,
    ultima_ejecucion: new Date().toISOString(),
    nuevas,
    duplicadas,
    errores,
  });
}

async function upsertLicitacion(lic, score) {
  // Mira si ya existe, para conservar histórico si cambia de estado
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
  console.log('🔄 LicitaTech AI — Iniciando sincronización...');
  const { cpv: cpvBiblioteca, keywords: keywordsBiblioteca } = await cargarBibliotecas();

  if (!cpvBiblioteca.length) {
    console.warn('⚠️  cpv_biblioteca está vacía — ejecuta sql/schema.sql en Supabase primero.');
  }

  let url = await obtenerCursor();
  let nuevas = 0, duplicadas = 0, errores = 0, descartadasPorFiltro = 0;
  let paginas = 0;

  while (url && paginas < MAX_PAGINAS_POR_EJECUCION) {
    console.log(`📄 Descargando página ${paginas + 1}: ${url}`);
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

    for (const entry of entries) {
      try {
        // <at:deleted-entry> indica que la licitación se retiró — se podría marcar como archivada
        if (entry?.['deleted-entry']) continue;

        const lic = normalizarEntry(entry);
        if (!pasaFiltroPrevio(lic, cpvBiblioteca)) {
          descartadasPorFiltro++;
          continue;
        }

        const score = calcularScore(lic, cpvBiblioteca, keywordsBiblioteca);
        const { esNueva } = await upsertLicitacion(lic, score);
        esNueva ? nuevas++ : duplicadas++;
      } catch (e) {
        console.error('❌ Error procesando entrada:', e.message);
        errores++;
      }
    }

    // Paginación: PLACSP encadena páginas via <link rel="next">
    const links = Array.isArray(root?.link) ? root.link : [root?.link].filter(Boolean);
    const next = links.find(l => l?.['@_rel'] === 'next')?.['@_href'];
    url = next || null;
    paginas++;
  }

  await guardarCursor({ cursorUrl: url ?? FEED_URL, nuevas, duplicadas, errores });

  console.log('✅ Sincronización completada:');
  console.log(`   Nuevas: ${nuevas} | Actualizadas: ${duplicadas} | Descartadas por filtro: ${descartadasPorFiltro} | Errores: ${errores}`);
}

main().catch(e => {
  console.error('💥 Fallo general del script:', e);
  process.exit(1);
});
