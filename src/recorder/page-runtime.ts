/**
 * Injected into the page once per recording. Everything the camera does
 * (scroll, zoom, highlight) is a requestAnimationFrame tween running here, so
 * motion is smooth and frame-accurate rather than stepped from Node.
 *
 * Kept as a source string on purpose: it runs in the page, not in Node, and
 * inlining it avoids a bundling step just to get one file across the boundary.
 */
export const PAGE_RUNTIME = String.raw`
window.__aic = (function () {
  var EASINGS = {
    linear: function (t) { return t },
    easeInOut: function (t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2 },
    easeOut: function (t) { return 1 - Math.pow(1 - t, 3) }
  }

  var zoom = { scale: 1, tx: 0, ty: 0 }

  /* Where 'centred' actually is. Vertical video is always captioned, and the
     caption sits in the lower third, so framing a subject at the true middle
     puts it under the text. Everything that centres respects this instead. */
  var focusY = 0.42

  function focusPoint() { return window.innerHeight * focusY }
  var OVERLAY_ID = '__aic_highlight'

  function tween(durationMs, easingName, step) {
    return new Promise(function (resolve) {
      if (!(durationMs > 0)) { step(1); requestAnimationFrame(function () { resolve() }); return }
      var ease = EASINGS[easingName] || EASINGS.linear
      var t0 = performance.now()
      requestAnimationFrame(function frame(now) {
        var p = Math.min(1, (now - t0) / durationMs)
        step(ease(p))
        if (p < 1) requestAnimationFrame(frame)
        else resolve()
      })
    })
  }

  function must(selector) {
    var el = document.querySelector(selector)
    if (!el) throw new Error('selector not found: ' + selector)
    return el
  }

  /* A block element reports its container's width, not its text's. Pushing in
     on a heading therefore looks like no zoom at all unless we measure the
     content itself, which a Range over the node contents gives us. */
  function tightRect(el) {
    var box = el.getBoundingClientRect()
    try {
      var range = document.createRange()
      range.selectNodeContents(el)
      var text = range.getBoundingClientRect()
      range.detach && range.detach()
      if (text.width > 1 && text.height > 1 &&
          text.width <= box.width + 1 && text.height <= box.height + 1) {
        return text
      }
    } catch (e) { /* detached node or unsupported content — use the box. */ }
    return box
  }

  function maxScroll() {
    return Math.max(0, document.documentElement.scrollHeight - window.innerHeight)
  }

  function clamp(y) { return Math.max(0, Math.min(maxScroll(), y)) }

  /* The camera is one transform on the root element, always anchored at the
     document origin: a page point p lands at (t + scale * p) - scroll. Keeping
     transform-origin at 0,0 means scale and pan compose without the jump you
     get from moving the origin between shots. */
  function applyZoom(scale, tx, ty) {
    var root = document.documentElement
    if (scale === 1 && tx === 0 && ty === 0) {
      root.style.transform = ''
      root.style.transformOrigin = ''
      root.style.willChange = ''
    } else {
      root.style.transformOrigin = '0 0'
      root.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')'
      root.style.willChange = 'transform'
    }
  }

  /* Page dimensions have to be read untransformed, so drop the transform for
     the measurement and put it back before the browser gets a chance to paint. */
  function measurePage() {
    var root = document.documentElement
    var saved = root.style.transform
    root.style.transform = ''
    var size = { width: root.scrollWidth, height: root.scrollHeight }
    root.style.transform = saved
    return size
  }

  function clampPan(value, lo, hi) {
    if (lo > hi) return hi
    return Math.min(hi, Math.max(lo, value))
  }

  /* Pan so the focus point sits in the middle of frame, then pull back far
     enough that the zoom never exposes blank space past the page edges. */
  function panFor(px, py, scale) {
    var page = measurePage()
    return {
      tx: clampPan(
        window.innerWidth / 2 + window.scrollX - scale * px,
        window.scrollX + window.innerWidth - scale * page.width,
        window.scrollX),
      ty: clampPan(
        focusPoint() + window.scrollY - scale * py,
        window.scrollY + window.innerHeight - scale * page.height,
        window.scrollY)
    }
  }

  /* Zoom transforms the root element, which also transforms anything measured
     in viewport coordinates. Any action that needs true viewport coords resets
     the zoom first rather than silently drawing in the wrong place. */
  function unzoom(durationMs) {
    if (zoom.scale === 1 && zoom.tx === 0 && zoom.ty === 0) return Promise.resolve()
    var s0 = zoom.scale, x0 = zoom.tx, y0 = zoom.ty
    return tween(durationMs, 'easeInOut', function (p) {
      applyZoom(s0 + (1 - s0) * p, x0 * (1 - p), y0 * (1 - p))
    }).then(function () { zoom = { scale: 1, tx: 0, ty: 0 } })
  }

  var api = {
    zoomed: function () { return zoom.scale !== 1 || zoom.tx !== 0 || zoom.ty !== 0 },

    scrollToY: function (y, durationMs, easingName) {
      var from = window.scrollY
      var to = clamp(y)
      return tween(durationMs, easingName, function (p) {
        window.scrollTo(0, from + (to - from) * p)
      })
    },

    setFocusY: function (value) { focusY = value },

    scrollToSelector: function (selector, align, durationMs, easingName) {
      var el = must(selector)
      var rect = el.getBoundingClientRect()
      var top = rect.top + window.scrollY
      var y = align === 'top'
        ? top - 24
        : top + rect.height / 2 - focusPoint()
      return api.scrollToY(y, durationMs, easingName)
    },

    scrollBy: function (dy, durationMs, easingName) {
      return api.scrollToY(window.scrollY + dy, durationMs, easingName)
    },

    /* Pick the scale from the target's real size so it fills the requested
       fraction of the frame. Guessing a multiplier by hand crops anything
       that is already full-width. */
    scaleToFit: function (selector, fit) {
      var r = tightRect(must(selector))
      var w = r.width / zoom.scale
      var h = r.height / zoom.scale
      var byWidth = w > 0 ? (window.innerWidth * fit) / w : Infinity
      var byHeight = h > 0 ? (window.innerHeight * fit) / h : Infinity
      return Math.max(1, Math.min(6, Math.min(byWidth, byHeight)))
    },

    zoomTo: function (selector, scale, durationMs) {
      var px, py
      if (selector) {
        /* getBoundingClientRect reports the transformed box, so undo the
           current camera to recover the underlying page coordinates. */
        var r = tightRect(must(selector))
        px = ((r.left + r.width / 2) - zoom.tx + window.scrollX) / zoom.scale
        py = ((r.top + r.height / 2) - zoom.ty + window.scrollY) / zoom.scale
      } else {
        px = window.scrollX + window.innerWidth / 2
        py = window.scrollY + focusPoint()
      }
      var target = panFor(px, py, scale)
      var s0 = zoom.scale, x0 = zoom.tx, y0 = zoom.ty
      return tween(durationMs, 'easeInOut', function (p) {
        applyZoom(
          s0 + (scale - s0) * p,
          x0 + (target.tx - x0) * p,
          y0 + (target.ty - y0) * p)
      }).then(function () { zoom = { scale: scale, tx: target.tx, ty: target.ty } })
    },

    unzoom: unzoom,

    highlight: function (selector, style) {
      var r = must(selector).getBoundingClientRect()
      var pad = 8
      var el = document.getElementById(OVERLAY_ID)
      if (!el) {
        el = document.createElement('div')
        el.id = OVERLAY_ID
        el.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border-radius:14px;'
        document.body.appendChild(el)
      }
      el.style.left = (r.left - pad) + 'px'
      el.style.top = (r.top - pad) + 'px'
      el.style.width = (r.width + pad * 2) + 'px'
      el.style.height = (r.height + pad * 2) + 'px'
      if (style === 'box') {
        el.style.boxShadow = '0 0 0 3px #ff3b30, 0 0 28px rgba(255,59,48,.45)'
        el.style.border = 'none'
      } else {
        el.style.boxShadow = '0 0 0 9999px rgba(8,10,14,.66)'
        el.style.border = '2px solid rgba(255,255,255,.92)'
      }
      el.style.display = 'block'
    },

    clearHighlight: function () {
      var el = document.getElementById(OVERLAY_ID)
      if (el) el.style.display = 'none'
    },

    hide: function (selectors) {
      var hidden = 0
      selectors.forEach(function (sel) {
        document.querySelectorAll(sel).forEach(function (el) {
          el.style.setProperty('display', 'none', 'important')
          hidden++
        })
      })
      return hidden
    },

    /* An element near the end of the document cannot be scrolled up to the
       focus point — there is nothing below it to scroll. A spacer gives the
       page somewhere to go; it lands under the caption band, so it is never
       visible in the finished frame. */
    addScrollPadding: function () {
      if (document.getElementById('__aic_pad')) return 0
      var height = Math.round(window.innerHeight * (1 - focusY) + 40)
      var pad = document.createElement('div')
      pad.id = '__aic_pad'
      pad.style.cssText = 'height:' + height + 'px;width:100%;pointer-events:none'
      document.body.appendChild(pad)
      return height
    },

    freezeAnimations: function () {
      var style = document.createElement('style')
      style.textContent =
        '*,*::before,*::after{animation-play-state:paused!important;' +
        'transition-property:none!important;scroll-behavior:auto!important}' +
        '#' + OVERLAY_ID + '{transition:none!important}'
      document.head.appendChild(style)
    },

    /* Sticky headers that follow the scroll read as jitter once the footage is
       cut to 15 seconds. Pin them out of the way. */
    unstick: function () {
      var pinned = 0
      document.querySelectorAll('body *').forEach(function (el) {
        var pos = getComputedStyle(el).position
        if ((pos === 'fixed' || pos === 'sticky') && el.id !== OVERLAY_ID) {
          var r = el.getBoundingClientRect()
          if (r.height > 0 && r.height < window.innerHeight * 0.5) {
            el.style.setProperty('position', 'absolute', 'important')
            pinned++
          }
        }
      })
      return pinned
    }
  }

  return api
})()
`
