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
  if (!Array.isArray(state.log)) state.log = [];
  if (state.others == null) state.others = true;
  if (state.hop == null) state.hop = true;
  if (!state.custom) state.custom = {};
  // Breaks you add yourself (lunch, a friend's place): always "open", with their own length.
  function registerCustom(c) {
    c.custom = true; c.full = c.name; c.sat = c.sun = [0, 24]; c.note = c.note || "";
    byId[c.id] = c;
  }
  Object.keys(state.custom).forEach(function (id) { registerCustom(state.custom[id]); });
  function isCustom(id) { return !!(byId[id] && byId[id].custom); }
  // Where to actually walk to: the entrance if we know it, else the address point.
  function pt(s) { return s.door || [s.lat, s.lng]; }

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
    var i = tIdx[a], j = tIdx[b], A = pt(byId[a]), B = pt(byId[b]);
    // Breaks aren't in the table: estimate from the straight line until the real path arrives.
    if (i == null || j == null) { var est = metersBetween(A, B) * 1.3; return { m: est, s: est / WALK_MPS, pts: [A, B], rough: true, est: true }; }
    return { m: TABLE.m[i][j], s: TABLE.s[i][j], pts: [A, B], rough: true };
  }
  function fetchLeg(a, b) {
    var k = a + "|" + b;
    if (legCache[k] || fetching[k]) return;
    fetching[k] = true;
    var A = pt(byId[a]), B = pt(byId[b]), base = leg(a, b);
    fetch("https://routing.openstreetmap.de/routed-foot/route/v1/foot/" + A[1] + "," + A[0] + ";" + B[1] + "," + B[0] + "?overview=full&geometries=polyline")
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.routes || !d.routes[0]) return;
        var m = base.est ? d.routes[0].distance : base.m;
        legCache[k] = { m: m, s: base.est ? m / WALK_MPS : base.s, pts: decode(d.routes[0].geometry) };
        // A break's real walk changes the timings, not just the line on the map.
        if (base.est) render(); else drawMap();
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
      var s = byId[id], h = s[day], l = null, stay = s.dwell || dwell;
      if (prev) { l = leg(prev, id); t += l.s / 60; walkS += l.s; walkM += l.m; }
      var arrive = t, wait = 0;
      if (arrive < h[0] * 60) { wait = h[0] * 60 - arrive; t = h[0] * 60; }
      var lateBy = t + stay - h[1] * 60;
      if (lateBy > 0) late += lateBy;
      rows.push({ id: id, prev: prev, leg: l, arrive: arrive, wait: wait, lateBy: lateBy, leave: t + stay });
      t += stay; prev = id;
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
    // Breaks stay where you put them (after the same number of stops); only the sites get reshuffled.
    var breaks = [];
    all.filter(function (id) { return isActive(id, day); }).forEach(function (id, k) { if (isCustom(id)) breaks.push({ id: id, k: k }); });
    var act = all.filter(function (id) { return isActive(id, day) && !isCustom(id); });
    var rest = all.filter(function (id) { return !isActive(id, day); });
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
    breaks.forEach(function (b) { best.splice(Math.min(b.k, best.length), 0, b.id); });
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
    if (i >= 0 && (isExtra[id] || isCustom(id))) state.order.splice(i, 1);
    // Keep a removed break's details only if your history still points at it.
    if (isCustom(id) && !state.log.some(function (v) { return v.id === id; })) { delete state.custom[id]; delete byId[id]; delete state.visited[id]; }
    render();
  }
  // Put a break in: "next" means before the first stop you haven't been to yet.
  function addBreak(c, where) {
    c.id = "brk-" + Date.now().toString(36);
    state.custom[c.id] = c; registerCustom(c);
    var act = state.order.filter(function (x) { return isActive(x, state.day); }), pos;
    if (where === "next") {
      var nx = act.filter(function (x) { return !state.visited[x]; })[0];
      pos = nx ? state.order.indexOf(nx) : state.order.length;
    } else if (where === "best") {
      var n = detour(c, act);
      pos = n.after ? state.order.indexOf(n.after) + 1 : n.before ? state.order.indexOf(n.before) : state.order.length;
    } else pos = state.order.indexOf(where) + 1;
    state.order.splice(pos, 0, c.id);
    render();
    toast(c.name + " added · " + c.dwell + " min");
  }

  // ---------- today / live status ----------
  function todayKey() {
    var d = new Date();
    if (d.getFullYear() !== 2026 || d.getMonth() !== 8) return null;
    return d.getDate() === 26 ? "sat" : d.getDate() === 27 ? "sun" : null;
  }
  function nowMin() { var d = new Date(); return d.getHours() * 60 + d.getMinutes(); }
  function status(s, day) {
    if (s.custom) return { cls: "open", text: "Break · " + s.dwell + " min" };
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
  // Map apps get the entrance's coordinates where we have one; a street address can land on the wrong side of a big block.
  function q(s) { return encodeURIComponent(s.door || s.custom ? pt(s).join(",") : place(s)); }
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
    return "https://maps.apple.com/?q=" + encodeURIComponent(s.full) + "&ll=" + pt(s).join(",") + "&address=" + encodeURIComponent(place(s));
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
    if (isCustom(id)) return '<span class="ph brk ' + (cls || "") + '">' + icon(byId[id].kind === "home" ? "home" : "cup") + "</span>";
    return '<span class="ph ' + (cls || "") + '">' + (i ? '<img src="' + esc(i.thumb) + '" alt="" loading="lazy" decoding="async">' : "") + "</span>";
  }
  function enterHtml(s, cls) {
    return s.enter ? '<span class="' + (cls || "ln") + ' door">' + icon("door", "xs") + esc(s.enter) + "</span>" : "";
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
    map.fitBounds(L.latLngBounds(ids.map(function (id) { return pt(byId[id]); })), {
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
        var m = L.marker(pt(s), {
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
      var html = '<div class="pin' + (r ? "" : " off") + (sel ? " sel" : "") + (done ? " done" : "") + (s.custom ? " brk" : "") + '"><span class="pimg">' +
        (i ? '<img src="' + esc(i.thumb) + '" alt="">' : s.custom ? icon(s.kind === "home" ? "home" : "cup") : "") + "</span>" + (r || done ? '<span class="pn">' + (done ? "✓" : r.n) + "</span>" : "") + "</div>";
      var size = r ? 50 : 36;
      // The pin's tip sits on the entrance, so the walking line ends at the door.
      var m = L.marker(pt(s), {
        icon: L.divIcon({ className: "", html: html, iconSize: [size, size + 8], iconAnchor: [size / 2, size + 8] }),
        zIndexOffset: sel ? 2000 : r ? 1000 - r.n : 0, title: s.full + (s.enter ? " · " + s.enter : "") + (done ? " (visited)" : ""), alt: s.full
      });
      m.on("click", function () { select(id); });
      m.addTo(markerLayer); markers[id] = m;
    });
  }

  // Live location. One watch serves the blue dot, "min away" and auto check-in.
  var me = null, fix = null, watchId = null, meMarker = null, meCircle = null, firstFix = false, locMsg = "";
  var locBtn = document.getElementById("locate");
  locBtn.addEventListener("click", function () {
    if (me) { map.setView(me, Math.max(map.getZoom(), 16)); return; }
    firstFix = true;
    startLocation();
  });
  function startLocation() {
    if (watchId != null) return;
    if (!navigator.geolocation) { locMsg = "Location isn't available in this browser."; renderHistory(); return; }
    locBtn.classList.add("busy");
    locMsg = "Finding you…";
    watchId = navigator.geolocation.watchPosition(onFix, function (e) {
      locBtn.classList.remove("busy");
      // Only a denied permission ends the watch; a timeout or lost signal keeps it
      // running so tracking resumes by itself when the phone gets a fix again.
      if (e.code === 1) {
        navigator.geolocation.clearWatch(watchId); watchId = null;
        locBtn.setAttribute("aria-pressed", "false");
        locBtn.title = "Location unavailable";
        locMsg = "Location permission is off. Allow location for this site in your browser settings, then turn auto check-in on again.";
      } else if (!fix) locMsg = "Still looking for a GPS signal…";
      renderHistory();
    }, { enableHighAccuracy: true, maximumAge: 10000 });
  }
  function stopLocation() {
    if (watchId != null) navigator.geolocation.clearWatch(watchId);
    watchId = null; me = null; fix = null; meLayer.clearLayers(); meMarker = meCircle = null;
    locBtn.setAttribute("aria-pressed", "false");
    renderPeek();
  }
  function onFix(p) {
    me = [p.coords.latitude, p.coords.longitude];
    fix = { ll: me, acc: p.coords.accuracy, t: Date.now() };
    locMsg = "";
    locBtn.classList.remove("busy"); locBtn.setAttribute("aria-pressed", "true");
    if (!meMarker) {
      meCircle = L.circle(me, { radius: p.coords.accuracy, color: "#2f7ff5", weight: 1, fillOpacity: 0.1, interactive: false }).addTo(meLayer);
      meMarker = L.marker(me, { icon: L.divIcon({ className: "", html: '<div class="me"></div>', iconSize: [22, 22], iconAnchor: [11, 11] }), zIndexOffset: 3000, title: "You are here", keyboard: false }).addTo(meLayer);
    } else { meMarker.setLatLng(me); meCircle.setLatLng(me).setRadius(p.coords.accuracy); }
    if (firstFix) { firstFix = false; map.setView(me, Math.max(map.getZoom(), 16)); }
    if (wantHere) { wantHere = false; setPick({ q: "here", label: "Where you are now", addr: "±" + Math.round(fix.acc) + " m", lat: me[0], lng: me[1] }); }
    checkPresence();
    renderPeek();
    if (view.v === "history") renderHistory();
  }

  // ---------- auto check-in ----------
  // Arrive: within ~55-90 m of a site (more slack for a fuzzier fix) for 90 s, so
  // walking past doesn't count. Leave: over 110 m away (or clearly at another site)
  // for 60 s. Fixes worse than 100 m (common indoors) are ignored, so a weak signal
  // inside a building never checks you out.
  var ENTER = 55, EXIT = 110, DWELL = 90e3, LEAVE = 60e3;
  var cand = null, leaving = null;
  function openVisit() {
    for (var i = state.log.length - 1; i >= 0; i--) if (!state.log[i].leave) return state.log[i];
    return null;
  }
  // Big buildings: you might be inside near the middle or standing at the door.
  function siteDist(ll, s) { return Math.min(metersBetween(ll, [s.lat, s.lng]), s.door ? metersBetween(ll, s.door) : Infinity); }
  function nearestSite(ll) {
    var best = null;
    ALL.forEach(function (s) {
      var d = siteDist(ll, s);
      if (!best || d < best.d) best = { id: s.id, d: d };
    });
    return best;
  }
  function checkPresence() {
    if (!state.track || !fix || Date.now() - fix.t > 5 * 60e3 || fix.acc > 100) return;
    var now = Date.now(), open = openVisit();
    var near = nearestSite(fix.ll), nearOk = near && fix.acc <= 80 && near.d <= ENTER + Math.min(fix.acc, 35);
    if (open) {
      var o = byId[open.id], dOpen = siteDist(fix.ll, o);
      var elsewhere = nearOk && near.id !== open.id && near.d < dOpen - 25;
      if (dOpen > EXIT || elsewhere) {
        if (!leaving || leaving.id !== open.id) leaving = { id: open.id, since: now };
        else if (now - leaving.since >= LEAVE) { endVisit(open, leaving.since, "auto"); open = null; leaving = null; }
      } else { leaving = null; cand = null; return; }
    }
    if (!nearOk || (open && near.id === open.id)) { cand = null; return; }
    if (!cand || cand.id !== near.id) { cand = { id: near.id, since: now }; return; }
    if (now - cand.since >= DWELL) {
      if (open) endVisit(open, leaving ? leaving.since : cand.since, "auto");
      leaving = null;
      startVisit(near.id, cand.since, "auto");
      cand = null;
      render();
    }
  }
  function startVisit(id, t, how) {
    state.log.push({ id: id, arrive: t, leave: null, how: how });
    if (!state.visited[id]) state.visited[id] = t;
    toast((how === "auto" ? "Checked in at " : "Arrived at ") + byId[id].name + " · " + clock(t));
    save();
  }
  function endVisit(v, t, how) {
    v.leave = Math.max(t, v.arrive);
    v.leaveHow = how;
    toast("Left " + byId[v.id].name + " after " + fmtSpan(v.leave - v.arrive));
    save();
    if (view.v === "history") renderHistory();
  }
  function clock(t) { var d = new Date(t); return fmtTime(d.getHours() * 60 + d.getMinutes()); }
  function fmtSpan(ms) { return fmtDur(Math.max(60, Math.round(ms / 1000))); }
  var toastEl = document.getElementById("toast"), toastTimer = null;
  function toast(msg, ms) {
    toastEl.textContent = msg; toastEl.classList.add("show");
    toastEl.classList.toggle("long", msg.length > 60);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove("show"); }, ms || 4000);
  }

  // Screen wake lock, so the page (and location) keeps running while you walk.
  var wakeLock = null;
  function syncWake() {
    if (!("wakeLock" in navigator)) return;
    if (state.wake && document.visibilityState === "visible" && !wakeLock) {
      navigator.wakeLock.request("screen").then(function (l) {
        wakeLock = l; l.addEventListener("release", function () { wakeLock = null; });
      }).catch(function () {});
    } else if (!state.wake && wakeLock) { wakeLock.release(); wakeLock = null; }
  }
  document.addEventListener("visibilitychange", function () {
    syncWake();
    if (document.visibilityState === "visible") { checkPresence(); render(); }
  });

  function minAway(s) {
    if (!me) return null;
    return Math.max(1, Math.round(metersBetween(me, pt(s)) * 1.25 / WALK_MPS / 60));
  }

  // ---------- the Hop ----------
  // Would the streetcar beat walking to a stop? It's only worth saying so if it saves a few minutes.
  var HOP_WORTH = 180, HOP_ASK = 600;
  function hopFor(id, live) {
    var r = view.rowBy && view.rowBy[id], s = byId[id];
    if (!window.Hop || !r) return null;
    var from = r.leg ? pt(byId[r.prev]) : null, walk = r.leg ? r.leg.s : 0;
    // Heading there now: start from where you actually are, if the phone knows.
    if (live && me && fix && Date.now() - fix.t < 120e3 && fix.acc < 150) { from = me; walk = metersBetween(me, pt(s)) * 1.25 / WALK_MPS; }
    if (!from) return null;
    var t = Hop.trip(from, pt(s), live ? 0 : 3600);
    if (!t) return null;
    t.walk = walk; t.saves = walk - t.total;
    return t;
  }
  // Live cars only matter for the walk you're about to make today; later legs use the schedule.
  function liveLeg(id) { return todayKey() === state.day && id === nextId() && !state.visited[id]; }
  function hopBrief(t) {
    return (t.live ? "car at " + t.on.name + " in " + fmtWalk(t.carIn) : "board at " + t.on.name) + ", ~" + fmtWalk(t.total) + " total";
  }
  function hopSteps(t) {
    return "Walk " + fmtWalk(t.walk1) + " to " + t.on.name + ", " +
      (t.live ? "next car there in " + fmtWalk(t.carIn) : "cars every ~" + fmtWalk(Hop.headway(t.route))) +
      ", ride " + fmtWalk(t.ride) + " to " + t.off.name + ", then walk " + fmtWalk(t.walk2) +
      ". About " + fmtWalk(t.total) + " vs " + fmtWalk(t.walk) + " walking. Free to ride.";
  }
  function hopState() {
    if (!window.Hop) return "";
    var st = Hop.status();
    if (st.live) return Hop.cars().length ? "Live car positions, updated " + Math.max(1, Math.round((Date.now() - st.at) / 1000)) + " s ago." : "Live feed is up, but no streetcars are reporting right now.";
    return "Live feed unavailable, so this uses the Hop's schedule.";
  }

  map.createPane("hop").style.zIndex = 390;
  var hopLayer = L.layerGroup().addTo(map), hopBtn = document.getElementById("hop");
  function drawHop() {
    hopLayer.clearLayers();
    hopBtn.setAttribute("aria-pressed", String(state.hop));
    var st = window.Hop ? Hop.status() : null;
    hopBtn.classList.toggle("live", !!(st && st.live && Hop.cars().length));
    hopBtn.title = st ? hopState() : "";
    if (!state.hop || !window.Hop) return;
    Hop.routes().forEach(function (rt) {
      rt.stops.forEach(function (s) {
        L.polyline(s.pts, { pane: "hop", color: rt.color, weight: 3, opacity: 0.55, interactive: false }).addTo(hopLayer);
      });
      rt.stops.forEach(function (s) {
        var m = L.circleMarker(s.ll, { pane: "hop", radius: 4, color: rt.color, weight: 2, fillColor: "#fff", fillOpacity: 1 });
        m.bindPopup(function () {
          var arr = Hop.arrivals(rt, s).slice(0, 2).map(function (a) { return a.eta < 60 ? "now" : fmtWalk(a.eta); });
          return "<b>" + esc(s.name) + "</b><br>The Hop · " + esc(rt.name) + "<br>" +
            (arr.length && Hop.status().live ? "Next car: " + arr.join(", then ") : "Cars about every " + fmtWalk(Hop.headway(rt)) + " (schedule)");
        });
        m.addTo(hopLayer);
      });
    });
    Hop.cars().forEach(function (c) {
      var rt = Hop.routes().filter(function (r) { return r.id === c.route; })[0], color = rt ? rt.color : "#6d27b8";
      L.marker(c.ll, {
        icon: L.divIcon({ className: "", html: '<div class="car" style="--c:' + color + '"><i style="transform:rotate(' + c.heading + 'deg)"></i>' + icon("tram", "xs") + "</div>", iconSize: [26, 26], iconAnchor: [13, 13] }),
        zIndexOffset: -200, keyboard: false, title: c.name + " · position " + Math.round(c.age + (Date.now() - Hop.status().at) / 1000) + " s old"
      }).addTo(hopLayer);
    });
  }
  hopBtn.addEventListener("click", function () {
    state.hop = !state.hop; save(); drawHop();
    toast(state.hop ? "Showing the Hop streetcar · " + hopState() : "Hop streetcar hidden");
  });
  function onHop() {
    drawHop();
    if (dragging) return;
    renderPeek();
    renderPlan();
    if (view.v === "stop" && view.tab === "info") renderDetail();
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
      var lines = [], hop = r && r.leg ? hopFor(id, liveLeg(id)) : null;
      if (r && r.leg) lines.push('<p class="ln">' + icon("walk", "xs") + fmtWalk(r.leg.s) + " walk · " + fmtMi(r.leg.m) +
        (hop && hop.saves >= HOP_WORTH ? ' <span class="hopchip" role="button" tabindex="0" data-hop="' + id + '" title="' + esc(hopSteps(hop)) + '">' + icon("tram", "xs") + "Hop ~" + fmtWalk(hop.total) + "</span>" : "") + "</p>");
      else if (r) lines.push('<p class="ln">' + icon("pin", "xs") + "First stop" + "</p>");
      else lines.push('<p class="ln">' + icon("pin", "xs") + esc(s.addr) + "</p>");
      if (s.custom && r) lines.push('<p class="ln">' + icon("pin", "xs") + esc(s.addr) + "</p>");
      lines.push('<p class="ln">' + statusHtml(s, day) + (r ? '<span class="arr">Arrive ' + fmtTime(r.arrive) + "</span>" : "") + "</p>");
      if (s.enter && r) lines.push('<p class="ln door">' + icon("door", "xs") + esc(s.enter) + "</p>");
      if (state.visited[id]) lines.push('<p class="flag ok">' + icon("check", "xs") + "Visited</p>");
      if (h && state.skip[id]) lines.push('<p class="flag">Skipped</p>');
      if (r && r.wait > 0) lines.push('<p class="flag warn">Opens ' + fmtHour(h[0]) + ", about " + Math.round(r.wait) + " min wait</p>");
      if (r && r.lateBy > 0) lines.push('<p class="flag bad">' + (r.lateBy >= dwell ? "Closed by the time you arrive" : "Only " + Math.max(0, Math.round(dwell - r.lateBy)) + " min before close") + "</p>");
      var edit = '<div class="editrow">' +
        '<button type="button" data-up="' + idx + '"' + (idx === 0 ? " disabled" : "") + ' aria-label="Move ' + esc(s.name) + ' earlier">' + icon("up", "sm") + "</button>" +
        '<button type="button" data-down="' + idx + '"' + (idx === state.order.length - 1 ? " disabled" : "") + ' aria-label="Move ' + esc(s.name) + ' later">' + icon("down", "sm") + "</button>" +
        (isExtra[id] || s.custom ? '<button type="button" data-remove="' + id + '">Remove</button>' :
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
  // Bottom card: a swipeable row of the route's stops (plus a tapped nearby site),
  // opened on the selected stop or the next one not yet visited.
  var peekIds = [], peekIdx = 0, peekBusy = false, peekTimer = null;
  function peekSlide(id) {
    var s = byId[id], r = view.rowBy[id], away = minAway(s), done = !!state.visited[id];
    var kick = eyebrow(id);
    if (r && !done && id === nextId()) kick = "Up next · " + kick;
    if (done) kick = "Visited · " + kick;
    var here = openVisit();
    if (here && here.id === id) kick = "Here now · " + fmtSpan(Date.now() - here.arrive);
    var sub = away != null ? "~" + away + " min away" : r ? "Arrive " + fmtTime(r.arrive) : "";
    // Up next: would the Hop get you there faster than walking, right now?
    var hopLn = "";
    if (r && !done && id === nextId()) {
      var hop = hopFor(id, liveLeg(id));
      if (hop && hop.saves >= HOP_WORTH) hopLn = '<span class="ln hopln good" data-hop="' + id + '">' + icon("tram", "xs") + "Hop saves " + fmtWalk(hop.saves) + " · " + esc(hopBrief(hop)) + "</span>";
      else if (hop && hop.walk >= HOP_ASK) hopLn = '<span class="ln hopln" data-hop="' + id + '">' + icon("tram", "xs") + "Walking is quicker than the Hop" + (hop.live ? " (next car " + fmtWalk(hop.carIn) + ")" : "") + "</span>";
    }
    return '<div class="pslide" data-id="' + id + '"><button type="button" class="card" data-open="' + id + '">' + thumb(id, "pth") +
      '<span class="txt"><span class="kick">' + esc(kick) + '</span><span class="nm">' + esc(s.name) + "</span>" +
      '<span class="ln">' + statusHtml(s, state.day) + "</span>" + (sub ? '<span class="ln psub">' + esc(sub) + "</span>" : "") +
      enterHtml(s, "ln psub") + hopLn + "</span></button>" +
      (s[state.day] || done ? '<button type="button" class="chev check" data-visit="' + id + '" aria-pressed="' + done + '" aria-label="' + (done ? "Uncheck " : "Check off ") + esc(s.name) + '">' + icon("check") + "</button>" : "") + "</div>";
  }
  function renderPeek() {
    if (peekBusy) return;
    var here = openVisit();
    var cur = view.sel && byId[view.sel] ? view.sel : here ? here.id : nextId();
    var ids = view.sch.rows.map(function (r) { return r.id; });
    if (cur && ids.indexOf(cur) < 0) ids.unshift(cur);
    if (!ids.length) { peekEl.innerHTML = ""; peekIds = []; return; }
    peekIds = ids; peekIdx = Math.max(0, ids.indexOf(cur));
    peekEl.innerHTML = '<div class="ptrack" role="group" aria-roledescription="carousel" aria-label="Stops, swipe for more">' +
      ids.map(peekSlide).join("") + "</div>" +
      (ids.length > 1 ? '<div class="pdots" aria-hidden="true">' + ids.map(function (id, k) { return "<i" + (k === peekIdx ? ' class="on"' : "") + "></i>"; }).join("") + "</div>" : "");
    var track = peekEl.querySelector(".ptrack");
    track.scrollLeft = peekIdx * slideStep(track);
    track.addEventListener("scroll", onPeekScroll, { passive: true });
    track.addEventListener("touchstart", function () { peekBusy = true; }, { passive: true });
    track.addEventListener("touchend", function () { setTimeout(function () { peekBusy = false; }, 400); }, { passive: true });
  }
  function slideStep(track) {
    var a = track.children[0], b = track.children[1];
    return (b ? b.offsetLeft - a.offsetLeft : 0) || track.clientWidth || 1;
  }
  function onPeekScroll(e) {
    var track = e.currentTarget;
    clearTimeout(peekTimer);
    peekTimer = setTimeout(function () {
      var k = Math.max(0, Math.min(peekIds.length - 1, Math.round(track.scrollLeft / slideStep(track))));
      peekEl.querySelectorAll(".pdots i").forEach(function (d, j) { d.classList.toggle("on", j === k); });
      if (k === peekIdx) return;
      peekIdx = k;
      var id = peekIds[k], st = byId[id];
      view.sel = id;
      drawMap(); highlightRow(id);
      // Keep the stop visible above the card.
      map.panInside(pt(st), { paddingTopLeft: [40, 190], paddingBottomRight: [40, peekEl.offsetHeight + 90] });
    }, 90);
  }

  function renderHistory() {
    var card = document.getElementById("trackcard"), list = document.getElementById("hlist");
    var log = state.log, now = Date.now(), open = openVisit();
    var inside = 0, walk = 0;
    log.forEach(function (v, k) {
      inside += (v.leave || now) - v.arrive;
      var nx = log[k + 1];
      if (v.leave && nx && nx.arrive > v.leave) walk += nx.arrive - v.leave;
    });
    document.getElementById("hist-sub").textContent = log.length ?
      log.length + " visit" + (log.length === 1 ? "" : "s") + " · " + fmtSpan(inside) + " inside" + (walk ? " · " + fmtSpan(walk) + " between" : "") : "Your visits will show up here.";
    document.getElementById("hist-copy").hidden = !log.length;

    var status;
    if (!state.track) status = "Off. Turn on to check in automatically when you arrive somewhere.";
    else if (locMsg) status = locMsg;
    else if (!fix) status = "Waiting for your location…";
    else {
      status = "On · GPS ±" + Math.round(fix.acc) + " m";
      if (fix.acc > 100) status += " · signal too weak to check in or out";
      else if (open) status += " · at " + byId[open.id].name + (leaving ? " (looks like you're leaving)" : "");
      else if (cand) status += " · near " + byId[cand.id].name + ", checking in after " + Math.max(1, Math.ceil((DWELL - (now - cand.since)) / 60e3)) + " more min";
      else { var n = nearestSite(fix.ll); status += " · nearest site " + byId[n.id].name + " (" + Math.round(n.d) + " m)"; }
    }
    card.innerHTML =
      '<div class="trow"><span><b>Auto check-in</b><span class="tstat">' + esc(status) + "</span></span>" +
      '<button type="button" class="switch" id="auto-toggle" role="switch" aria-checked="' + !!state.track + '" aria-label="Auto check-in"><i></i></button></div>' +
      ("wakeLock" in navigator ? '<div class="trow"><span><b>Keep screen on</b><span class="tstat">Stops the phone from locking and pausing location.</span></span>' +
        '<button type="button" class="switch" id="wake-toggle" role="switch" aria-checked="' + !!state.wake + '" aria-label="Keep screen on"><i></i></button></div>' : "") +
      '<p class="tnote">Works while this page is open. Phones pause location for web pages in the background or when the screen locks.</p>';

    if (!log.length) { list.innerHTML = '<p class="empty">No visits yet. Turn on auto check-in, or tap ✓ on a stop when you get there.</p>'; return; }
    var html = "", lastDay = "";
    log.forEach(function (v, k) {
      var d = new Date(v.arrive), day = d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
      if (day !== lastDay) { html += '<h3 class="hday">' + esc(day) + "</h3>"; lastDay = day; }
      var prev = log[k - 1];
      if (prev && prev.leave && v.arrive > prev.leave && new Date(prev.leave).toDateString() === d.toDateString())
        html += '<p class="hgap">' + icon("walk", "xs") + fmtSpan(v.arrive - prev.leave) + " between stops</p>";
      var s = byId[v.id], isOpen = !v.leave, dur = (v.leave || now) - v.arrive;
      var times = clock(v.arrive) + " → " + (isOpen ? "now" : clock(v.leave));
      var edit = view.editVisit === k;
      html += '<div class="hitem' + (isOpen ? " open" : "") + '">' +
        '<button type="button" class="card" data-open="' + v.id + '">' + thumb(v.id, "th sm") +
        '<span class="txt"><span class="nm">' + esc(s.name) + "</span>" +
        '<span class="ln htimes">' + times + "</span>" +
        '<span class="ln">' + (isOpen ? '<span class="here">Here now</span>' : "") + (v.how === "auto" ? "Auto check-in" : "Checked in by hand") +
        (v.leaveHow === "auto" ? " · left automatically" : "") + "</span></span></button>" +
        '<span class="hdur">' + fmtSpan(dur) + "</span>" +
        '<div class="hacts">' + (isOpen ? '<button type="button" data-leave="' + k + '">I left</button>' : "") +
        '<button type="button" data-editv="' + k + '">' + (edit ? "Done" : "Edit times") + "</button></div>" +
        (edit ? '<div class="hedit"><label>Arrived<input type="time" data-f="arrive" data-i="' + k + '" value="' + hhmm(v.arrive) + '"></label>' +
          '<label>Left<input type="time" data-f="leave" data-i="' + k + '" value="' + (v.leave ? hhmm(v.leave) : "") + '"></label>' +
          '<button type="button" class="del" data-delv="' + k + '">Delete visit</button></div>' : "") + "</div>";
    });
    list.innerHTML = html;
  }
  function hhmm(t) { var d = new Date(t); return (d.getHours() < 10 ? "0" : "") + d.getHours() + ":" + (d.getMinutes() < 10 ? "0" : "") + d.getMinutes(); }
  function logText() {
    var lastDay = "";
    return "Doors Open MKE visits\n" + state.log.map(function (v) {
      var day = new Date(v.arrive).toLocaleDateString(undefined, { weekday: "short", month: "numeric", day: "numeric" });
      var head = day !== lastDay ? "\n" + day + "\n" : "";
      lastDay = day;
      return head + clock(v.arrive) + " – " + (v.leave ? clock(v.leave) : "now") + " (" + fmtSpan((v.leave || Date.now()) - v.arrive) + ")  " + byId[v.id].full;
    }).join("\n");
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
      var hop = hopFor(id, liveLeg(id));
      if (hop && hop.saves < HOP_WORTH && hop.walk < HOP_ASK) hop = null;
      body = '<dl class="facts">' +
        fact("Address", esc(s.addr) + (s.note ? "<br><span class=\"muted\">" + esc(s.note) + "</span>" : "")) +
        (s.enter || s.door ? fact("Entrance", (s.enter ? esc(s.enter) : "Pin is on the entrance.") + ' <span class="muted">Map pin and directions go to this door.</span>') : "") +
        fact("Saturday", s.sat ? fmtHours(s.sat) : "Not open") +
        fact("Sunday", s.sun ? fmtHours(s.sun) : "Not open") +
        (legLine ? fact("Your plan", legLine) : "") +
        (hop ? fact("The Hop", (hop.saves >= HOP_WORTH ? "Saves about " + fmtWalk(hop.saves) + ". " : "Walking is quicker. ") + esc(hopSteps(hop)) +
          ' <span class="muted">' + esc(hopState()) + "</span>") : "") +
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
      '<p class="hl">' + icon("pin", "sm") + esc(s.addr) + "</p>" + (s.enter ? '<p class="hl door">' + icon("door", "sm") + esc(s.enter) + "</p>" : "") + "<p class=\"hl\">" + statusHtml(s, day) +
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
    if (h.indexOf("stop/") === 0 && byId[h.slice(5)] && !isCustom(h.slice(5))) {
      v = "stop";
      if (view.detail !== h.slice(5)) { view.detail = h.slice(5); view.tab = "overview"; }
      view.sel = view.detail;
    } else if (h === "plan" || h === "list" || h === "map" || h === "history") v = h;
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
    if (v === "history") renderHistory();
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
    setTimeout(function () { map.setView(pt(s), 17); }, 80);
  }

  // ---------- breaks (lunch, a friend's place) ----------
  var HELEN = { name: "Helen's", addr: "740 N Plankinton Ave", lat: 43.03969, lng: -87.91152, door: [43.03978, -87.91162], kind: "home" };
  var brk = document.getElementById("brk"), brkPick = null, wantHere = false, searching = false;
  var brkWhere = document.getElementById("brk-where"), brkRes = document.getElementById("brk-results");
  var brkName = document.getElementById("brk-name"), brkMin = document.getElementById("brk-min"), brkAfter = document.getElementById("brk-after");
  function openBreak() {
    var act = view.act.filter(function (id) { return byId[id]; });
    var nx = act.filter(function (id) { return !state.visited[id]; })[0];
    var anyVisited = act.some(function (id) { return state.visited[id]; });
    brkAfter.innerHTML = (nx ? '<option value="next">Next, before ' + esc(byId[nx].name) + "</option>" : "") +
      '<option value="best">Where it adds the least walking</option>' +
      act.map(function (id, k) { return '<option value="' + id + '">After ' + (k + 1) + " · " + esc(byId[id].name) + "</option>"; }).join("");
    brkAfter.value = nx && anyVisited ? "next" : "best";
    setPick(brkPick);
    if (brk.showModal) brk.showModal(); else brk.setAttribute("open", "");
  }
  function closeBreak() { if (brk.close) brk.close(); else brk.removeAttribute("open"); }
  function setPick(p) {
    brkPick = p;
    brkWhere.innerHTML = p ? icon("pin", "xs") + "<b>" + esc(p.label || p.name || "Picked spot") + "</b> · " + esc(p.addr || "") : "Pick a place above, search, or tap the map.";
    document.getElementById("brk-add").disabled = !p;
    brk.querySelectorAll("[data-bq]").forEach(function (b) { b.setAttribute("aria-pressed", String(!!p && p.q === b.dataset.bq)); });
  }
  function shortAddr(a) {
    if (!a) return "";
    return [a.house_number, a.road].filter(Boolean).join(" ") || a.neighbourhood || a.suburb || "";
  }
  brk.addEventListener("click", function (e) {
    var b = e.target.closest("button, li[data-i]");
    if (!b) { if (e.target === brk) closeBreak(); return; }
    if (b.dataset.bq === "helen") {
      setPick({ q: "helen", name: HELEN.name, addr: HELEN.addr, lat: HELEN.lat, lng: HELEN.lng, door: HELEN.door, kind: "home" });
      if (!brkName.value || brkName.value === "Lunch") brkName.value = HELEN.name;
    } else if (b.dataset.bq === "here") {
      if (me && fix && Date.now() - fix.t < 120e3) setPick({ q: "here", label: "Where you are now", addr: "±" + Math.round(fix.acc) + " m", lat: me[0], lng: me[1] });
      else { wantHere = true; brkWhere.textContent = "Finding you…"; startLocation(); }
    } else if (b.dataset.bq === "map") {
      closeBreak();
      if (!desktop.matches) go("map");
      toast("Tap the map where the break is", 6000);
      app.classList.add("picking");
      map.once("click", function (ev) {
        app.classList.remove("picking");
        var p = { q: "map", label: "Dropped pin", addr: "", lat: ev.latlng.lat, lng: ev.latlng.lng };
        setPick(p); openBreak();
        fetch("https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&addressdetails=1&lat=" + p.lat + "&lon=" + p.lng)
          .then(function (r) { return r.json(); })
          .then(function (d) { if (brkPick === p) { p.label = d.name || "Dropped pin"; p.addr = shortAddr(d.address); setPick(p); } })
          .catch(function () {});
      });
    } else if (b.id === "brk-go") {
      searchPlaces();
    } else if (b.dataset.i != null) {
      var r = brkRes._list[+b.dataset.i];
      setPick({ q: "search", name: r.name, addr: r.addr, lat: r.lat, lng: r.lng });
      if (!brkName.value || brkName.value === "Lunch" || brkName.value === HELEN.name) brkName.value = r.name.slice(0, 40);
    } else if (b.id === "brk-add") {
      if (!brkPick) return;
      var mins = Math.max(5, Math.min(240, Math.round(+brkMin.value) || 45));
      var c = { name: (brkName.value || "Break").trim().slice(0, 40), addr: brkPick.addr || "Dropped pin", lat: brkPick.lat, lng: brkPick.lng, dwell: mins, kind: brkPick.kind || "meal" };
      if (brkPick.door) c.door = brkPick.door;
      closeBreak();
      addBreak(c, brkAfter.value);
      brkPick = null; brkRes.innerHTML = ""; brkName.value = "Lunch";
    } else if (b.id === "brk-cancel") closeBreak();
  });
  document.getElementById("brk-q").addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); searchPlaces(); } });
  // Place search: OpenStreetMap's Nominatim, limited to downtown. One request per search, never per keystroke.
  function searchPlaces() {
    var qv = document.getElementById("brk-q").value.trim();
    if (!qv || searching) return;
    searching = true;
    brkRes.innerHTML = '<li class="muted">Searching…</li>';
    fetch("https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=6&bounded=1&viewbox=-87.96,43.06,-87.88,43.02&q=" + encodeURIComponent(qv))
      .then(function (r) { return r.json(); })
      .then(function (list) {
        brkRes._list = list.map(function (x) { return { name: x.name || x.display_name.split(",")[0], addr: shortAddr(x.address), lat: +x.lat, lng: +x.lon }; });
        brkRes.innerHTML = brkRes._list.length ? brkRes._list.map(function (x, i) {
          return '<li data-i="' + i + '" tabindex="0" role="button"><b>' + esc(x.name) + "</b><span>" + esc(x.addr) + "</span></li>";
        }).join("") : '<li class="muted">Nothing downtown matches. Try an address, or tap the map.</li>';
      })
      .catch(function () { brkRes.innerHTML = '<li class="muted">Search isn\'t reachable right now. Tap the map instead.</li>'; })
      .finally(function () { searching = false; });
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
  function showHop(id) {
    var t = hopFor(id, liveLeg(id));
    if (t) toast("The Hop to " + byId[id].name + ": " + hopSteps(t), 9000);
  }
  app.addEventListener("keydown", function (e) {
    var h = e.target.closest && e.target.closest(".hopchip");
    if (h && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); showHop(h.dataset.hop); }
  });
  app.addEventListener("click", function (e) {
    var hc = e.target.closest("[data-hop]");
    if (hc) { peekBusy = false; showHop(hc.dataset.hop); return; }
    var b = e.target.closest("button, a");
    if (!b || !app.contains(b)) return;
    peekBusy = false;
    var d = b.dataset;
    if (d.open) { if (isCustom(d.open)) showOnMap(d.open); else go("stop/" + d.open); return; }
    if (b.id === "add-break") { openBreak(); return; }
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
    if (b.id === "auto-toggle") {
      state.track = !state.track; save();
      if (state.track) { startLocation(); if (!state.wake && "wakeLock" in navigator) { state.wake = true; syncWake(); } }
      else { cand = leaving = null; stopLocation(); }
      renderHistory(); return;
    }
    if (b.id === "wake-toggle") { state.wake = !state.wake; save(); syncWake(); renderHistory(); return; }
    if (d.leave != null) { var lv = state.log[+d.leave]; if (lv && !lv.leave) { endVisit(lv, Date.now(), "manual"); render(); } return; }
    if (d.editv != null) { view.editVisit = view.editVisit === +d.editv ? null : +d.editv; renderHistory(); return; }
    if (d.delv != null) {
      if (confirm("Delete this visit from your history?")) { state.log.splice(+d.delv, 1); view.editVisit = null; save(); render(); renderHistory(); }
      return;
    }
    if (b.id === "hist-copy") {
      var text = logText();
      if (navigator.share) navigator.share({ title: "Doors Open MKE visits", text: text }).catch(function () {});
      else if (navigator.clipboard) navigator.clipboard.writeText(text).then(function () { toast("Log copied"); }, function () { toast("Couldn't copy"); });
      return;
    }
  });
  document.addEventListener("click", function (e) {
    var m = document.getElementById("d-menu");
    if (m && !m.hidden && !e.target.closest("#d-more") && !e.target.closest("#d-menu")) {
      m.hidden = true; document.getElementById("d-more").setAttribute("aria-expanded", "false");
    }
  });
  function toggleVisited(id) {
    var now = Date.now(), open = openVisit();
    if (state.visited[id]) {
      delete state.visited[id];
      // Undo a check-in that was just made by mistake.
      if (open && open.id === id && open.how === "manual" && now - open.arrive < 5 * 60e3) state.log.splice(state.log.indexOf(open), 1);
    } else {
      state.visited[id] = now;
      if (!open || open.id !== id) {
        if (open) endVisit(open, now, "manual");
        startVisit(id, now, "manual");
      }
    }
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
  document.getElementById("hlist").addEventListener("change", function (e) {
    var t = e.target, v = state.log[+t.dataset.i];
    if (!v || !t.dataset.f) return;
    if (!t.value) { if (t.dataset.f === "leave") v.leave = null; }
    else {
      var p = t.value.split(":"), base = new Date(v.arrive);
      base.setHours(+p[0], +p[1], 0, 0);
      var ms = base.getTime();
      if (t.dataset.f === "arrive") { v.arrive = ms; if (v.leave && v.leave < ms) v.leave = ms; }
      else v.leave = Math.max(ms, v.arrive);
    }
    save(); renderHistory(); renderPeek();
  });
  document.getElementById("q").addEventListener("input", function (e) { view.q = e.target.value; renderList(); });
  window.addEventListener("resize", function () { map.invalidateSize(); });

  // Phone layout: pull a sheet down (by its handle/header, or from the top of its
  // content) to close it and go back to the map. Tapping the handle does the same.
  function closeSheet(sheet) {
    sheet.style.transition = "transform .2s ease";
    sheet.style.transform = "translateY(100%)";
    go("map");
    setTimeout(function () { sheet.style.transition = ""; sheet.style.transform = ""; }, 260);
  }
  document.querySelectorAll(".sheet").forEach(function (sheet) {
    var y0 = null, dy = 0, t0 = 0, handle = false, pulling = false;
    sheet.querySelector(".grabbtn").addEventListener("click", function () { closeSheet(sheet); });
    sheet.addEventListener("touchstart", function (e) {
      y0 = null;
      if (desktop.matches || e.touches.length > 1) return;
      var t = e.target;
      handle = !!t.closest(".grabbtn, .sheethead");
      if (!handle && (sheet.scrollTop > 0 || t.closest(".grip, input, .chips, .cards"))) return;
      y0 = e.touches[0].clientY; dy = 0; t0 = Date.now(); pulling = false;
    }, { passive: true });
    sheet.addEventListener("touchmove", function (e) {
      if (y0 == null) return;
      dy = e.touches[0].clientY - y0;
      if (!pulling) {
        // Scrolling up, or content already scrolled: leave it to the browser.
        if (dy < 0 || (!handle && sheet.scrollTop > 0)) { y0 = null; return; }
        if (dy < 6) return;
        pulling = true;
        sheet.style.transition = "none";
      }
      e.preventDefault();
      sheet.style.transform = "translateY(" + Math.max(0, dy) + "px)";
    }, { passive: false });
    function end() {
      if (y0 == null) return;
      y0 = null;
      if (!pulling) return;
      pulling = false;
      var fast = dy > 40 && dy / Math.max(1, Date.now() - t0) > 0.6;
      if (dy > 120 || fast) closeSheet(sheet);
      else { sheet.style.transition = "transform .2s ease"; sheet.style.transform = ""; setTimeout(function () { sheet.style.transition = ""; }, 220); }
    }
    sheet.addEventListener("touchend", end);
    sheet.addEventListener("touchcancel", end);
  });

  // Keep "open now" and the up-next card current during the event.
  setInterval(function () { if (!dragging && todayKey()) render(); }, 60000);
  // Re-check presence between fixes: a phone standing still indoors may not report new positions.
  setInterval(function () {
    checkPresence();
    if (view.v === "history") renderHistory();
  }, 20000);
  if (state.track) startLocation();
  syncWake();

  if (!valid(state.order)) state.order = suggest();
  render();
  route();
  fitRoute();
  if (window.Hop) { Hop.onChange(onHop); Hop.start(); }
  drawHop();
})();
