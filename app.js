(function () {
  "use strict";

  var STOPS = window.STOPS, EXTRAS = window.EXTRAS || [], ROUTES = window.ROUTES, TABLE = window.TABLE;
  var byId = {}, isExtra = {}, tIdx = {};
  STOPS.forEach(function (s) { byId[s.id] = s; });
  EXTRAS.forEach(function (s) { byId[s.id] = s; isExtra[s.id] = true; });
  TABLE.ids.forEach(function (id, i) { tIdx[id] = i; });
  var DAY_LABEL = { sat: "Sat", sun: "Sun" };
  var KEY = "mke-doors-open-2026";

  // ---------- state ----------
  var state = load() || {};
  if (!state.day) state.day = new Date() >= new Date(2026, 8, 27) ? "sun" : "sat";
  if (!state.start) state.start = "10:00";
  if (!state.dwell) state.dwell = 30;
  if (!state.skip) state.skip = {};

  function valid(order) {
    if (!Array.isArray(order)) return false;
    var seen = {};
    return order.every(function (id) { if (!byId[id] || seen[id]) return false; return (seen[id] = true); }) &&
      STOPS.every(function (s) { return seen[s.id]; });
  }
  function load() { try { return JSON.parse(localStorage.getItem(KEY)); } catch (e) { return null; } }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {} }

  // ---------- geometry ----------
  function decode(str) {
    var i = 0, lat = 0, lng = 0, out = [];
    while (i < str.length) {
      var b, shift = 0, res = 0;
      do { b = str.charCodeAt(i++) - 63; res |= (b & 31) << shift; shift += 5; } while (b >= 32);
      lat += res & 1 ? ~(res >> 1) : res >> 1;
      shift = 0; res = 0;
      do { b = str.charCodeAt(i++) - 63; res |= (b & 31) << shift; shift += 5; } while (b >= 32);
      lng += res & 1 ? ~(res >> 1) : res >> 1;
      out.push([lat / 1e5, lng / 1e5]);
    }
    return out;
  }
  // Legs between the planned stops ship with the page. Legs to added sites use the
  // precomputed time/distance table and fetch their path on demand (straight line until then).
  var legCache = {}, fetching = {};
  function leg(a, b) {
    var k = a + "|" + b;
    if (legCache[k]) return legCache[k];
    var r = ROUTES[k], rev = false;
    if (!r) { r = ROUTES[b + "|" + a]; rev = true; }
    if (r) {
      var pts = decode(r.g);
      if (rev) pts.reverse();
      return (legCache[k] = { m: r.m, s: r.s, pts: pts });
    }
    var i = tIdx[a], j = tIdx[b], A = byId[a], B = byId[b];
    return { m: TABLE.m[i][j], s: TABLE.s[i][j], pts: [[A.lat, A.lng], [B.lat, B.lng]], rough: true };
  }
  function fetchLeg(a, b) {
    var k = a + "|" + b;
    if (legCache[k] || fetching[k]) return;
    fetching[k] = true;
    var A = byId[a], B = byId[b], base = leg(a, b);
    fetch("https://routing.openstreetmap.de/routed-foot/route/v1/foot/" + A.lng + "," + A.lat + ";" + B.lng + "," + B.lat + "?overview=full&geometries=polyline")
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.routes || !d.routes[0]) return;
        legCache[k] = { m: base.m, s: base.s, pts: decode(d.routes[0].geometry) };
        drawMap();
      })
      .catch(function () {});
  }

  // ---------- schedule ----------
  function hoursFor(s, day) { return s[day]; }
  function isActive(id, day) { return !!hoursFor(byId[id], day) && !state.skip[id]; }
  function toMin(hhmm) { var p = hhmm.split(":"); return +p[0] * 60 + +p[1]; }
  function fmtTime(min) {
    min = Math.round(min);
    var h = Math.floor(min / 60), m = min % 60, ap = h >= 12 ? "pm" : "am";
    var h12 = h % 12 || 12;
    return h12 + ":" + (m < 10 ? "0" : "") + m + " " + ap;
  }
  function fmtHour(h) {
    var ap = h >= 12 ? "pm" : "am", mm = Math.round((h % 1) * 60), hh = Math.floor(h);
    return (hh % 12 || 12) + (mm ? ":" + (mm < 10 ? "0" : "") + mm : "") + " " + ap;
  }
  function fmtHours(h) { return fmtHour(h[0]) + "–" + fmtHour(h[1]); }
  function fmtMi(m) { return (m / 1609.34).toFixed(m < 1609 ? 2 : 1) + " mi"; }
  function fmtDur(sec) {
    var min = Math.round(sec / 60);
    return min < 60 ? min + " min" : Math.floor(min / 60) + " hr " + (min % 60) + " min";
  }

  // Walk the active stops in order, tracking arrival time, waits and late arrivals.
  function schedule(ids, day, start, dwell) {
    var t = start, prev = null, walkS = 0, walkM = 0, late = 0, rows = [];
    ids.forEach(function (id) {
      var s = byId[id], h = hoursFor(s, day), l = null;
      if (prev) { l = leg(prev, id); t += l.s / 60; walkS += l.s; walkM += l.m; }
      var arrive = t, wait = 0;
      if (arrive < h[0] * 60) { wait = h[0] * 60 - arrive; t = h[0] * 60; }
      var lateBy = t + dwell - h[1] * 60;
      if (lateBy > 0) late += lateBy;
      rows.push({ id: id, leg: l, arrive: arrive, wait: wait, lateBy: lateBy, leave: t + dwell });
      t += dwell; prev = id;
    });
    return { rows: rows, end: t, walkS: walkS, walkM: walkM, late: late };
  }
  function cost(ids, day, start, dwell) {
    var r = schedule(ids, day, start, dwell);
    return r.end + r.late * 50 + r.walkS / 600;
  }

  // Best order for the active stops: exhaustive for up to 9, else nearest-neighbour + 2-opt.
  function suggest() {
    var day = state.day, start = toMin(state.start), dwell = +state.dwell;
    var all = state.order || STOPS.map(function (s) { return s.id; });
    var act = all.filter(function (id) { return isActive(id, day); });
    var rest = all.filter(function (id) { return act.indexOf(id) < 0; });
    var best = act.slice(), bestC = Infinity;
    if (act.length <= 9) {
      var used = new Array(act.length).fill(false), cur = [];
      (function rec() {
        if (cur.length === act.length) {
          var c = cost(cur, day, start, dwell);
          if (c < bestC) { bestC = c; best = cur.slice(); }
          return;
        }
        if (cur.length > 1 && cost(cur, day, start, dwell) >= bestC) return;
        for (var i = 0; i < act.length; i++) {
          if (used[i]) continue;
          used[i] = true; cur.push(act[i]); rec(); cur.pop(); used[i] = false;
        }
      })();
    } else {
      best = [act[0]];
      var left = act.slice(1);
      while (left.length) {
        var last = best[best.length - 1];
        left.sort(function (a, b) { return leg(last, a).s - leg(last, b).s; });
        best.push(left.shift());
      }
      bestC = cost(best, day, start, dwell);
      var improved = true;
      while (improved) {
        improved = false;
        for (var i = 0; i < best.length - 1; i++) for (var j = i + 1; j < best.length; j++) {
          var cand = best.slice(0, i).concat(best.slice(i, j + 1).reverse(), best.slice(j + 1));
          var c = cost(cand, day, start, dwell);
          if (c < bestC - 1e-6) { best = cand; bestC = c; improved = true; }
        }
      }
    }
    return best.concat(rest);
  }

  // Open sites not in the list, ranked by the extra walking it takes to fit them in.
  function nearby(act, day) {
    var inList = {};
    state.order.forEach(function (id) { inList[id] = true; });
    return EXTRAS.filter(function (s) { return !inList[s.id] && s[day]; }).map(function (s) {
      var best = { add: Infinity, after: null };
      if (!act.length) return { s: s, add: 0, after: null, before: null };
      for (var i = 0; i <= act.length; i++) {
        var p = act[i - 1], n = act[i], add;
        if (p && n) add = leg(p, s.id).s + leg(s.id, n).s - leg(p, n).s;
        else if (p) add = leg(p, s.id).s;
        else add = leg(s.id, n).s;
        if (add < best.add) best = { add: add, after: p || null, before: n || null };
      }
      best.s = s;
      return best;
    }).sort(function (a, b) { return a.add - b.add; });
  }
  function addStop(id) {
    var day = state.day, act = state.order.filter(function (x) { return isActive(x, day); });
    var n = nearby(act, day).filter(function (x) { return x.s.id === id; })[0];
    var pos = state.order.length;
    if (n && n.after) pos = state.order.indexOf(n.after) + 1;
    else if (n && n.before) pos = state.order.indexOf(n.before);
    state.order.splice(pos, 0, id);
    render();
    highlight(id, true);
  }

  // ---------- links ----------
  function place(s) { return s.addr + ", Milwaukee, WI"; }
  function q(s) { return encodeURIComponent(place(s)); }
  function appleRoute(ids, fromHere) {
    if (!ids.length) return "https://maps.apple.com/";
    var stops = ids.map(function (id) { return byId[id]; });
    var parts = [];
    if (!fromHere) parts.push("source=" + q(stops.shift()));
    var dest = stops.pop();
    stops.forEach(function (s) { parts.push("waypoint=" + q(s)); });
    if (dest) parts.push("destination=" + q(dest));
    else parts.push("destination=" + q(byId[ids[0]]));
    parts.push("mode=walking");
    return "https://maps.apple.com/directions?" + parts.join("&");
  }
  function appleLeg(a, b) {
    return "https://maps.apple.com/directions?source=" + q(byId[a]) + "&destination=" + q(byId[b]) + "&mode=walking";
  }
  function applePlace(s) {
    return "https://maps.apple.com/?q=" + encodeURIComponent(s.full) + "&ll=" + s.lat + "," + s.lng + "&address=" + q(s);
  }
  function googleRoute(ids) {
    var stops = ids.map(function (id) { return byId[id]; });
    if (!stops.length) return "https://www.google.com/maps";
    var o = stops[0], d = stops[stops.length - 1], mid = stops.slice(1, -1);
    return "https://www.google.com/maps/dir/?api=1&travelmode=walking&origin=" + q(o) +
      "&destination=" + q(d) + (mid.length ? "&waypoints=" + mid.map(q).join("%7C") : "");
  }

  // ---------- map ----------
  var map = L.map("map", { zoomControl: true, scrollWheelZoom: true });
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);
  var nearLayer = L.layerGroup().addTo(map), routeLayer = L.layerGroup().addTo(map), markerLayer = L.layerGroup().addTo(map);
  var markers = {}, legLines = {};
  map.fitBounds(L.latLngBounds(STOPS.map(function (s) { return [s.lat, s.lng]; })).pad(0.12));
  var accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#d2430f";

  // ---------- render ----------
  var listEl = document.getElementById("stops"), nearEl = document.getElementById("nearby");
  var showAllNear = false, view = {};
  function render() {
    var day = state.day, start = toMin(state.start), dwell = +state.dwell;
    var act = state.order.filter(function (id) { return isActive(id, day); });
    var sch = schedule(act, day, start, dwell), rowBy = {};
    sch.rows.forEach(function (r, i) { r.n = i + 1; rowBy[r.id] = r; });

    // day toggle
    ["sat", "sun"].forEach(function (d) {
      document.getElementById("day-" + d).setAttribute("aria-checked", String(d === day));
    });

    // summary
    document.getElementById("summary").innerHTML =
      cell("Stops", act.length + " / " + state.order.length) +
      cell("Walking", fmtDur(sch.walkS)) +
      cell("Distance", fmtMi(sch.walkM)) +
      cell("Done by", act.length ? fmtTime(sch.end) : "–");
    function cell(k, v) { return "<div><dt>" + k + "</dt><dd>" + v + "</dd></div>"; }

    document.getElementById("apple-all").href = appleRoute(act, false);
    document.getElementById("apple-here").href = appleRoute(act, true);
    document.getElementById("google-all").href = googleRoute(act);

    // list
    listEl.innerHTML = state.order.map(function (id, idx) {
      var s = byId[id], r = rowBy[id], h = s[day], other = day === "sat" ? "sun" : "sat";
      var pills = [];
      if (!h) pills.push('<span class="pill bad">Closed ' + DAY_LABEL[day] + (s[other] ? " · open " + DAY_LABEL[other] + " " + fmtHours(s[other]) : "") + "</span>");
      else pills.push('<span class="pill">' + DAY_LABEL[day] + " " + fmtHours(h) + "</span>");
      if (h && state.skip[id]) pills.push('<span class="pill">Skipped</span>');
      if (isExtra[id]) pills.push('<span class="pill added">Added</span>');
      if (r) {
        pills.unshift('<span class="pill arrive">Arrive ' + fmtTime(r.arrive) + "</span>");
        if (r.wait > 0) pills.push('<span class="pill warn">Opens ' + fmtHour(h[0]) + ", wait " + Math.round(r.wait) + " min</span>");
        if (r.lateBy > 0) pills.push('<span class="pill bad">' + (r.lateBy >= dwell ? "Closed by arrival" : "Only " + Math.max(0, Math.round(dwell - r.lateBy)) + " min before close") + "</span>");
      }
      var legHtml = "";
      if (r && r.leg) {
        var prev = sch.rows[r.n - 2].id;
        legHtml = '<div class="leg"><span>Walk <b>' + fmtDur(r.leg.s) + "</b> · " + fmtMi(r.leg.m) + " from " + esc(byId[prev].name) + '</span><a href="' + appleLeg(prev, id) + '" target="_blank" rel="noopener">Directions</a></div>';
      }
      var skipBtn = isExtra[id] ? '<button type="button" data-remove="' + id + '">Remove</button>' :
        h ? '<button type="button" data-skip="' + id + '">' + (state.skip[id] ? "Add back" : "Skip") + "</button>" : "";
      return '<li class="stop' + (r ? "" : " off") + '" data-id="' + id + '">' + legHtml +
        '<div class="row"><span class="grip" aria-hidden="true"></span>' +
        '<span class="num">' + (r ? r.n : "–") + "</span>" +
        "<div><p class=\"name\"><a href=\"" + s.url + '" target="_blank" rel="noopener">' + esc(s.name) + "</a></p>" +
        '<p class="addr">' + esc(s.addr) + (s.note ? " · " + esc(s.note) : "") + "</p>" +
        '<div class="meta">' + pills.join("") + "</div>" +
        '<div class="links"><a href="' + applePlace(s) + '" target="_blank" rel="noopener">Apple Maps</a>' + skipBtn + "</div></div>" +
        '<div class="move"><button type="button" data-up="' + idx + '" aria-label="Move ' + esc(s.name) + ' up"' + (idx === 0 ? " disabled" : "") + ">▲</button>" +
        '<button type="button" data-down="' + idx + '" aria-label="Move ' + esc(s.name) + ' down"' + (idx === state.order.length - 1 ? " disabled" : "") + ">▼</button></div>" +
        "</div></li>";
    }).join("");

    // nearby
    var near = nearby(act, day).filter(function (x) { return x.add <= 20 * 60; });
    var shown = showAllNear ? near : near.slice(0, 8);
    nearEl.innerHTML = near.length ? shown.map(function (x) {
      var s = x.s, where = x.after && x.before ? "between " + esc(byId[x.after].name) + " and " + esc(byId[x.before].name)
        : x.after ? "after " + esc(byId[x.after].name) : x.before ? "before " + esc(byId[x.before].name) : "";
      return '<li class="near" data-near="' + s.id + '"><div><p class="name"><a href="' + s.url + '" target="_blank" rel="noopener">' + esc(s.name) + '</a></p>' +
        '<p class="addr">' + esc(s.addr) + " · " + DAY_LABEL[day] + " " + fmtHours(s[day]) + "</p>" +
        '<p class="detour"><b>+' + Math.max(1, Math.round(x.add / 60)) + " min walk</b> " + where + "</p></div>" +
        '<button type="button" class="btn add" data-add="' + s.id + '" aria-label="Add ' + esc(s.name) + '">Add</button></li>';
    }).join("") + (near.length > 8 ? '<li class="more"><button type="button" class="btn ghost" id="near-more">' + (showAllNear ? "Show fewer" : "Show all " + near.length) + "</button></li>" : "")
      : '<li class="empty">No other open sites within a short walk.</li>';

    view = { day: day, sch: sch, rowBy: rowBy, near: shown };
    drawMap();
    save();
  }

  function drawMap() {
    var day = view.day, sch = view.sch, rowBy = view.rowBy;
    nearLayer.clearLayers(); routeLayer.clearLayers(); markerLayer.clearLayers(); markers = {}; legLines = {};
    sch.rows.forEach(function (r, i) {
      if (!r.leg) return;
      var prev = sch.rows[i - 1].id, l = leg(prev, r.id);
      if (l.rough) fetchLeg(prev, r.id);
      L.polyline(l.pts, { color: "#000", weight: 7, opacity: 0.12 }).addTo(routeLayer);
      legLines[r.id] = L.polyline(l.pts, { color: accent, weight: 4, opacity: 0.9, dashArray: l.rough ? "6 6" : null }).addTo(routeLayer);
    });
    view.near.forEach(function (x) {
      var s = x.s;
      var m = L.marker([s.lat, s.lng], { icon: L.divIcon({ className: "", html: '<div class="mk near"></div>', iconSize: [14, 14], iconAnchor: [7, 7] }), title: s.name, zIndexOffset: -500 });
      m.bindPopup("<strong>" + esc(s.full) + "</strong><br>" + esc(s.addr) + "<br>" + DAY_LABEL[day] + " " + fmtHours(s[day]) +
        " · +" + Math.max(1, Math.round(x.add / 60)) + ' min walk<br><button type="button" class="btn add" data-add="' + s.id + '">Add to route</button>');
      m.addTo(nearLayer); markers[s.id] = m;
    });
    state.order.forEach(function (id) {
      var s = byId[id], r = rowBy[s.id];
      var icon = L.divIcon({ className: "", html: '<div class="mk' + (r ? "" : " off") + '">' + (r ? r.n : "") + "</div>", iconSize: [28, 28], iconAnchor: [14, 14] });
      var m = L.marker([s.lat, s.lng], { icon: icon, zIndexOffset: r ? 1000 - r.n : 0, title: s.name });
      m.bindPopup("<strong>" + esc(s.full) + "</strong><br>" + esc(s.addr) + "<br>" +
        (r ? "Stop " + r.n + " · arrive " + fmtTime(r.arrive) : (s[day] ? "Skipped" : "Closed " + DAY_LABEL[day])) +
        '<br><a href="' + applePlace(s) + '" target="_blank" rel="noopener">Open in Apple Maps</a>');
      m.on("click", function () { highlight(s.id, true); });
      m.addTo(markerLayer); markers[s.id] = m;
    });
  }
  function esc(t) { return String(t).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  function highlight(id, scroll) {
    listEl.querySelectorAll(".stop.hl").forEach(function (el) { el.classList.remove("hl"); });
    var el = listEl.querySelector('[data-id="' + id + '"]');
    if (el) { el.classList.add("hl"); if (scroll && window.innerWidth > 800) el.scrollIntoView({ block: "nearest", behavior: "smooth" }); }
    Object.keys(legLines).forEach(function (k) { legLines[k].setStyle({ weight: k === id ? 7 : 4 }); });
  }

  // ---------- events ----------
  Sortable.create(listEl, {
    handle: ".grip", draggable: ".stop", animation: 150,
    onEnd: function () {
      state.order = Array.prototype.map.call(listEl.querySelectorAll(".stop"), function (el) { return el.dataset.id; });
      render();
    }
  });
  listEl.addEventListener("click", function (e) {
    var b = e.target.closest("button");
    if (b) {
      var i;
      if (b.dataset.up != null) { i = +b.dataset.up; swap(i, i - 1); }
      else if (b.dataset.down != null) { i = +b.dataset.down; swap(i, i + 1); }
      else if (b.dataset.skip) { state.skip[b.dataset.skip] = !state.skip[b.dataset.skip]; render(); }
      else if (b.dataset.remove) { state.order.splice(state.order.indexOf(b.dataset.remove), 1); render(); }
      return;
    }
    if (e.target.closest("a")) return;
    var li = e.target.closest(".stop");
    if (li) {
      var s = byId[li.dataset.id];
      highlight(s.id, false);
      map.panTo([s.lat, s.lng]);
      markers[s.id].openPopup();
    }
  });
  nearEl.addEventListener("click", function (e) {
    var b = e.target.closest("button");
    if (b && b.dataset.add) { addStop(b.dataset.add); return; }
    if (b && b.id === "near-more") { showAllNear = !showAllNear; render(); return; }
    if (e.target.closest("a")) return;
    var li = e.target.closest(".near");
    if (li && markers[li.dataset.near]) {
      var s = byId[li.dataset.near];
      map.panTo([s.lat, s.lng]);
      markers[s.id].openPopup();
    }
  });
  document.getElementById("map").addEventListener("click", function (e) {
    var b = e.target.closest("button[data-add]");
    if (b) { map.closePopup(); addStop(b.dataset.add); }
  });
  function swap(a, b) {
    var o = state.order, t = o[a]; o[a] = o[b]; o[b] = t;
    render();
  }
  document.querySelectorAll(".seg button").forEach(function (b) {
    b.addEventListener("click", function () { state.day = b.dataset.day; render(); });
  });
  var startEl = document.getElementById("start"), dwellEl = document.getElementById("dwell");
  startEl.value = state.start; dwellEl.value = state.dwell;
  startEl.addEventListener("change", function () { if (startEl.value) { state.start = startEl.value; render(); } });
  dwellEl.addEventListener("change", function () {
    var v = Math.max(5, Math.min(180, Math.round(+dwellEl.value) || 30));
    dwellEl.value = v; state.dwell = v; render();
  });
  document.getElementById("suggest").addEventListener("click", function () {
    state.order = suggest(); render();
  });

  var appEl = document.querySelector(".app"), mapBtn = document.getElementById("maptoggle");
  mapBtn.addEventListener("click", function () {
    var small = appEl.classList.toggle("map-small");
    mapBtn.textContent = small ? "Bigger map" : "Smaller map";
    mapBtn.setAttribute("aria-pressed", String(small));
    setTimeout(function () { map.invalidateSize(); }, 250);
  });

  if (!valid(state.order)) state.order = suggest();
  render();
})();
