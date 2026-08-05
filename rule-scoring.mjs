// ============================================================
// Motor de scoring por reglas v3 — LicitaTech AI
// Novedad clave: normalización de texto (sin tildes, minúsculas)
// PLACSP publica mucho en MAYÚSCULAS SIN TILDES — sin esto,
// "ROBOTICA" no hacía match con la keyword 'robótica'.
// ============================================================

const IMPORTE_MIN = 0;
const IMPORTE_MAX = 5_000_000;
const CCAA_BONUS = ['Cantabria'];
const CCAA_BONUS_PUNTOS = 10;

/**
 * Normaliza texto para comparación: minúsculas + sin tildes/diacríticos.
 * "ROBÓTICA" y "robotica" y "Robótica" → "robotica"
 */
export function normalizar(texto) {
  if (!texto) return '';
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, ''); // elimina tildes/diacríticos
}

export function calcularScore(lic, cpvBiblioteca, keywordsBiblioteca) {
  let score = 0;
  const categorias = new Set();

  // 1) Match por CPV — prefijo de 4 dígitos (nivel "clase")
  const cpvLic = lic.cpv || [];
  for (const codigo of cpvLic) {
    const match = cpvBiblioteca.find(c => codigo.startsWith(c.codigo.slice(0, 4)));
    if (match) {
      score += match.peso;
      categorias.add(match.categoria);
    }
  }

  // 2) Match por keywords — AMBOS lados normalizados (sin tildes, minúsculas)
  const textoCompleto = normalizar(
    [lic.titulo, lic.objeto, lic.descripcion].filter(Boolean).join(' ')
  );

  for (const kw of keywordsBiblioteca) {
    const palabraNormalizada = normalizar(kw.palabra);
    if (textoCompleto.includes(palabraNormalizada)) {
      score += kw.peso;
      if (kw.categoria) categorias.add(kw.categoria);
    }
  }

  // 3) Bonus por importe dentro de rango razonable
  const importe = lic.presupuesto ?? lic.valor_estimado ?? 0;
  if (importe >= IMPORTE_MIN && importe <= IMPORTE_MAX) {
    score += 10;
  }

  // 4) Bonus territorial
  if (CCAA_BONUS.includes(lic.comunidad_autonoma)) {
    score += CCAA_BONUS_PUNTOS;
  }

  score = Math.min(score, 100);

  const prioridad =
    score >= 90 ? 'Muy recomendable' :
    score >= 70 ? 'Interesante' :
    score >= 40 ? 'Revisar' : 'Descartar';

  return {
    score,
    categorias: [...categorias],
    interesa: score >= 40,
    prioridad,
  };
}

// Ya no se usa pasaFiltroPrevio() en el flujo principal (v2+):
// TODO se guarda, sin excepción. Se mantiene exportada por si algún
// día se quiere volver a un modo de pre-filtro para ahorrar cómputo.
export function pasaFiltroPrevio() {
  return true;
}
