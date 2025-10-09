// lib/html.js - HTML utilities extracted for clarity

export function stripLdJsonScripts(html) {
  try {
    return String(html || '').replace(/<script[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi, '');
  } catch {
    return html;
  }
}

export function normalizeGeneratedHtml(input) {
  try {
    let s = String(input || '').trim();
    s = s.replace(/```[a-z]*|```/gi, '').trim();
    if (s.startsWith('{')) {
      try {
        const obj = JSON.parse(s);
        if (obj && typeof obj === 'object') {
          if (obj.new_content_html) return String(obj.new_content_html);
          if (obj.html) return String(obj.html);
        }
      } catch (_) {
        const m = s.match(/"new_content_html"\s*:\s*"([\s\S]*?)"\s*}/);
        if (m) {
          try { return JSON.parse(`"${m[1]}"`); } catch { return m[1].replace(/\\n/g, '\n').replace(/\\\"/g, '"'); }
        }
      }
    }
    return s;
  } catch { return String(input || ''); }
}

export function removeNaSpecItems(html) {
  try {
    let s = String(html || '');
    const lower = s.toLowerCase();
    const h2Match = lower.match(/<h2[^>]*>\s*specificatii\s+tehnice\s*<\/h2>/i);
    if (!h2Match) return s;
    const h2Index = lower.indexOf(h2Match[0]);
    const afterH2 = h2Index + h2Match[0].length;
    const ulStart = lower.indexOf('<ul', afterH2);
    if (ulStart === -1) return s;
    const ulEnd = lower.indexOf('</ul>', ulStart);
    if (ulEnd === -1) return s;
    const before = s.slice(0, ulStart);
    const ulBlock = s.slice(ulStart, ulEnd + 5);
    const after = s.slice(ulEnd + 5);
    const cleanedUl = ulBlock.replace(/<li[^>]*>[^<]*n\/?a[^<]*<\/li>/gi, '').replace(/<li[^>]*>\s*na\s*<\/li>/gi, '');
    return before + cleanedUl + after;
  } catch { return String(html || ''); }
}

export function removeSimilarSection(html) {
  try {
    let s = String(html || '');
    // remove existing 'Produse similare' section (H2 and following UL if present)
    s = s.replace(/<h2[^>]*>\s*produse\s+similare\s*<\/h2>\s*(<ul[\s\S]*?<\/ul>)?/i, '');
    return s;
  } catch { return String(html || ''); }
}

export function buildSimilarProductsList(currentProduct, allProducts, maxItems = 3) {
  try {
    const tokenize = (t) => new Set(String(t||'').toLowerCase().split(/[^a-z0-9ăâîșț]+/i).filter(Boolean));
    const currentTokens = tokenize(currentProduct.title);
    const candidates = allProducts.filter(p => p.id !== currentProduct.id);
    const scored = candidates.map(p => {
      const tokens = tokenize(p.title);
      let overlap = 0; tokens.forEach(t => { if (currentTokens.has(t)) overlap++; });
      return { p, score: overlap };
    }).sort((a,b) => b.score - a.score);
    let top = scored.filter(x => x.score > 0).slice(0, maxItems).map(x => x.p);
    if (top.length === 0) top = scored.slice(0, maxItems).map(x => x.p);
    const items = top.map(p => `<li><a href=\"${process.env.BASE_SITE_URL || ''}/products/${p.handle}\">${(p.title||'').slice(0,120)}</a></li>`).join('');
    return items ? `<ul>${items}</ul>` : '';
  } catch {
    return '';
  }
}
