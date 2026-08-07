import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);

const BDNS_URL = 'https://www.infosubvenciones.es/bdnstrans/api/convocatorias/busqueda';
const PAGE_SIZE = 50;
const MAX_PAGINAS = 5;

function detectarTerritorio(nivel1) {
  if (nivel1 === 'ESTADO') return 'españa';
  if (nivel1 === 'CCAA') return 'autonomico';
  if (nivel1 === 'LOCAL') return 'local';
  return 'españa';
}

function normalizar(item) {
  const fechaPublicacion = item.fechaRecepcion ? new Date(item.fechaRecepcion).toISOString() : null;
  const fechaCierreEstimada = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();

  return {
    fuente: 'bdns',
    id_externo: `bdns_${item.id}`,
    titulo: (item.descripcion || 'Sin título').substring(0, 500),
    descripcion: item.descripcion || '',
    entidad_responsable: item.nivel3 || item.nivel2 || item.nivel1 || '',
    fecha_publicacion: fechaPublicacion,
    fecha_cierre: fechaCierreEstimada,
    estado: 'abierta',
    territorio: detectarTerritorio(item.nivel1),
    version: 1,
    fuente_verificada: true
  };
}

async function fetchPagina(pagina) {
  const params = new URLSearchParams({
    fechaDesde: '01/01/2026',
    fechaHasta: '31/12/2026',
    pageSize: String(PAGE_SIZE),
    page: String(pagina),
    order: 'numeroConvocatoria',
    direccion: 'desc'
  });

  const url = `${BDNS_URL}?${params}`;
  const response = await fetch(url, {
    headers: { 'Accept': 'application/json' }
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} en página ${pagina}`);
  }

  return response.json();
}

async function sync() {
  console.log('🚀 Iniciando sync BDNS (datos reales)...');
  let totalInsertadas = 0;

  try {
    for (let pagina = 0; pagina < MAX_PAGINAS; pagina++) {
      console.log(`📄 Obteniendo página ${pagina + 1}/${MAX_PAGINAS}...`);
      
      const data = await fetchPagina(pagina);
      const items = data.content || [];

      if (items.length === 0) {
        console.log('📭 No hay más resultados.');
        break;
      }

      const subvenciones = items.map(normalizar);

      const { error } = await supabase
        .schema('arena')
        .from('subvenciones')
        .upsert(subvenciones, { onConflict: 'fuente,id_externo' });

      if (error) {
        console.error(`❌ Error en página ${pagina + 1}:`, error);
        continue;
      }

      totalInsertadas += subvenciones.length;
      console.log(`✅ Página ${pagina + 1}: ${subvenciones.length} subvenciones procesadas`);

      await new Promise(r => setTimeout(r, 500));
    }

    console.log('═'.repeat(50));
    console.log(`📊 TOTAL procesadas: ${totalInsertadas}`);
    console.log('═'.repeat(50));
    process.exit(0);

  } catch (error) {
    console.error('❌ Error fatal:', error);
    process.exit(1);
  }
}

sync();
