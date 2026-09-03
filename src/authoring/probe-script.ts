export interface Anchor {
  /** A selector that resolves to exactly this element. */
  selector: string
  text: string
  /** Distance from the top of the document, for planning scroll order. */
  top: number
  /** Rendered size in CSS pixels. An element already as wide as the viewport
   *  cannot be zoomed into, so an author picks `highlight` for it instead. */
  width: number
  height: number
}

export interface PageProbe {
  url: string
  title: string
  pageHeight: number
  headline?: Anchor
  price?: Anchor
  bullets?: { selector: string; count: number; items: Anchor[] }
  /** Reviews, comments, pull quotes — anything with a human voice in it. */
  quotes: Anchor[]
  /** Section headings, in document order. */
  sections: Anchor[]
}

/**
 * Runs in the page. Kept free of backticks and ${...} so it survives being
 * carried across as a raw template literal.
 */
export const PROBE_SCRIPT = String.raw`
(function () {
  function unique(sel) {
    try { return document.querySelectorAll(sel).length === 1 } catch (e) { return false }
  }

  function cssPath(el) {
    if (el.id && unique('#' + CSS.escape(el.id))) return '#' + CSS.escape(el.id)
    var parts = []
    var node = el
    while (node && node.nodeType === 1 && parts.length < 8) {
      if (node.id && unique('#' + CSS.escape(node.id))) {
        parts.unshift('#' + CSS.escape(node.id))
        break
      }
      var tag = node.tagName.toLowerCase()
      var parent = node.parentElement
      if (!parent) { parts.unshift(tag); break }
      var siblings = Array.prototype.filter.call(parent.children, function (c) {
        return c.tagName === node.tagName
      })
      parts.unshift(siblings.length > 1
        ? tag + ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')'
        : tag)
      node = parent
    }
    return parts.join(' > ')
  }

  function text(el) {
    return (el.textContent || '').replace(/\s+/g, ' ').trim()
  }

  function visible(el) {
    var r = el.getBoundingClientRect()
    if (r.width < 8 || r.height < 8) return false
    var s = getComputedStyle(el)
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.1
  }

  function anchor(el) {
    var r = el.getBoundingClientRect()
    return {
      selector: cssPath(el),
      text: text(el).slice(0, 240),
      top: Math.round(r.top + window.scrollY),
      width: Math.round(r.width),
      height: Math.round(r.height)
    }
  }

  /* Leaf-most element still carrying the text keeps the camera off giant
     wrapper divs, which zoom into nothing useful. */
  function tightest(el) {
    var current = el
    for (var depth = 0; depth < 6; depth++) {
      var kids = Array.prototype.filter.call(current.children, function (c) {
        return visible(c) && text(c) === text(current)
      })
      if (kids.length !== 1) break
      current = kids[0]
    }
    return current
  }

  var all = Array.prototype.slice.call(document.querySelectorAll('body *')).filter(visible)

  var headline = null
  var h1 = all.filter(function (el) { return el.tagName === 'H1' && text(el).length > 3 })[0]
  if (h1) headline = anchor(tightest(h1))
  if (!headline) {
    var biggest = null, biggestSize = 0
    all.forEach(function (el) {
      if (el.children.length || text(el).length < 8 || text(el).length > 160) return
      var size = parseFloat(getComputedStyle(el).fontSize) || 0
      if (size > biggestSize) { biggestSize = size; biggest = el }
    })
    if (biggest) headline = anchor(biggest)
  }

  /* Among elements whose own text is just a currency amount, the one the
     page wants you to read is the visually loudest — not the smallest box.
     Struck-through text is the old price, which is never the story. */
  var priceRe = /^[^0-9]{0,3}[$£€¥]\s?[0-9][0-9.,]*\s*$/
  var price = null, priceSize = 0, priceArea = Infinity
  all.forEach(function (el) {
    if (el.children.length > 1) return
    if (!priceRe.test(text(el))) return
    var style = getComputedStyle(el)
    if (/line-through/.test(style.textDecorationLine || style.textDecoration || '')) return
    var r = el.getBoundingClientRect()
    var area = r.width * r.height
    if (area <= 0) return
    var size = parseFloat(style.fontSize) || 0
    if (size > priceSize || (size === priceSize && area < priceArea)) {
      priceSize = size; priceArea = area; price = el
    }
  })

  var bullets = null
  var list = Array.prototype.slice.call(document.querySelectorAll('ul, ol')).filter(function (el) {
    return visible(el) && el.querySelectorAll(':scope > li').length >= 2 && text(el).length > 40
  })[0]
  if (list) {
    var items = Array.prototype.slice.call(list.querySelectorAll(':scope > li'))
      .filter(visible).slice(0, 8).map(anchor)
    bullets = { selector: cssPath(list), count: items.length, items: items }
  }

  var quoteRe = /(review|comment|quote|testimonial|feedback)/i
  var quotes = all.filter(function (el) {
    if (el.tagName === 'BLOCKQUOTE') return true
    var id = (el.id || '') + ' ' + (el.className && el.className.baseVal !== undefined ? '' : el.className || '')
    return quoteRe.test(id) && text(el).length > 30 && text(el).length < 400
  })
  /* Keep outermost matches only, so one review is one anchor. */
  quotes = quotes.filter(function (el) {
    return !quotes.some(function (other) { return other !== el && other.contains(el) })
  }).slice(0, 6).map(anchor)

  var sections = Array.prototype.slice.call(document.querySelectorAll('h2, h3'))
    .filter(visible).slice(0, 10).map(function (el) { return anchor(tightest(el)) })

  return {
    url: location.href,
    title: document.title,
    pageHeight: document.documentElement.scrollHeight,
    headline: headline || undefined,
    price: price ? anchor(price) : undefined,
    bullets: bullets || undefined,
    quotes: quotes,
    sections: sections
  }
})()
`
