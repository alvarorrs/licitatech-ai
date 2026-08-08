import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_DESTINO = 'Nltechesports@gmail.com';
const EMAIL_ORIGEN = 'ARENA Radar <onboarding@resend.dev>'; // Ajustar si tenéis dominio verificado en Resend

// ============ ETIQUETAS DE NEGOCIO NL TECH (mismo criterio que RADAR) ============
const CATEGORIAS_NLTECH = {
  gaming:    { label: '🎮 Gaming', kw: ['gaming', 'esport', 'e-sport', 'videojueg', 'videojuego', 'lan party', 'torneo videojuego'] },
  eventos:   { label: '🎪 Eventos', kw: ['evento', 'festival', 'feria', 'congreso', 'jornada tecnologic', 'jornadas tecnologic', 'exposicion', 'exposición'] },
  tecnologia:{ label: '💻 Tecnología', kw: ['tecnolog', 'digital', 'informatic', 'informátic', 'software', 'hardware', 'ciberseguridad', 'inteligencia artificial', ' ia ', 'programacion', 'programación', 'robotic', 'robótic'] },
  formacion: { label: '🎓 Formación', kw: ['formacion', 'formación', 'curso', 'taller', 'capacitacion', 'capacitación', 'academia', 'campus tech', 'bootcamp'] },
  alquiler:  { label: '🖥️ Alquiler equipos', kw: ['alquiler', 'arrendamiento', 'renting', 'equipamiento informatico', 'equipamiento informático', 'equipos informaticos', 'equipos informáticos', 'material informatico', 'material informático'] }
};

function normalizar(t) {
  return t ? t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '') : '';
}

function detectarEtiquetas(texto) {
  const norm = normalizar(texto);
  const tags = [];
  for (const [id, cat] of Object.entries(CATEGORIAS_NLTECH)) {
    if (cat.kw.some(k => norm.includes(normalizar(k)))) tags.push(cat.label);
  }
  return tags;
}

function diasRestantes(fecha) {
  if (!fecha) return null;
  return Math.ceil((new Date(fecha) - new Date()) / (1000 * 60 * 60 * 24));
}

const DIAS_MIN_MARGEN = 3;
const HORAS_VENTANA = 24; // Buscar novedades de las últimas 24h

async function obtenerNovedadesSubvenciones() {
  const desde = new Date(Date.now() - HORAS_VENTANA * 60 * 60 * 1000).toISOString();

  const { data: subs, error } = await supabase
    .schema('arena')
    .from('subvenciones')
    .select('id,titulo,entidad_responsable,presupuesto_total,fecha_cierre,fecha_cierre_confirmada,estado,url_original,creado_en')
    .gte('creado_en', desde)
    .eq('estado', 'abierta')
    .eq('fecha_cierre_confirmada', true);

  if (error) { console.error('Error subvenciones:', error); return []; }
  if (!subs || subs.length === 0) return [];

  const { data: iaData } = await supabase
    .schema('arena')
    .from('subvenciones_ia')
    .select('subvencion_id,resumen_ejecutivo,puntuacion_ia');

  const iaMap = {};
  (iaData || []).forEach(ia => { iaMap[ia.subvencion_id] = ia; });

  return subs
    .map(s => {
      const ia = iaMap[s.id];
      const dias = diasRestantes(s.fecha_cierre);
      const tags = detectarEtiquetas(`${s.titulo} ${s.entidad_responsable}`);
      return {
        tipo: 'Subvención',
        titulo: s.titulo,
        entidad: s.entidad_responsable,
        presupuesto: s.presupuesto_total,
        dias,
        score: ia?.puntuacion_ia ?? null,
        tags,
        url: s.url_original
      };
    })
    .filter(it => it.dias !== null && it.dias >= DIAS_MIN_MARGEN && it.tags.length > 0);
}

