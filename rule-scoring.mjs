// ============================================================
// Motor de scoring por reglas (sin IA) — LicitaTech AI
// Recibe una licitación normalizada + las bibliotecas CPV/keywords
// y devuelve { score, categorias, interesa, prioridad }
// ============================================================

const IMPORTE_MIN = 0;          // ajustar según lo que interese
const IMPORTE_MAX = 5_000_000;  // descarta contratos desproporcionados si hace falta
const CCAA_BONUS = ['Cantabria']; // bonus por territorio propio
const CCAA_BONUS_PUNTOS = 10;

/**
 * @param {object} lic - licitación normalizada (title, objeto, descripcion, cpv[], presupuesto, comunidad_autonoma)
 * @param {Array}  cpvBiblioteca - filas de la tabla cpv_biblioteca
 * @param {Array}  keywordsBiblioteca - filas de la tabla keywords_biblioteca
 */
export function calcularScore(lic, cpvBiblioteca, keywordsBiblioteca) {
  let score = 0;
  const categorias = new Set();

  // 1) Match por CPV (lo más fiable — es un código oficial, no texto libre)
  const cpvLic = lic.cpv || [];
  for (const codigo of cpvLic) {
    // match exacto o por prefijo (los CPV tienen jerarquía: los primeros dígitos son la familia)
    const match = cpvBiblioteca.find(c => codigo.startsWith(c.codigo.slice(0, 4)));
    if (match) {
      score += match.peso;
      categorias.add(match.categoria);
    }
  }

  // 2) Match por keywords en objeto/descripción/título
  const textoCompleto = [lic.titulo, lic.objeto, lic.descripcion]
    .filter(Boolean).join(' ').toLowerCase();

  for (const kw of keywordsBiblioteca) {
    if (textoCompleto.includes(kw.palabra.toLowerCase())) {
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

  // Cap a 100
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

/**
 * Filtro previo — descarta ANTES de gastar tiempo/recursos en scoring detallado.
 * Devuelve true si la licitación merece pasar al scoring por reglas.
 *
 * Deliberadamente PERMISIVO: el objetivo es "no perder ninguna licitación gamer",
 * y como el scoring es gratis (sin IA), el coste de revisar de más es ~0.
 * Es mejor dejar pasar un falso positivo (se descarta luego por score bajo)
 * que perder una licitación real por un filtro demasiado estricto.
 */
export function pasaFiltroPrevio(lic, cpvBiblioteca) {
  const cpvLic = lic.cpv || [];
  // Match por CPV: prefijo de 4 dígitos (nivel "clase") en vez de exigir coincidencia más larga
  const tieneCpvRelevante = cpvLic.some(codigo =>
    cpvBiblioteca.some(c => codigo.startsWith(c.codigo.slice(0, 4)))
  );

  const textoCompleto = [lic.titulo, lic.objeto, lic.descripcion]
    .filter(Boolean).join(' ').toLowerCase();

  // Lista amplia de señales genéricas — cualquier coincidencia basta para pasar el filtro.
  // No hace falta que sea exhaustiva (para eso está el scoring detallado después);
  // solo necesita ser lo bastante amplia para no descartar por error.
  const palabrasClaveGenericas = [
    'gaming', 'esports', 'e-sports', 'videojuego', 'evento', 'tecnolog', 'formación',
    'digital', 'streaming', 'robótic', 'realidad virtual', 'realidad aumentada',
    'sim racing', 'consola', 'playstation', 'xbox', 'nintendo', 'ocio', 'lúdic',
    'juvent', 'campamento', 'maker', 'steam', 'ciberseguridad', 'inteligencia artificial',
    'dron', 'audiovisual', 'feria', 'congreso', 'exposición', 'cultural', 'juego',
  ];
  const tieneKeywordGenerica = palabrasClaveGenericas.some(p => textoCompleto.includes(p));

  // Sin CPV relevante NI ninguna señal de texto -> no merece la pena seguir
  return tieneCpvRelevante || tieneKeywordGenerica;
}
