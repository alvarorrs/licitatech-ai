// ============================================================
// LicitaTech AI — Resumen diario por email
// Se ejecuta cada noche vía GitHub Actions. Envía por Resend
// (gratis hasta 100 emails/día / 3.000 al mes).
// ============================================================

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM; // ej. 'LicitaTech <alertas@nltech.es>'
const EMAIL_TO = (process.env.EMAIL_TO || '').split(',').map(e => e.trim()).filter(Boolean);

const PORTAL_URL = 'https://licitaciones.nltech.es';

// REGLA DE NEGOCIO: solo se puede presentar oferta mientras esta PUBLICADA.
// En Evaluacion el plazo ya cerro, asi que no tiene sentido alertar de ellas.
function esPresentable(lic) {
  const e = (lic?.estado || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return e.startsWith('pub');
}

function diasRestantes(fecha) {
  if (!fecha) return null;
  const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
  return Math.round((new Date(fecha + 'T00:00:00') - hoy) / 86400000);
}

function formatDinero(n) {
  if (!n) return null;
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n);
}

function tierColor(score) {
  if (score >= 70) return '#8B9200'; // lima oscuro, legible sobre blanco
  if (score >= 40) return '#1E7268';
  return '#B8460D';
}

function filaHTML(l) {
  const dias = diasRestantes(l.fecha_limite);
  const presupuesto = formatDinero(l.presupuesto || l.valor_estimado);
  const urgente = dias !== null && dias >= 0 && dias < 5;
  return `
  <tr>
    <td style="padding:12px 14px;border-bottom:1px solid #E5E5E5;">
      <div style="font-weight:700;font-size:14px;color:#111;margin-bottom:3px;">
        ${l.titulo || l.objeto || 'Licitación sin título'}
      </div>
      <div style="font-size:12px;color:#666;">
        🏛️ ${l.organismo || 'Organismo'} ${l.comunidad_autonoma ? '· 📍 ' + l.comunidad_autonoma : ''}
      </div>
      <div style="margin-top:6px;font-size:12px;">
        <span style="background:${tierColor(l.score || 0)};color:#fff;padding:2px 8px;border-radius:4px;font-weight:700;">
          Score ${l.score ?? '–'}
        </span>
        ${presupuesto ? `<span style="margin-left:8px;color:#333;font-weight:600;">${presupuesto}</span>` : ''}
        ${dias !== null ? `<span style="margin-left:8px;color:${urgente ? '#D9480F' : '#888'};font-weight:${urgente ? '700' : '400'};">
          ${dias >= 0 ? `⏳ ${dias} días` : '⚪ Finalizado'}
        </span>` : ''}
      </div>
    </td>
    <td style="padding:12px 14px;border-bottom:1px solid #E5E5E5;text-align:right;white-space:nowrap;">
      ${l.enlace_oficial ? `<a href="${l.enlace_oficial}" style="color:#8B9200;font-weight:600;text-decoration:none;font-size:12px;">Ver ↗</a>` : ''}
    </td>
  </tr>`;
}

function construirEmailHTML(nuevas, urgentes) {
  const fecha = new Date().toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
  return `
  <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:600px;margin:0 auto;background:#fff;">
    <div style="background:#07090F;padding:20px 24px;">
      <span style="color:#E4F300;font-size:18px;font-weight:700;">LicitaTech</span>
      <span style="color:#9098AC;font-size:12px;margin-left:6px;">Resumen diario</span>
    </div>
    <div style="padding:20px 24px 4px;">
      <p style="font-size:13px;color:#666;margin:0 0 4px;text-transform:capitalize;">${fecha}</p>
      <p style="font-size:14px;color:#111;margin:0;">
        <b>${nuevas.length}</b> licitaciones <b>publicadas</b> en las últimas 24h (podéis presentaros)
        ${urgentes.length ? ` · <b style="color:#D9480F;">${urgentes.length} urgentes</b> (&lt;5 días para el plazo)` : ''}
      </p>
    </div>

    ${urgentes.length ? `
    <div style="padding:16px 24px 0;">
      <h3 style="font-size:13px;color:#D9480F;text-transform:uppercase;letter-spacing:.03em;margin:0 0 8px;">🔥 Urgentes</h3>
      <table style="width:100%;border-collapse:collapse;">${urgentes.map(filaHTML).join('')}</table>
    </div>` : ''}

    <div style="padding:16px 24px 0;">
      <h3 style="font-size:13px;color:#8B9200;text-transform:uppercase;letter-spacing:.03em;margin:0 0 8px;">🆕 Publicadas hoy</h3>
      ${nuevas.length
        ? `<table style="width:100%;border-collapse:collapse;">${nuevas.map(filaHTML).join('')}</table>`
        : `<p style="font-size:13px;color:#888;">Sin licitaciones nuevas en las últimas 24h.</p>`}
    </div>

    <div style="padding:20px 24px 24px;text-align:center;">
      <a href="${PORTAL_URL}" style="display:inline-block;background:#E4F300;color:#07090F;font-weight:700;font-size:13px;padding:10px 20px;border-radius:8px;text-decoration:none;">
        Ver todas en LicitaTech →
      </a>
    </div>

    <div style="background:#F5F5F5;padding:14px 24px;text-align:center;">
      <p style="font-size:11px;color:#999;margin:0;">
        Datos públicos sincronizados desde PLACSP. LicitaTech no participa en ningún proceso de contratación.
      </p>
    </div>
  </div>`;
}

async function enviarEmail(html, resumen) {
  if (!RESEND_API_KEY) throw new Error('Falta RESEND_API_KEY');
  if (!EMAIL_TO.length) throw new Error('Falta EMAIL_TO (destinatarios)');

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: EMAIL_FROM || 'LicitaTech <onboarding@resend.dev>',
      to: EMAIL_TO,
      subject: `📋 LicitaTech: ${resumen}`,
      html,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend API error ${res.status}: ${body}`);
  }
  return res.json();
}

async function main() {
  console.log('📧 Generando resumen diario...');

  const hace24h = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

  const { data: crudas, error } = await supabase
    .from('licitaciones')
    .select('*')
    .gte('created_at', hace24h)
    .order('score', { ascending: false })
    .limit(200);

  if (error) throw error;

  // Solo las que estan PUBLICADAS: si ya esta en evaluacion, no podemos presentarnos
  const nuevas = (crudas || []).filter(esPresentable).slice(0, 50);

  const urgentes = (nuevas || []).filter(l => {
    const dias = diasRestantes(l.fecha_limite);
    return dias !== null && dias >= 0 && dias < 5;
  });

  console.log(`   ${crudas?.length || 0} detectadas · ${nuevas.length} publicadas (presentables) · ${urgentes.length} urgentes`);

  if (nuevas.length === 0) {
    console.log('ℹ️ Sin licitaciones nuevas PUBLICADAS — no se envía email (evita ruido innecesario).');
    return;
  }

  const html = construirEmailHTML(nuevas, urgentes);
  const resumen = `${nuevas.length} publicadas${urgentes.length ? `, ${urgentes.length} urgentes` : ''}`;
  await enviarEmail(html, resumen);

  console.log('✅ Email enviado correctamente');
}

main().catch(e => {
  console.error('💥 Error enviando resumen:', e);
  process.exit(1);
});
