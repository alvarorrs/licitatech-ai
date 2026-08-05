// ============================================================
// LicitaTech AI — Sync PLACSP → Supabase (v3)
// Novedades:
//  - Multi-canal: licitaciones "grandes" + contratos menores
//  - Usa rule-scoring v3 (normalización de tildes/mayúsculas)
//  - Sin filtro destructivo: guarda TODO
// ============================================================

import { createClient } from '@supabase/supabase-js';
import { XMLParser } from 'fast-xml-parser';
import { calcularScore } from './rule-scoring.mjs';

// ---------- Canales oficiales PLACSP ----------
// Nota: la URL de contratos menores se ha construido siguiendo el mismo
// patrón documentado que el canal principal (sindicación 1143, confirmada
// en la web oficial de datos abiertos de Hacienda). Si en la primera
// ejecución diera 404, hay que revisar el nombre exacto del .atom base
// en https://www.hacienda.gob.es/.../ContratosMenores.aspx
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

const MAX_PAGINAS_POR_CANAL = 50;

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
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} (${url})`);
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
  return codes.length > 0 ? codes : ['92000000'];
}

function extraerImporte(contractFolder) {
  const budget = contractFolder?.ProcurementProject?.BudgetAmount;
  const val = budget?.EstimatedOverallContractAmount?.['#text'] ?? budget?.EstimatedOverallContractAmount
    ?? budget?.TotalAmount?.['#text'] ?? budget?.TotalAmount;
  return val ? Number(val) : null;
}

function normalizarEntry(entry, canalId) {
  const cf = entry?.ContractFolderStatus ?? {};
  const idExpediente = cf?.ContractFolderID ?? entry?.id;
  const party = cf?.LocatedContractingParty?.Party;
  const organismo = party?.PartyName?.Name ?? party?.PartyLegalEntity?.RegistrationName ?? 'Sin nombre';
  const location = cf?.ProcurementProject?.RealizedLocation?.CountrySubentity ?? null;

  return {
    // Prefijo por canal para evitar colisión de IDs entre canales
    id_expediente: `${canalId}:${idExpediente ?? entry?.id ?? crypto.randomUUID()}`,
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

async function sincronizarCanal(canal, cpvBiblioteca, keywordsBiblioteca) {
  console.log(`\n📡 Canal: ${canal.nombre}`);
  let url = await obtenerCursor(canal.id, canal.url);
  let nuevas = 0, actualizadas = 0, errores = 0, paginas = 0;

  while (url && paginas < MAX_PAGINAS_POR_CANAL) {
    let feed;
    try {
      feed = await fetchAtom(url);
    } catch (e) {
      console.error(`   ❌ Error descargando (${canal.nombre}):`, e.message);
      errores++;
      break;
    }

    const root = feed?.feed ?? feed;
    const entries = Array.isArray(root?.entry) ? root.entry : [root?.entry].filter(Boolean);

    for (const entry of entries) {
      try {
        if (entry?.['deleted-entry']) continue;
        const lic = normalizarEntry(entry, canal.id);
        const score = calcularScore(lic, cpvBiblioteca, keywordsBiblioteca);
        const { esNueva } = await upsertLicitacion(lic, score);
        esNueva ? nuevas++ : actualizadas++;
      } catch (e) {
        console.error('   ❌ Error procesando entrada:', e.message);
        errores++;
      }
    }

    const links = Array.isArray(root?.link) ? root.link : [root?.link].filter(Boolean);
    const next = links.find(l => l?.['@_rel'] === 'next')?.['@_href'];
    url = next || null;
    paginas++;

    if (paginas % 10 === 0) console.log(`   ✓ ${paginas} páginas · ${nuevas + actualizadas} guardadas`);
  }

  await guardarCursor(canal.id, url ?? canal.url, nuevas, actualizadas, errores);
  console.log(`   ✅ ${canal.nombre}: ${nuevas} nuevas, ${actualizadas} actualizadas, ${errores} errores (${paginas} páginas)`);
  return { nuevas, actualizadas, errores };
}

async function main() {
  console.log('🔄 LicitaTech AI v3 — Sincronización multi-canal iniciada');
  const { cpv: cpvBiblioteca, keywords: keywordsBiblioteca } = await cargarBibliotecas();

  if (!cpvBiblioteca.length) console.warn('⚠️ cpv_biblioteca vacía');
  if (!keywordsBiblioteca.length) console.warn('⚠️ keywords_biblioteca vacía');

  let totalNuevas = 0, totalActualizadas = 0, totalErrores = 0;

  for (const canal of CANALES) {
    try {
      const r = await sincronizarCanal(canal, cpvBiblioteca, keywordsBiblioteca);
      totalNuevas += r.nuevas;
      totalActualizadas += r.actualizadas;
      totalErrores += r.errores;
    } catch (e) {
      // Si un canal falla completo (ej. URL 404), no bloquea el resto
      console.error(`💥 Canal "${canal.nombre}" falló completamente:`, e.message);
      totalErrores++;
    }
  }

  console.log('\n✅ SINCRONIZACIÓN COMPLETADA (todos los canales):');
  console.log(`   Nuevas: ${totalNuevas} | Actualizadas: ${totalActualizadas} | Errores: ${totalErrores}`);
}

main().catch(e => {
  console.error('💥 Error fatal:', e);
  process.exit(1);
});
