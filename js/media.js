// @ts-check

/**
 * SocialOS — Visuals: quote-card rendering + the Web Share bridge
 *
 * Turns a line of text into a shareable PNG card entirely on-device (no
 * network, no server, no new secrets) and gives the composer a small,
 * never-throwing wrapper around the Web Share API (Level 2, files) so an
 * "assisted" platform can be handed an image instead of just copied text.
 * Pure canvas + File/Blob logic — no DOM assumptions beyond
 * `document.createElement('canvas')`, so it stays dependency-light even
 * though it is only ever loaded in the window (never imported into the
 * service worker — see sw.js's SW_MODULES_OK list, which stays limited to
 * window-free publish modules).
 *
 * Brand colors are hard-coded hex literals below because an offscreen
 * canvas 2D context can't read CSS custom properties — keep these in sync
 * with the `:root` tokens in css/app.css by hand if the palette changes.
 */

const SocialOSMedia = (() => {
  'use strict';

  // ── Brand palette (mirrors css/app.css :root — canvas can't read CSS vars) ──
  const BG_DARK_FLAT = '#06060B';   // --bg-primary — Quote template background
  const BG_CARD_DARK = '#12121E';   // --bg-card — reused as the Clean template's dark text
  const BG_LIGHT_CARD = '#F7F7FB';  // near-white card background for Clean
  const GRADIENT_STOPS = ['#6E7BFF', '#A855F7', '#22D3EE']; // --accent → --accent-2 → --accent-3
  const TEXT_LIGHT = '#EEF0FF';     // --text-primary, for dark backgrounds
  const ACCENT = '#6E7BFF';         // --accent

  /**
   * @typedef {'clean'|'bold'|'quote'} QuoteCardTemplateId
   * @typedef {'square'|'wide'} QuoteCardSize
   */

  /**
   * The three quote-card looks offered in the composer's "Generate a card"
   * step (UX spec §2): Clean (light card, dark text), Bold (accent/gradient
   * background, big type), Quote (dark background, large quotation-mark
   * motif). Kept to exactly three by design — don't grow this without a UX
   * pass.
   * @type {Record<QuoteCardTemplateId, {id: QuoteCardTemplateId, label: string, description: string}>}
   */
  const TEMPLATES = {
    clean: { id: 'clean', label: 'Clean', description: 'White card, dark text' },
    bold: { id: 'bold', label: 'Bold', description: 'Accent background, big type' },
    quote: { id: 'quote', label: 'Quote', description: 'Large quotation-mark motif' }
  };

  /** Soft character cap — cards read best under this; longer text is trimmed on the card only (UX spec §6.4). */
  const QUOTE_SOFT_LIMIT = 140;

  const SIZES = {
    square: { width: 1200, height: 1200 },
    wide: { width: 1200, height: 627 }
  };

  const QUOTE_JPEG_QUALITY = 0.9; // photo-scale payload for the social-relay base64 path (risk 2)
  let _fontsReady = null;

  /**
   * Trim text to a soft character limit at a word boundary and append an
   * ellipsis. Only affects what's painted on the card — callers keep the
   * full text as the post caption.
   * @param {string} text
   * @param {number} limit
   * @returns {string}
   */
  function softTrim(text, limit) {
    if (text.length <= limit) return text;
    const cut = text.slice(0, limit);
    const lastSpace = cut.lastIndexOf(' ');
    const trimmed = lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut;
    return trimmed.replace(/[\s.,;:!?-]+$/, '') + '…';
  }

  /**
   * Greedy word-wrap for canvas text — CanvasRenderingContext2D has no
   * built-in wrapping, only `measureText`.
   * @param {CanvasRenderingContext2D} ctx
   * @param {string} text
   * @param {number} maxWidth
   * @returns {string[]}
   */
  function wrapText(ctx, text, maxWidth) {
    const words = text.split(/\s+/).filter(Boolean);
    /** @type {string[]} */
    const lines = [];
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (ctx.measureText(candidate).width > maxWidth && line) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    if (line) lines.push(line);
    return lines.length ? lines : [''];
  }

  /**
   * Paint the template background for the given canvas context.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} width
   * @param {number} height
   * @param {QuoteCardTemplateId} template
   */
  function paintBackground(ctx, width, height, template) {
    if (template === 'bold') {
      const grad = ctx.createLinearGradient(0, 0, width, height);
      grad.addColorStop(0, GRADIENT_STOPS[0]);
      grad.addColorStop(0.5, GRADIENT_STOPS[1]);
      grad.addColorStop(1, GRADIENT_STOPS[2]);
      ctx.fillStyle = grad;
    } else if (template === 'clean') {
      ctx.fillStyle = BG_LIGHT_CARD;
    } else {
      ctx.fillStyle = BG_DARK_FLAT;
    }
    ctx.fillRect(0, 0, width, height);
  }

  // SEAM: a future server-side image-gen backend (e.g. a proxy call that
  // returns a rendered PNG) can replace this function's body wholesale —
  // the public signature (`{text, template, size, byline}` in, a PNG data
  // URI string out) stays identical, so composer.js/app.js callers never
  // need to change.
  /**
   * Render a quote card to a JPEG data URI, entirely on-device (no network).
   * Callers must pass already-scrubbed text — this function does not run
   * the content scrubber; it only draws pixels.
   * @param {{text: string, template?: QuoteCardTemplateId, size?: QuoteCardSize, byline?: string}} opts
   * @returns {string} JPEG data URI (`data:image/jpeg;base64,...`)
   */
  function renderQuoteCard(opts) {
    const templateId = TEMPLATES[/** @type {QuoteCardTemplateId} */ (opts.template)] ? /** @type {QuoteCardTemplateId} */ (opts.template) : 'clean';
    const sizeId = opts.size === 'wide' ? 'wide' : 'square';
    const { width, height } = SIZES[sizeId];
    const text = softTrim((opts.text || '').trim(), QUOTE_SOFT_LIMIT);
    const byline = (opts.byline || '').trim();

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return '';

    paintBackground(ctx, width, height, templateId);

    const isLight = templateId === 'clean';
    const textColor = isLight ? BG_CARD_DARK : TEXT_LIGHT;
    const bylineColor = isLight ? 'rgba(18, 18, 30, 0.6)' : 'rgba(238, 240, 255, 0.7)';

    // Quote template: a large quotation-mark motif behind the text.
    if (templateId === 'quote') {
      ctx.save();
      ctx.fillStyle = 'rgba(110, 123, 255, 0.35)';
      ctx.font = `800 ${Math.round(width * 0.34)}px Georgia, 'Times New Roman', serif`;
      ctx.textBaseline = 'top';
      ctx.textAlign = 'left';
      ctx.fillText('“', Math.round(width * 0.05), Math.round(height * 0.02));
      ctx.restore();
    }

    const padding = Math.round(width * 0.09);
    const bylineReserve = byline ? Math.round(height * 0.09) : 0;
    const maxWidth = width - padding * 2;
    const maxTextHeight = height - padding * 2 - bylineReserve;

    let fontSize = Math.round(width * 0.078);
    const minFontSize = 28;
    /** @type {string[]} */
    let lines = [text];
    let lineHeight = fontSize;
    while (fontSize >= minFontSize) {
      ctx.font = `700 ${fontSize}px 'Space Grotesk', system-ui, sans-serif`;
      lines = wrapText(ctx, text, maxWidth);
      lineHeight = Math.round(fontSize * 1.3);
      if (lines.length * lineHeight <= maxTextHeight) break;
      fontSize -= 4;
    }
    ctx.font = `700 ${fontSize}px 'Space Grotesk', system-ui, sans-serif`;

    const blockHeight = lines.length * lineHeight;
    let y = (height - blockHeight) / 2 + lineHeight / 2 - bylineReserve / 2;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = textColor;
    for (const line of lines) {
      ctx.fillText(line, width / 2, y, maxWidth);
      y += lineHeight;
    }

    if (byline) {
      ctx.font = `600 ${Math.round(width * 0.03)}px 'Inter', system-ui, sans-serif`;
      ctx.fillStyle = bylineColor;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(byline, width / 2, height - padding * 0.7, maxWidth);
    }

    // Small accent underline as a brand touch, above the byline / bottom edge.
    const barWidth = Math.round(width * 0.08);
    ctx.fillStyle = ACCENT;
    ctx.fillRect((width - barWidth) / 2, height - padding * (byline ? 1.15 : 0.55), barWidth, 4);

    return canvas.toDataURL('image/jpeg', QUOTE_JPEG_QUALITY);
  }

  /**
   * Whether the Web Share API (Level 2, files) can share the given files on
   * this device/browser. Never throws — `navigator.canShare` itself can
   * throw on some browsers for unsupported file types.
   * @param {File[]} files
   * @returns {boolean}
   */
  function canShareFiles(files) {
    try {
      return !!(navigator.canShare && navigator.share) && navigator.canShare({ files });
    } catch {
      return false;
    }
  }

  /**
   * Convert a data URI (as produced by `renderQuoteCard` or a Library
   * ContentItem's `thumbnail_url`) into a `File` object for `navigator.share`.
   * @param {string} dataUri
   * @param {string} filename
   * @returns {File}
   */
  function dataUriToFile(dataUri, filename) {
    const [header, base64 = ''] = dataUri.split(',');
    const mimeMatch = /data:([^;]+);base64/.exec(header || '');
    const mime = mimeMatch ? mimeMatch[1] : 'image/png';
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new File([bytes], filename, { type: mime });
  }

  /**
   * Hand an image + caption to the OS share sheet via Web Share L2. This is
   * the "assisted" bridge for platforms SocialOS can't post to directly
   * (UX spec §3) — it never claims a post landed, only that the share sheet
   * opened. Never throws: a user-cancelled share or an unsupported browser
   * both resolve normally so callers can fall back to clipboard + download.
   * @param {{text?: string, dataUri: string, filename: string}} opts
   * @returns {Promise<{shared: boolean, reason?: 'cancelled'|'unsupported'|'retry'}>}
   */
  async function shareMedia(opts) {
    try {
      const file = dataUriToFile(opts.dataUri, opts.filename);
      if (!canShareFiles([file])) return { shared: false, reason: 'unsupported' };
      await navigator.share({ text: opts.text || '', files: [file] });
      return { shared: true };
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return { shared: false, reason: 'cancelled' };
      if (err instanceof Error && err.name === 'NotAllowedError') return { shared: false, reason: 'retry' };
      return { shared: false, reason: 'unsupported' };
    }
  }

  /** Warm the webfonts the canvas uses so the first card isn't painted in a fallback face (risk 4). Memoized; never throws. */
  function ensureFonts() {
    if (_fontsReady) return _fontsReady;
    _fontsReady = (async () => {
      try {
        if (!document.fonts || !document.fonts.load) return;
        await Promise.all([
          document.fonts.load("700 100px 'Space Grotesk'"),
          document.fonts.load("600 40px 'Inter'")
        ]);
        if (document.fonts.ready) await document.fonts.ready;
      } catch { /* system-font fallback is cosmetic only */ }
    })();
    return _fontsReady;
  }

  /** Filename with the extension implied by a data-URI mime (opp 5) — jpg for the quote cards, png for legacy. */
  function filenameForDataUri(dataUri, base) {
    const m = /^data:image\/(png|jpe?g|webp|gif)/i.exec(dataUri || '');
    const ext = m ? (/jpe?g/i.test(m[1]) ? 'jpg' : m[1].toLowerCase()) : 'png';
    return `${base || 'socialos'}.${ext}`;
  }

  return {
    TEMPLATES,
    QUOTE_SOFT_LIMIT,
    renderQuoteCard,
    canShareFiles,
    dataUriToFile,
    shareMedia,
    ensureFonts,
    filenameForDataUri
  };
})();
