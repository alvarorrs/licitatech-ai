import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);

const BOE_BASE = 'https://www.boe.es/datosabiertos/api/boe/sumario';
const DIAS_ATRAS = 7; // Cuántos días hacia atrás revisar cada ejecución

function formatearFechaBOE(fecha) {
  const y = fecha.getFullYear();
  const m = String(fecha.getMonth() + 1).padStart(2, '0');
  const d = String(fecha.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

function esSubvencion(titulo) {
  const lower = (titulo || '').toLowerCase();
  return lower.includes('subvencion') || 
         lower.includes('subvención') || 
         lower.includes('ayudas') ||
         lower.includes('convocatoria');
}

async function fetchSumarioDia(fechaStr) {
  const url = `${BOE_BASE}/${fechaStr}`;
  
  try {
    const response = await fetch(url, {
      headers: { 'Accept': 'application/json' }
    });

    if (!response.ok) {
      // Días sin BOE (festivos) devuelven error, es normal
      return null;
    }

    return response.json();
  } catch (error) {
    console.warn(`⚠️ Error obteniendo sumario ${fechaStr}: ${error.message}`);
    return null;
  }
}

function extraerAnunciosSubvenciones(sumarioData, fechaStr) {
  const anuncios = [];
  
  try {
    const diariosRaw = sumarioData?.data?.sumario?.diario || [];
    const diarios = Array.isArray(diariosRaw) ? diariosRaw : [diariosRaw];
    
    for (const diario of diarios) {
      const seccionesRaw = diario.seccion || [];
      const secciones = Array.isArray(seccionesRaw) ? seccionesRaw : [seccionesRaw];
      
      for (const seccion of secciones) {
        // Nos interesa sección V (Anuncios) principalmente, pero revisamos todas
        const departamentosRaw = seccion.departamento || [];
        const departamentos = Array.isArray(departamentosRaw) ? departamentosRaw : [departamentosRaw];
        
        for (const depto of departamentos) {
          const epigrafes = depto.epigrafe || [];
          const epigrafesArray = Array.isArray(epigrafes) ? epigrafes : [epigrafes];
          
          for (const epigrafe of epigrafesArray) {
            if (!epigrafe) continue;
            
            let items = epigrafe.item || [];
            items = Array.isArray(items) ? items : [items];
            
            for (const item of items) {
              if (!item || !item.titulo) continue;
              
              if (esSubvencion(item.titulo)) {
                anuncios.push({
                  fuente: 'boe',
                  id_externo: item.identificador,
                  titulo: item.titulo.substring(0, 500),
                  descripcion: item.titulo,
                  entidad_responsable: depto.nombre || '',
                  fecha_publicacion: `${fechaStr.substring(0,4)}-${fechaStr.substring(4,6)}-${fechaStr.substring(6,8)}`,
                  fecha_cierre: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
                  url_original: item.url_pdf?.texto || '',
                  bases_reguladoras_url: item.url_pdf?.texto || '',
                  estado: 'abierta',
                  territorio: 'españa',
                  sector_principal: 'general',
                  version: 1,
                  fuente_verificada: true
                });
              }
            }
          }
        }
      }
    }
  } catch (error) {
    console.warn(`⚠️ Error parseando sumario: ${error.message}`);
  }
  
  return anuncios;
}

async function guardarAnuncios(anuncios) {
  if (anuncios.length === 0) return 0;

  const { error } = await supabase
    .schema('arena')
    .from('subvenciones')
    .upsert(anuncios, { onConflict: 'fuente,id_externo' });

  if (error) {
    console.error('❌ Error guardando lote:', error.message);
    return 0;
  }

  return anuncios.length;
}

async function sync() {
  console.log('🚀 Iniciando sync BOE (anuncios de subvenciones)...');
  
  let totalEncontrados = 0;
  let totalGuardados = 0;
  let diasProcesados = 0;
  let diasSinPublicacion = 0;

  const hoy = new Date();

  for (let i = 0; i < DIAS_ATRAS; i++) {
    const fecha = new Date(hoy);
    fecha.setDate(fecha.getDate() - i);
    const fechaStr = formatearFechaBOE(fecha);

    console.log(`📅 Revisando BOE del ${fechaStr}...`);

    const sumario = await fetchSumarioDia(fechaStr);

    if (!sumario) {
      diasSinPublicacion++;
      continue;
    }

    diasProcesados++;
    const anuncios = extraerAnunciosSubvenciones(sumario, fechaStr);

    if (anuncios.length > 0) {
      totalEncontrados += anuncios.length;
      const guardados = await guardarAnuncios(anuncios);
      totalGuardados += guardados;
      console.log(`   ✅ ${anuncios.length} anuncios de subvenciones encontrados`);
    } else {
      console.log(`   📭 Sin anuncios de subvenciones`);
    }

    // Pausa pequeña entre días para no saturar la API del BOE
    await new Promise(r => setTimeout(r, 500));
  }

  console.log('═'.repeat(50));
  console.log('📊 RESUMEN SYNC BOE');
  console.log('═'.repeat(50));
  console.log(`Días con publicación:     ${diasProcesados}`);
  console.log(`Días sin publicación:     ${diasSinPublicacion}`);
  console.log(`Anuncios encontrados:     ${totalEncontrados}`);
  console.log(`Anuncios guardados:       ${totalGuardados}`);
  console.log('═'.repeat(50));

  process.exit(0);
}

sync().catch(error => {
  console.error('❌ Error fatal:', error);
  process.exit(1);
});
