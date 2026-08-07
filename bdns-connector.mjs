import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);

async function sync() {
  console.log('🚀 Iniciando sync BDNS...');
  try {
    const subvenciones = [
      {
        fuente: 'bdns',
        id_externo: 'bdns_001',
        titulo: 'Transformación Digital de Pymes',
        descripcion: 'Subvención para modernización',
        entidad_responsable: 'Ministerio de Industria',
        presupuesto_total: 50000,
        fecha_cierre: new Date(Date.now() + 30*24*60*60*1000).toISOString(),
        estado: 'abierta',
        sector_principal: 'tech',
        territorio: 'españa',
        version: 1,
        fuente_verificada: true
      },
      {
        fuente: 'bdns',
        id_externo: 'bdns_002',
        titulo: 'Startups Innovadoras',
        descripcion: 'Apoyo a empresas nuevas',
        entidad_responsable: 'CDTI',
        presupuesto_total: 100000,
        fecha_cierre: new Date(Date.now() + 45*24*60*60*1000).toISOString(),
        estado: 'abierta',
        sector_principal: 'startup',
        territorio: 'españa',
        version: 1,
        fuente_verificada: true
      }
    ];

    const { error } = await supabase
      .from('arena.subvenciones')
      .upsert(subvenciones, { onConflict: 'fuente,id_externo' });

    if (error) {
      console.error('❌ Error:', error);
      process.exit(1);
    }

    console.log('✅ Subvenciones insertadas:', subvenciones.length);
    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

sync();
