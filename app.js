(function () {
  "use strict";

  var STOPS = window.STOPS, EXTRAS = window.EXTRAS || [], ROUTES = window.ROUTES, TABLE = window.TABLE, INFO = window.INFO || {};
  var byId = {}, isExtra = {}, tIdx = {};
  STOPS.forEach(function (s) { byId[s.id] = s; });
  EXTRAS.forEach(function (s) { byId[s.id] = s; isExtra[s.id] = true; });
  TABLE.ids.forEach(function (id, i) { tIdx[id] = i; });
  var ALL = STOPS.concat(EXTRAS);
  var DAY_LABEL = { sat: "Sat", sun: "Sun" }, DAY_LONG = { sat: "Saturday", sun: "Sunday" };
  var KEY = "mke-doors-open-2026";
  var WALK_MPS = 1.25;

  // ---------- state ----------
  var state = load() || {};
  if (!state.day) state.day = new Date() >= new Date(2026, 8, 27) ? "sun" : "sat";
  if (!state.start) state.start = "10:00";
  if (!state.dwell) state.dwell = 30;
  if (!state.skip) state.skip = {};
  if (!state.visited) state.visited = {};
  if (state.others == null) state.others = true;

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
  function metersBetween(a, b) {
    var R = 6371000, toR = Math.PI / 180;
    var dLat = (b[0] - a[0]) * toR, dLng = (b[1] - a[1]) * toR;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a[0] * toR) * Math.cos(b[0] * toR) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  // ---------- schedule ----------
  function isActive(id, day) { return !!byId[id][day] && !state.skip[id]; }
  function toMin(hhmm) { var p = hhmm.split(":"); return +p[0] * 60 + +p[1]; }
  function fmtTime(min) {
    min = Math.round(min);
    var h = Math.floor(min / 60), m = min % 60;
    return (h % 12 || 12) + ":" + (m < 10 ? "0" : "") + m + " " + (h >= 12 ? "PM" : "AM");
  }
  function fmtHour(h) {
    var mm = Math.round((h % 1) * 60), hh = Math.floor(h);
    return (hh % 12 || 12) + (mm ? ":" + (mm < 10 ? "0" : "") + mm : "") + " " + (hh >= 12 ? "PM" : "AM");
  }
  function fmtHours(h) { return fmtHour(h[0]) + " – " + fmtHour(h[1]); }
  function fmtMi(m) { return (m / 1609.34).toFixed(m < 1609 ? 2 : 1) + " mi"; }
  function fmtWalk(sec) { return Math.max(1, Math.round(sec / 60)) + " min"; }
  function fmtDur(sec) {
    var min = Math.round(sec / 60);
    return min < 60 ? min + " min" : Math.floor(min / 60) + " hr " + (min % 60) + " min";
  }

  // Walk the active stops in order, tracking arrival time, waits and late arrivals.
  function schedule(ids, day, start, dwell) {
    var t = start, prev = null, walkS = 0, walkM = 0, late = 0, rows = [];
    ids.forEach(function (id) {
      var s = byId[id], h = s[day], l = null;
      if (prev) { l = leg(prev, id); t += l.s / 60; walkS += l.s; walkM += l.m; }
      var arrive = t, wait = 0;
      if (arrive < h[0] * 60) { wait = h[0] * 60 - arrive; t = h[0] * 60; }
      var lateBy = t + dwell - h[1] * 60;
      if (lateBy > 0) late += lateBy;
      rows.push({ id: id, prev: prev, leg: l, arrive: arrive, wait: wait, lateBy: lateBy, leave: t + dwell });
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
    } else if (act.length) {
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

  // Where a site would slot into the route, and how much walking it adds.
  function detour(s, act) {
    var best = { add: Infinity, after: null, before: null, s: s };
    if (!act.length) return { add: 0, after: null, before: null, s: s };
    for (var i = 0; i <= act.length; i++) {
      var p = act[i - 1], n = act[i], add;
      if (p && n) add = leg(p, s.id).s + leg(s.id, n).s - leg(p, n).s;
      else if (p) add = leg(p, s.id).s;
      else add = leg(s.id, n).s;
      if (add < best.add) best = { add: add, after: p || null, before: n || null, s: s };
    }
    return best;
  }
  // Open sites not in the list, ranked by the extra walking it takes to fit them in.
  function nearby(act, day) {
    return EXTRAS.filter(function (s) { return !inPlan(s.id) && s[day]; })
      .map(function (s) { return detour(s, act); })
      .sort(function (a, b) { return a.add - b.add; });
  }
  function inPlan(id) { return state.order.indexOf(id) >= 0; }
  function addStop(id) {
    if (inPlan(id)) return;
    var act = state.order.filter(function (x) { return isActive(x, state.day); });
    var n = detour(byId[id], act), pos = state.order.length;
    if (n.after) pos = state.order.indexOf(n.after) + 1;
    else if (n.before) pos = state.order.indexOf(n.before);
    state.order.splice(pos, 0, id);
    render();
  }
  function removeStop(id) {
    var i = state.order.indexOf(id);
    if (i >= 0 && isExtra[id]) state.order.splice(i, 1);
    render();
  }

  // ---------- today / live status ----------
  function todayKey() {
    var d = new Date();
    if (d.getFullYear() !== 2026 || d.getMonth() !== 8) return null;
    return d.getDate() === 26 ? "sat" : d.getDate() === 27 ? "sun" : null;
  }
  function nowMin() { var d = new Date(); return d.getHours() * 60 + d.getMinutes(); }
  function status(s, day) {
    var h = s[day], other = day === "sat" ? "sun" : "sat";
    if (!h) return { cls: "closed", text: "Closed " + DAY_LABEL[day] + (s[other] ? " · open " + DAY_LABEL[other] + " " + fmtHours(s[other]) : "") };
    if (todayKey() === day) {
      var n = nowMin();
      if (n < h[0] * 60) return { cls: "soon", text: "Opens " + fmtHour(h[0]) + " · until " + fmtHour(h[1]) };
      if (n < h[1] * 60) return { cls: "open", text: "Open now · until " + fmtHour(h[1]) };
      return { cls: "closed", text: "Closed for today · was " + fmtHours(h) };
    }
    return { cls: "open", text: "Open " + fmtHours(h) };
  }
  function statusHtml(s, day) {
    var st = status(s, day);
    return '<span class="status ' + st.cls + '"><i class="dot" aria-hidden="true"></i>' + esc(st.text) + "</span>";
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
    parts.push("destination=" + q(dest || byId[ids[0]]));
    parts.push("mode=walking");
    return "https://maps.apple.com/directions?" + parts.join("&");
  }
  function appleTo(s) { return "https://maps.apple.com/directions?destination=" + q(s) + "&mode=walking"; }
  function applePlace(s) {
    return "https://maps.apple.com/?q=" + encodeURIComponent(s.full) + "&ll=" + s.lat + "," + s.lng + "&address=" + q(s);
  }
  function googlePlace(s) { return "https://www.google.com/maps/dir/?api=1&travelmode=walking&destination=" + q(s); }
  function googleRoute(ids) {
    var stops = ids.map(function (id) { return byId[id]; });
    if (!stops.length) return "https://www.google.com/maps";
    var o = stops[0], d = stops[stops.length - 1], mid = stops.slice(1, -1);
    return "https://www.google.com/maps/dir/?api=1&travelmode=walking&origin=" + q(o) +
      "&destination=" + q(d) + (mid.length ? "&waypoints=" + mid.map(q).join("%7C") : "");
  }

  // ---------- helpers ----------
  function esc(t) { return String(t).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function icon(name, cls) { return '<svg class="ic' + (cls ? " " + cls : "") + '" aria-hidden="true"><use href="#i-' + name + '"/></svg>'; }
  function info(id) { return INFO[id] || { photos: [], desc: [], exp: [], tags: [] }; }
  function thumb(id, cls) {
    var i = INFO[id];
    return '<span class="ph ' + (cls || "") + '">' + (i ? '<img src="' + esc(i.thumb) + '" alt="" loading="lazy" decoding="async">' : "") + "</span>";
  }
  var desktop = window.matchMedia("(min-width: 900px)");
  // Broken images fall back to the tinted placeholder behind them.
  document.addEventListener("error", function (e) {
    if (e.target.tagName === "IMG") e.target.classList.add("broken");
  }, true);

  // ---------- map ----------
  var map = L.map("map", { zoomControl: false, scrollWheelZoom: true, attributionControl: true });
  L.control.zoom({ position: "bottomright" }).addTo(map);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);
  var otherLayer = L.layerGroup().addTo(map), routeLayer = L.layerGroup().addTo(map), markerLayer = L.layerGroup().addTo(map), meLayer = L.layerGroup().addTo(map);
  var markers = {};
  function fitRoute() {
    var ids = view.act && view.act.length ? view.act : STOPS.map(function (s) { return s.id; });
    var pad = desktop.matches ? [60, 60] : [40, 40];
    map.fitBounds(L.latLngBounds(ids.map(function (id) { return [byId[id].lat, byId[id].lng]; })), {
      paddingTopLeft: desktop.matches ? [40, 180] : [30, 190], paddingBottomRight: desktop.matches ? pad : [30, 200]
    });
  }
  var accent = getComputedStyle(document.documentElement).getPropertyValue("--route").trim() || "#c4461c";

  function drawMap() {
    var day = state.day, sch = view.sch, rowBy = view.rowBy;
    otherLayer.clearLayers(); routeLayer.clearLayers(); markerLayer.clearLayers(); markers = {};
    sch.rows.forEach(function (r) {
      if (!r.leg) return;
      var l = leg(r.prev, r.id);
      if (l.rough) fetchLeg(r.prev, r.id);
      L.polyline(l.pts, { color: "#fff", weight: 8, opacity: 0.85, interactive: false }).addTo(routeLayer);
      L.polyline(l.pts, { color: accent, weight: r.id === view.sel ? 6 : 4, opacity: 0.95, dashArray: l.rough ? "6 7" : null, interactive: false }).addTo(routeLayer);
    });
    if (state.others) {
      EXTRAS.forEach(function (s) {
        if (inPlan(s.id) || !s[day]) return;
        var m = L.marker([s.lat, s.lng], {
          icon: L.divIcon({ className: "", html: '<div class="dotpin' + (s.id === view.sel ? " sel" : "") + '"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }),
          title: s.full, alt: s.full, zIndexOffset: -500
        });
        m.on("click", function () { select(s.id); });
        m.addTo(otherLayer); markers[s.id] = m;
      });
    }
    state.order.forEach(function (id) {
      var s = byId[id], r = rowBy[id], i = INFO[id], sel = id === view.sel;
      var done = !!state.visited[id];
      var html = '<div class="pin' + (r ? "" : " off") + (sel ? " sel" : "") + (done ? " done" : "") + '"><span class="pimg">' +
        (i ? '<img src="' + esc(i.thumb) + '" alt="">' : "") + "</span>" + (r || done ? '<span class="pn">' + (done ? "✓" : r.n) + "</span>" : "") + "</div>";
      var size = r ? 50 : 36;
      var m = L.marker([s.lat, s.lng], {
        icon: L.divIcon({ className: "", html: html, iconSize: [size, size + 8], iconAnchor: [size / 2, size + 8] }),
        zIndexOffset: sel ? 2000 : r ? 1000 - r.n : 0, title: s.full + (done ? " (visited)" : ""), alt: s.full
      });
      m.on("click", function () { select(id); });
      m.addTo(markerLayer); markers[id] = m;
    });
  }

  // Live location
  var me = null, watchId = null, meMarker = null, meCircle = null, firstFix = false;
  var locBtn = document.getElementById("locate");
  locBtn.addEventListener("click", function () {
    if (watchId != null) {
      if (me) { map.setView(me, Math.max(map.getZoom(), 16)); return; }
    }
    if (!navigator.geolocation) { locBtn.disabled = true; return; }
    locBtn.classList.add("busy");
    firstFix = true;
    if (watchId == null) watchId = navigator.geolocation.watchPosition(function (p) {
      me = [p.coords.latitude, p.coords.longitude];
      locBtn.classList.remove("busy"); locBtn.setAttribute("aria-pressed", "true");
      if (!meMarker) {
        meCircle = L.circle(me, { radius: p.coords.accuracy, color: "#2f7ff5", weight: 1, fillOpacity: 0.1, interactive: false }).addTo(meLayer);
        meMarker = L.marker(me, { icon: L.divIcon({ className: "", html: '<div class="me"></div>', iconSize: [22, 22], iconAnchor: [11, 11] }), zIndexOffset: 3000, title: "You are here", keyboard: false }).addTo(meLayer);
      } else { meMarker.setLatLng(me); meCircle.setLatLng(me).setRadius(p.coords.accuracy); }
      if (firstFix) { firstFix = false; map.setView(me, Math.max(map.getZoom(), 16)); }
      renderPeek();
    }, function () {
      locBtn.classList.remove("busy");
      navigator.geolocation.clearWatch(watchId); watchId = null;
      locBtn.setAttribute("aria-pressed", "false");
      locBtn.title = "Location unavailable";
    }, { enableHighAccuracy: true, maximumAge: 15000 });
  });
  function minAway(s) {
    if (!me) return null;
    return Math.max(1, Math.round(metersBetween(me, [s.lat, s.lng]) * 1.25 / WALK_MPS / 60));
  }

  var layersBtn = document.getElementById("layers");
  layersBtn.setAttribute("aria-pressed", String(state.others));
  layersBtn.addEventListener("click", function () {
    state.others = !state.others;
    layersBtn.setAttribute("aria-pressed", String(state.others));
    drawMap(); save();
  });

  // ---------- render ----------
  var app = document.getElementById("app");
  var listEl = document.getElementById("stops"), nearEl = document.getElementById("nearby"), peekEl = document.getElementById("peek");
  var detailEl = document.getElementById("detail"), sitesEl = document.getElementById("sites");
  var view = { v: "map", sel: null, detail: null, tab: "overview", edit: false, nearCat: "All", listCat: "All", q: "", openOnly: true };
  var dragging = false;

  function render() {
    var day = state.day, start = toMin(state.start), dwell = +state.dwell;
    var act = state.order.filter(function (id) { return isActive(id, day); });
    var sch = schedule(act, day, start, dwell), rowBy = {};
    sch.rows.forEach(function (r, i) { r.n = i + 1; rowBy[r.id] = r; });
    view.act = act; view.sch = sch; view.rowBy = rowBy;

    document.getElementById("day").value = day;
    document.querySelectorAll(".seg button").forEach(function (b) { b.setAttribute("aria-checked", String(b.dataset.day === day)); });

    renderPlan(); renderNearby(); renderList(); renderPeek();
    if (view.v === "stop") renderDetail();
    drawMap();
    save();
  }

  function renderPlan() {
    var day = state.day, act = view.act, sch = view.sch, rowBy = view.rowBy, dwell = +state.dwell;
    var total = act.length ? (sch.end - toMin(state.start)) * 60 : 0;
    var seen = act.filter(function (id) { return state.visited[id]; }).length;
    document.getElementById("plan-sub").textContent = act.length + " stop" + (act.length === 1 ? "" : "s") + " · " + fmtMi(sch.walkM) + " · ~" + fmtDur(total);
    var prog = document.getElementById("progress");
    prog.hidden = !act.length;
    prog.innerHTML = '<span class="bar"><i style="width:' + (act.length ? Math.round(seen / act.length * 100) : 0) + '%"></i></span>' +
      '<span><b>' + seen + " of " + act.length + "</b> visited" + (seen === act.length && seen ? " · nice work!" : " · tap ✓ when you've been") + "</span>" +
      (Object.keys(state.visited).length ? '<button type="button" id="clear-visited">Clear</button>' : "");
    document.getElementById("plan-done").innerHTML = act.length ?
      "Start <b>" + fmtTime(toMin(state.start)) + "</b> · done by <b>" + fmtTime(sch.end) + "</b> · " + fmtDur(sch.walkS) + " walking" : "No open stops on " + DAY_LONG[day] + ".";
    document.getElementById("apple-all").href = appleRoute(act, false);
    document.getElementById("apple-here").href = appleRoute(act, true);
    document.getElementById("google-all").href = googleRoute(act);
    var editBtn = document.getElementById("edit");
    editBtn.textContent = view.edit ? "Done" : "Edit";
    editBtn.setAttribute("aria-pressed", String(view.edit));

    // Open stops in route order first, then the ones left off the route.
    var ordered = state.order.filter(function (id) { return rowBy[id]; }).concat(state.order.filter(function (id) { return !rowBy[id]; }));
    listEl.classList.toggle("editing", view.edit);
    listEl.innerHTML = ordered.map(function (id) {
      var s = byId[id], r = rowBy[id], h = s[day], idx = state.order.indexOf(id);
      var lines = [];
      if (r && r.leg) lines.push('<p class="ln">' + icon("walk", "xs") + fmtWalk(r.leg.s) + " walk · " + fmtMi(r.leg.m) + "</p>");
      else if (r) lines.push('<p class="ln">' + icon("pin", "xs") + "First stop" + "</p>");
      else lines.push('<p class="ln">' + icon("pin", "xs") + esc(s.addr) + "</p>");
      lines.push('<p class="ln">' + statusHtml(s, day) + (r ? '<span class="arr">Arrive ' + fmtTime(r.arrive) + "</span>" : "") + "</p>");
      if (state.visited[id]) lines.push('<p class="flag ok">' + icon("check", "xs") + "Visited</p>");
      if (h && state.skip[id]) lines.push('<p class="flag">Skipped</p>');
      if (r && r.wait > 0) lines.push('<p class="flag warn">Opens ' + fmtHour(h[0]) + ", about " + Math.round(r.wait) + " min wait</p>");
      if (r && r.lateBy > 0) lines.push('<p class="flag bad">' + (r.lateBy >= dwell ? "Closed by the time you arrive" : "Only " + Math.max(0, Math.round(dwell - r.lateBy)) + " min before close") + "</p>");
      var edit = '<div class="editrow">' +
        '<button type="button" data-up="' + idx + '"' + (idx === 0 ? " disabled" : "") + ' aria-label="Move ' + esc(s.name) + ' earlier">' + icon("up", "sm") + "</button>" +
        '<button type="button" data-down="' + idx + '"' + (idx === state.order.length - 1 ? " disabled" : "") + ' aria-label="Move ' + esc(s.name) + ' later">' + icon("down", "sm") + "</button>" +
        (isExtra[id] ? '<button type="button" data-remove="' + id + '">Remove</button>' :
          h ? '<button type="button" data-skip="' + id + '">' + (state.skip[id] ? "Add back" : "Skip") + "</button>" : "") + "</div>";
      var done = !!state.visited[id];
      var num = '<span class="num">' + (done ? icon("check", "sm") : r ? r.n : "–") + "</span>";
      var box = h || done ? '<button type="button" class="checkbox" data-visit="' + id + '" aria-pressed="' + done + '" aria-label="' + (done ? "Uncheck " : "Check off ") + esc(s.name) + '">' + icon("check", "sm") + "</button>" : "<span></span>";
      return '<li class="stop' + (r ? "" : " off") + (done ? " done" : "") + (id === view.sel ? " sel" : "") + '" data-id="' + id + '">' + num +
        '<button type="button" class="card" data-open="' + id + '">' + thumb(id, "th") +
        '<span class="txt"><span class="nm">' + esc(s.name) + "</span>" + lines.join("") + "</span></button>" + box +
        '<span class="grip" role="img" aria-label="Drag to reorder">' + icon("grip") + "</span>" + edit + "</li>";
    }).join("");
  }

  function catsFor(list) {
    var count = {};
    list.forEach(function (s) { info(s.id).tags.forEach(function (t) { count[t] = (count[t] || 0) + 1; }); });
    return ["All"].concat(Object.keys(count).sort(function (a, b) { return count[b] - count[a]; }).slice(0, 7));
  }
  function chipsHtml(cats, cur, attr) {
    return cats.map(function (c) { return '<button type="button" class="chip" ' + attr + '="' + esc(c) + '" aria-pressed="' + (c === cur) + '">' + esc(c) + "</button>"; }).join("");
  }

  function renderNearby() {
    var day = state.day;
    var near = nearby(view.act, day).filter(function (x) { return x.add <= 20 * 60; });
    var cats = catsFor(near.map(function (x) { return x.s; }));
    if (cats.indexOf(view.nearCat) < 0) view.nearCat = "All";
    document.getElementById("near-chips").innerHTML = chipsHtml(cats, view.nearCat, "data-ncat");
    var shown = near.filter(function (x) { return view.nearCat === "All" || info(x.s.id).tags.indexOf(view.nearCat) >= 0; });
    nearEl.innerHTML = shown.length ? shown.map(function (x) {
      var s = x.s, where = x.after && x.before ? "between " + byId[x.after].name + " and " + byId[x.before].name
        : x.after ? "after " + byId[x.after].name : x.before ? "before " + byId[x.before].name : "";
      return '<div class="xcard">' +
        '<button type="button" class="xopen" data-open="' + s.id + '">' + thumb(s.id, "xth") +
        '<span class="xname">' + esc(s.name) + "</span>" +
        '<span class="xmeta">' + icon("walk", "xs") + "+" + fmtWalk(x.add) + (where ? " · " + esc(where) : "") + "</span>" +
        '<span class="xmeta">' + statusHtml(s, day) + "</span></button>" +
        '<button type="button" class="addbtn" data-add="' + s.id + '" aria-label="Add ' + esc(s.name) + ' to your plan">' + icon("plus", "sm") + "Add</button></div>";
    }).join("") : '<p class="empty">No other open sites within a short walk.</p>';
  }

  function renderList() {
    var day = state.day, qq = view.q.trim().toLowerCase();
    var base = ALL.filter(function (s) { return !view.openOnly || s[day] || inPlan(s.id); });
    var cats = catsFor(base);
    if (cats.indexOf(view.listCat) < 0) view.listCat = "All";
    document.getElementById("list-chips").innerHTML =
      '<button type="button" class="chip" id="open-only" aria-pressed="' + view.openOnly + '">Open ' + DAY_LABEL[day] + "</button>" +
      chipsHtml(cats, view.listCat, "data-lcat");
    var list = base.filter(function (s) {
      if (view.listCat !== "All" && info(s.id).tags.indexOf(view.listCat) < 0) return false;
      return !qq || (s.full + " " + s.addr + " " + info(s.id).tags.join(" ")).toLowerCase().indexOf(qq) >= 0;
    }).sort(function (a, b) { return a.full.replace(/^The /, "").localeCompare(b.full.replace(/^The /, "")); });
    document.getElementById("list-sub").textContent = list.length + " of " + ALL.length + " downtown Doors Open sites";
    sitesEl.innerHTML = list.length ? list.map(function (s) {
      var r = view.rowBy[s.id], p = inPlan(s.id);
      var btn = state.visited[s.id] ? '<span class="stopno ok" aria-label="Visited">' + icon("check", "xs") + "</span>" : p ? (r ? '<span class="stopno" aria-label="Stop ' + r.n + '">' + r.n + "</span>" : '<span class="stopno off" aria-label="In your plan, not on route">' + icon("check", "xs") + "</span>")
        : '<button type="button" class="addbtn round-add" data-add="' + s.id + '" aria-label="Add ' + esc(s.name) + ' to your plan">' + icon("plus", "sm") + "</button>";
      return '<li class="site"><button type="button" class="card" data-open="' + s.id + '">' + thumb(s.id, "th sm") +
        '<span class="txt"><span class="nm">' + esc(s.full) + '</span><span class="ln">' + esc(s.addr) + "</span>" +
        '<span class="ln">' + statusHtml(s, day) + "</span></span></button>" + btn + "</li>";
    }).join("") : '<li class="empty">No sites match.</li>';
  }

  function nextId() {
    var rows = view.sch.rows;
    if (!rows.length) return state.order[0];
    for (var i = 0; i < rows.length; i++) if (!state.visited[rows[i].id]) return rows[i].id;
    return rows[rows.length - 1].id;
  }
  function eyebrow(id) {
    var s = byId[id], r = view.rowBy[id];
    if (r) return "Stop " + r.n + " of " + view.act.length;
    if (!inPlan(id)) return "Nearby site";
    if (!s[state.day]) return "Closed " + DAY_LABEL[state.day];
    return "Skipped";
  }
  function renderPeek() {
    var id = view.sel && byId[view.sel] ? view.sel : nextId();
    if (!id) { peekEl.innerHTML = ""; return; }
    var s = byId[id], r = view.rowBy[id], away = minAway(s);
    var kick = away != null ? "~" + away + " min away" : r ? eyebrow(id) + " · arrive " + fmtTime(r.arrive) : eyebrow(id);
    var done = !!state.visited[id];
    if (!view.sel && r && !done && away == null) kick = "Up next · arrive " + fmtTime(r.arrive);
    if (done) kick = "Visited" + (away != null ? " · ~" + away + " min away" : "");
    peekEl.innerHTML = '<div class="grab" aria-hidden="true"></div><div class="prow"><button type="button" class="card" data-open="' + id + '">' + thumb(id, "pth") +
      '<span class="txt"><span class="kick">' + esc(kick) + '</span><span class="nm">' + esc(s.name) + "</span>" +
      '<span class="ln">' + statusHtml(s, state.day) + "</span></span></button>" +
      (s[state.day] || done ? '<button type="button" class="chev check" data-visit="' + id + '" aria-pressed="' + done + '" aria-label="' + (done ? "Uncheck " : "Check off ") + esc(s.name) + '">' + icon("check") + "</button>" : "") +
      '<button type="button" class="chev" data-open="' + id + '" aria-label="Open ' + esc(s.name) + '">' + icon("right") + "</button></div>";
  }

  function renderDetail() {
    var id = view.detail, s = byId[id];
    if (!s) return;
    var day = state.day, i = info(id), r = view.rowBy[id], p = inPlan(id), marked = isExtra[id] ? p : !!r;
    var hero = i.img ? '<img src="' + esc(i.img) + '" alt="' + esc(i.alt || s.full) + '" decoding="async">' : "";
    var photos = i.photos || [];
    var tab = view.tab;
    var body;
    if (tab === "photos") {
      body = photos.length ? '<div class="pgrid">' + photos.map(function (ph, k) {
        return '<button type="button" class="ph" data-photo="' + k + '" aria-label="Open photo ' + (k + 1) + ' of ' + photos.length + '"><img src="' + esc(ph.thumb) + '" alt="" loading="lazy"></button>';
      }).join("") + "</div>" : '<p class="muted">No photos posted for this site.</p>';
      body += '<p class="credit">Photos from <a href="' + s.url + '" target="_blank" rel="noopener">Historic Milwaukee</a>.</p>';
    } else if (tab === "info") {
      var legLine = "";
      if (r && r.leg) legLine = fmtWalk(r.leg.s) + " walk (" + fmtMi(r.leg.m) + ") from " + esc(byId[r.prev].name) + ", arrive " + fmtTime(r.arrive);
      else if (r) legLine = "First stop, arrive " + fmtTime(r.arrive);
      body = '<dl class="facts">' +
        fact("Address", esc(s.addr) + (s.note ? "<br><span class=\"muted\">" + esc(s.note) + "</span>" : "")) +
        fact("Saturday", s.sat ? fmtHours(s.sat) : "Not open") +
        fact("Sunday", s.sun ? fmtHours(s.sun) : "Not open") +
        (legLine ? fact("Your plan", legLine) : "") +
        (i.access ? fact("Accessibility", esc(i.access)) : "") +
        (i.photo ? fact("Photography", esc(i.photo)) : "") +
        (i.tags && i.tags.length ? fact("Interests", i.tags.map(esc).join(", ")) : "") + "</dl>" +
        '<div class="dlinks"><a href="' + s.url + '" target="_blank" rel="noopener">Historic Milwaukee page</a>' +
        '<a href="' + applePlace(s) + '" target="_blank" rel="noopener">Apple Maps</a>' +
        '<a href="' + googlePlace(s) + '" target="_blank" rel="noopener">Google Maps</a>' +
        '<button type="button" data-showmap="' + id + '">Show on map</button></div>';
    } else {
      body = (i.desc || []).map(function (t) { return "<p>" + esc(t) + "</p>"; }).join("") +
        (i.exp && i.exp.length ? '<h3>What you\'ll see</h3>' + i.exp.map(function (t) { return "<p>" + esc(t) + "</p>"; }).join("") : "");
      if (!body) body = '<p class="muted">See the <a href="' + s.url + '" target="_blank" rel="noopener">Historic Milwaukee page</a> for details.</p>';
      if (photos.length > 1) body += '<div class="strip">' + photos.slice(0, 8).map(function (ph, k) {
        return '<button type="button" class="ph" data-photo="' + k + '" aria-label="Open photo ' + (k + 1) + '"><img src="' + esc(ph.thumb) + '" alt="" loading="lazy"></button>';
      }).join("") + "</div>";
    }
    function fact(k, v) { return "<div><dt>" + k + "</dt><dd>" + v + "</dd></div>"; }

    var dirSub = r && r.leg ? fmtWalk(r.leg.s) + " · " + fmtMi(r.leg.m) : minAway(s) != null ? "~" + minAway(s) + " min" : "";
    if (!p && view.act.length) { var d = detour(s, view.act); dirSub = "+" + fmtWalk(d.add) + " to route"; }
    var bookLabel = isExtra[id] ? (p ? "Remove from your plan" : "Add to your plan") : !s[day] ? "Closed " + DAY_LONG[day] : (marked ? "Skip this stop" : "Add back to your route");

    detailEl.innerHTML =
      '<div class="hero">' + hero + '<div class="shade"></div>' +
      '<div class="topbtns"><button type="button" class="round glass" id="d-back" aria-label="Back">' + icon("left") + "</button><span></span>" +
      '<button type="button" class="round glass" id="d-book" aria-pressed="' + marked + '" aria-label="' + bookLabel + '" title="' + bookLabel + '"' + (!isExtra[id] && !s[day] ? " disabled" : "") + ">" + icon("bookmark") + "</button>" +
      '<button type="button" class="round glass" id="d-more" aria-label="More options" aria-expanded="false">' + icon("more") + "</button>" +
      '<div class="menu" id="d-menu" hidden><a href="' + s.url + '" target="_blank" rel="noopener">View on Historic Milwaukee</a>' +
      '<a href="' + applePlace(s) + '" target="_blank" rel="noopener">Open in Apple Maps</a><a href="' + googlePlace(s) + '" target="_blank" rel="noopener">Open in Google Maps</a>' +
      '<button type="button" data-showmap="' + id + '">Show on map</button></div></div>' +
      '<div class="herotext"><p class="eyebrow">' + esc(eyebrow(id)) + '</p><h2 id="d-name">' + esc(s.full) + "</h2>" +
      '<p class="hl">' + icon("pin", "sm") + esc(s.addr) + "</p><p class=\"hl\">" + statusHtml(s, day) +
      (r ? '<span class="arr">Arrive ' + fmtTime(r.arrive) + "</span>" : "") + "</p>" +
      (s[day] || state.visited[id] ? '<button type="button" class="visitbtn" data-visit="' + id + '" aria-pressed="' + !!state.visited[id] + '">' + icon("check", "sm") +
        (state.visited[id] ? "Visited · tap to undo" : "Mark as visited") + "</button>" : "") + "</div></div>" +
      '<div class="tabs" role="tablist">' +
      ["overview", "photos", "info"].map(function (t) {
        var lab = { overview: "Overview", photos: "Photos" + (photos.length ? " (" + photos.length + ")" : ""), info: "Visit Info" }[t];
        return '<button type="button" role="tab" data-tab="' + t + '" aria-selected="' + (t === tab) + '">' + lab + "</button>";
      }).join("") + "</div>" +
      '<div class="dbody" role="tabpanel">' + body + "</div>" +
      '<div class="dirbar">' + (p || !isExtra[id] ?
        '<a class="dir" href="' + appleTo(s) + '" target="_blank" rel="noopener">' + icon("walk") + "<b>Get Directions</b><span>" + esc(dirSub) + "</span></a>" :
        '<button type="button" class="dir" data-add="' + id + '">' + icon("plus") + "<b>Add to My Plan</b><span>" + esc(dirSub) + "</span></button>") + "</div>";
  }

  // ---------- views ----------
  var lastMain = "map", navigated = false;
  function go(hash) { navigated = true; location.hash = hash; }
  function route() {
    var h = decodeURIComponent(location.hash.slice(1));
    var v;
    if (h.indexOf("stop/") === 0 && byId[h.slice(5)]) {
      v = "stop";
      if (view.detail !== h.slice(5)) { view.detail = h.slice(5); view.tab = "overview"; }
      view.sel = view.detail;
    } else if (h === "plan" || h === "list" || h === "map") v = h;
    else v = desktop.matches ? "plan" : "map";
    if (v === "map" && desktop.matches) v = "plan";
    if (v !== "stop") lastMain = v;
    view.v = v;
    app.dataset.view = v;
    document.querySelectorAll(".tabbar a").forEach(function (a) {
      var on = a.dataset.tab === v || (v === "stop" && a.dataset.tab === lastMain);
      if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    if (v === "stop") { renderDetail(); detailEl.scrollTop = 0; }
    renderPeek(); drawMap();
    setTimeout(function () { map.invalidateSize(); }, 50);
  }
  window.addEventListener("hashchange", route);
  desktop.addEventListener && desktop.addEventListener("change", route);

  function select(id) {
    view.sel = id;
    if (desktop.matches) { go("stop/" + id); return; }
    renderPeek(); drawMap();
    highlightRow(id);
  }
  function highlightRow(id) {
    listEl.querySelectorAll(".stop.sel").forEach(function (el) { el.classList.remove("sel"); });
    var el = listEl.querySelector('[data-id="' + id + '"]');
    if (el) el.classList.add("sel");
  }
  function showOnMap(id) {
    var s = byId[id];
    view.sel = id;
    go(desktop.matches ? "plan" : "map");
    setTimeout(function () { map.setView([s.lat, s.lng], 17); }, 80);
  }

  // ---------- lightbox ----------
  var lb = document.getElementById("lightbox"), lbImg = lb.querySelector("img"), lbCap = lb.querySelector(".lb-cap"), lbIdx = 0;
  function openPhoto(k) {
    var ph = info(view.detail).photos;
    if (!ph || !ph.length) return;
    lbIdx = (k + ph.length) % ph.length;
    lbImg.src = ph[lbIdx].src;
    lbImg.alt = (lbIdx === 0 && info(view.detail).alt) || byId[view.detail].full;
    lbCap.textContent = byId[view.detail].full + " · " + (lbIdx + 1) + " / " + ph.length + " · Historic Milwaukee";
    lb.hidden = false;
    lb.querySelector(".lb-close").focus();
  }
  function closePhoto() { lb.hidden = true; lbImg.removeAttribute("src"); }
  lb.addEventListener("click", function (e) {
    if (e.target.closest(".lb-prev")) openPhoto(lbIdx - 1);
    else if (e.target.closest(".lb-next")) openPhoto(lbIdx + 1);
    else if (e.target === lbImg) return;
    else closePhoto();
  });
  document.addEventListener("keydown", function (e) {
    if (!lb.hidden) {
      if (e.key === "Escape") closePhoto();
      if (e.key === "ArrowLeft") openPhoto(lbIdx - 1);
      if (e.key === "ArrowRight") openPhoto(lbIdx + 1);
    } else if (e.key === "Escape" && view.v === "stop") back();
  });

  // ---------- events ----------
  function back() {
    if (navigated) history.back();
    else location.hash = lastMain;
  }
  app.addEventListener("click", function (e) {
    var b = e.target.closest("button, a");
    if (!b || !app.contains(b)) return;
    var d = b.dataset;
    if (d.open) { go("stop/" + d.open); return; }
    if (d.add) { addStop(d.add); return; }
    if (d.visit) { toggleVisited(d.visit); return; }
    if (b.id === "clear-visited") { if (confirm("Clear all check-offs?")) { state.visited = {}; render(); } return; }
    if (d.showmap) { showOnMap(d.showmap); return; }
    if (d.photo != null) { openPhoto(+d.photo); return; }
    if (d.up != null) { swap(+d.up, +d.up - 1); return; }
    if (d.down != null) { swap(+d.down, +d.down + 1); return; }
    if (d.skip) { state.skip[d.skip] = !state.skip[d.skip]; render(); return; }
    if (d.remove) { removeStop(d.remove); return; }
    if (d.ncat) { view.nearCat = d.ncat; renderNearby(); return; }
    if (d.lcat) { view.listCat = d.lcat; renderList(); return; }
    if (b.id === "open-only") { view.openOnly = !view.openOnly; renderList(); return; }
    if (d.tab && b.getAttribute("role") === "tab") { view.tab = d.tab; renderDetail(); document.querySelector('.tabs [data-tab="' + d.tab + '"]').focus(); return; }
    if (b.id === "d-back") { back(); return; }
    if (b.id === "d-book") {
      var id = view.detail;
      if (isExtra[id]) { if (inPlan(id)) removeStop(id); else addStop(id); }
      else { state.skip[id] = !state.skip[id]; render(); }
      return;
    }
    if (b.id === "d-more") {
      var m = document.getElementById("d-menu"), open = m.hidden;
      m.hidden = !open; b.setAttribute("aria-expanded", String(open));
      return;
    }
    if (b.id === "toplan") { go("plan"); return; }
    if (b.id === "edit") { view.edit = !view.edit; renderPlan(); return; }
  });
  document.addEventListener("click", function (e) {
    var m = document.getElementById("d-menu");
    if (m && !m.hidden && !e.target.closest("#d-more") && !e.target.closest("#d-menu")) {
      m.hidden = true; document.getElementById("d-more").setAttribute("aria-expanded", "false");
    }
  });
  function toggleVisited(id) {
    if (state.visited[id]) delete state.visited[id]; else state.visited[id] = Date.now();
    // After checking off the card's stop, let it move on to the next one.
    if (state.visited[id] && view.sel === id && view.v !== "stop") view.sel = null;
    render();
  }
  function swap(a, b) {
    var o = state.order, t = o[a]; o[a] = o[b]; o[b] = t;
    render();
  }
  Sortable.create(listEl, {
    handle: ".grip", draggable: ".stop:not(.off)", animation: 150,
    onStart: function () { dragging = true; },
    onEnd: function () {
      dragging = false;
      var onRoute = Array.prototype.map.call(listEl.querySelectorAll(".stop:not(.off)"), function (el) { return el.dataset.id; });
      var rest = state.order.filter(function (id) { return onRoute.indexOf(id) < 0; });
      state.order = onRoute.concat(rest);
      render();
    }
  });
  document.getElementById("day").addEventListener("change", function (e) { state.day = e.target.value; render(); fitRoute(); });
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
  document.getElementById("suggest").addEventListener("click", function () { state.order = suggest(); render(); });
  document.getElementById("q").addEventListener("input", function (e) { view.q = e.target.value; renderList(); });
  window.addEventListener("resize", function () { map.invalidateSize(); });

  // Keep "open now" and the up-next card current during the event.
  setInterval(function () { if (!dragging && todayKey()) render(); }, 60000);

  if (!valid(state.order)) state.order = suggest();
  render();
  route();
  fitRoute();
})();
