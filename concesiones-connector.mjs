import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);

const BDNS_URL = 'https://www.infosubvenciones.es/bdnstrans/api/concesiones/busqueda';
const PAGE_SIZE = 50;
const MAX_PAGINAS = 5;

async function fetchPagina(pagina) {
  const params = new URLSearchParams({
    fechaDesde: '01/01/2024',
    fechaHasta: '31/12/2026',
    pageSize: String(PAGE_SIZE),
    page: String(pagina),
    order: 'fechaConcesion',
    direccion: 'desc'
  });

  const url = `${BDNS_URL}?${params}`;
  const response = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!response.ok) throw new Error(`HTTP ${response.status} en página ${pagina}`);
  return response.json();
}

function normalizarConcesion(item) {
  return {
    fuente: 'bdns',
    numero_convocatoria: item.numeroConvocatoria || null,
    beneficiario: item.beneficiario || item.nombreBeneficiario || 'Desconocido',
    entidad_concedente: item.nivel3 || item.nivel2 || item.nivel1 || '',
    importe_concedido: item.importe ? parseFloat(item.importe) : null,
    fecha_concesion: item.fechaConcesion ? new Date(item.fechaConcesion).toISOString() : null,
    descripcion: item.descripcion || item.instrumento || '',
    territorio: item.nivel1 || ''
  };
}

async function sync() {
  console.log('🚀 Iniciando sync de concesiones históricas BDNS...');
  let total = 0;

  try {
    for (let pagina = 0; pagina < MAX_PAGINAS; pagina++) {
      console.log(`📄 Página ${pagina + 1}/${MAX_PAGINAS}...`);
      const data = await fetchPagina(pagina);
      const items = data.content || [];

      if (items.length === 0) {
        console.log('📭 Sin más resultados.');
        break;
      }

      const concesiones = items.map(normalizarConcesion);

      const { error } = await supabase
        .schema('arena')
        .from('concesiones_historicas')
        .upsert(concesiones, { onConflict: 'numero_convocatoria,beneficiario' });

      if (error) {
        console.error(`❌ Error en página ${pagina + 1}:`, error.message);
        continue;
      }

      total += concesiones.length;
      console.log(`   ✅ ${concesiones.length} concesiones procesadas`);
      await new Promise(r => setTimeout(r, 500));
    }

    console.log('═'.repeat(50));
    console.log(`📊 TOTAL concesiones históricas: ${total}`);
    console.log('═'.repeat(50));
    process.exit(0);

  } catch (error) {
    console.error('❌ Error fatal:', error);
    process.exit(1);
  }
}

sync();