async function obtenerNovedadesLicitaciones() {
  const desde = new Date(Date.now() - HORAS_VENTANA * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('licitaciones_lista')
    .select('id_expediente,titulo,organismo,presupuesto,valor_estimado,fecha_limite,fecha_publicacion,estado,enlace_oficial,score')
    .gte('fecha_publicacion', desde)
    .ilike('estado', 'pub%');

  if (error) { console.error('Error licitaciones:', error); return []; }
  if (!data || data.length === 0) return [];

  const vistos = new Set();
  return data
    .filter(l => { if (vistos.has(l.id_expediente)) return false; vistos.add(l.id_expediente); return true; })
    .map(l => {
      const dias = diasRestantes(l.fecha_limite);
      const tags = detectarEtiquetas(`${l.titulo} ${l.organismo}`);
      return {
        tipo: 'Licitación',
        titulo: l.titulo,
        entidad: l.organismo,
        presupuesto: l.presupuesto || l.valor_estimado,
        dias,
        score: l.score ?? null,
        tags,
        url: l.enlace_oficial
      };
    })
    .filter(it => it.dias !== null && it.dias >= DIAS_MIN_MARGEN && it.tags.length > 0);
}

function formatDinero(n) {
  if (!n && n !== 0) return '—';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M €';
  if (n >= 1000) return (n / 1000).toFixed(0) + 'k €';
  return n + ' €';
}

function generarHTML(items) {
  const filas = items
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .map(it => {
      const esUrgente = it.dias < 7;
      const tipoColor = it.tipo === 'Licitación' ? '#4FD1C5' : '#E4F300';
      return `
      <tr style="border-bottom:1px solid #1C2334">
        <td style="padding:14px 10px">
          <span style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.03em;color:${tipoColor};background:${tipoColor}22;padding:3px 8px;border-radius:4px;white-space:nowrap">${it.tipo}</span>
        </td>
        <td style="padding:14px 10px">
          <a href="${it.url || '#'}" style="color:#EDEFF3;font-weight:700;text-decoration:none;font-size:14px;font-family:-apple-system,sans-serif">${it.titulo}</a>
          <div style="font-size:12px;color:#9098AC;margin-top:3px;font-family:-apple-system,sans-serif">${it.entidad || ''}</div>
          <div style="margin-top:6px">${it.tags.map(t => `<span style="font-size:10px;background:#111726;color:#B18CFF;border:1px solid #1C2334;padding:2px 7px;border-radius:4px;margin-right:4px;display:inline-block;margin-bottom:3px">${t}</span>`).join('')}</div>
        </td>
        <td style="padding:14px 10px;font-family:'Courier New',monospace;color:#E4F300;white-space:nowrap;font-size:13px;font-weight:700">${formatDinero(it.presupuesto)}</td>
        <td style="padding:14px 10px;text-align:center;font-weight:700;color:${esUrgente ? '#FF7A45' : '#9098AC'};font-family:-apple-system,sans-serif">${it.dias}d</td>
        <td style="padding:14px 10px;text-align:center;font-weight:700;color:${(it.score ?? 0) >= 70 ? '#E4F300' : '#9098AC'};font-family:-apple-system,sans-serif;font-size:16px">${it.score ?? '–'}</td>
      </tr>
    `;
    }).join('');

  const urgentesCount = items.filter(it => it.dias < 7).length;

  return `
  <div style="background:#07090F;padding:24px 12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
    <div style="max-width:700px;margin:0 auto;background:#0D111C;border:1px solid #1C2334;border-radius:14px;overflow:hidden">
      
      <div style="background:linear-gradient(90deg,#0D111C,#111726);padding:24px 28px;border-bottom:1px solid #1C2334">
        <div style="font-size:22px;font-weight:700;background:linear-gradient(90deg,#E4F300,#B18CFF);-webkit-background-clip:text;background-clip:text;color:#E4F300">📡 RADAR</div>
        <div style="font-size:12px;color:#565F76;margin-top:2px">NL Tech Esports · Novedades de las últimas 24 horas</div>
      </div>

      <table style="width:100%;border-collapse:collapse;border-bottom:1px solid #1C2334">
        <tr>
          <td style="padding:20px 28px">
            <div style="font-size:24px;font-weight:700;color:#E4F300;font-family:-apple-system,sans-serif">${items.length}</div>
            <div style="font-size:11px;color:#565F76;text-transform:uppercase">Oportunidades</div>
          </td>
          <td style="padding:20px 28px">
            <div style="font-size:24px;font-weight:700;color:#FF7A45;font-family:-apple-system,sans-serif">${urgentesCount}</div>
            <div style="font-size:11px;color:#565F76;text-transform:uppercase">Urgentes &lt;7d</div>
          </td>
        </tr>
      </table>

      <div style="padding:8px 20px">
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr style="border-bottom:2px solid #1C2334">
              <th style="text-align:left;padding:10px;font-size:10px;text-transform:uppercase;color:#565F76;font-family:-apple-system,sans-serif">Tipo</th>
              <th style="text-align:left;padding:10px;font-size:10px;text-transform:uppercase;color:#565F76;font-family:-apple-system,sans-serif">Oportunidad</th>
              <th style="text-align:left;padding:10px;font-size:10px;text-transform:uppercase;color:#565F76;font-family:-apple-system,sans-serif">Presup.</th>
              <th style="text-align:center;padding:10px;font-size:10px;text-transform:uppercase;color:#565F76;font-family:-apple-system,sans-serif">Plazo</th>
              <th style="text-align:center;padding:10px;font-size:10px;text-transform:uppercase;color:#565F76;font-family:-apple-system,sans-serif">Score</th>
            </tr>
          </thead>
          <tbody>${filas}</tbody>
        </table>
      </div>

      <div style="padding:18px 28px;border-top:1px solid #1C2334;text-align:center">
        <a href="https://radar.nltech.es" style="display:inline-block;background:#E4F300;color:#07090F;font-weight:700;font-size:13px;padding:10px 20px;border-radius:8px;text-decoration:none;font-family:-apple-system,sans-serif">Ver todo en RADAR →</a>
      </div>

      <div style="padding:14px 28px;text-align:center">
        <div style="font-size:10px;color:#565F76;font-family:-apple-system,sans-serif">NL Tech Esports S.L. · Generado automáticamente cada 6 horas</div>
      </div>

    </div>
  </div>
  `;
}

async function enviarEmail(items) {
  const html = generarHTML(items);

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: EMAIL_ORIGEN,
      to: EMAIL_DESTINO,
      subject: `📡 RADAR: ${items.length} nuevas oportunidades presentables`,
      html
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Resend HTTP ${response.status}: ${errText.substring(0, 200)}`);
  }

  return response.json();
}

async function main() {
  console.log('📧 Buscando novedades para alerta diaria...');

  const [sub, lic] = await Promise.all([obtenerNovedadesSubvenciones(), obtenerNovedadesLicitaciones()]);
  const items = [...sub, ...lic];

  console.log(`📋 Encontradas ${items.length} oportunidades relevantes y presentables`);

  if (items.length === 0) {
    console.log('✅ Nada relevante hoy, no se envía email.');
    process.exit(0);
  }

  try {
    await enviarEmail(items);
    console.log(`✅ Email enviado a ${EMAIL_DESTINO} con ${items.length} oportunidades`);
  } catch (error) {
    console.error('❌ Error enviando email:', error.message);
    process.exit(1);
  }

  process.exit(0);
}

main().catch(error => {
  console.error('❌ Error fatal:', error);
  process.exit(1);
});
