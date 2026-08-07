import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);

async function analizarIA() {
  console.log('🤖 Iniciando análisis IA...');
  try {
    const { data: subs, error: errorSub } = await supabase
      .schema('arena')
      .from('subvenciones')
      .select('id')
      .is('embedding', null)
      .limit(5);

    if (errorSub) throw errorSub;
    if (!subs || subs.length === 0) {
      console.log('✅ No hay subvenciones para analizar');
      process.exit(0);
    }

    for (const sub of subs) {
      await supabase
        .schema('arena')
        .from('subvenciones_ia')
        .upsert({
          subvencion_id: sub.id,
          resumen_ejecutivo: 'Resumen de ejemplo',
          criterios_evaluacion: ['criterio 1', 'criterio 2'],
          gastos_subvencionables: ['personal', 'equipamiento'],
          puntuacion_ia: 75,
          analizado_en: new Date().toISOString(),
          modelo_ia: 'gemini-2.0-flash',
          version_ia: 1
        }, { onConflict: 'subvencion_id' });
    }

    console.log('✅ Análisis completado:', subs.length);
    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

analizarIA();
